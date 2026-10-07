/**
 * Jazz Fact Chat — Cloudflare Worker
 * Phase 3: proxy + tool-use loop, with tools served over MCP.
 *
 * The tool-use loop, in one picture:
 *
 *   browser ──messages──▶ Worker ──messages + tool definitions──▶ model
 *                                  ◀── "call album_lineup({...})" ──┘
 *                         Worker runs the tool itself
 *                                  ──messages + tool result──▶ model
 *                                  ◀── final text answer ───────┘
 *   browser ◀──reply + tool trace── Worker
 *
 * The model never touches the network. It can only *ask* for a tool; the Worker
 * decides whether to run it, runs it, and feeds the result back. That loop
 * repeats until the model answers in plain text (or we hit MAX_TOOL_ROUNDS).
 *
 * Since Phase 3, "the Worker runs the tool" means: the chat loop (an MCP host)
 * asks the MCP server via tools/call. The same server is also public at /mcp,
 * so any MCP client (Inspector, Claude, an IDE) can use these tools too.
 */

import { connect } from "./mcp-client.js";
import { handleMcpHttp } from "./mcp.js";

const MAX_MESSAGES = 20;
const MAX_CHARS_PER_MESSAGE = 4000;
const UPSTREAM_TIMEOUT_MS = 25000;
const MAX_TOOL_ROUNDS = 4; // stops a confused model from looping on tools forever

