// Tests for chord_chart similar: true (other library tunes on the same changes).
// The matcher is pure code, so most tests use small made-up charts defined here;
// the last few run the real tool against the 12-tune sample library. Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOLS, qualityClass, chartFingerprint, sameChanges, splitChartResult } from "../src/tools.js";
import { handleRpc } from "../src/mcp.js";

// A made-up 32-bar AABA in Bb, written as four 8-bar sections.
const A = ["Bbmaj7", "G7", "Cm7", "F7", "Dm7", "G7", "Cm7 F7", "Bbmaj7"];
const B = ["D7", "D7", "G7", "G7", "C7", "C7", "F7", "F7"];
const aaba = (title, a = A, b = B, key = "Bb") => ({
  title, composer: "Test", key, mode: "major", form: "AABA, 32 bars",
  sections: [{ label: "A", bars: a }, { label: "A", bars: a }, { label: "B", bars: b }, { label: "A", bars: a }],
});
const blues = (title, bars, key = "F", mode = "major") => ({
  title, composer: "Test", key, mode, form: "12-bar blues", sections: [{ label: "", bars }],
});
const F_BLUES = ["F7", "Bb7", "F7", "Cm7 F7", "Bb7", "Bdim7", "F7", "D7", "Gm7", "C7", "F7 D7", "Gm7 C7"];

test("quality classes: extensions and alterations don't change the class", () => {
  const cases = {
    maj: ["", "maj7", "maj9", "M7", "6", "6/9", "add9", "6add9", "aug", "maj7#11", "5"],
    min: ["m", "m7", "m6", "m9", "m11", "mMaj7", "-7", "min7", "m6/9"],
    dom: ["7", "9", "13", "7b9", "7#11", "7alt", "7#5", "7sus4", "sus4", "13/E"],
    hdim: ["m7b5", "m9b5", "ø7"],
    dim: ["dim", "dim7", "o7"],
  };
  for (const [want, qs] of Object.entries(cases)) for (const q of qs) assert.equal(qualityClass(q), want, `C${q}`);
});

test("fingerprint ignores the key: the same tune in F and in Bb scores every bar", () => {
  const inF = aaba("Tune in F", A.map((c) => c.replace(/^Bb/, "F").replace(/^G7/, "D7").replace(/^Cm7 F7/, "Gm7 C7").replace(/^Cm7/, "Gm7").replace(/^F7/, "C7").replace(/^Dm7/, "Am7")),
    B.map((c) => ({ D7: "A7", G7: "D7", C7: "G7", F7: "C7" })[c]), "F");
  const inBb = aaba("Tune in Bb");
  assert.deepEqual(chartFingerprint(inF), chartFingerprint(inBb));
  assert.equal(chartFingerprint(inBb)[0], "0:maj");
  assert.equal(chartFingerprint(inBb)[1], "9:dom");
  assert.deepEqual(sameChanges(inBb, [inBb, inF]), [{ title: "Tune in F", key: "F major", matching_bars: 32, bars: 32 }]);
});

test("extensions don't block a match (C7 vs C9 blues)", () => {
  const plain = blues("Plain Blues", F_BLUES);
  const fancy = blues("Fancy Blues", F_BLUES.map((b) => b.replace(/7\b/g, "9").replace("Bdim9", "Bdim7")));
  assert.notDeepEqual(plain.sections, fancy.sections);
  assert.equal(sameChanges(plain, [plain, fancy])[0].matching_bars, 12);
});

test("only the same bar count and mode are compared, and a tune never lists itself", () => {
  const tune = blues("Blues", F_BLUES);
  const longer = blues("Blues With Tag", [...F_BLUES, "F7", "F7", "F7", "F7"]);
  const minorCopy = blues("Minor Copy", F_BLUES, "F", "minor");
  const sameTitle = blues("Blues", F_BLUES); // a duplicate entry of the same tune
  assert.deepEqual(sameChanges(tune, [tune, longer, minorCopy, sameTitle]), []);
});

