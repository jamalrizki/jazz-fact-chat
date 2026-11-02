// Answers never name their sources. stripSourceTags enforces that in code,
// because the prompt alone doesn't stop the model from writing "According to Wikipedia, …".
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripSourceTags } from "../src/source-tags.js";
import { runTool } from "../src/tools.js";

const strip = (s) => stripSourceTags(s);

test("parenthesized tags are removed (existing behavior)", () => {
  assert.equal(strip("Kind of Blue came out in 1959 (Source: MusicBrainz)."), "Kind of Blue came out in 1959.");
  assert.equal(strip("He played tenor (per Wikipedia)."), "He played tenor.");
  assert.equal(strip("Recorded in 1957【3†source】."), "Recorded in 1957.");
});

test("a leading 'According to <source>,' is removed and the sentence recapitalized", () => {
  assert.equal(strip("According to Wikipedia, he was born in 1926."), "He was born in 1926.");
  assert.equal(
    strip("Mingus led the band. According to the MusicBrainz entry, the album came out in 1959."),
    "Mingus led the band. The album came out in 1959.",
  );
  assert.equal(strip("Per Discogs, the first pressing was mono."), "The first pressing was mono.");
  assert.equal(strip("According to All About Jazz's review, it was cut in one day."), "It was cut in one day.");
  assert.equal(strip("According to Wikipedia and Discogs, it's a 1961 session."), "It's a 1961 session.");
});

test("list items and new lines are handled too", () => {
  assert.equal(
    strip("Two sessions:\n- According to Wikipedia, the first was in 1956.\n- The second was in 1957."),
    "Two sessions:\n- The first was in 1956.\n- The second was in 1957.",
  );
});

test("a trailing or mid-sentence attribution is removed", () => {
  assert.equal(strip("He was born in 1926, according to Wikipedia."), "He was born in 1926.");
  assert.equal(strip("The album, according to MusicBrainz, came out in 1959."), "The album came out in 1959.");
  assert.equal(strip("It was released in 1964 via Discogs listings, then reissued."), "It was released in 1964, then reissued.");
  assert.equal(strip("They made four records together according to search_jazz."), "They made four records together.");
});

test("music phrases that only look like attributions survive", () => {
  const keep = [
    "Play one chord per bar.",
    "Resolve via the ii–V into F.",
    "According to the melody, the bridge goes up a fourth.",
    "Per chorus, trade fours with the drummer.",
    "He recorded for Blue Note, according to his own account.",
  ];
  for (const s of keep) assert.equal(strip(s), s);
});

test("search_jazz's result note no longer asks the model to name the site", async () => {
  // Stub the network: one Wikipedia hit, no web search key.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes("list=search")
      ? { query: { search: [{ title: "Sonny Rollins" }] } }
      : { query: { pages: { 1: { title: "Sonny Rollins", extract: "Sonny Rollins is a tenor saxophonist." } } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const { result, isError } = await runTool("search_jazz", { query: "Sonny Rollins tenor" });
    assert.equal(isError, false);
    assert.equal(result.found, true);
    assert.match(result.note, /without naming the sites/);
    assert.doesNotMatch(result.note, /name the site you used/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
