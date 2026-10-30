// find_tunes `instrument`: "bossas for alto" lists each tune's written key for that horn.
// The written key is computed in code, the same way chord_chart does it. Run from worker/: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/tools.js";
import { handleRpc } from "../src/mcp.js";

const find = async (args) => {
  const { result, isError } = await runTool("find_tunes", args);
  return { ...result, isError };
};

test("bandstand cases: concert key stays, written key is added", async () => {
  const alto = await find({ style: "bossa", instrument: "Eb" });
  assert.equal(alto.instrument, "Eb");
  assert.deepEqual(alto.tunes, [{ title: "Blue Bossa", key: "C minor", written_key: "A minor", form: alto.tunes[0].form, style: "Bossa Nova" }]);
  assert.match(alto.note, /key is concert/);
  assert.match(alto.note, /instrument: "Eb"/);

  const tenor = await find({ composer: "Miles Davis", instrument: "Bb" });
  assert.deepEqual(tenor.tunes.map((t) => [t.title, t.key, t.written_key]), [
    ["So What", "D minor", "E minor"],
    ["Solar", "C minor", "D minor"],
  ]);
  const horn = await find({ key: "Ab", instrument: "F" });
  assert.deepEqual(horn.tunes.map((t) => t.written_key), ["Eb major"]);
});

test("written_key always agrees with chord_chart for the same tune and instrument", async () => {
  for (const instrument of ["Bb", "Eb", "F"]) {
    for (const mode of ["major", "minor"]) {
      const r = await find({ mode, instrument, limit: 10 });
      for (const t of r.tunes) {
        const { result: c } = await runTool("chord_chart", { tune: t.title, instrument });
        assert.equal(c.found, true, t.title);
        assert.equal(t.written_key, c.key, `${t.title} for ${instrument}`);
        assert.equal(t.key, c.concert_key, `${t.title} concert`);
      }
    }
  }
});

test("the key filter stays concert pitch", async () => {
  // "tunes in C" for a Bb player still means concert C; the written key is D.
  const r = await find({ key: "C", mode: "major", instrument: "Bb" });
  assert.ok(r.tunes.length > 0);
  for (const t of r.tunes) {
    assert.equal(t.key, "C major");
    assert.equal(t.written_key, "D major");
  }
});

test("concert or no instrument: no written_key, result unchanged", async () => {
  const plain = await find({ mode: "minor" });
  for (const instrument of [undefined, null, "", "concert"]) {
    const r = await find({ mode: "minor", instrument });
    assert.equal(r.isError, false);
    assert.deepEqual(r, plain, String(instrument));
  }
  assert.equal(plain.instrument, undefined);
  assert.ok(plain.tunes.every((t) => !("written_key" in t)));
  assert.doesNotMatch(plain.note, /written_key/);
});

test("bad instrument: error, no echo of the caller's text", async () => {
  for (const instrument of ["alto sax", "bb", "Gxxxx", 2, ["Bb"], { x: 1 }]) {
    const r = await find({ mode: "minor", instrument });
    assert.equal(r.isError, true, JSON.stringify(instrument));
    assert.match(r.error, /"instrument" must be one of: concert, Bb, Eb, F/);
    assert.doesNotMatch(r.error, /alto|Gxxxx/);
  }
  // an instrument alone is not a filter
  assert.equal((await find({ instrument: "Bb" })).isError, true);
});

test("not-found results stay title-free with an instrument", async () => {
  const r = await find({ composer: "Nobody Atall", instrument: "Eb" });
  assert.equal(r.found, false);
  assert.equal(r.tunes, undefined);
});

test("MCP: public /mcp accepts instrument on find_tunes", async () => {
  const list = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const def = list.result.tools.find((t) => t.name === "find_tunes");
  assert.deepEqual(def.inputSchema.properties.instrument.enum, ["concert", "Bb", "Eb", "F"]);
  const call = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "find_tunes", arguments: { composer: "Coltrane", instrument: "Bb" } } });
  assert.equal(call.result.isError, false);
  assert.deepEqual(call.result.structuredContent.tunes.map((t) => [t.title, t.written_key]), [["Mr. P.C.", "D minor"]]);
});
