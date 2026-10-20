// chord_chart `instrument`: charts written for Bb, Eb and F players. Run from worker/: npm test
// The interval math is done in code; these tests pin it down for every concert key.

import test from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOLS, splitChartResult } from "../src/tools.js";

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pc = (name) => (PC[name[0]] + (name[1] === "#" ? 1 : name[1] === "b" ? -1 : 0) + 12) % 12;
const rootPc = (chord) => pc(chord.match(/^[A-G][b#]?/)[0]);
const keyRoot = (label) => label.split(" ")[0];
const OFFSET = { Bb: 2, Eb: 9, F: 7 };
const CONCERT_KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

async function chart(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.found, true);
  return result;
}

const chords = (r) => r.layout.bars.flatMap((b) => b.c || []).filter((c) => /^[A-G]/.test(c));

test("the bandstand cases: Autumn Leaves and Blue Bossa", async () => {
  const expect = { Bb: "A minor", Eb: "E minor", F: "D minor" };
  for (const [instrument, key] of Object.entries(expect)) {
    const r = await chart({ tune: "Autumn Leaves", instrument });
    assert.equal(r.key, key, instrument);
    assert.equal(r.concert_key, "G minor");
    assert.equal(r.instrument, instrument);
    assert.equal(r.transposed, true);
  }
  const bossa = await chart({ tune: "Blue Bossa", instrument: "Bb" });
  assert.equal(bossa.key, "D minor");
  assert.equal(bossa.concert_key, "C minor");
  // key is the concert key; instrument shifts it: Satin Doll in F concert for alto reads in D.
  const doll = await chart({ tune: "Satin Doll", key: "F", instrument: "Eb" });
  assert.equal(doll.key, "D major");
  assert.equal(doll.concert_key, "F major");
});

test("every instrument x every concert key: written = concert + fixed interval, every chord moves the same", async () => {
  for (const tune of ["Autumn Leaves", "Satin Doll"]) {
    for (const key of CONCERT_KEYS) {
      const concert = await chart({ tune, key });
      const concertChords = chords(concert);
      assert.ok(concertChords.length > 0);
      for (const [instrument, offset] of Object.entries(OFFSET)) {
        const r = await chart({ tune, key, instrument });
        const label = `${tune} in ${key} for ${instrument}`;
        assert.equal(r.concert_key, concert.key, label);
        assert.equal(pc(keyRoot(r.key)), (pc(key) + offset) % 12, label);
        assert.equal(r.key.split(" ")[1], concert.key.split(" ")[1], `${label}: mode kept`);
        const written = chords(r);
        assert.equal(written.length, concertChords.length, `${label}: no bars dropped`);
        written.forEach((c, i) => {
          assert.equal((rootPc(c) - rootPc(concertChords[i]) + 12) % 12, offset, `${label}: ${concertChords[i]} -> ${c}`);
          // Only the root (and bass) change; the quality stays as written.
          assert.equal(c.replace(/^[A-G][b#]?/, "").replace(/\/[A-G][b#]?$/, ""),
            concertChords[i].replace(/^[A-G][b#]?/, "").replace(/\/[A-G][b#]?$/, ""), label);
        });
        // The plain-text chart moves with it.
        assert.ok(r.chart_text.includes(`· ${r.key} ·`), label);
      }
    }
  }
});

test("concert (or no instrument) is unchanged and adds no fields", async () => {
  const plain = await chart({ tune: "Autumn Leaves" });
  for (const instrument of ["concert", "", null, undefined]) {
    const r = await chart({ tune: "Autumn Leaves", instrument });
    assert.deepEqual(r, plain);
  }
  assert.equal(plain.key, "G minor");
  assert.equal("instrument" in plain, false);
  assert.equal("concert_key" in plain, false);
});

test("bad instrument values are rejected without echoing the caller's text", async () => {
  for (const instrument of ["alto <script>", "bb", "Bb ", "tenor", 7, true, ["Bb"], { x: 1 }, "toString", "__proto__"]) {
    const { result, isError } = await runTool("chord_chart", { tune: "Autumn Leaves", instrument });
    assert.equal(isError, true, String(instrument));
    assert.match(result.error, /must be one of: concert, Bb, Eb, F/);
    assert.ok(!result.error.includes("script") && !result.error.includes("tenor"));
  }
  const { result, isError } = await runTool("chord_chart", { tune: "Autumn Leaves", key: "H<b>", instrument: "Bb" });
  assert.equal(isError, true);
  assert.ok(!result.error.includes("H<b>"), "bad key text is not echoed either");
});

test("the page header says which instrument; the model gets both keys", async () => {
  const r = await chart({ tune: "Autumn Leaves", instrument: "Eb" });
  const { page, model } = splitChartResult(r);
  assert.equal(page.key, "E minor, for Eb instruments");
  assert.equal(model.key, "E minor");
  assert.equal(model.concert_key, "G minor");
  assert.equal(model.instrument, "Eb");
  assert.match(model.note, /written key/);
  assert.equal("chart_text" in model || "layout" in model, false, "the model never sees the chords");

  const plain = splitChartResult(await chart({ tune: "Autumn Leaves" }));
  assert.equal(plain.page.key, "G minor");
  assert.equal("concert_key" in plain.model, false);
});

test("chord_chart definition: instrument is an enum, and the definition stays small", () => {
  const t = TOOLS.find((x) => x.name === "chord_chart");
  assert.deepEqual(t.inputSchema.properties.instrument.enum, ["concert", "Bb", "Eb", "F"]);
  assert.deepEqual(t.inputSchema.required, ["tune"]);
  assert.ok(JSON.stringify({ d: t.description, s: t.inputSchema }).length < 1300, "sent with every request: keep it small");
});