test("threshold: 24 of 32 bars (a new bridge) is in, 23 of 32 is out", () => {
  const rhythm = aaba("Rhythm");
  const newBridge = aaba("New Bridge", A, ["Fm7", "Bb7", "Ebmaj7", "Ebmaj7", "Abm7", "Db7", "Gbmaj7", "Cm7 F7"]);
  const lastA = A.map((c, i) => (i === 7 ? "Ebmaj7" : c)); // one more bar differs, in the last A only
  const tooFar = { ...aaba("Too Far", A, newBridge.sections[2].bars), sections: [...newBridge.sections.slice(0, 3), { label: "A", bars: lastA }] };
  assert.deepEqual(sameChanges(rhythm, [rhythm, newBridge, tooFar]), [{ title: "New Bridge", key: "Bb major", matching_bars: 24, bars: 32 }]);
});

test("best first, at most 5", () => {
  const tune = aaba("Original");
  const copies = ["G", "F", "E", "D", "C", "B", "A"].map((x) => aaba(`Copy ${x}`));
  const weaker = aaba("Aaa Weaker", A, ["Fm7", "Bb7", "Ebmaj7", "Ebmaj7", "Abm7", "Db7", "Gbmaj7", "F7"]);
  const r = sameChanges(tune, [weaker, ...copies, tune]);
  assert.equal(r.length, 5);
  assert.deepEqual(r.map((x) => x.title), ["Copy A", "Copy B", "Copy C", "Copy D", "Copy E"]); // full matches beat the 25/32 one
  assert.ok(r.every((x) => x.matching_bars === 32));
});

test("unreadable bars or keys never match", () => {
  const nc = blues("No Chords", F_BLUES.map(() => "N.C."));
  const nc2 = blues("No Chords Either", F_BLUES.map(() => "N.C."));
  assert.deepEqual(sameChanges(nc, [nc, nc2]), []);
  const badKey = { ...blues("Bad Key", F_BLUES), key: "?" };
  assert.equal(chartFingerprint(badKey), null);
  assert.deepEqual(sameChanges(badKey, [badKey, blues("Blues", F_BLUES)]), []);
});

/* ---------- through the real tool, against the sample library ---------- */

test("chord_chart similar: true adds a computed list (empty on the sample), and only when asked", async () => {
  const yes = await runTool("chord_chart", { tune: "Rhythm Changes", similar: true });
  assert.equal(yes.isError, false);
  assert.deepEqual(yes.result.similar, []); // no sample chart shares its changes
  const no = await runTool("chord_chart", { tune: "Rhythm Changes" });
  assert.equal(no.result.similar, undefined);
  assert.equal((await runTool("chord_chart", { tune: "Rhythm Changes", similar: false })).result.similar, undefined);
  // transposing or a horn key doesn't change the comparison
  const tenor = await runTool("chord_chart", { tune: "Rhythm Changes", similar: true, instrument: "Bb", key: "F" });
  assert.deepEqual(tenor.result.similar, []);
});

test("similar must be a boolean, and the error never echoes the caller's text", async () => {
  for (const similar of ["yes", 1, "true", {}, ["x"]]) {
    const r = await runTool("chord_chart", { tune: "Solar", similar });
    assert.equal(r.isError, true, JSON.stringify(similar));
    assert.doesNotMatch(r.result.error, /yes|"true"/);
  }
});

test("the model's summary carries the matches and a list-only-these note", async () => {
  const { result } = await runTool("chord_chart", { tune: "Rhythm Changes", similar: true });
  const empty = splitChartResult(result).model;
  assert.deepEqual(empty.similar, []);
  assert.match(empty.note, /never name tunes on the same changes from memory/);
  const withMatches = splitChartResult({ ...result, similar: [{ title: "X", key: "Bb major", matching_bars: 26, bars: 32 }] }).model;
  assert.equal(withMatches.similar[0].title, "X");
  assert.match(withMatches.note, /Name only these/);
  const plain = splitChartResult((await runTool("chord_chart", { tune: "Rhythm Changes" })).result).model;
  assert.equal(plain.similar, undefined);
  assert.doesNotMatch(plain.note, /similar/);
});

test("definition: similar is an optional boolean, and adds under 100 characters", async () => {
  const t = TOOLS.find((x) => x.name === "chord_chart");
  const s = t.inputSchema.properties.similar;
  assert.equal(s.type, "boolean");
  assert.ok(!t.inputSchema.required.includes("similar"));
  assert.ok(JSON.stringify({ similar: s }).length < 100);
  const list = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(list.result.tools.find((x) => x.name === "chord_chart").inputSchema.properties.similar.type, "boolean");
});
