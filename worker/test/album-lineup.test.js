// Tests for album_lineup's pressing choice. MusicBrainz is replaced by a stub `fetch`,
// so these run offline and never hit the real API.
// Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool, pickPressings } from "../src/tools.js";

const GROUP = "rg-love-supreme";
const rel = (id, extra = {}) => ({ id, score: 100, title: "A Love Supreme", status: "Official", "release-group": { id: GROUP }, ...extra });
const credit = (name, instrument) => ({ "target-type": "artist", type: "instrument", attributes: [instrument], artist: { name } });

const QUARTET = [credit("McCoy Tyner", "piano"), credit("Jimmy Garrison", "double bass"), credit("Elvin Jones", "drums")];
const DELUXE_EXTRA = [credit("Archie Shepp", "tenor saxophone"), credit("Art Davis", "double bass")];

function fullRelease(id, relations) {
  return {
    id, title: "A Love Supreme", date: "1965-02",
    "artist-credit": [{ name: "John Coltrane" }],
    "release-group": { id: GROUP, "first-release-date": "1965-02" },
    relations,
  };
}

/** Stub fetch: search returns `search`; release lookups return `details[id]`. Records the ids looked up. */
function stubFetch(search, details) {
  const looked = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    let body;
    if (u.includes("/ws/2/release?")) body = { releases: search };
    else {
      const id = u.match(/\/release\/([^?]+)/)[1];
      looked.push(id);
      body = details[id];
    }
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("", { status: 404 });
  };
  return looked;
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test("pickPressings: original official pressing first, reissues last", () => {
  const order = pickPressings([
    rel("deluxe", { date: "2002", disambiguation: "Deluxe Edition" }),
    rel("cd-1986", { date: "1986" }),
    rel("bootleg", { date: "1965", status: "Bootleg" }),
    rel("remaster", { title: "A Love Supreme (Remastered)", date: "2015" }),
    rel("lp-1965", { date: "1965-02" }),
    rel("undated"),
  ]).map((r) => r.id);
  assert.deepEqual(order, ["lp-1965", "cd-1986", "undated", "bootleg", "deluxe", "remaster"]);
});

test("pickPressings: reissue words are matched as words, case-insensitively", () => {
  const ids = (list) => pickPressings(list).map((r) => r.id);
  assert.deepEqual(ids([rel("x", { disambiguation: "EXPANDED EDITION" }), rel("y")]), ["y", "x"]);
  assert.deepEqual(ids([rel("x", { title: "50th Anniversary" }), rel("y")]), ["y", "x"]);
  assert.deepEqual(ids([rel("a", { title: "Completely Free" }), rel("b")]), ["a", "b"]); // "Completely" isn't "Complete"
  assert.deepEqual(pickPressings([]), []);
});

test("A Love Supreme: deluxe edition is top search hit, original quartet is returned", async () => {
  const looked = stubFetch(
    [rel("deluxe", { date: "2002", disambiguation: "deluxe edition" }), rel("lp-1965", { date: "1965-02" })],
    {
      deluxe: fullRelease("deluxe", [...QUARTET, ...DELUXE_EXTRA]),
      "lp-1965": fullRelease("lp-1965", QUARTET),
    }
  );
  const { result, isError } = await runTool("album_lineup", { album: "A Love Supreme", artist: "John Coltrane" });
  assert.equal(isError, false);
  assert.equal(result.found, true);
  assert.equal(result.release_year, 1965);
  const names = result.personnel.map((p) => p.name);
  assert.deepEqual(names, ["McCoy Tyner", "Jimmy Garrison", "Elvin Jones"]);
  assert.ok(!names.includes("Archie Shepp") && !names.includes("Art Davis"));
  assert.deepEqual(looked, ["lp-1965"]); // one lookup: the deluxe set was never fetched
});

test("a reissue in its own release group doesn't steal the anchor", async () => {
  stubFetch(
    [rel("deluxe", { disambiguation: "Deluxe Edition", "release-group": { id: "rg-deluxe" } }), rel("lp-1965", { date: "1965" })],
    { deluxe: fullRelease("deluxe", [...QUARTET, ...DELUXE_EXTRA]), "lp-1965": fullRelease("lp-1965", QUARTET) }
  );
  const { result } = await runTool("album_lineup", { album: "A Love Supreme" });
  assert.equal(result.url, "https://musicbrainz.org/release/lp-1965");
  assert.equal(result.personnel.length, 3);
});

test("falls back to a reissue only when no original pressing has credits", async () => {
  const looked = stubFetch(
    [rel("deluxe", { date: "2002", disambiguation: "deluxe edition" }), rel("lp-1965", { date: "1965" })],
    { deluxe: fullRelease("deluxe", [...QUARTET, ...DELUXE_EXTRA]), "lp-1965": fullRelease("lp-1965", []) }
  );
  const { result } = await runTool("album_lineup", { album: "A Love Supreme" });
  assert.deepEqual(looked, ["lp-1965", "deluxe"]);
  assert.equal(result.personnel.length, 5); // better than nothing; still from MusicBrainz, not memory
});

test("keeps the original even when a later plain pressing has more credits than one", async () => {
  // Original has 1 credit; reissue would add bonus players. Stop at the reissue boundary.
  const looked = stubFetch(
    [rel("lp-1965", { date: "1965" }), rel("deluxe", { disambiguation: "Deluxe" })],
    { "lp-1965": fullRelease("lp-1965", [QUARTET[0]]), deluxe: fullRelease("deluxe", [...QUARTET, ...DELUXE_EXTRA]) }
  );
  const { result } = await runTool("album_lineup", { album: "A Love Supreme" });
  assert.deepEqual(looked, ["lp-1965"]);
  assert.deepEqual(result.personnel.map((p) => p.name), ["McCoy Tyner"]);
});

test("no match and bad arguments", async () => {
  stubFetch([], {});
  const none = await runTool("album_lineup", { album: "Nonexistent Record" });
  assert.equal(none.result.found, false);
  const bad = await runTool("album_lineup", { album: 42 });
  assert.equal(bad.isError, true);
  const long = await runTool("album_lineup", { album: "x".repeat(151) });
  assert.equal(long.isError, true);
  assert.ok(!long.result.error.includes("xxxx")); // caller text is not echoed
});
