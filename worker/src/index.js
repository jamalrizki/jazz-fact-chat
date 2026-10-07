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

// Some models (often ones picked by a free router) write a tool call out as text
// instead of using the structured tool_calls field. Never show that to the user.
const LEAKED_TOOL_MARKUP = /<\/?[\w-]*(function_call|tool_call|invoke|parameter)\b|<\|[^|>]*\|>/i;

function stripToolMarkup(text) {
  return text
    .replace(/<([\w-]*(?:function_call|tool_call))\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?[\w-]*(?:function_call|tool_call|invoke|parameter)\b[^>]*>/gi, "")
    .replace(/<\|[^|>]*\|>/g, "")
    .trim();
}

const SYSTEM_PROMPT = `You are Jazz Fact Chat, a friendly expert on jazz: musicians, albums, history, and theory.

How to answer any jazz question:
1. If you're confident and it's well established (famous albums, major careers, standard theory), just answer. No tool needed.
2. If you're not sure, or it's specific or obscure (who played on a record, who someone recorded with, how many albums two players made together, exact dates), look it up first:
   - album_lineup for the personnel and year of one named album (MusicBrainz).
   - search_jazz for everything else: discographies, sideman work, collaborations, counts, lesser-known players. It searches Wikipedia, All About Jazz and other jazz references.
   - lookup_musician for a quick bio.
3. Fallback: if a tool finds nothing or not enough, try search_jazz with a better query before giving up. Never guess titles and test them one by one.
4. If your sources don't have the answer, say so plainly. Don't invent names, dates, personnel or numbers.
5. Keep it to one or two searches when you can, then answer.

Other tools:
- chord_chart: whenever the user asks for chords, changes, or a chart for a tune. Pass the key if they name one.
- random_jazz_fact: only when the user asks for a fun fact or trivia.

Chord charts:
- Put chord_chart's chart_text in your reply inside a \`\`\`chart code block, copied exactly. Add at most two short sentences after it (e.g. the form, or one practice tip).
- If chord_chart doesn't have the tune, say so in one sentence and mention any close matches from its "suggestions". Do NOT write chords for that tune from memory, not even a partial or "typical" version.
- Never transpose a chart yourself; ask chord_chart for the key instead. Never write out melodies or lyrics.

Style:
- When you used a tool, name the source briefly in plain parentheses, e.g. "(per Wikipedia)". Do not use 【】 brackets, footnote markers, or citation tokens.
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
    if (pathname === "/mcp") return handleMcpHttp(request, { allowedOrigins, cors, env });

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
  const mcp = await connect(env); // env carries secrets the tools need (e.g. TAVILY_API_KEY)
  const convo = [...messages];
  const trace = []; // what we report back to the browser so you can see the loop happen

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // On the final round, tool_choice "none" forces a text answer, and we say so explicitly:
    // some models ignore tool_choice and try to write a tool call as text instead.
    const finalRound = round === MAX_TOOL_ROUNDS;
    if (finalRound) {
      convo.push({
        role: "system",
        content: "Tool budget used up. Answer the user now in plain text using only the tool results above. Do not call or write out any tool calls.",
      });
    }
    const toolChoice = finalRound ? "none" : "auto";
    let { message, provider, model } = await chatWithFallback(convo, env, mcp.openAITools, toolChoice);

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    // No tool calls means the model is done: this is the answer.
    if (calls.length === 0) {
      let reply = (message.content || "").trim();
      if (LEAKED_TOOL_MARKUP.test(reply)) {
        // Retry once, forcing plain text.
        console.warn(`${provider}/${model} wrote tool-call markup as text; retrying once`);
        const retry = await chatWithFallback(
          [...convo, { role: "system", content: "Your last reply contained raw tool-call markup. Reply again in plain text only, using the tool results above." }],
          env, mcp.openAITools, "none"
        );
        ({ provider, model } = retry);
        reply = stripToolMarkup((retry.message.content || "").trim());
        if (reply.length < 40) {
          reply = trace.length
            ? "Sorry, I gathered some data but couldn't put an answer together. Expand the tool trace below to see what came back, or ask again."
            : "Sorry, something went wrong putting an answer together. Please ask again.";
        }
      }
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
