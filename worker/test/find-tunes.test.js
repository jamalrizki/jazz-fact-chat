// Tests for find_tunes: browse the chord library by composer, key, mode, style and form.
// Runs against the 12-tune sample library. Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOLS, formType } from "../src/tools.js";
import { handleRpc } from "../src/mcp.js";

const find = async (args) => {
  const { result, isError } = await runTool("find_tunes", args);
  return { ...result, isError };
};
const titles = (r) => r.tunes.map((t) => t.title);

test("composer: substring match on the library's composer field", async () => {
  const r = await find({ composer: "Miles Davis" });
  assert.equal(r.found, true);
  assert.deepEqual(titles(r), ["So What", "Solar"]);
  assert.deepEqual(r.tunes[1], { title: "Solar", key: "C minor", form: "12 bars" });
  // last name only, any case, co-written tunes count
  assert.deepEqual(titles(await find({ composer: "strayhorn" })), ["Satin Doll", "Take the 'A' Train"]);
});

test("key + mode: C minor", async () => {
  const want = ["Blue Bossa", "Mr. P.C.", "Solar"];
  assert.deepEqual(titles(await find({ key: "C", mode: "minor" })), want);
  // the mode can come with the key itself
  for (const key of ["C minor", "Cm", "c min", "C-"]) assert.deepEqual(titles(await find({ key })), want, key);
  // key alone: both modes
  assert.deepEqual(titles(await find({ key: "C" })),
    ["Blue Bossa", "Fly Me to the Moon", "Mr. P.C.", "Satin Doll", "Solar", "Take the 'A' Train"]);
});

test("keys are compared by pitch, so enharmonic spellings match", async () => {
  assert.deepEqual(titles(await find({ key: "A#" })), ["Rhythm Changes"]);
  assert.deepEqual(titles(await find({ key: "Bb major" })), ["Rhythm Changes"]);
  assert.deepEqual(titles(await find({ key: "G sharp" })), ["All the Things You Are"]);
});

test("mode alone, combined filters", async () => {
  const minor = await find({ mode: "minor" });
  assert.equal(minor.total, 6);
  assert.ok(minor.tunes.every((t) => t.key.endsWith(" minor")));
  assert.deepEqual(titles(await find({ composer: "Miles Davis", key: "D" })), ["So What"]);
});

