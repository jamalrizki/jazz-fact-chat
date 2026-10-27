// Tests for find_tunes: browse the chord library by composer, key and mode.
// Runs against the 12-tune sample library. Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOLS } from "../src/tools.js";
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
  ];
  for (const args of bad) {
    const r = await find(args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.doesNotMatch(r.error, /Germany|dorian|xxxx/i, JSON.stringify(args));
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
  assert.ok(JSON.stringify({ d: t.description, s: t.inputSchema }).length < 650);
});

test("MCP: public /mcp lists find_tunes and runs it", async () => {
  const list = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(list.result.tools.some((t) => t.name === "find_tunes"));
  const call = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_tunes", arguments: { composer: "Coltrane" } } });
  assert.equal(call.result.isError, false);
  assert.deepEqual(call.result.structuredContent.tunes.map((t) => t.title), ["Mr. P.C."]);
});
