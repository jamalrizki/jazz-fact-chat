// Key names a caller passes to chord_chart and find_tunes. Run from worker/: npm test
// The whole key string must be read, so "B-flat" means Bb (not B) and junk is refused, not half-read.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, parseKeyArg } from "../src/tools.js";

async function chart(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.found, true);
  return result;
}

const firstChord = (r) => r.layout.bars.find((b) => b.c)?.c[0];

test("chord_chart: every way of writing B-flat gives Bb, never B", async () => {
  for (const key of ["Bb", "bb", "B♭", "B flat", "B-flat", "b-flat", "B Flat", "Bb minor", "Bbm", "B-flat minor", "Bb-"]) {
    const r = await chart({ tune: "Autumn Leaves", key });
    assert.equal(r.key, "Bb minor", key);
    assert.equal(firstChord(r), "Ebm7", key); // Cm7 in G minor is Ebm7 in Bb minor
  }
});

test("chord_chart: hyphenated and spelled-out accidentals on other keys", async () => {
  assert.equal((await chart({ tune: "Satin Doll", key: "E-flat" })).key, "Eb major");
  assert.equal((await chart({ tune: "Satin Doll", key: "F-sharp" })).key, "F# major");
  assert.equal((await chart({ tune: "Satin Doll", key: "F sharp major" })).key, "F# major");
  assert.equal((await chart({ tune: "Satin Doll", key: "B natural" })).key, "B major");
  assert.equal((await chart({ tune: "Satin Doll", key: "B" })).key, "B major");
  // with an instrument, key stays the concert key: Satin Doll in E-flat for Bb reads in F
  const horn = await chart({ tune: "Satin Doll", key: "E-flat", instrument: "Bb" });
  assert.equal(horn.key, "F major");
  assert.equal(horn.concert_key, "Eb major");
});

test("chord_chart: a key it can't read is refused, without echoing the caller's text", async () => {
  for (const key of ["Germany", "H", "Bx", "C dorian", "B-natural7", "Eb for alto", "<b>F</b>"]) {
    const { result, isError } = await runTool("chord_chart", { tune: "Autumn Leaves", key });
    assert.equal(isError, true, key);
    assert.ok(!result.error.includes(key), key);
  }
});

test("find_tunes: B-flat and E flat are read as keys", async () => {
  const titles = async (key) => {
    const { result } = await runTool("find_tunes", { key });
    return (result.tunes || []).map((t) => t.title);
  };
  assert.deepEqual(await titles("B-flat"), ["Rhythm Changes"]);
  assert.deepEqual(await titles("B-flat major"), ["Rhythm Changes"]);
  assert.deepEqual(await titles("A-flat"), ["All the Things You Are"]);
});

test("parseKeyArg: names, pitch classes and modes", () => {
  assert.deepEqual(parseKeyArg("B-flat"), { pc: 10, name: "Bb", mode: null });
  assert.deepEqual(parseKeyArg("c# minor"), { pc: 1, name: "C#", mode: "minor" });
  assert.deepEqual(parseKeyArg("C-"), { pc: 0, name: "C", mode: "minor" });
  assert.deepEqual(parseKeyArg("Eb major"), { pc: 3, name: "Eb", mode: "major" });
  assert.equal(parseKeyArg("Cb").pc, 11);
  // "B-" is B minor (jazz shorthand), not a half-typed "B-flat"
  assert.deepEqual(parseKeyArg("B-"), { pc: 11, name: "B", mode: "minor" });
  assert.equal(parseKeyArg("Germany"), null);
});
