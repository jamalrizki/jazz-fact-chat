// "Show chart" / "Add to setlist" under a find_tunes list (tune-picks.js at the repo root).
// Run from worker/: npm test
// The page scripts are loaded as-is; their fetch goes to the real /mcp handler in-process,
// so these tests cover the whole path: find_tunes → page list → MCP tools/call → chart.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { runTool, splitChartResult, tuneListForPage } from "../src/tools.js";
import { handleMcpHttp } from "../src/mcp.js";

const sandbox = { window: {} };
for (const f of ["setlist-print.js", "tune-picks.js"]) {
  vm.runInNewContext(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"), sandbox);
}
const TP = sandbox.window.TunePicks;
const plain = (x) => JSON.parse(JSON.stringify(x)); // vm-realm objects → this realm

const ORIGIN = "https://example.test";
const requests = [];
async function fetchFn(url, init) {
  requests.push(JSON.parse(init.body));
  const req = new Request(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  return handleMcpHttp(req, { allowedOrigins: [ORIGIN], cors: {}, env: {} });
}
const opts = { url: "https://worker.test/mcp", fetchFn };

async function find(args) {
  const { result, isError } = await runTool("find_tunes", args);
  assert.equal(isError, false);
  return result;
}

test("a find_tunes result becomes a page list with title, key, form and style", async () => {
  const list = tuneListForPage(await find({ key: "C minor" }));
  assert.ok(list);
  assert.deepEqual(list.tunes.map((t) => t.title), ["Blue Bossa", "Mr. P.C.", "Solar"]);
  const bossa = list.tunes[0];
  assert.equal(bossa.key, "C minor");
  assert.equal(bossa.style, "Bossa Nova");
  assert.equal(typeof bossa.form, "string");
  assert.deepEqual(Object.keys(bossa).sort(), ["form", "key", "style", "title"]);
});

test("no list for not-found results, errors or odd input", async () => {
  assert.equal(tuneListForPage(await find({ composer: "Nobody Atall" })), null);
  assert.equal(tuneListForPage(await find({ style: "polka" })), null); // known_styles reply, no titles
  for (const bad of [null, undefined, "x", {}, { found: true }, { found: true, tunes: "Solar" }, { found: false, tunes: [{ title: "Solar" }] }]) {
    assert.equal(tuneListForPage(bad), null);
  }
});

test("only titles that are really in the library reach the page, at most 10", () => {
  const list = tuneListForPage({
    found: true,
    tunes: [{ title: "Solar", key: "C minor" }, { title: "Made Up Tune" }, { title: 42 }, null, { title: "Autumn Leaves", style: { x: 1 } }],
  });
  assert.deepEqual(list.tunes.map((t) => t.title), ["Solar", "Autumn Leaves"]);
  assert.equal(list.tunes[1].style, ""); // non-strings are dropped, not passed through
  assert.equal(tuneListForPage({ found: true, tunes: [{ title: "Made Up Tune" }] }), null);
  const many = tuneListForPage({ found: true, tunes: Array.from({ length: 15 }, () => ({ title: "Solar" })) });
  assert.equal(many.tunes.length, 10);
});

test("page: cleanLists keeps well-formed entries only, capped", () => {
  assert.deepEqual(plain(TP.cleanLists(undefined)), []);
  assert.deepEqual(plain(TP.cleanLists("nope")), []);
  const lists = plain(TP.cleanLists([
    { tunes: [{ title: "Solar", key: "C minor", form: "12 bars" }, { title: "" }, { title: 7 }, { key: "F" }] },
    { tunes: [] },
    null,
    { tunes: Array.from({ length: 14 }, (_, i) => ({ title: `T${i}`, style: ["not", "a", "string"] })) },
  ]));
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0], [{ title: "Solar", key: "C minor", form: "12 bars", style: "" }]);
  assert.equal(lists[1].length, 10);
  assert.equal(lists[1][0].style, "");
  assert.equal(TP.meta({ key: "C minor", form: "16 bars", style: "" }), "C minor · 16 bars");
});

test("Show chart / Add to setlist fetch exactly the chart the chat would show", async () => {
  const [tunes] = plain(TP.cleanLists([tuneListForPage(await find({ style: "bossa" }))]));
  assert.equal(tunes[0].title, "Blue Bossa");
  requests.length = 0;
  const chart = plain(await TP.fetchChart(tunes[0].title, opts));
  // One tools/call to chord_chart with only the title: no model, no other arguments.
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, { name: "chord_chart", arguments: { tune: "Blue Bossa" } });
  const { result } = await runTool("chord_chart", { tune: "Blue Bossa" });
  assert.deepEqual(chart, plain(splitChartResult(result).page));
  assert.ok(chart.bars.length > 0);
});

test("every title find_tunes can list opens as a chart", async () => {
  const titles = new Set();
  for (const args of [{ mode: "major" }, { mode: "minor" }]) {
    const list = tuneListForPage(await find({ ...args, limit: 10 }));
    for (const t of list.tunes) titles.add(t.title);
  }
  assert.ok(titles.size >= 10);
  for (const title of titles) {
    const chart = await TP.fetchChart(title, opts);
    assert.ok(chart, title);
    assert.equal(chart.title, title);
  }
});

test("a reply for another tune, an error or a bad HTTP status is not shown", async () => {
  const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const other = await runTool("chord_chart", { tune: "Solar" });
  const wrong = { jsonrpc: "2.0", id: 1, result: { isError: false, structuredContent: other.result } };
  assert.equal(await TP.fetchChart("Blue Bossa", { url: opts.url, fetchFn: reply(wrong) }), null);
  assert.equal(await TP.fetchChart("Blue Bossa", { url: opts.url, fetchFn: reply({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "x" } }) }), null);
  assert.equal(await TP.fetchChart("Made Up Tune", opts), null); // not found → nothing to show
  await assert.rejects(TP.fetchChart("Solar", { url: opts.url, fetchFn: reply({}, 502) }), /MCP HTTP 502/);
});
