// Setlist "Print for" switch (setlist-print.js at the repo root). Run from worker/: npm test
// The page script is loaded as-is; its fetch goes to the real /mcp handler in-process,
// so these tests cover the whole path: page → MCP batch → chord_chart → page.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { runTool, splitChartResult } from "../src/tools.js";
import { handleMcpHttp } from "../src/mcp.js";

const src = readFileSync(new URL("../../setlist-print.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const SP = sandbox.window.SetlistPrint;
// Arrays made inside the vm sandbox have that realm's prototype; copy them before deepEqual.
const plain = (x) => JSON.parse(JSON.stringify(x));

const ORIGIN = "https://example.test";
let mcpCalls = 0;
async function fetchFn(url, init) {
  mcpCalls++;
  const req = new Request(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  return handleMcpHttp(req, { allowedOrigins: [ORIGIN], cors: {}, env: {} });
}
const opts = { url: "https://worker.test/mcp", fetchFn };

// A chart as the chat hands it to the page (and the setlist saves it).
async function saved(args) {
  const { result } = await runTool("chord_chart", args);
  assert.equal(result.found, true);
  return JSON.parse(JSON.stringify(splitChartResult(result).page)); // as it comes back from localStorage
}

test("the page gets the concert key with every chart", async () => {
  assert.equal((await saved({ tune: "Autumn Leaves" })).concert_key, "G minor");
  assert.equal((await saved({ tune: "Autumn Leaves", instrument: "Eb" })).concert_key, "G minor");
  assert.equal((await saved({ tune: "Satin Doll", key: "F", instrument: "Bb" })).concert_key, "F major");
});

test("a mixed setlist printed for Eb: every chart in the alto key, same as asking the chat", async () => {
  const set = [
    await saved({ tune: "Autumn Leaves" }), // concert
    await saved({ tune: "Blue Bossa", instrument: "Bb" }), // saved for tenor
    await saved({ tune: "Satin Doll", key: "F" }), // concert, moved to F
  ];
  const { charts, kept } = await SP.chartsFor(set, "Eb", opts);
  assert.deepEqual(plain(kept), []);
  assert.deepEqual(plain(charts.map((c) => c.key)), [
    "E minor, for Eb instruments",
    "A minor, for Eb instruments",
    "D major, for Eb instruments",
  ]);
  // Bar for bar the same as the chart the chat would show for that request.
  assert.deepEqual(JSON.parse(JSON.stringify(charts[2])), await saved({ tune: "Satin Doll", key: "F", instrument: "Eb" }));
  assert.deepEqual(plain(charts.map((c) => c.concert_key)), ["G minor", "C minor", "F major"]);
});

test("back to concert, and Bb/F; charts already right are not fetched again", async () => {
  const tenor = await saved({ tune: "Blue Bossa", instrument: "Bb" });
  const concert = await saved({ tune: "Autumn Leaves" });

  mcpCalls = 0;
  const toConcert = await SP.chartsFor([tenor, concert], "concert", opts);
  assert.equal(toConcert.charts[0].key, "C minor");
  assert.equal(toConcert.charts[1], concert, "the concert chart is reused as is");
  assert.equal(mcpCalls, 1, "one batch request for the whole set");

  const toF = await SP.chartsFor([tenor, concert], "F", opts);
  assert.deepEqual(plain(toF.charts.map((c) => c.key)), ["G minor, for F instruments", "D minor, for F instruments"]);

  mcpCalls = 0;
  const same = await SP.chartsFor([tenor], "Bb", opts);
  assert.equal(same.charts[0], tenor);
  assert.equal(mcpCalls, 0);
});

test("'as saved' is today's behaviour: no network, nothing changes", async () => {
  const set = [await saved({ tune: "Autumn Leaves", instrument: "Eb" })];
  mcpCalls = 0;
  const { charts, kept } = await SP.chartsFor(set, SP.SAVED, opts);
  assert.equal(charts[0], set[0]);
  assert.deepEqual(plain(kept), []);
  assert.equal(mcpCalls, 0);
});

test("big setlists go out in batches of 20 (the /mcp limit)", async () => {
  const one = await saved({ tune: "Autumn Leaves" });
  const set = Array.from({ length: 45 }, () => one);
  mcpCalls = 0;
  const { charts, kept } = await SP.chartsFor(set, "Bb", opts);
  assert.equal(mcpCalls, 3);
  assert.deepEqual(plain(kept), []);
  assert.ok(charts.every((c) => c.key === "A minor, for Bb instruments"));
});

test("charts that can't be switched are printed as saved and named", async () => {
  const good = await saved({ tune: "Autumn Leaves" });
  // Saved for Eb before concert_key existed: the concert key is unknown, so no request is made.
  const legacy = { ...(await saved({ tune: "Blue Bossa", instrument: "Eb" })) };
  delete legacy.concert_key;
  // A title the library doesn't have, and one whose saved key is junk.
  const missing = { ...good, title: "No Such Tune Anywhere" };
  const junk = { ...good, title: "Satin Doll", key: "<b>x</b>", concert_key: undefined };

  const plan = SP.planRequests([good, legacy, missing, junk], "Bb");
  assert.deepEqual(plain(plan.unknown), [1, 3]);
  assert.deepEqual(plain(plan.requests.map((r) => r.id)), [0, 2]);

  const { charts, kept } = await SP.chartsFor([good, legacy, missing, junk], "Bb", opts);
  assert.equal(charts[0].key, "A minor, for Bb instruments");
  assert.equal(charts[1], legacy);
  assert.equal(charts[2], missing);
  assert.deepEqual(plain(kept), ["Blue Bossa", "No Such Tune Anywhere", "Satin Doll"]);
});

test("replies are checked, not trusted", () => {
  const asked = { title: "Autumn Leaves" };
  const ok = { result: { isError: false, structuredContent: { found: true, title: "Autumn Leaves", key: "A minor", instrument: "Bb", concert_key: "G minor", layout: { style: null, bars: [] } } } };
  assert.equal(SP.chartFromReply(ok, asked).key, "A minor, for Bb instruments");
  assert.equal(SP.chartFromReply({ error: { code: -32602, message: "x" } }, asked), null);
  assert.equal(SP.chartFromReply({ result: { ...ok.result, isError: true } }, asked), null);
  const other = structuredClone(ok); other.result.structuredContent.title = "Autumn in New York";
  assert.equal(SP.chartFromReply(other, asked), null, "a different tune is never swapped in");
  const badBars = structuredClone(ok); badBars.result.structuredContent.layout.bars = "C7";
  assert.equal(SP.chartFromReply(badBars, asked), null);
  const badInst = structuredClone(ok); badInst.result.structuredContent.instrument = "<script>";
  assert.equal(SP.chartFromReply(badInst, asked), null);
  assert.equal(SP.chartFromReply(undefined, asked), null);
});

test("a failed request is an error (the page shows its connection toast)", async () => {
  const set = [await saved({ tune: "Autumn Leaves" })];
  const down = async () => new Response("nope", { status: 503 });
  await assert.rejects(SP.chartsFor(set, "Eb", { url: opts.url, fetchFn: down }));
});

test("cover and file name label", () => {
  assert.equal(SP.label("concert"), "concert");
  assert.equal(SP.label("Eb"), "for Eb");
  assert.equal(SP.label(SP.SAVED), "");
  assert.equal(SP.label("tenor"), "");
});