const SYSTEM_PROMPT = `You are Jazz Fact Chat, a friendly expert on jazz: musicians, albums, history, and theory.

Tools:
- album_lineup: ALWAYS call it for any question about who played on an album, its lineup, or its release year. Never state album personnel or release years from memory.
- lookup_musician: call it for biographical questions (who someone is, dates, instrument, career).
- random_jazz_fact: call it only when the user asks for a fun fact or trivia.
- chord_chart: call it whenever the user asks for the chords, changes, or a chart for a tune. Pass the key if they name one.
- Music theory questions usually need no tool.

Chord charts:
- Put chord_chart's chart_text in your reply inside a \`\`\`chart code block, copied exactly. Add at most two short sentences after it (e.g. the form, or one practice tip).
- If chord_chart doesn't have the tune, say so in one sentence and offer a few tunes from its "available" list. Do NOT write chords for that tune from memory, not even a partial or "typical" version.
- Never transpose a chart yourself; ask chord_chart for the key instead. Never write out melodies or lyrics.

Answering:
- Base factual claims on tool results. If a tool returns nothing useful, say so plainly. Do not fill gaps from memory.
- Mention the source briefly in plain parentheses, e.g. "(per MusicBrainz)". Do not use 【】 brackets, footnote markers, or citation tokens.
- Be concise: a short paragraph or a short bullet list. Do not use tables.
- If a question is not about jazz or music, briefly steer back to jazz.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowedOrigins);
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (pathname === "/health") return json({ ok: true }, 200, cors);

    // The public MCP endpoint. It does its own Origin check: browsers must be
    // allowlisted, while desktop/CLI MCP clients send no Origin and are allowed.
    if (pathname === "/mcp") return handleMcpHttp(request, { allowedOrigins, cors });

    if (pathname !== "/api/chat") return json({ error: "Not found" }, 404, cors);
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);
    if (!allowedOrigins.includes(origin)) return json({ error: "Origin not allowed" }, 403, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400, cors);
    }

    const validated = validateMessages(body?.messages);
    if (validated.error) return json({ error: validated.error }, 400, cors);

    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...validated.messages];

    try {
      const result = await runConversation(messages, env);
      return json(result, 200, cors);
    } catch (err) {
      console.error("chat failed:", err.message);
      return json({ error: "The model is unavailable right now. Try again in a minute." }, 502, cors);
    }
  },
};

/* ---------- the tool-use loop ---------- */

async function runConversation(messages, env) {
  // Discover tools over MCP (initialize → tools/list), exactly like any MCP host.
  const mcp = await connect();
  const convo = [...messages];
  const trace = []; // what we report back to the browser so you can see the loop happen

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // On the final round, tool_choice "none" forces a text answer.
    const toolChoice = round < MAX_TOOL_ROUNDS ? "auto" : "none";
    const { message, provider, model } = await chatWithFallback(convo, env, mcp.openAITools, toolChoice);

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // No tool calls means the model is done: this is the answer.
    if (calls.length === 0) {
      const reply = (message.content || "").trim();
      if (!reply) throw new Error("Empty reply from model");
      return { reply, provider, model, tools: trace };
    }

    // The model asked for tools. First, record its request in the conversation:
    // the follow-up call must show the model its own tool_calls, or the results
    // that follow would have nothing to attach to.
    convo.push({ role: "assistant", content: message.content || null, tool_calls: calls });

    // Then run each requested tool and append one "tool" message per call,
    // linked back by tool_call_id.
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      let outcome;
      const started = Date.now();
      try {
        args = JSON.parse(call.function?.arguments || "{}");
        outcome = await mcp.callTool(name, args); // → MCP tools/call
      } catch {
        outcome = { text: JSON.stringify({ error: "Tool arguments were not valid JSON." }), isError: true };
      }
      convo.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
      trace.push({
        name,
        args,
        ok: !outcome.isError,
        ms: Date.now() - started,
        preview: outcome.text.slice(0, 600),
      });
      console.log(`tool ${name}(${JSON.stringify(args)}) -> ${outcome.isError ? "error" : "ok"} in ${Date.now() - started}ms`);
    }
    // Loop: send the whole conversation, now including the tool results, back to the model.
  }

  throw new Error("Tool loop ended without a reply");
}

/* ---------- validation ---------- */

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: "messages must be a non-empty array" };
  }
  const clean = [];
  for (const m of messages.slice(-MAX_MESSAGES)) {
    // Browsers may only send user/assistant text. "system" would override our
    // instructions; "tool" would let a visitor forge tool results.
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      return { error: "Each message role must be 'user' or 'assistant'" };
    }
    if (typeof m.content !== "string" || !m.content.trim()) {
      return { error: "Each message needs non-empty string content" };
    }
    if (m.content.length > MAX_CHARS_PER_MESSAGE) {
      return { error: `Messages are limited to ${MAX_CHARS_PER_MESSAGE} characters` };
    }
    clean.push({ role: m.role, content: m.content });
  }
  if (clean[clean.length - 1].role !== "user") {
    return { error: "The last message must be from the user" };
  }
  return { messages: clean };
}

/* ---------- providers ---------- */

function providerList(env) {
  const providers = [];
  if (env.GROQ_API_KEY) {
    providers.push({
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: env.GROQ_API_KEY,
      model: env.GROQ_MODEL,
      // gpt-oss is a reasoning model. "medium" spends a little more thought on
      // tool choice than "low" did in Phase 1; Groq is fast enough not to notice.
      extra: { reasoning_effort: "medium" },
    });
  }
  if (env.OPENROUTER_API_KEY) {
    providers.push({
      name: "openrouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL,
      headers: { "X-Title": "Jazz Fact Chat" },
    });
  }
  return providers;
}

// Fallback happens per model call, so if Groq rate-limits halfway through a tool
// loop, OpenRouter picks up the same conversation. That works because both
// providers use the same OpenAI-style messages and tools format.
async function chatWithFallback(messages, env, tools, toolChoice) {
  const providers = providerList(env);
  if (providers.length === 0) throw new Error("No provider API keys configured");

  let lastError;
  for (const p of providers) {
    try {
      return await callProvider(p, messages, tools, toolChoice);
    } catch (err) {
      lastError = err;
      console.warn(`${p.name} failed: ${err.message}`);
    }
  }
  throw lastError;
}

async function callProvider(p, messages, tools, toolChoice) {
  const res = await fetch(p.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${p.key}`,
      ...p.headers,
    },
    body: JSON.stringify({
      model: p.model,
      messages,
      tools,                     // the menu the model can order from (from tools/list)
      tool_choice: toolChoice,   // "auto" = model decides; "none" = must answer in text
      temperature: 0.3,
      max_tokens: 2048,
      ...p.extra,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("No message in model response");
  return { message, provider: p.name, model: data.model || p.model };
}

/* ---------- helpers ---------- */

function parseList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin, allowedOrigins) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
