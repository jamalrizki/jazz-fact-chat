// chord_chart `changes` + `from_key`: transpose chords the user typed, not just library tunes.
// Part of issue #44 (slice 1: concert keys). Run from worker/: npm test
// The model only copies the user's chords into the argument; every note is moved here, in code.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, splitChartResult, parseTypedChanges } from "../src/tools.js";
import { handleMcpHttp } from "../src/mcp.js";

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pc = (name) => (PC[name[0]] + (name[1] === "#" ? 1 : name[1] === "b" ? -1 : 0) + 12) % 12;
const KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

async function typed(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  return result;
}
const chords = (r) => r.layout.bars.flatMap((b) => b.c || []);

test("the issue's example: my tune in C, put it in Bb", async () => {
  const r = await typed({ changes: "Dm7 G7 | Cmaj7 | Fm7 Bb7 | Ebmaj7", from_key: "C", key: "Bb" });
  assert.equal(r.found, true);
  assert.equal(r.key, "Bb major");
  assert.equal(r.from_key, "C major");
  assert.equal(r.transposed, true);
  assert.equal(r.bars, 4);
  assert.deepEqual(r.layout.bars.map((b) => b.c.join(" ")), ["Cm7 F7", "Bbmaj7", "Ebm7 Ab7", "Dbmaj7"]);
  assert.match(r.chart_text, /\| Cm7 F7 \| Bbmaj7 \| Ebm7 Ab7 \| Dbmaj7 \|/);
  assert.equal(r.layout.bars[0].t, "4/4");
  assert.equal(r.layout.bars.at(-1).e, "Z");
});

