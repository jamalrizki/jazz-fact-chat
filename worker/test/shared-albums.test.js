// Tests for album_lineup's `with`: albums two players are both credited on.
// MusicBrainz is replaced by a stub `fetch`, so these run offline.
// Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOLS, pickArtist, albumCredits, intersectAlbums } from "../src/tools.js";

// A release-level credit, as it appears on /ws/2/artist/<id>?inc=release-rels.
const onAlbum = (title, date, instrument, extra = {}) => ({
  "target-type": "release", type: "instrument", direction: "backward", attributes: [instrument],
  release: { id: `${title}-${date}`, title, date, ...extra },
});
const engineered = (title, date) => ({ "target-type": "release", type: "engineer", release: { id: "e", title, date } });

const PC = { id: "pc", name: "Paul Chambers", score: 100, disambiguation: "jazz double bassist" };
const PJJ = { id: "pjj", name: "Philly Joe Jones", score: 100, disambiguation: "jazz drummer" };

const PC_RELS = [
  onAlbum("'Round About Midnight", "1957-03-04", "double bass"),
  onAlbum("Cookin' With the Miles Davis Quintet", "1957", "double bass"),
  onAlbum("Relaxin' With the Miles Davis Quintet (Remastered)", "2006", "double bass"), // a reissue...
  onAlbum("Relaxin' With the Miles Davis Quintet", "1958", "double bass"), // ...and the original
  onAlbum("Kind of Blue", "1959-08-17", "double bass"), // Philly Joe isn't on it
  onAlbum("Bass on Top", "1957", "double bass"),
];
const PJJ_RELS = [
  onAlbum("Relaxin' with the Miles Davis Quintet", "1958", "drums"),
  onAlbum("Cookin' With the Miles Davis Quintet", "1957", "drums"),
  onAlbum("'Round About Midnight", "1957", "drums"),
  onAlbum("Blues for Dracula", "1958", "drums"),
  engineered("Bass on Top", "1957"), // not a playing credit
];

/** Stub MusicBrainz: artist searches return `search[n]` in call order; lookups return `rels[id]`. */
function stubFetch({ search = [[PC], [PJJ]], rels = { pc: PC_RELS, pjj: PJJ_RELS } } = {}) {
  const urls = [];
  let searches = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    urls.push(u);
    const body = u.includes("/ws/2/artist?")
      ? { artists: search[searches++] || [] }
      : { id: u.match(/\/artist\/([^?]+)/)[1], relations: rels[u.match(/\/artist\/([^?]+)/)[1]] || [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return urls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const together = (pair) => runTool("album_lineup", { with: pair });

test("overlap: albums both are credited on, oldest first, one entry per album, with each player's role", async () => {
  const urls = stubFetch();
  const { result, isError } = await together(["paul chambers", "Philly Joe Jones"]);
  assert.equal(isError, false);
  assert.equal(result.found, true);
  assert.deepEqual(result.albums.map((a) => [a.title, a.year]), [
    ["'Round About Midnight", 1957],
    ["Cookin' With the Miles Davis Quintet", 1957],
    ["Relaxin' With the Miles Davis Quintet", 1958], // the 2006 remaster folds into the original
  ]);
  assert.deepEqual(result.albums[0].roles, { "Paul Chambers": ["double bass"], "Philly Joe Jones": ["drums"] });
  // Kind of Blue (only Chambers) and Bass on Top (Jones only as engineer) are left out.
  assert.ok(!result.albums.some((a) => /Kind of Blue|Bass on Top/.test(a.title)));
  assert.match(result.note, /at least these/);
  assert.deepEqual(result.players.map((p) => p.name), ["Paul Chambers", "Philly Joe Jones"]);
  // Two artist searches, then two credit lookups: four MusicBrainz requests.
  assert.equal(urls.length, 4);
  assert.ok(urls.every((u) => u.startsWith("https://musicbrainz.org/ws/2/artist")));
});

test("no overlap: found false, no names from memory", async () => {
  stubFetch({ rels: { pc: [onAlbum("Bass on Top", "1957", "double bass")], pjj: PJJ_RELS } });
  const { result } = await together(["Paul Chambers", "Philly Joe Jones"]);
  assert.equal(result.found, false);
  assert.equal(result.albums, undefined);
  assert.match(result.message, /don't list albums from memory/);
});

test("unknown player: found false, says which slot, never echoes the name", async () => {
  stubFetch({ search: [[PC], []] });
  const { result } = await together(["Paul Chambers", "Zzyzx Qwerty"]);
  assert.equal(result.found, false);
  assert.match(result.message, /second name/);
  assert.ok(!JSON.stringify(result).includes("Zzyzx"));
});

test("cap: at most 10 albums, then a count of the rest", async () => {
  const many = (inst) => Array.from({ length: 13 }, (_, i) => onAlbum(`Session ${i + 1}`, String(1950 + i), inst));
  stubFetch({ rels: { pc: many("double bass"), pjj: many("drums") } });
  const { result } = await together(["Paul Chambers", "Philly Joe Jones"]);
  assert.equal(result.albums.length, 10);
  assert.equal(result.more, 3);
  assert.equal(result.albums[0].year, 1950);
  assert.match(result.note, /3 more/);
});

test("bad arguments are rejected before any request, without echoing caller text", async () => {
  const urls = stubFetch();
  for (const bad of [["Paul Chambers"], ["A", "B", "C"], "Paul Chambers and Philly Joe Jones", ["Paul Chambers", 42],
    ["Paul Chambers", "paul  chambers"], ["Paul Chambers", "x".repeat(101) + "SECRET"]]) {
    const { result, isError } = await together(bad);
    assert.equal(isError, true, JSON.stringify(bad).slice(0, 60));
    assert.ok(!/SECRET|Chambers/.test(result.error), result.error);
  }
  assert.equal(urls.length, 0);
  // Without `with`, album is still required.
  const { isError } = await runTool("album_lineup", {});
  assert.equal(isError, true);
});

test("pickArtist: exact name first, and the jazz player among namesakes", () => {
  const evans = [
    { id: "sax", name: "Bill Evans", score: 100, disambiguation: "American saxophonist" },
    { id: "pno", name: "Bill Evans", score: 100, disambiguation: "American jazz pianist" },
    { id: "x", name: "Bill Evans Trio", score: 95 },
  ];
  assert.equal(pickArtist(evans, "bill evans").id, "pno");
  assert.equal(pickArtist([{ id: "low", name: "Bill Evans", score: 40 }], "Bill Evans"), null);
  assert.equal(pickArtist([{ id: "t", name: "Bill Evans Trio", score: 92 }], "Bill Evans").id, "t");
});

test("albumCredits / intersectAlbums: keyed by album, reissue titles lose to the original", () => {
  const a = albumCredits([onAlbum("Milestones (Deluxe Edition)", "2001", "double bass"), onAlbum("Milestones", "1958", "double bass")]);
  const b = albumCredits([onAlbum("Milestones [Remastered]", "2001", "drums")]);
  assert.deepEqual(intersectAlbums(a, b, ["A", "B"]), [{ title: "Milestones", year: 1958, roles: { A: ["double bass"], B: ["drums"] } }]);
});

test("definition stays small: with is optional and album is no longer schema-required", () => {
  const t = TOOLS.find((x) => x.name === "album_lineup");
  assert.ok(t.inputSchema.properties.with);
  assert.equal(t.inputSchema.required, undefined);
  assert.ok(JSON.stringify({ d: t.description, s: t.inputSchema }).length < 1000);
});
