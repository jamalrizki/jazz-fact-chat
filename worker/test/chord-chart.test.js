// Tests for chord_chart: transposition, key spelling and title matching.
// Written against relationships (transposed vs. untransposed output of the same tool), not
// hard-coded chords, so they pass with the sample library AND with a full imported one.
// Run from worker/:  node --test test/chord-chart.test.js
// (On a fresh clone, run `node scripts/ensure-charts.mjs` once first to copy in the sample library.)
import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/tools.js";

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (letter, acc) => (PC[letter] + (acc === "#" ? 1 : acc === "b" ? -1 : 0) + 12) % 12;

/** Every chord symbol in a result, in order: from chart_text and from the written layout. */
function chords(result) {
  const fromText = result.chart_text
    .split("\n")
    .slice(1)
    .flatMap((line) => line.split("|").slice(1).join(" ").split(/\s+/))
    .filter(Boolean);
  const fromLayout = result.layout.bars.flatMap((b) => b.c || []);
  return { fromText, fromLayout };
}

/** Root and bass of a chord symbol, e.g. "Bbm7/F" -> [{letter:"B",acc:"b"}, {letter:"F",acc:""}]. */
function notesOf(chord) {
  const m = chord.match(/^([A-G])([b#]?)(.*?)(?:\/([A-G])([b#]?))?$/);
  if (!m) return [];
  const out = [{ letter: m[1], acc: m[2] }];
  if (m[4]) out.push({ letter: m[4], acc: m[5] });
  return out;
}

const chart = async (tune, key) => {
  const { result, isError } = await runTool("chord_chart", key === undefined ? { tune } : { tune, key });
  assert.equal(isError, false, `chord_chart failed for ${tune} ${key}`);
  return result;
};

const FLAT_KEYS = { major: ["F", "Bb", "Eb", "Ab", "Db", "Gb"], minor: ["D", "G", "C", "F", "Bb", "Eb"] };
const SHARP_KEYS = { major: ["G", "D", "A", "E", "B", "F#"], minor: ["E", "B", "F#", "C#", "G#"] };

for (const tune of ["Satin Doll", "Autumn Leaves"]) {
  test(`${tune}: every key moves every chord by the same interval, bars intact`, async () => {
    const base = await chart(tune);
    assert.equal(base.found, true);
    const baseKeyPc = pcOf(base.key[0], base.key[1] === "#" || base.key[1] === "b" ? base.key[1] : "");
    const { fromText: baseText, fromLayout: baseLayout } = chords(base);
    for (const key of ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]) {
      const r = await chart(tune, key);
      const shift = (pcOf(key[0], key[1] || "") - baseKeyPc + 12) % 12;
      const { fromText, fromLayout } = chords(r);
      assert.equal(r.bars, base.bars);
      assert.equal(fromText.length, baseText.length);
      assert.equal(fromLayout.length, baseLayout.length);
      for (const [orig, moved] of [[baseText, fromText], [baseLayout, fromLayout]]) {
        orig.forEach((c, i) => {
          const a = notesOf(c), b = notesOf(moved[i]);
          assert.equal(b.length, a.length, `${c} -> ${moved[i]}`);
          a.forEach((n, j) => assert.equal(pcOf(b[j].letter, b[j].acc), (pcOf(n.letter, n.acc) + shift) % 12, `${c} -> ${moved[i]} in ${key}`));
          // The quality (m7b5, 7#11, 6/9, ...) is never touched.
          assert.equal(moved[i].replace(/^[A-G][b#]?/, "").replace(/\/[A-G][b#]?$/, ""), c.replace(/^[A-G][b#]?/, "").replace(/\/[A-G][b#]?$/, ""));
        });
      }
    }
  });

  test(`${tune}: flat keys use only flats, sharp keys only sharps`, async () => {
    const mode = (await chart(tune)).key.endsWith("minor") ? "minor" : "major";
    for (const [keys, forbidden] of [[FLAT_KEYS[mode], "#"], [SHARP_KEYS[mode], "b"]]) {
      for (const key of keys) {
        const r = await chart(tune, key);
        if (!r.transposed) continue; // the chart's own key is printed as written
        assert.equal(r.key, `${key} ${mode}`);
        for (const c of chords(r).fromText) {
          for (const n of notesOf(c)) assert.notEqual(n.acc, forbidden, `${c} in ${key} ${mode}`);
        }
      }
    }
  });
}

test("awkward keys get their usual spelling, and the result says so", async () => {
  const cases = [
    ["Satin Doll", "C#", "Db major"],
    ["Satin Doll", "Cb", "B major"], // used to print a "B major" header over flat chords
    ["Satin Doll", "D#", "Eb major"],
    ["Satin Doll", "E#", "F major"],
    ["Autumn Leaves", "Gb", "F# minor"],
    ["Autumn Leaves", "Db", "C# minor"],
    ["Autumn Leaves", "A#m", "Bb minor"],
    ["Autumn Leaves", "D# minor", "Eb minor"],
  ];
  for (const [tune, key, want] of cases) {
    const r = await chart(tune, key);
    assert.equal(r.key, want, `${tune} in ${key}`);
    assert.match(r.key_note, new RegExp(`written in ${want}`));
    // Spelling matches the header: a flat-key header never sits over sharp chords, and vice versa.
    const forbidden = want.includes("b ") || ["F major", "Bb minor", "Eb minor"].includes(want) ? "#" : "b";
    for (const c of chords(r).fromText) for (const n of notesOf(c)) assert.notEqual(n.acc, forbidden, `${c} in ${want}`);
  }
});

test("keys spelled the usual way carry no key_note; both spellings of F#/Gb major and G#/Ab minor are kept", async () => {
  for (const [tune, key, want] of [
    ["Satin Doll", "Db", "Db major"], ["Satin Doll", "F#", "F# major"], ["Satin Doll", "Gb", "Gb major"],
    ["Autumn Leaves", "G#", "G# minor"], ["Autumn Leaves", "Ab", "Ab minor"], ["Autumn Leaves", "C#", "C# minor"],
  ]) {
    const r = await chart(tune, key);
    assert.equal(r.key, want);
    assert.equal(r.key_note, undefined);
  }
});

test("key arguments: symbols, words and case all read the same", async () => {
  for (const key of ["Bb", "bb", "B♭", "B flat", "Bbm", "Bb minor"]) {
    assert.equal((await chart("Satin Doll", key)).key, "Bb major", key);
  }
  for (const key of ["F#", "f#", "F♯", "F sharp"]) {
    assert.equal((await chart("Satin Doll", key)).key, "F# major", key);
  }
});

test("bad keys are rejected without echoing the caller's text", async () => {
  for (const key of ["H", "<script>", "?", "x".repeat(21), 7]) {
    const { result, isError } = await runTool("chord_chart", { tune: "Satin Doll", key });
    assert.equal(isError, true, String(key));
    if (typeof key === "string") assert.ok(!result.error.includes(key), `echoed ${key}`);
  }
});

test("title matching: case, punctuation, 'the', and request filler", async () => {
  for (const q of ["autumn leaves", "AUTUMN LEAVES", "Autumn Leaves chords", "autumn leaves in bb", "the autumn leaves", "Autumn Leaves!"]) {
    const r = await chart(q);
    assert.equal(r.found, true, q);
    assert.equal(r.title, "Autumn Leaves", q);
  }
  assert.equal((await chart("satin")).title, "Satin Doll"); // starts-with
});

test("misses: no chart invented, suggestions only, caller text not echoed", async () => {
  const r = await chart("Zzyzx Quuxle Blorp");
  assert.equal(r.found, false);
  assert.ok(Array.isArray(r.suggestions));
  assert.ok(!r.message.includes("Zzyzx"));
  assert.equal(r.chart_text, undefined);
  assert.equal((await chart("the")).found, false); // only a stop-word: nothing to match
});
