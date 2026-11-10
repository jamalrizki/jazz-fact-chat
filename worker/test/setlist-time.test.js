// Setlist timer (setlist-time.js at the repo root). Run from worker/: npm test
// The page script is loaded as-is. Charts come from the real chord_chart tool, as the page saves them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { runTool, splitChartResult } from "../src/tools.js";
import { handleMcpHttp } from "../src/mcp.js";

const load = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(load("setlist-time.js"), sandbox);
vm.runInNewContext(load("setlist-print.js"), sandbox);
const ST = sandbox.window.SetlistTime;
const SP = sandbox.window.SetlistPrint;

async function saved(args) {
  const { result } = await runTool("chord_chart", args);
  assert.equal(result.found, true);
  return JSON.parse(JSON.stringify(splitChartResult(result).page)); // as it comes back from localStorage
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg ?? ""} ${a} ≠ ${b}`);

test("the page gets bars per chorus with every chart", async () => {
  assert.equal((await saved({ tune: "Blue Bossa" })).chorus_bars, 16);
  assert.equal((await saved({ tune: "Autumn Leaves", instrument: "Bb" })).chorus_bars, 32);
  assert.equal((await saved({ tune: "All the Things You Are", numerals: true })).chorus_bars, 36);
});

test("Blue Bossa at 150 with 6 choruses: 8 times through 16 bars of 4/4 ≈ 3:25", async () => {
  const bb = await saved({ tune: "Blue Bossa" });
  const s = ST.tuneSeconds(bb, 150, 6);
  near(s, (8 * 16 * 4 * 60) / 150);
  assert.equal(ST.clock(s), "3:25");
  // Autumn Leaves (32 bars) at 120 with 4 choruses → 6:24, as in the idea issue.
  assert.equal(ST.clock(ST.tuneSeconds(await saved({ tune: "Autumn Leaves" }), "120", "4")), "6:24");
  // No solos: head in and head out only.
  assert.equal(ST.clock(ST.tuneSeconds(bb, 120, 0)), "1:04");
});

test("the chart's time signature sets the beats per bar", () => {
  const chart = (t) => ({ title: "x", chorus_bars: 32, bars: [{ c: ["C"], ...(t ? { t } : {}) }] });
  assert.equal(ST.beatsPerBar(chart("4/4")), 4);
  assert.equal(ST.beatsPerBar(chart("3/4")), 3);
  assert.equal(ST.beatsPerBar(chart("5/4")), 5);
  assert.equal(ST.beatsPerBar(chart("2/2")), 4, "cut time, counted in quarters");
  assert.equal(ST.beatsPerBar(chart("6/8")), 2, "compound: dotted quarters");
  assert.equal(ST.beatsPerBar(chart("12/8")), 4);
  assert.equal(ST.beatsPerBar(chart("7/8")), 3.5);
  assert.equal(ST.beatsPerBar(chart()), 4, "no time signature: 4/4");
  assert.equal(ST.beatsPerBar(chart("<b>")), 4);
  assert.equal(ST.beatsPerBar(chart("0/4")), 4);
  // A waltz takes 3/4 of the time of the same bars in 4/4.
  near(ST.tuneSeconds(chart("3/4"), 120, 2), (ST.tuneSeconds(chart("4/4"), 120, 2) * 3) / 4);
});

test("bad tempo or choruses: that tune is untimed", async () => {
  const bb = await saved({ tune: "Blue Bossa" });
  for (const bpm of [0, 39, 401, 1000, "fast", "", "12.5", "-120", " ", null, undefined, {}, "1e2"]) {
    assert.equal(ST.tuneSeconds(bb, bpm, 4), null, `bpm ${JSON.stringify(bpm)}`);
  }
  for (const ch of [-1, 21, "two", "", null, undefined, 2.5]) {
    assert.equal(ST.tuneSeconds(bb, 120, ch), null, `choruses ${JSON.stringify(ch)}`);
  }
  assert.notEqual(ST.tuneSeconds(bb, 40, 0), null);
  assert.notEqual(ST.tuneSeconds(bb, "400", "20"), null);
  assert.equal(ST.clock(null), "—");
});

test("bars per chorus: tool value first, then the form text, then the written bars without repeats", () => {
  assert.equal(ST.chorusBars({ chorus_bars: 40, form: "AABA, 32 bars", bars: [] }), 40);
  // Saved before chorus_bars existed.
  assert.equal(ST.chorusBars({ form: "AABA, 32 bars", bars: [] }), 32);
  assert.equal(ST.chorusBars({ form: "12-bar minor blues", bars: [] }), 12);
  assert.equal(ST.chorusBars({ form: "ABAC", bars: Array.from({ length: 24 }, () => ({ c: ["C"] })) }), 24);
  // Written with a repeat and endings: the written count isn't what's played, so untimed.
  const repeated = [{ c: ["C"], o: "{" }, { c: ["F"] }, { c: ["G"], n: 1, e: "}" }, { c: ["C"], n: 2, e: "Z" }];
  assert.equal(ST.chorusBars({ form: "AB", bars: repeated }), null);
  // Junk is never trusted.
  assert.equal(ST.chorusBars({ chorus_bars: "32", form: "", bars: [] }), null);
  assert.equal(ST.chorusBars({ chorus_bars: 0, form: "999 bars", bars: [] }), null);
  assert.equal(ST.chorusBars({ chorus_bars: 1e6, form: 5, bars: "x" }), null);
  assert.equal(ST.chorusBars(null), null);
});

test("the set total skips untimed tunes and counts them", async () => {
  const set = [
    { ...(await saved({ tune: "Blue Bossa" })), bpm: "150", choruses: "6" }, // 204.8 s
    { ...(await saved({ tune: "Autumn Leaves" })), bpm: 120, choruses: 4 }, // 384 s
    { ...(await saved({ tune: "Satin Doll" })), bpm: "fast", choruses: "3" }, // untimed
    await saved({ tune: "Solar" }), // nothing entered yet
  ];
  const total = ST.setSeconds(set);
  near(total.seconds, 204.8 + 384);
  assert.equal(total.timed, 2);
  assert.equal(total.untimed, 2);
  assert.equal(ST.totalLine(total), "Set length ~10 min · 2 tunes untimed");
  assert.equal(ST.totalLine({ seconds: 2460, timed: 8, untimed: 0 }), "Set length ~41 min");
  assert.equal(ST.totalLine({ seconds: 3900, timed: 12, untimed: 1 }), "Set length ~1 h 05 min · 1 tune untimed");
  assert.equal(ST.totalLine({ seconds: 0, timed: 0, untimed: 3 }), "Add a tempo and choruses to each tune to time the set.");
  assert.equal(ST.totalLine(ST.setSeconds([])), "");
  assert.equal(ST.setSeconds("nope").timed, 0);
});

test("setlists saved before the timer still load and just show as untimed", async () => {
  const old = await saved({ tune: "Blue Bossa" });
  delete old.chorus_bars; // saved before this change
  assert.equal(ST.chorusBars(old), 16, "read from the form text");
  assert.deepEqual(JSON.parse(JSON.stringify(ST.setSeconds([old]))), { seconds: 0, timed: 0, untimed: 1 });
});

test("charts switched by \"Print for\" keep their bars per chorus", async () => {
  const ORIGIN = "https://example.test";
  const fetchFn = async (url, init) =>
    handleMcpHttp(new Request(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } }), { allowedOrigins: [ORIGIN], cors: {}, env: {} });
  const { charts } = await SP.chartsFor([await saved({ tune: "Autumn Leaves" })], "Eb", { url: "https://worker.test/mcp", fetchFn });
  assert.equal(charts[0].chorus_bars, 32);
});