test("limit caps the list and says how many more there are", async () => {
  const r = await find({ mode: "major", limit: 2 });
  assert.equal(r.total, 6);
  assert.equal(r.tunes.length, 2);
  assert.equal(r.more, 4);
  assert.match(r.note, /narrow/);
  // default limit is 8, and no "more" when everything fits
  const all = await find({ mode: "major" });
  assert.equal(all.tunes.length, 6);
  assert.equal(all.more, undefined);
  // sorted by title
  assert.deepEqual(titles(all), [...titles(all)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
});

test("nothing matches: found false, no titles at all", async () => {
  const r = await find({ composer: "Thelonious Monk" });
  assert.equal(r.found, false);
  assert.equal(r.total, 0);
  assert.equal(r.tunes, undefined);
  assert.match(r.message, /Do not list tunes from memory/);
  assert.doesNotMatch(r.message, /Monk/i); // caller text is never echoed
  assert.equal((await find({ key: "E", mode: "major" })).found, false);
});

test("bad arguments are errors that never echo the caller's text", async () => {
  const bad = [
    {},
    { limit: 3 },
    { key: "Germany" },
    { key: "H" },
    { key: "C dorian" },
    { mode: "dorian" },
    { key: "Cm", mode: "major" },
    { composer: "x" },
    { composer: 42 },
    { composer: "a".repeat(61) },
    { key: "C", limit: 0 },
    { key: "C", limit: 11 },
    { key: "C", limit: 2.5 },
    { key: "C", limit: "5" },
    { style: "sw" },
    { style: 7 },
    { style: "b".repeat(31) },
    { form: "rhythm changes" },
    { form: "AABA" },
  ];
  for (const args of bad) {
    const r = await find(args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.doesNotMatch(r.error, /Germany|dorian|xxxx|rhythm changes|bbbb/i, JSON.stringify(args));
  }
});

test("never returns chords", async () => {
  const r = await find({ mode: "minor", limit: 10 });
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /"sections"|"bars"|"chart_text"|"layout"/);
  for (const t of r.tunes) assert.deepEqual(Object.keys(t).filter((k) => !["title", "key", "form", "style"].includes(k)), []);
});

test("definition stays small (it rides on every request)", () => {
  const t = TOOLS.find((x) => x.name === "find_tunes");
  assert.ok(JSON.stringify({ d: t.description, s: t.inputSchema }).length < 800);
});

test("MCP: public /mcp lists find_tunes and runs it", async () => {
  const list = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(list.result.tools.some((t) => t.name === "find_tunes"));
  const call = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_tunes", arguments: { composer: "Coltrane" } } });
  assert.equal(call.result.isError, false);
  assert.deepEqual(call.result.structuredContent.tunes.map((t) => t.title), ["Mr. P.C."]);
});

test("style: matched against the styles the library actually has", async () => {
  // "bossa", "Bossa Nova" and the plural "bossas" all find the one bossa in the sample
  for (const style of ["bossa", "Bossa Nova", "bossas", "BOSSA"]) {
    const r = await find({ style });
    assert.deepEqual(titles(r), ["Blue Bossa"], style);
    assert.equal(r.tunes[0].style, "Bossa Nova");
  }
  // "swing" covers every swing style; tunes without a style never match a style filter
  const swing = await find({ style: "swing" });
  assert.deepEqual(titles(swing), ["All the Things You Are", "Autumn Leaves", "Mr. P.C.", "Rhythm Changes", "Satin Doll", "So What"]);
  assert.deepEqual(titles(await find({ style: "up tempo" })), ["Mr. P.C.", "Rhythm Changes"]);
  assert.deepEqual(titles(await find({ style: "swing", mode: "minor" })), ["Autumn Leaves", "Mr. P.C.", "So What"]);
});

test("style the library doesn't have: lists the real styles, no titles, no echo", async () => {
  const r = await find({ style: "zydeco" });
  assert.equal(r.found, false);
  assert.equal(r.tunes, undefined);
  assert.deepEqual(r.known_styles, ["Bossa Nova", "Funk", "Medium Swing", "Medium Up Swing", "Up Tempo Swing"]);
  assert.match(r.message, /Do not list tunes from memory/);
  assert.doesNotMatch(JSON.stringify(r), /zydeco/i);
  // a real style with no tune in that key is an ordinary empty result
  const none = await find({ style: "bossa", key: "F" });
  assert.equal(none.found, false);
  assert.equal(none.known_styles, undefined);
  assert.match(none.message, /key \+ style/);
});

test("form type is worked out in code from the form text", () => {
  assert.equal(formType("12-bar blues"), "blues");
  assert.equal(formType("12-bar minor blues"), "blues");
  assert.equal(formType("12 bars"), "other"); // Solar: 12 bars, but not a blues
  assert.equal(formType("AABA, 32 bars"), "aaba");
  assert.equal(formType("AABA', 36 bars"), "aaba");
  assert.equal(formType("AABA, 32 bars (D Dorian / E♭ Dorian)"), "aaba");
  assert.equal(formType("AABC, 32 bars"), "other");
  assert.equal(formType("AB AB', 32 bars"), "other");
  assert.equal(formType(undefined), "other");
});

test("form filter: blues, minor blues, AABA", async () => {
  assert.deepEqual(titles(await find({ form: "blues" })), ["Jazz Blues", "Mr. P.C."]);
  assert.deepEqual(titles(await find({ form: "blues", mode: "minor" })), ["Mr. P.C."]);
  assert.deepEqual(titles(await find({ form: "blues", key: "F" })), ["Jazz Blues"]);
  assert.deepEqual(titles(await find({ form: "aaba", key: "C" })), ["Satin Doll", "Take the 'A' Train"]);
  const other = await find({ form: "other", limit: 10 });
  assert.equal(other.total, 5);
  assert.ok(titles(other).includes("Solar")); // Solar's "12 bars" is not called a blues
  assert.match((await find({ form: "blues", key: "E" })).message, /key \+ form/);
});
