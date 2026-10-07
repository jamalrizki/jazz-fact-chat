/**
 * Jazz Fact Chat — MCP server (hand-written, no SDK).
 *
 * MCP in one paragraph: a server exposes capabilities (here: tools) to any
 * MCP client over JSON-RPC 2.0. The client first calls `initialize` to agree
 * on a protocol version and learn what the server supports, then
 * `tools/list` to discover tools, then `tools/call` to run one. The client
 * lives inside a "host" app (Claude Desktop, an IDE, or our own chat Worker),
 * and the host is what hands tool definitions to its LLM.
 *
 * Transport: "Streamable HTTP". Every client message is an HTTP POST to /mcp
 * whose body is one JSON-RPC message. Requests (with an `id`) get a JSON-RPC
 * response; notifications (no `id`) get HTTP 202 and no body. This server is
 * stateless: no sessions and no server-to-client stream, so GET returns 405.
 * The spec allows exactly that, and it suits a Worker, where each request
 * runs on its own.
 *
 * Two layers, kept separate on purpose:
 *   handleRpc(message)     pure JSON-RPC logic; reused in-process by mcp-client.js
 *   handleMcpHttp(request) the HTTP transport around it
 */

import { TOOLS, hasTool, publicDefinition, runTool, serializeResult } from "./tools.js";

// Newest first. If the client asks for one we know, we echo it back;
// otherwise we offer our newest and the client decides whether to continue.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const SERVER_INFO = { name: "jazz-fact-chat", title: "Jazz Fact Chat", version: "0.3.0" };
const INSTRUCTIONS =
  "Jazz reference tools. Use album_lineup for album personnel and release years, " +
  "lookup_musician for biographies, and random_jazz_fact for trivia.";
const MAX_BODY_BYTES = 64 * 1024;

// JSON-RPC 2.0 standard error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/* ---------- JSON-RPC layer ---------- */

/**
 * Handle one JSON-RPC message. Returns a response object, or null for a
 * notification (notifications never get a reply).
 */
export async function handleRpc(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, INVALID_REQUEST, "Invalid Request");
  }

  // No id = notification, e.g. "notifications/initialized" right after the
  // handshake. Acknowledge silently.
  if (msg.id === undefined) return null;

  const { id, method, params = {} } = msg;

  switch (method) {
    // 1. Handshake: agree on a version, declare capabilities.
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        // We only offer tools. No resources or prompts, and our tool list never
        // changes at runtime, so listChanged is false.
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }

    case "ping":
      return rpcResult(id, {});

    // 2. Discovery: the definitions only. Handlers never leave the server.
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.map(publicDefinition) });

    // 3. Invocation
    case "tools/call": {
      const { name, arguments: args = {} } = params;
      // Asking for a tool that doesn't exist is a *protocol* error...
      if (typeof name !== "string" || !hasTool(name)) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      }
      // ...but a tool that runs and fails is a normal *result* with isError: true,
      // so the model gets to see the failure and react to it.
      const { result, isError } = await runTool(name, args);
      return rpcResult(id, {
        content: [{ type: "text", text: serializeResult(result) }], // for any client/LLM
        structuredContent: result, // machine-readable copy for clients that support it
        isError,
      });
    }

    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/* ---------- HTTP transport layer ---------- */

export async function handleMcpHttp(request, { allowedOrigins, cors }) {
  // DNS-rebinding protection (required by the spec): if a *browser* sends this
  // request, its Origin must be one we trust. Desktop/CLI MCP clients send no
  // Origin header and are allowed.
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.includes(origin)) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, "Origin not allowed"), 403, cors);
  }

  // Stateless server: no GET event stream, no DELETE session teardown.
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST", ...cors } });
  }

  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) {
    return jsonResponse(rpcError(null, INVALID_REQUEST, "Request too large"), 413, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, PARSE_ERROR, "Parse error"), 400, cors);
  }

  // Older spec revisions allowed batching several messages in one array. Cheap to support.
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) {
      return jsonResponse(rpcError(null, INVALID_REQUEST, "Invalid batch"), 400, cors);
    }
    const replies = (await Promise.all(body.map(handleRpc))).filter(Boolean);
    return replies.length ? jsonResponse(replies, 200, cors) : new Response(null, { status: 202, headers: cors });
  }

  const reply = await handleRpc(body);
  if (!reply) return new Response(null, { status: 202, headers: cors }); // notification accepted
  return jsonResponse(reply, 200, cors);
}

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
