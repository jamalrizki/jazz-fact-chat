// Tests for album_lineup with `tune`: recordings of a composition ("Which versions of Body and Soul?").
// MusicBrainz is replaced by a stub `fetch`, so these run offline.
// Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool, pickTuneRecordings, firstAlbum, TOOLS } from "../src/tools.js";

const WORK = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_WORK = "aaaaaaaa-0000-4000-8000-000000000002";
const rid = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;

const perf = (workId = WORK, attributes = []) => ({ "target-type": "work", type: "performance", attributes, work: { id: workId } });
const rec = (n, artist, date, extra = {}) => ({
  id: rid(n),
  title: "Body and Soul",
  "first-release-date": date,
  "artist-credit": [{ name: artist, joinphrase: "" }],
  relations: [perf()],
  ...extra,
});

const WORKS = {
  works: [
    { id: WORK, score: 100, title: "Body and Soul", type: "Song",
      relations: [{ type: "composer", artist: { name: "Johnny Green" } }, { type: "lyricist", artist: { name: "Edward Heyman" } }] },
    { id: OTHER_WORK, score: 95, title: "Body and Soul Revisited" },
  ],
};

const RECORDINGS = [
  rec(1, "John Coltrane", "1964-02-00"),
  rec(2, "Coleman Hawkins and His Orchestra", "1940"),
  rec(3, "John Coltrane", "1961-03-01"), // same artist, earlier: this one wins
  rec(4, "Billie Holiday", "1957"),
  rec(5, "Some Medley Band", "1950", { relations: [perf(WORK, ["medley"])] }),
  rec(6, "Two Tunes Trio", "1955", { relations: [perf(WORK), perf(OTHER_WORK)] }), // also a medley
  rec(7, "Undated Quartet", ""),
  rec(8, "Video Artist", "1945", { video: true }),
  rec(9, "Dexter Gordon", "1965", { relations: [perf(WORK, ["live"])] }),
];

const RELEASES = {
  recordings: [
    { id: rid(2), releases: [
      { title: "Body and Soul Hits", status: "Official", date: "1960", "release-group": { "secondary-types": ["Compilation"] } },
      { title: "Body and Soul / Fine Dinner", status: "Official", date: "1940", "release-group": { "primary-type": "Single" } },
    ] },
    { id: rid(3), releases: [
      { title: "Coltrane's Sound (Deluxe Edition)", status: "Official", date: "1999" },
      { title: "Coltrane's Sound", status: "Official", date: "1964" },
    ] },
  ],
};