test("every key from one input: each root moves by the same interval, quality untouched", async () => {
  const input = "Cmaj7 A7b9 | Dm7 G7 | Em7b5 A7 | Dm7/C G7sus4";
  const original = parseTypedChanges(input).bars.flat();
  for (const key of KEYS) {
    const r = await typed({ changes: input, from_key: "C", key });
    const out = chords(r);
    assert.equal(out.length, original.length, key);
    const shift = (pc(key) + 12) % 12;
    out.forEach((c, i) => {
      const [, root, quality] = c.match(/^([A-G][b#]?)(.*?)(?:\/[A-G][b#]?)?$/);
      const [, oRoot, oQuality] = original[i].match(/^([A-G][b#]?)(.*?)(?:\/[A-G][b#]?)?$/);
      assert.equal(pc(root), (pc(oRoot) + shift) % 12, `${key}: ${c}`);
      assert.equal(quality, oQuality, `${key}: ${c}`);
    });
    const bass = out.at(-2).split("/")[1];
    assert.equal(pc(bass), shift, `${key}: the slash bass moves too`);
  }
});

test("typed from a phone: ♭/♯ on the root and bass are read, not left in the chord", async () => {
  // The three traps from the research comment on #44.
  assert.deepEqual(chords(await typed({ changes: "F♯m7b5", from_key: "E", key: "D" })), ["Em7b5"]);
  assert.deepEqual(chords(await typed({ changes: "B♭7", from_key: "F", key: "F#" })), ["B7"]);
  assert.deepEqual(chords(await typed({ changes: "C7/G♭", from_key: "F", key: "Eb" })), ["Bb7/E"]);
});

test("jazz shorthand passes through as typed, in every key", async () => {
  for (const key of KEYS) {
    const out = chords(await typed({ changes: "C-7 | CΔ7 | Cø7 | C6/9 | C7#9 C7b13", from_key: "C", key }));
    assert.deepEqual(out.map((c) => c.replace(/^[A-G][b#]?/, "")), ["-7", "Δ7", "ø7", "6/9", "7#9", "7b13"], key);
  }
});

test("% repeats the bar and N.C. stays N.C.", async () => {
  const r = await typed({ changes: "C7 | % | N.C. | F7", from_key: "C", key: "F" });
  assert.deepEqual(r.layout.bars[1], { r: "%" });
  assert.deepEqual(r.layout.bars[2].c, ["N.C."]);
  assert.deepEqual(r.layout.bars[3].c, ["Bb7"]);
});

test("new lines count as bar lines; without key it stays in the key it was written in", async () => {
  const r = await typed({ changes: "| Dm7 | G7 |\n| Cmaj7 | Cmaj7 |", from_key: "C major" });
  assert.equal(r.bars, 4);
  assert.equal(r.transposed, false);
  assert.equal(r.key, "C major");
  const minor = await typed({ changes: "Cm7 | F7 | Bbmaj7", from_key: "G minor", key: "E" });
  assert.equal(minor.key, "E minor", "the changes keep from_key's mode");
});

test("anything unreadable refuses the whole chart, with a count and no echo", async () => {
  const cases = [
    ["Dm7/ | G7", 1], // dangling slash
    ["bb7 | c-7 | C7", 2], // lowercase roots: b could be a note or a flat
    ["% | C7", 1], // nothing to repeat yet
    ["C7 | <script>alert(1)</script>", 1],
    ["C7/x", 1],
    ["Cmaj7 Hmaj7", 1],
  ];
  for (const [changes, n] of cases) {
    const r = await typed({ changes, from_key: "C", key: "D" });
    assert.equal(r.found, false, changes);
    assert.equal(r.unreadable, n, changes);
    assert.equal("layout" in r || "chart_text" in r, false, "nothing comes back half-transposed");
    for (const bit of changes.split(/[\s|]+/).filter((t) => t.length > 2)) {
      assert.equal(r.message.includes(bit), false, `no echo: ${bit}`);
    }
  }
});

test("caps: length, bars, chords, chords per bar", async () => {
  const long = await runTool("chord_chart", { changes: "C7 | ".repeat(100), from_key: "C" });
  assert.equal(long.isError, true);
  const manyBars = await typed({ changes: Array(33).fill("C7").join(" | "), from_key: "C" });
  assert.equal(manyBars.found, false);
  assert.match(manyBars.message, /at most 32/);
  const crowded = await typed({ changes: "Dm7 G7 Cmaj7 A7 Dm7 G7", from_key: "C" });
  assert.equal(crowded.found, false);
  assert.match(crowded.message, /per bar/);
  const ok = await typed({ changes: Array(32).fill("C7 F7").join(" | "), from_key: "C" });
  assert.equal(ok.found, true);
  assert.equal(chords(ok).length, 64);
});

test("arguments: tune and changes together refused; missing from_key asks the user", async () => {
  const both = await runTool("chord_chart", { tune: "Autumn Leaves", changes: "C7", from_key: "C" });
  assert.equal(both.isError, true);
  const stray = await runTool("chord_chart", { tune: "Autumn Leaves", from_key: "C" });
  assert.equal(stray.isError, true);
  const neither = await runTool("chord_chart", {});
  assert.equal(neither.isError, true);
  const noKey = await typed({ changes: "Dm7 G7 | Cmaj7", key: "Bb" });
  assert.equal(noKey.found, false);
  assert.match(noKey.message, /Ask the user what key/);
  const badKey = await runTool("chord_chart", { changes: "C7", from_key: "Germany" });
  assert.equal(badKey.isError, true);
  assert.equal(JSON.stringify(badKey.result).includes("Germany"), false);
  for (const extra of [{ instrument: "Eb" }, { numerals: true }]) {
    const r = await typed({ changes: "C7", from_key: "C", ...extra });
    assert.equal(r.found, false, JSON.stringify(extra));
    assert.match(r.message, /concert key/);
  }
});

test("library charts still work, and the page/model split hides typed chords from the model", async () => {
  const lib = await typed({ tune: "Autumn Leaves", key: "A" });
  assert.equal(lib.found, true);
  assert.equal(lib.key, "A minor");
  const split = splitChartResult(await typed({ changes: "Dm7 G7 | Cmaj7", from_key: "C", key: "F" }));
  assert.equal(split.page.title, "Your changes");
  assert.equal(split.page.key, "F major");
  assert.equal("layout" in split.model || "chart_text" in split.model, false);
});

test("public /mcp: chord_chart takes changes", async () => {
  const req = new Request("https://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chord_chart", arguments: { changes: "Dm7 G7 | Cmaj7", from_key: "C", key: "Eb" } } }),
  });
  const res = await handleMcpHttp(req, { allowedOrigins: [], cors: {}, env: {} });
  const body = await res.json();
  assert.deepEqual(chords(body.result.structuredContent), ["Fm7", "Bb7", "Ebmaj7"]);
});
