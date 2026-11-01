// Public /mcp endpoint: malformed messages get JSON-RPC errors, never a crash. Run from worker/: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpHttp, handleRpc } from "../src/mcp.js";

const post = (body) =>
  handleMcpHttp(
    new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { allowedOrigins: [], cors: {}, env: {} },
  );

test("params that aren't an object get -32602 instead of crashing", async () => {
  for (const method of ["initialize", "tools/list", "tools/call"]) {
    for (const params of [null, "x", 5, true, [1, 2]]) {
      const reply = await handleRpc({ jsonrpc: "2.0", id: 7, method, params });
      assert.equal(reply.id, 7);
      assert.equal(reply.error?.code, -32602, `${method} with params ${JSON.stringify(params)}`);
      assert.doesNotMatch(reply.error.message, /x|null|true/); // nothing from the caller echoed
    }
  }
});

test("omitted params still work (tools/list, ping)", async () => {
  const list = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(list.result.tools.length > 0);
  const ping = await handleRpc({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(ping.result, {});
});

test("over HTTP, a bad message gets a 200 JSON-RPC error, not a 500", async () => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: null });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error.code, -32602);
});

test("one bad message in a batch doesn't take the others down", async () => {
  const res = await post([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: null },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chord_chart", arguments: { tune: "Autumn Leaves" } } },
    { jsonrpc: "2.0", id: 3, method: "initialize", params: "x" },
  ]);
  assert.equal(res.status, 200);
  const replies = await res.json();
  assert.equal(replies.length, 3);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
  assert.equal(byId[1].error.code, -32602);
  assert.equal(byId[3].error.code, -32602);
  assert.equal(byId[2].result.isError, false);
  assert.equal(byId[2].result.structuredContent.title, "Autumn Leaves");
});

test("server instructions name every public tool and never the internal one", async () => {
  const init = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const { instructions } = init.result;
  const list = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  for (const t of list.result.tools) assert.match(instructions, new RegExp(`\\b${t.name}\\b`), t.name);
  assert.doesNotMatch(instructions, /search_theory_books/);
});