function stubFetch({ works = WORKS, recordings = RECORDINGS, count, releases = RELEASES, failReleases = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    let body;
    if (u.includes("/ws/2/work?")) body = works;
    else if (u.includes("&work=")) body = { "recording-count": count ?? recordings.length, recordings };
    else if (u.includes("/ws/2/recording?") && u.includes("query=")) {
      if (failReleases) return new Response("busy", { status: 503 });
      body = releases;
    } else body = {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const recordingsOf = (tune) => runTool("album_lineup", { tune });

test("one row per artist (their earliest), oldest first, medleys and videos left out", async () => {
  const calls = stubFetch();
  const { result, isError } = await recordingsOf("body and soul");
  assert.equal(isError, false);
  assert.equal(result.found, true);
  assert.equal(result.tune, "Body and Soul");
  assert.deepEqual(result.written_by, ["Johnny Green", "Edward Heyman"]);
  assert.deepEqual(result.recordings.map((r) => [r.artist, r.year]), [
    ["Coleman Hawkins and His Orchestra", 1940],
    ["Billie Holiday", 1957],
    ["John Coltrane", 1961],
    ["Dexter Gordon", 1965],
    ["Undated Quartet", null], // undated rows go last
  ]);
  assert.equal(result.recordings.find((r) => r.artist === "Dexter Gordon").live, true);
  // The work id from step 1 is what step 2 browses; the caller's text never builds that URL.
  assert.ok(calls[1].includes(`work=${WORK}`));
  assert.equal(calls.length, 3);
  // Internal ids never reach the model.
  assert.ok(result.recordings.every((r) => r.id === undefined));
});

test("album is the original release: not the compilation, not the deluxe reissue", async () => {
  stubFetch();
  const { result } = await recordingsOf("Body and Soul");
  const album = Object.fromEntries(result.recordings.map((r) => [r.artist, r.album]));
  assert.equal(album["Coleman Hawkins and His Orchestra"], "Body and Soul / Fine Dinner");
  assert.equal(album["John Coltrane"], "Coltrane's Sound");
  assert.equal(album["Billie Holiday"], null); // no release data: null, never a guess
});

test("capped at 8 rows", async () => {
  const many = Array.from({ length: 20 }, (_, i) => rec(100 + i, `Artist ${i}`, String(1930 + i)));
  stubFetch({ recordings: many, releases: { recordings: [] } });
  const { result } = await recordingsOf("Body and Soul");
  assert.equal(result.recordings.length, 8);
  assert.equal(result.recordings[0].artist, "Artist 0");
});

test("the note says when the page is only part of what MusicBrainz has", async () => {
  stubFetch({ count: 2400 });
  const { result } = await recordingsOf("Body and Soul");
  assert.match(result.note, /not a complete discography/);
  assert.match(result.note, /2400 recordings/);
  stubFetch();
  const small = await recordingsOf("Body and Soul");
  assert.doesNotMatch(small.result.note, /recordings to this tune/);
});

test("if the album lookup fails, rows still come back with album: null", async () => {
  stubFetch({ failReleases: true });
  const { result, isError } = await recordingsOf("Body and Soul");
  assert.equal(isError, false);
  assert.equal(result.recordings.length, 5);
  assert.ok(result.recordings.every((r) => r.album === null));
});

test("no match, or only a near-miss title: abstains without echoing the caller's text", async () => {
  stubFetch({ works: { works: [{ id: OTHER_WORK, score: 100, title: "Body and Soul Revisited" }] } });
  const near = await recordingsOf("Body and Soul");
  assert.equal(near.result.found, false);
  assert.doesNotMatch(JSON.stringify(near.result), /Body and Soul/);

  stubFetch({ works: { works: [{ id: WORK, score: 60, title: "Zzyzx Xylophone" }] } });
  const none = await recordingsOf("Zzyzx Xylophone");
  assert.equal(none.result.found, false);
  assert.doesNotMatch(JSON.stringify(none.result), /Zzyzx/);
});

test("a work with no usable recordings says so instead of guessing", async () => {
  stubFetch({ recordings: [rec(5, "Some Medley Band", "1950", { relations: [perf(WORK, ["medley"])] })] });
  const { result } = await recordingsOf("Body and Soul");
  assert.equal(result.found, true);
  assert.deepEqual(result.recordings, []);
  assert.match(result.note, /no recordings/);
});

test("validation: tune is capped, and tune + album together are refused", async () => {
  stubFetch();
  const long = await recordingsOf("x".repeat(81));
  assert.equal(long.isError, true);
  assert.doesNotMatch(long.result.error, /xxxx/);
  const both = await runTool("album_lineup", { tune: "Body and Soul", album: "Kind of Blue" });
  assert.equal(both.isError, true);
  const neither = await runTool("album_lineup", {});
  assert.equal(neither.isError, true);
  const wrongType = await runTool("album_lineup", { tune: 42 });
  assert.equal(wrongType.isError, true);
});

test("pickTuneRecordings / firstAlbum handle junk input", () => {
  assert.deepEqual(pickTuneRecordings(null, WORK), []);
  assert.deepEqual(pickTuneRecordings([null, { id: "not-an-mbid", "artist-credit": [{ name: "X" }] }], WORK), []);
  assert.equal(firstAlbum(undefined), null);
  assert.equal(firstAlbum([{ title: "" }]), null);
});

test("album_lineup definition: tune is optional and the definition stays small", () => {
  const t = TOOLS.find((x) => x.name === "album_lineup");
  assert.equal(t.inputSchema.properties.tune.type, "string");
  assert.equal(t.inputSchema.required, undefined);
  assert.ok(JSON.stringify({ d: t.description, s: t.inputSchema }).length < 950, "sent with every request: keep it small");
});
