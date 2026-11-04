// chord_chart `numerals: true` also marks the ii–V pairs, found in code (findTwoFives). Run from worker/: npm test
// The model gets only "into bIII (bars 1–2, …)" lines, never the chords, so it can say where the ii–Vs lead without garbling them.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, splitChartResult, findTwoFives, TOOLS } from "../src/tools.js";
import { handleMcpHttp } from "../src/mcp.js";

async function chart(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  return result;
}
const sec = (...bars) => [{ label: "A", bars }];

test("Autumn Leaves: ii–V into the relative major (bIII), then a minor ii–V home", async () => {
  const r = await chart({ tune: "Autumn Leaves", numerals: true });
  assert.deepEqual(r.two_fives[0], { bars: "1–2", chords: ["IVm7", "bVII7"], into: "bIII", resolves: true });
  assert.deepEqual(r.two_fives[1], { bars: "5–6", chords: ["IIm7b5", "V7"], into: "I", resolves: true });
  const { model } = splitChartResult(r);
  assert.deepEqual(model.two_fives, ["into bIII (bars 1–2, 9–10, 21–22)", "into I (bars 5–6, 13–14, 17–18, 25–26, 30)"]);
});

test("a ii–V inside one bar, and one that doesn't resolve", () => {
  // | Cmaj7 | Dm7 G7 | Em7 A7 | Fmaj7 |  in C: neither resolves (G7 goes to Em7, A7 to Fmaj7).
  assert.deepEqual(findTwoFives(sec("Cmaj7", "Dm7 G7", "Em7 A7", "Fmaj7"), "C"), [
    { bars: "2", chords: ["IIm7", "V7"], into: "I", resolves: false },
    { bars: "3", chords: ["IIIm7", "VI7"], into: "II", resolves: false },
  ]);
  assert.equal(findTwoFives(sec("Em7 A7", "Dm7"), "C")[0].resolves, true, "any quality on the target counts");
});

test("the qualities that count: m7/m9/m11/m7b5 into any dominant (alterations and sus too)", () => {
  for (const [ii, v] of [["Dm9", "G13"], ["Dm11", "G7sus"], ["Dm7b5", "G7b9"], ["Dm7", "G7alt"], ["Dm9b5", "G9"]]) {
    assert.equal(findTwoFives(sec(ii, v, "C6"), "C").length, 1, `${ii} ${v}`);
  }
  for (const [ii, v] of [["Dmaj7", "G7"], ["Dm7", "Gmaj7"], ["Dm7", "Gm7"], ["Dm6", "G7"], ["Dm7", "A7"], ["Dm7", "Db7"]]) {
    assert.equal(findTwoFives(sec(ii, v, "C6"), "C").length, 0, `${ii} ${v} is not a ii–V`);
  }
});

test("chromatic targets are spelled a fourth above the V (b vs # from the letters)", () => {
  // Ebm7 Ab7 in C points to Db (bII), not C#; F#m7b5 B7 in Ab points to E (#V, as chord_chart numbers Emaj7 there).
  assert.equal(findTwoFives(sec("Ebm7 Ab7", "Dbmaj7"), "C")[0].into, "bII");
  assert.equal(findTwoFives(sec("F#m7b5", "B7", "Emaj7"), "Ab")[0].into, "#V");
  assert.equal(findTwoFives(sec("Fm7 Bb7", "Ebmaj7"), "C")[0].into, "bIII");
});

test("across bar and section lines; the last chord leads back to the top (turnarounds resolve)", () => {
  const sections = [{ label: "A", bars: ["Fmaj7", "Gm7"] }, { label: "B", bars: ["C7", "Fmaj7", "Gm7 C7"] }];
  assert.deepEqual(findTwoFives(sections, "F"), [
    { bars: "2–3", chords: ["IIm7", "V7"], into: "I", resolves: true },
    { bars: "5", chords: ["IIm7", "V7"], into: "I", resolves: true },
  ]);
});

test("the same ii–V twice in a row counts once, over both bars", () => {
  assert.deepEqual(findTwoFives(sec("Dm7 G7", "Dm7 G7", "Cmaj7"), "C"), [{ bars: "1–2", chords: ["IIm7", "V7"], into: "I", resolves: true }]);
});

test("slash chords, N.C. and modal tunes", async () => {
  assert.equal(findTwoFives(sec("Dm7/C G7/B", "C"), "C").length, 1, "a slash bass doesn't hide the ii–V");
  assert.deepEqual(findTwoFives(sec("N.C.", "Dm7", "N.C.", "G7"), "C"), []);
  assert.deepEqual((await chart({ tune: "So What", numerals: true })).two_fives, [], "no ii–Vs in So What");
});

test("same in every key and for every instrument; only with numerals: true", async () => {
  const base = (await chart({ tune: "All the Things You Are", numerals: true })).two_fives;
  assert.ok(base.length >= 5);
  for (const key of ["C", "E", "Gb"]) for (const instrument of ["concert", "Bb", "Eb"]) {
    assert.deepEqual((await chart({ tune: "All the Things You Are", key, instrument, numerals: true })).two_fives, base);
  }
  assert.equal("two_fives" in (await chart({ tune: "Autumn Leaves" })), false);
  assert.equal("two_fives" in splitChartResult(await chart({ tune: "Autumn Leaves" })).model, false);
});

test("the model gets targets and bar numbers, not the chords; the note says to copy them", async () => {
  const { model, page } = splitChartResult(await chart({ tune: "Blue Bossa", numerals: true }));
  assert.deepEqual(model.two_fives, ["into I (bars 5–6, 13–14, 16)", "into bII (bars 9–10)"]);
  assert.ok(!/m7|7b9|maj7/.test(JSON.stringify(model.two_fives)), "no chord qualities reach the model");
  assert.match(model.note, /two_fives .*exactly as given/);
  assert.equal("two_fives" in page, false, "the page is unchanged in this slice");
  for (const line of model.two_fives) assert.ok(line.length < 60, line);
});

test("public /mcp: two_fives in structuredContent; chord_chart's definition is unchanged in size", async () => {
  const req = new Request("https://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chord_chart", arguments: { tune: "Solar", numerals: true } } }),
  });
  const body = await (await handleMcpHttp(req, { allowedOrigins: [], cors: {}, env: {} })).json();
  assert.deepEqual(body.result.structuredContent.two_fives.map((t) => t.into), ["IV", "bIII", "bII", "I"]);
  const t = TOOLS.find((x) => x.name === "chord_chart");
  assert.equal(Object.keys(t.inputSchema.properties).length, 4, "no new argument");
});
