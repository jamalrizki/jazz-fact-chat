// chord_chart `scales: true`: one chord-scale per distinct chord in a tune. Run from worker/: npm test
// Note names must come from the same code as chord_voicings scale: true, so the tests compare against it.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOLS, splitChartResult, tuneScales } from "../src/tools.js";
import { chordVoicings } from "../src/voicings.js";

async function chart(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.found, true);
  return result;
}

// Distinct chord symbols of a chart result, in order of first appearance (section labels dropped).
const distinctChords = (r) => [...new Set(r.chart_text.split("\n").slice(1).flatMap((l) => l.slice(l.indexOf("|")).split(/[\s|]+/)).filter((c) => /^[A-G]/.test(c)))];

test("Autumn Leaves: one entry per distinct chord, in order, matching chord_voicings", async () => {
  const r = await chart({ tune: "Autumn Leaves", scales: true });
  assert.deepEqual(r.scales.map((s) => s.chord), distinctChords(r));
  assert.equal(r.more_chords, undefined);
  for (const s of r.scales) {
    const v = chordVoicings({ chord: s.chord, scale: true }).scale;
    assert.equal(s.notes, v.text, s.chord);
    assert.ok(s.scale.endsWith(v.name), s.chord);
    assert.equal(s.scale.split(" ")[0], v.text.split(" ")[0], `${s.chord}: scale named from its root`);
  }
  const by = Object.fromEntries(r.scales.map((s) => [s.chord, s]));
  assert.equal(by.Cm7.scale, "C Dorian");
  assert.equal(by.Cm7.notes, "C D E♭ F G A B♭");
  assert.equal(by.Am7b5.scale, "A Locrian");
  assert.equal(by.Bbmaj7.notes, "B♭ C D E♭ F G A");
});

test("transposed and instrument charts give the scales of the chords as written", async () => {
  for (const args of [{ tune: "Blue Bossa", key: "D" }, { tune: "Autumn Leaves", instrument: "Eb" }, { tune: "Satin Doll", key: "F", instrument: "Bb" }]) {
    const r = await chart({ ...args, scales: true });
    assert.equal(r.transposed, true);
    assert.deepEqual(r.scales.map((s) => s.chord), distinctChords(r), JSON.stringify(args));
    for (const s of r.scales) assert.equal(s.notes, chordVoicings({ chord: s.chord, scale: true }).scale.text);
  }
  const alto = await chart({ tune: "Autumn Leaves", instrument: "Eb", scales: true });
  assert.equal(alto.scales[0].chord, "Am7"); // Cm7 concert, read a major 6th up
  assert.equal(alto.scales[0].scale, "A Dorian");
});

test("cap at 16 distinct chords, with more_chords for the rest", async () => {
  const r = await chart({ tune: "All the Things You Are", scales: true });
  const all = distinctChords(r);
  assert.ok(all.length > 16);
  assert.equal(r.scales.length, 16);
  assert.deepEqual(r.scales.map((s) => s.chord), all.slice(0, 16));
  assert.equal(r.more_chords, all.length - 16);
});

test("no clear default -> scale: null; unreadable symbols are skipped, not guessed", () => {
  const { scales } = tuneScales([{ label: "A", bars: ["Cdim Cm7", "Xyz7 C7#9 Cdim", "N.C. Cm7 C9sus13!"] }]);
  assert.deepEqual(scales.map((s) => s.chord), ["Cdim", "Cm7", "C7#9"]);
  assert.deepEqual(scales[0], { chord: "Cdim", scale: null });
  assert.equal(scales[2].scale, "C half-whole diminished");
});

test("scales is off by default; bad values are rejected without echoing them", async () => {
  const plain = await chart({ tune: "Autumn Leaves" });
  assert.equal(plain.scales, undefined);
  const off = await chart({ tune: "Autumn Leaves", scales: false });
  assert.equal(off.scales, undefined);
  for (const bad of ["true", "yes<script>", 1, [true], { a: 1 }]) {
    const { result, isError } = await runTool("chord_chart", { tune: "Autumn Leaves", scales: bad });
    assert.equal(isError, true, JSON.stringify(bad));
    assert.ok(!result.error.includes("script") && !result.error.includes("yes"));
  }
});

test("the model's summary carries the scales but never the chart's bars", async () => {
  const r = await chart({ tune: "All the Things You Are", scales: true });
  const { model, page } = splitChartResult(r);
  assert.deepEqual(model.scales, r.scales);
  assert.equal(model.more_chords, r.more_chords);
  assert.ok(!("chart_text" in model) && !("layout" in model));
  assert.match(model.note, /exactly as given in scales/);
  assert.ok(!("scales" in page));
  const plain = splitChartResult(await chart({ tune: "Autumn Leaves" })).model;
  assert.ok(!("scales" in plain));
  assert.match(plain.note, /Do not write out the chords/);
});

test("chord_chart definition: scales is an optional boolean", () => {
  const def = TOOLS.find((t) => t.name === "chord_chart");
  assert.equal(def.inputSchema.properties.scales.type, "boolean");
  assert.deepEqual(def.inputSchema.required, ["tune"]);
});
