// chord_chart `numerals`: the changes in numbers (Roman numerals against the key). Run from worker/: npm test
// The numerals are worked out in code from each chord's root and the tune's key; these tests pin the rules down.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { runTool, TOOLS, splitChartResult, toNumeral } from "../src/tools.js";
import { handleMcpHttp } from "../src/mcp.js";

async function chart(args) {
  const { result, isError } = await runTool("chord_chart", args);
  assert.equal(isError, false, JSON.stringify(result));
  assert.equal(result.found, true);
  return result;
}
const chords = (r) => r.layout.bars.flatMap((b) => b.c || []);

test("a major tune: I–VI–II–V (Rhythm Changes)", async () => {
  const r = await chart({ tune: "Rhythm Changes", numerals: true });
  assert.equal(r.numerals, true);
  assert.equal(r.numerals_from, "Bb");
  assert.deepEqual(chords(r).slice(0, 4), ["I6", "VI7", "IIm7", "V7"]);
  assert.match(r.chart_text, /· Bb major · numerals from Bb ·/);
  assert.match(r.chart_text, /\| I6 VI7 \| IIm7 V7 \|/);
  assert.ok(!/[A-G]/.test(chords(r).join(" ")), "no letter-name chords left");
});

test("a minor tune is counted against the parallel major: bIII and bVI (Autumn Leaves)", async () => {
  const r = await chart({ tune: "Autumn Leaves", numerals: true });
  assert.equal(r.key, "G minor");
  assert.deepEqual(chords(r).slice(0, 8), ["IVm7", "bVII7", "bIIImaj7", "bVImaj7", "IIm7b5", "V7", "Im6", "Im6"]);
});

test("chromatic roots: b vs # follows the letter name, odd spellings fall back to the usual name", () => {
  assert.equal(toNumeral("Db7", "C"), "bII7"); // tritone sub
  assert.equal(toNumeral("F#m7b5", "C"), "#IVm7b5");
  assert.equal(toNumeral("Gb7", "C"), "bV7");
  assert.equal(toNumeral("Bbmaj7", "C"), "bVIImaj7");
  assert.equal(toNumeral("Ab7", "C"), "bVI7");
  assert.equal(toNumeral("G#dim7", "C"), "#Vdim7");
  assert.equal(toNumeral("Fb", "C"), "III", "Fb in C would be bIV: use III");
  assert.equal(toNumeral("Cb", "C"), "VII", "bI is not a numeral anyone uses");
  assert.equal(toNumeral("E#", "C"), "IV");
  assert.equal(toNumeral("Bm7", "D"), "VIm7");
  assert.equal(toNumeral("C#7", "Db"), "I7", "same pitch as the tonic is I, however it's spelled");
  assert.equal(toNumeral("Gbmaj7", "F#"), "Imaj7");
});

test("slash chords keep the bass as a note name; N.C. and other text pass through", () => {
  assert.equal(toNumeral("Cmaj7/E", "C"), "Imaj7/E");
  assert.equal(toNumeral("Bb7/D", "F"), "IV7/D");
  assert.equal(toNumeral("Db/Ab", "Ab"), "IV/Ab");
  for (const t of ["N.C.", "x", "%", ""]) assert.equal(toNumeral(t, "C"), t);
});

test("numerals are the same in every key and for every instrument; the result says which tonic", async () => {
  for (const tune of ["All the Things You Are", "Autumn Leaves", "Satin Doll"]) {
    const base = await chart({ tune, numerals: true });
    for (const key of ["C", "Db", "E", "F#", "Bb"]) {
      for (const instrument of ["concert", "Bb", "Eb", "F"]) {
        const r = await chart({ tune, key, instrument, numerals: true });
        assert.deepEqual(chords(r), chords(base), `${tune} in ${key} for ${instrument}`);
        assert.equal(r.numerals_from, r.key.split(" ")[0], "counted from the key shown");
      }
    }
  }
});

