# Jazz Fact Chat

A small AI chat about jazz musicians, records, theory, and chord changes. It answers well-known questions directly, looks things up when it isn't sure, and shows chord charts in iReal Pro's layout.

**Live:** https://jamalrizki.github.io/jazz-fact-chat/ · **How it works:** [docs page](https://jamalrizki.github.io/jazz-fact-chat/docs.html)

Built to learn LLM tool use and the Model Context Protocol (MCP) hands-on, at a running cost of $0.

## Architecture

```
Browser (GitHub Pages)
   │  POST /api/chat  {messages}
   ▼
Cloudflare Worker ── holds API keys as secrets, owns the system prompt
   │   chat loop = MCP host:  initialize → tools/list → tools/call
   ├──► MCP server (same Worker, also public at /mcp)
   │       lookup_musician · album_lineup · search_jazz · chord_chart · random_jazz_fact
   │          Wikipedia · MusicBrainz · Tavily (All About Jazz, Discogs, jazzdisco.org) · chord library
   └──► LLM: Groq (openai/gpt-oss-120b) → fallback OpenRouter free models
```

- **The model never runs anything.** It returns `tool_calls`; the Worker runs them through MCP and sends the results back until the model answers.
- **Tools are defined once** (`worker/src/tools.js`, MCP-native `inputSchema`). The same definitions serve outside MCP clients at `/mcp` and the app's own chat loop. `mcp-client.js` converts them to the OpenAI function format the LLM providers expect.
- **Chord charts skip the model.** `chord_chart` returns the chart as data, transposed in code. The page renders it iReal-style, and the model only adds a sentence or two.

## Tools

| Tool | Source | Used for |
|---|---|---|
| `lookup_musician` | Wikipedia | Quick bios |
| `album_lineup` | MusicBrainz | Personnel and release year of one album |
| `search_jazz` | Wikipedia + Tavily (All About Jazz, Discogs, jazzdisco.org) | General fallback for anything specific, obscure, or uncertain (max 2 per question) |
| `chord_chart` | Chord library | Changes for a tune in any key |
| `random_jazz_fact` | Local JSON | Trivia |

## Use the MCP server

Endpoint: `https://jazz-fact-chat.jamalrizki.workers.dev/mcp` (stateless Streamable HTTP, tools only, read-only).

```bash
curl -s https://jazz-fact-chat.jamalrizki.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Run it locally

**Prerequisites:** Node 20+, Python 3, a free [Groq](https://console.groq.com) API key. An [OpenRouter](https://openrouter.ai) key (fallback) and a [Tavily](https://tavily.com) key (web search) are optional.

1. `cd worker && npm install`
2. `cp .dev.vars.example .dev.vars` and fill in your keys. `.dev.vars` is gitignored; never commit it.
3. `npm run dev`. The Worker runs at http://localhost:8787.
4. In a second terminal, from the repo root: `python3 -m http.server 8000`, then open http://localhost:8000.

## Deploy

**Before the first deploy:** run `npx wrangler login`, set your GitHub Pages origin in `ALLOWED_ORIGINS` in `worker/wrangler.toml`, and set the deployed Worker URL in `config.js`.

1. Add secrets: `npx wrangler secret put GROQ_API_KEY` (likewise `OPENROUTER_API_KEY`, `TAVILY_API_KEY`).
2. `cd worker && npm run deploy`
3. Push to `main`. GitHub Pages serves the repo root.

## Chord library

The repo includes a small sample library (`worker/src/chord-charts.sample.json`, 12 standards). The full library is generated from an iReal Pro playlist export and is **not published**:

```bash
cd worker && npm run import -- path/to/ireal-export.html   # writes src/chord-charts.json (gitignored)
```

`npm run dev` and `npm run deploy` fall back to the sample library when the full one isn't there.

## Project layout

```
index.html, app.js, style.css    chat page
docs.html, docs.js               "How it works" page (tool list loaded live via tools/list)
config.js                        Worker URL (local vs deployed)
worker/src/index.js              chat endpoint, tool-use loop, provider fallback
worker/src/mcp.js                hand-written MCP server (JSON-RPC 2.0)
worker/src/mcp-client.js         in-process MCP client + MCP → OpenAI tool conversion
worker/src/tools.js              tool definitions and implementations
worker/scripts/import-ireal.mjs  iReal Pro export → chord library
```

## Credits

Data from [Wikipedia](https://www.wikipedia.org), [MusicBrainz](https://musicbrainz.org), [All About Jazz](https://www.allaboutjazz.com), [Discogs](https://www.discogs.com), and the [Jazz Discography Project](https://www.jazzdisco.org). The iReal Pro decoding follows [ireal-reader](https://github.com/pianosnake/ireal-reader) (MIT) and ironss/accompaniser.
