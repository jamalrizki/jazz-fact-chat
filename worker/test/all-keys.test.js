// "Download in all 12 keys" (planAllKeys / allKeys in setlist-print.js). Run from worker/: npm test
// The page script is loaded as-is; its fetch goes to the real /mcp handler in-process,
// so these tests cover the whole path: page → one MCP batch of 12 chord_chart calls → page.

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
const plain = (x) => JSON.parse(JSON.stringify(x));

const ORIGIN = "https://example.test";
let mcpCalls = 0;
async function fetchFn(url, init) {
  mcpCalls++;
  const req = new Request(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } });
  return handleMcpHttp(req, { allowedOrigins: [ORIGIN], cors: {}, env: {} });
}
const opts = { url: "https://worker.test/mcp", fetchFn };

async function saved(args) {
  const { result } = await runTool("chord_chart", args);
  assert.equal(result.found, true);
  return JSON.parse(JSON.stringify(splitChartResult(result).page));
}
const keysOf = (requests) => plain(requests.map((r) => r.params.arguments.key));

test("Autumn Leaves (G minor): 12 different keys round the cycle of fourths, starting at G then C", async () => {
  const reqs = SP.planAllKeys(await saved({ tune: "Autumn Leaves" }));
  assert.deepEqual(keysOf(reqs), ["G", "C", "F", "Bb", "Eb", "G#", "C#", "F#", "B", "E", "A", "D"]);
  assert.deepEqual(plain(reqs.map((r) => r.id)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(reqs.every((r) => r.method === "tools/call" && r.params.name === "chord_chart" && r.params.arguments.tune === "Autumn Leaves"));
});

test("a major tune uses the flat-side names (Db, Gb), and starts from the key it's in now", async () => {
  // Satin Doll moved to F: the cycle starts at F, not the tune's usual C.
  assert.deepEqual(keysOf(SP.planAllKeys(await saved({ tune: "Satin Doll", key: "F" }))),
    ["F", "Bb", "Eb", "Ab", "Db", "Gb", "B", "E", "A", "D", "G", "C"]);
  // A chart already in a key off the list keeps its own name on page 1.
  assert.deepEqual(keysOf(SP.planAllKeys(await saved({ tune: "Satin Doll", key: "F#" }))).slice(0, 3), ["F#", "B", "E"]);
});

test("a horn chart stays written for that horn on every page", async () => {
  const tenor = await saved({ tune: "Autumn Leaves", instrument: "Bb" });
  const reqs = SP.planAllKeys(tenor);
  assert.equal(reqs[0].params.arguments.key, "G", "concert keys are asked for; the tool writes them for Bb");
  assert.ok(reqs.every((r) => r.params.arguments.instrument === "Bb"));
  assert.ok(SP.planAllKeys(await saved({ tune: "Autumn Leaves" })).every((r) => r.params.arguments.instrument === "concert"));
});

test("end to end: one batch, 12 charts, each the same as asking the chat for that key", async () => {
  const alto = await saved({ tune: "Blue Bossa", instrument: "Eb" }); // concert C minor
  mcpCalls = 0;
  const { charts, missing } = await SP.allKeys(alto, opts);
  assert.equal(mcpCalls, 1);
  assert.deepEqual(plain(missing), []);
  assert.equal(charts.length, 12);
  assert.deepEqual(plain(charts.map((c) => c.concert_key)), [
    "C minor", "F minor", "Bb minor", "Eb minor", "G# minor", "C# minor",
    "F# minor", "B minor", "E minor", "A minor", "D minor", "G minor",
  ]);
  assert.equal(new Set(charts.map((c) => c.key)).size, 12, "12 different written keys");
  assert.ok(charts.every((c) => c.key.endsWith(", for Eb instruments")));
  assert.equal(charts[0].key, alto.key, "page 1 is the key it's in now");
  assert.deepEqual(plain(charts[3]), await saved({ tune: "Blue Bossa", key: "Eb", instrument: "Eb" }));
});

test("no concert key, no requests (the menu item is hidden)", async () => {
  const legacy = await saved({ tune: "Blue Bossa", instrument: "Eb" });
  delete legacy.concert_key; // saved before concert_key existed
  assert.deepEqual(plain(SP.planAllKeys(legacy)), []);
  const junk = { ...(await saved({ tune: "Satin Doll" })), key: "<b>x</b>", concert_key: "H minor" };
  assert.deepEqual(plain(SP.planAllKeys(junk)), []);
  assert.deepEqual(plain(SP.planAllKeys({ concert_key: "C major" })), [], "no title");
  assert.deepEqual(plain(SP.planAllKeys(null)), []);
  mcpCalls = 0;
  assert.deepEqual(plain(await SP.allKeys(legacy, opts)), { charts: [], missing: [] });
  assert.equal(mcpCalls, 0);
});

test("keys that fail are left out and named; the rest still come back", async () => {
  const chart = await saved({ tune: "Autumn Leaves" });
  // Break two replies in the batch (an error and a different tune); keep the other ten.
  const flaky = async (url, init) => {
    const res = await fetchFn(url, init);
    const replies = await res.json();
    replies[2] = { jsonrpc: "2.0", id: 2, error: { code: -32603, message: "x" } };
    replies[5].result.structuredContent.title = "Autumn in New York";
    return new Response(JSON.stringify(replies), { status: 200 });
  };
  const { charts, missing } = await SP.allKeys(chart, { url: opts.url, fetchFn: flaky });
  assert.deepEqual(plain(missing), ["F", "G#"]);
  assert.equal(charts.length, 10);
  assert.ok(charts.every((c) => c.title === "Autumn Leaves"));
  // A tune the library doesn't have: every key is missing, nothing is made up.
  const gone = await SP.allKeys({ ...chart, title: "No Such Tune Anywhere" }, opts);
  assert.equal(gone.charts.length, 0);
  assert.equal(gone.missing.length, 12);
});

test("an unreachable /mcp is an error (the page shows its connection toast)", async () => {
  const chart = await saved({ tune: "Autumn Leaves" });
  await assert.rejects(SP.allKeys(chart, { url: opts.url, fetchFn: async () => new Response("nope", { status: 503 }) }));
});
