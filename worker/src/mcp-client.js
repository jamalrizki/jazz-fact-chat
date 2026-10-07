/**
 * Jazz Fact Chat — MCP client, as used by our chat "host".
 *
 * Our chat loop now plays the same role Claude Desktop does: it is an MCP
 * host. It doesn't import tool code directly. It asks an MCP server what tools
 * exist (tools/list), hands those to the LLM, and when the LLM asks for one,
 * forwards the request (tools/call).
 *
 * The transport here is in-process: we call the server's handleRpc() directly
 * with the exact JSON-RPC messages a remote client would POST to /mcp.
 * (A Worker can't easily fetch its own public URL, and there's no reason to
 * pay for a network hop to ourselves.) Swapping this for a real HTTP
 * transport would change only the send() function below.
 *
 * The other job of a host: translating between MCP and the LLM provider.
 *   MCP tool      { name, description, inputSchema }
 *   OpenAI tool   { type: "function", function: { name, description, parameters } }
 */

import { handleRpc, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp.js";

let nextId = 1;

export async function connect(env = {}) {
  const send = async (method, params) => {
    const reply = await handleRpc({ jsonrpc: "2.0", id: nextId++, method, params }, env);
    if (reply.error) throw new Error(`MCP ${method} failed: ${reply.error.message}`);
    return reply.result;
  };

  // The same handshake any MCP client performs.
  const init = await send("initialize", {
    protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: {},
    clientInfo: { name: "jazz-fact-chat-host", version: "0.3.0" },
  });
  await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, env);
  const { tools } = await send("tools/list", {});
  return {
    serverInfo: init.serverInfo,
    tools,
    // MCP → OpenAI-compatible format, for Groq/OpenRouter.
    openAITools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    async callTool(name, args) {
      try {
        const result = await send("tools/call", { name, arguments: args });
        // MCP returns content blocks; the LLM's "tool" message wants one string.
        const text = (result.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        return { text, isError: Boolean(result.isError) };
      } catch (err) {
        // Protocol-level error (e.g. the model invented a tool name). Report it to the model as data.
        return { text: JSON.stringify({ error: err.message }), isError: true };
      }
    },
  };
}
