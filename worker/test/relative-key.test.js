// chord_chart: a key asked for with the other mode means the relative key. Run from worker/: npm test
// "Autumn Leaves in Bb major" is the G minor chart (same key signature), not Bb minor;
// "Satin Doll in A minor" is C major, not A major. Worked out in code, and the result says so.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, relativeKey, parseKeyArg, splitChartResult } from "../src/tools.js";

async function chart(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.found, true);
  return result;
}

const firstChord = (r) => r.layout.bars.find((b) => b.c)?.c[0];

test("minor tune asked for in a major key: its relative minor", async () => {
  const r = await chart({ tune: "Autumn Leaves", key: "Bb major" });
  assert.equal(r.key, "G minor"); // Bb major's relative minor is the tune's own key
  assert.equal(r.transposed, false);
  assert.equal(firstChord(r), "Cm7");
  assert.match(r.key_note, /Bb major was read as its relative minor key, G minor/);

  const blue = await chart({ tune: "Blue Bossa", key: "F major" });
  assert.equal(blue.key, "D minor");
  assert.equal(firstChord(blue), "Dm7"); // Cm7 in C minor is Dm7 in D minor
});

test("major tune asked for in a minor key: its relative major", async () => {
  const r = await chart({ tune: "Satin Doll", key: "A minor" });
  assert.equal(r.key, "C major");
  assert.equal(r.transposed, false);
  assert.ok(r.key_note.includes("A minor was read as its relative major key, C major"));
  assert.equal((await chart({ tune: "Satin Doll", key: "E minor" })).key, "G major");
  assert.equal((await chart({ tune: "Satin Doll", key: "C-" })).key, "Eb major"); // C- is jazz shorthand for C minor
});

test("the relative key is spelled from the key signature asked for", async () => {
  assert.equal((await chart({ tune: "Autumn Leaves", key: "Db major" })).key, "Bb minor"); // 5 flats, not A# minor
  assert.equal((await chart({ tune: "Autumn Leaves", key: "E major" })).key, "C# minor");
  assert.equal((await chart({ tune: "Autumn Leaves", key: "C# major" })).key, "A# minor"); // 7 sharps
  assert.equal((await chart({ tune: "Satin Doll", key: "Eb minor" })).key, "Gb major");
  assert.equal((await chart({ tune: "Satin Doll", key: "D# minor" })).key, "F# major");
  assert.equal((await chart({ tune: "Satin Doll", key: "F# minor" })).key, "A major");
});

test("no mode word, or the same mode: unchanged, and no key_note", async () => {
  for (const key of ["Bb", "Bb minor", "B-flat", "Bb-"]) {
    const r = await chart({ tune: "Autumn Leaves", key });
    assert.equal(r.key, "Bb minor", key);
    assert.equal(r.key_note, undefined, key);
  }
  const doll = await chart({ tune: "Satin Doll", key: "F major" });
  assert.equal(doll.key, "F major");
  assert.equal(doll.key_note, undefined);
});

test("with an instrument, the relative key is the concert key", async () => {
  // Bb major → G minor concert → A minor for a Bb instrument.
  const r = await chart({ tune: "Autumn Leaves", key: "Bb major", instrument: "Bb" });
  assert.equal(r.concert_key, "G minor");
  assert.equal(r.key, "A minor");
  assert.ok(r.key_note);
});

test("with numerals, the numbers are counted from the relative key's tonic", async () => {
  const r = await chart({ tune: "Satin Doll", key: "E minor", numerals: true });
  assert.equal(r.numerals_from, "G");
  assert.equal(r.key, "G major");
});

test("key_note reaches the model and never repeats the caller's text", async () => {
  const r = await chart({ tune: "Autumn Leaves", key: "b-flat major" });
  assert.ok(!r.key_note.includes("b-flat"));
  const { model } = splitChartResult(r);
  assert.equal(model.key_note, r.key_note);
  assert.match(model.note, /key_note/);
  const plain = splitChartResult(await chart({ tune: "Autumn Leaves" })).model;
  assert.equal(plain.key_note, undefined);
  assert.ok(!plain.note.includes("key_note"));
});

test("relativeKey: the pure function", () => {
  assert.deepEqual(relativeKey(parseKeyArg("Bb major"), "minor"), { pc: 7, name: "G" });
  assert.deepEqual(relativeKey(parseKeyArg("A minor"), "major"), { pc: 0, name: "C" });
  assert.deepEqual(relativeKey(parseKeyArg("Gb major"), "minor"), { pc: 3, name: "Eb" });
  assert.deepEqual(relativeKey(parseKeyArg("G# minor"), "major"), { pc: 11, name: "B" });
  assert.equal(relativeKey(parseKeyArg("Bb"), "minor"), null);
  assert.equal(relativeKey(parseKeyArg("Bb minor"), "minor"), null);
  assert.equal(relativeKey(parseKeyArg("Bb major"), undefined), null);
});