test("every chord in every sample tune becomes a numeral with its quality unchanged", async () => {
  for (const tune of ["Autumn Leaves", "Blue Bossa", "So What", "Jazz Blues", "Rhythm Changes", "Take the 'A' Train",
    "All the Things You Are", "Satin Doll", "Solar", "Mr. P.C.", "Cantaloupe Island", "Fly Me to the Moon"]) {
    const letters = chords(await chart({ tune }));
    const nums = chords(await chart({ tune, numerals: true }));
    assert.equal(nums.length, letters.length, tune);
    nums.forEach((n, i) => {
      assert.match(n, /^[b#]?(VII|VI|IV|V|III|II|I)/, `${tune}: ${letters[i]} -> ${n}`);
      const q = (s, re) => s.replace(re, "").replace(/\/[A-G][b#]?$/, "");
      assert.equal(q(n, /^[b#]?(VII|VI|IV|V|III|II|I)/), q(letters[i], /^[A-G][b#]?/), `${tune}: quality kept`);
    });
  }
});

test("numerals off (or omitted) changes nothing; bad values are rejected without echo", async () => {
  const plain = await chart({ tune: "Autumn Leaves" });
  for (const numerals of [false, null, undefined]) assert.deepEqual(await chart({ tune: "Autumn Leaves", numerals }), plain);
  assert.equal("numerals" in plain, false);
  for (const numerals of ["true", "yes <b>", 1, 0, [true], { x: 1 }]) {
    const { result, isError } = await runTool("chord_chart", { tune: "Autumn Leaves", numerals });
    assert.equal(isError, true, String(numerals));
    assert.match(result.error, /"numerals" must be true or false\.$/);
  }
});

test("page header says 'in numbers' (before any instrument suffix); the model never sees the numerals", async () => {
  const { page, model } = splitChartResult(await chart({ tune: "Autumn Leaves", numerals: true }));
  assert.equal(page.key, "G minor, in numbers");
  assert.equal(page.bars[0].c[0], "IVm7");
  assert.equal(model.numerals, true);
  assert.equal(model.numerals_from, "G");
  assert.match(model.note, /Roman numerals/);
  assert.ok(!JSON.stringify(model).includes("IVm7"), "the model gets a summary, not the chart");
  const horn = splitChartResult(await chart({ tune: "Autumn Leaves", instrument: "Bb", numerals: true }));
  assert.equal(horn.page.key, "A minor, in numbers, for Bb instruments");
  assert.equal(horn.model.numerals_from, "A");
});

test("the page draws numerals as chords: accidental first, quality as usual", () => {
  const src = readFileSync(new URL("../../charts.js", import.meta.url), "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);
  const { parseChord } = sandbox.window.ChartSheet;
  const p = (s) => JSON.parse(JSON.stringify(parseChord(s)));
  assert.deepEqual(p("bVIImaj7"), { pre: "b", root: "VII", acc: "", q: "maj7" });
  assert.deepEqual(p("#IVm7b5"), { pre: "#", root: "IV", acc: "", q: "m7b5" });
  assert.deepEqual(p("Imaj7/E"), { pre: "", root: "I", acc: "", q: "maj7", bass: "E", bassAcc: "" });
  assert.deepEqual(p("IIIm7"), { pre: "", root: "III", acc: "", q: "m7" });
  assert.equal(p("Bb7").root, "B", "letter chords still parse as before");
  assert.equal("pre" in p("Bb7"), false);
  assert.equal(parseChord("N.C."), null);
});

test("public /mcp: chord_chart takes numerals", async () => {
  const req = new Request("https://worker.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chord_chart", arguments: { tune: "Blue Bossa", numerals: true } } }),
  });
  const res = await handleMcpHttp(req, { allowedOrigins: [], cors: {}, env: {} });
  const body = await res.json();
  const sc = body.result.structuredContent;
  assert.equal(sc.numerals_from, "C");
  assert.deepEqual(chords(sc).slice(8, 11), ["bIIIm7", "bVI7", "bIImaj7"], "the bridge: up to Db");
});

test("chord_chart definition: numerals is a boolean and the definition stays small", () => {
  const t = TOOLS.find((x) => x.name === "chord_chart");
  assert.equal(t.inputSchema.properties.numerals.type, "boolean");
  assert.deepEqual(t.inputSchema.required, ["tune"]);
  assert.ok(JSON.stringify({ d: t.description, s: t.inputSchema }).length < 1300);
});
