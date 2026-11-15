// Tests for album_lineup's per-track personnel (who plays on which track).
// MusicBrainz is replaced by a stub `fetch`, so these run offline.
// Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/tools.js";

const credit = (name, instrument) => ({ "target-type": "artist", type: "instrument", attributes: [instrument], artist: { name } });
const engineer = (name) => ({ "target-type": "artist", type: "engineer", artist: { name } });

const MILES = credit("Miles Davis", "trumpet");
const TRANE = credit("John Coltrane", "tenor saxophone");
const CANNON = credit("Cannonball Adderley", "alto saxophone");
const PC = credit("Paul Chambers", "double bass");
const COBB = credit("Jimmy Cobb", "drums");
const EVANS = credit("Bill Evans", "piano");
const KELLY = credit("Wynton Kelly", "piano");

const tr = (title, relations) => ({ title, recording: { title, relations } });

// Shape of the real data: Kelly on one track, Evans on the other four, Cannonball out on one.
const KOB_TRACKS = [
  tr("So What", [MILES, TRANE, CANNON, EVANS, PC, COBB]),
  tr("Freddie Freeloader", [MILES, TRANE, CANNON, KELLY, PC, COBB, engineer("Fred Plaut")]),
  tr("Blue in Green", [MILES, TRANE, EVANS, PC, COBB]),
  tr("All Blues", [MILES, TRANE, CANNON, EVANS, PC, COBB]),
  tr("Flamenco Sketches", [MILES, TRANE, CANNON, EVANS, PC, COBB]),
];

function release({ tracks = KOB_TRACKS, relations = [] } = {}) {
  return {
    id: "kob", title: "Kind of Blue", date: "1959-08-17",
    "artist-credit": [{ name: "Miles Davis" }],
    "release-group": { id: "rg-kob", "first-release-date": "1959-08-17" },
    relations,
    media: [{ tracks }],
  };
}

function stubFetch(full) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes("/ws/2/release?")
      ? { releases: [{ id: "kob", score: 100, title: "Kind of Blue", status: "Official", date: "1959-08-17", "release-group": { id: "rg-kob" } }] }
      : full;
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

const lineup = (args) => runTool("album_lineup", { album: "Kind of Blue", artist: "Miles Davis", ...args });
const byName = (personnel) => Object.fromEntries(personnel.map((p) => [p.name, p]));

test("whole album: players on only some tracks get on_tracks, everyone else doesn't", async () => {
  stubFetch(release());
  const { result, isError } = await lineup({});
  assert.equal(isError, false);
  const p = byName(result.personnel);
  assert.deepEqual(p["Wynton Kelly"].on_tracks, ["Freddie Freeloader"]);
  assert.deepEqual(p["Bill Evans"].on_tracks, ["So What", "Blue in Green", "All Blues", "Flamenco Sketches"]);
  assert.deepEqual(p["Cannonball Adderley"].on_tracks, ["So What", "Freddie Freeloader", "All Blues", "Flamenco Sketches"]);
  for (const name of ["Miles Davis", "John Coltrane", "Paul Chambers", "Jimmy Cobb"]) assert.equal(p[name].on_tracks, undefined, name);
  assert.equal(p["Fred Plaut"], undefined); // engineers are still left out
  assert.match(result.note, /only on those tracks/);
  // Internal bookkeeping never reaches the model.
  for (const k of ["players", "tracks", "perTrack"]) assert.equal(result[k], undefined, k);
});

test("track: \"Freddie Freeloader\" returns just that track's players", async () => {
  stubFetch(release());
  const { result } = await lineup({ track: "freddie freeloader" });
  assert.equal(result.found, true);
  assert.equal(result.track, "Freddie Freeloader");
  const names = result.personnel.map((p) => p.name);
  assert.ok(names.includes("Wynton Kelly"));
  assert.ok(!names.includes("Bill Evans"));
  assert.ok(result.personnel.every((p) => !p.on_tracks));
});

test("track: Blue in Green has no Cannonball; title match ignores case and \"the\"", async () => {
  stubFetch(release());
  const { result } = await lineup({ track: "BLUE IN GREEN" });
  const names = result.personnel.map((p) => p.name);
  assert.deepEqual(names.sort(), ["Bill Evans", "Jimmy Cobb", "John Coltrane", "Miles Davis", "Paul Chambers"]);
});

test("track: a unique \"starts with\" match finds an alternate-take title", async () => {
  stubFetch(release({ tracks: [...KOB_TRACKS, tr("Flamenco Sketches (alternate take)", [MILES, EVANS])] }));
  const { result } = await lineup({ track: "So What" });
  assert.equal(result.track, "So What"); // exact match wins
  const ambiguous = await lineup({ track: "Flamenco" });
  assert.equal(ambiguous.result.found, false);
});

test("track: unknown title is found:false, lists the real titles, never echoes the caller", async () => {
  stubFetch(release());
  const secret = "Giant Steps <script>";
  const { result, isError } = await lineup({ track: secret });
  assert.equal(isError, false);
  assert.equal(result.found, false);
  assert.ok(result.tracks.includes("Freddie Freeloader"));
  assert.ok(!JSON.stringify(result).includes("Giant Steps"));
});

test("album-wide credits only: no on_tracks, note says it can't tell who's on which track", async () => {
  const plain = KOB_TRACKS.map((t) => tr(t.title, []));
  stubFetch(release({ tracks: plain, relations: [MILES, TRANE, EVANS, KELLY] }));
  const { result } = await lineup({});
  assert.ok(result.personnel.every((p) => !p.on_tracks));
  assert.match(result.note, /as a whole, not track by track/);
  const one = await lineup({ track: "Freddie Freeloader" });
  assert.equal(one.result.track, "Freddie Freeloader");
  assert.match(one.result.note, /can't confirm who plays on this particular track/);
});

test("album-level credit counts for every track; uncredited tracks don't make players look partial", async () => {
  const tracks = [tr("So What", [MILES, EVANS]), tr("Freddie Freeloader", [MILES, KELLY]), tr("Blue in Green", [])];
  stubFetch(release({ tracks, relations: [credit("Teo Macero", "producer")].map((r) => ({ ...r, type: "producer", attributes: [] })) }));
  const { result } = await lineup({});
  const p = byName(result.personnel);
  assert.equal(p["Miles Davis"].on_tracks, undefined); // on both credited tracks
  assert.equal(p["Teo Macero"].on_tracks, undefined); // album-level credit
  assert.deepEqual(p["Wynton Kelly"].on_tracks, ["Freddie Freeloader"]);
  assert.match(result.note, /Some tracks have no player credits/);
  const blue = await lineup({ track: "Blue in Green" });
  assert.deepEqual(blue.result.personnel.map((x) => x.name), ["Teo Macero"]);
});

test("on_tracks is capped at 10 titles plus a count", async () => {
  const tracks = Array.from({ length: 14 }, (_, i) => tr(`Take ${i + 1}`, i < 12 ? [MILES, EVANS] : [MILES]));
  stubFetch(release({ tracks }));
  const { result } = await lineup({});
  const evans = byName(result.personnel)["Bill Evans"];
  assert.equal(evans.on_tracks.length, 11);
  assert.equal(evans.on_tracks[10], "+2 more");
});

test("track argument is validated as untrusted input", async () => {
  stubFetch(release());
  const long = await lineup({ track: "x".repeat(101) });
  assert.equal(long.isError, true);
  const wrongType = await lineup({ track: 42 });
  assert.equal(wrongType.isError, true);
});
