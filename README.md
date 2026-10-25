# Jaizz Chat

An AI chat for jazz musicians: players, records, history, theory, and chord changes. It answers well-known questions directly, looks things up when it isn't sure, spells chords in code, and shows jazz charts.

**Live:** https://jamalrizki.github.io/jazz-fact-chat/ · **How it works:** [docs page](https://jamalrizki.github.io/jazz-fact-chat/docs.html)

Built to learn LLM tool use, the Model Context Protocol (MCP) and retrieval (RAG) hands-on, at a running cost of $0.

> The repo, Worker, URLs and MCP server id are still named `jazz-fact-chat` (the app's earlier name). Only the display name changed.

## Architecture

```
Browser (GitHub Pages)
   │  POST /api/chat  {messages}
   ▼
Cloudflare Worker ── holds API keys as secrets, owns the system prompt
   │   chat loop = MCP host:  initialize → tools/list → tools/call
   ├──► MCP server (same Worker; public at /mcp minus internal-only tools)
   │       lookup_musician · album_lineup · search_jazz · chord_chart
   │       chord_voicings · random_jazz_fact · search_theory_books (internal only)
   │          Wikipedia · MusicBrainz · Tavily (All About Jazz, Discogs, jazzdisco.org)
   │          chord library · chord-spelling code · Workers AI + Vectorize (reference material)
   └──► LLM: Groq (openai/gpt-oss-120b) → fallback OpenRouter free models
```

- **The model never runs anything.** It returns `tool_calls`; the Worker runs them through MCP and sends the results back until the model answers (at most 4 tool rounds).
- **Tools are defined once** (`worker/src/tools.js`, MCP-native `inputSchema`). The same definitions serve outside MCP clients at `/mcp` and the app's own chat loop. `mcp-client.js` converts them to the OpenAI function format the LLM providers expect.
- **Exact work happens in code, not in the model:** transposing charts, spelling chord notes, capping searches (2 web searches and 2 reference searches per question), choosing reference passages, parsing rate-limit waits, and stripping source tags from replies.
- **Chord charts skip the model.** `chord_chart` returns the chart as data, transposed in code. The page renders it as a chart, and the model only adds a sentence or two.
- **The setlist calls the MCP server directly.** Its "Print for" switch (concert, Bb, Eb, F) sends one JSON-RPC batch of `chord_chart` `tools/call`s to `/mcp` (`setlist-print.js`), with no model in the loop, so the page never transposes anything itself.

## Tools

| Tool | Source | Used for |
|---|---|---|
| `lookup_musician` | Wikipedia | Quick bios |
| `album_lineup` | MusicBrainz | Personnel and release year of one album (original pressing, not deluxe/expanded reissues with bonus players) |
| `search_jazz` | Wikipedia + Tavily (All About Jazz, Discogs, jazzdisco.org) | General fallback for anything specific, obscure, or uncertain (max 2 per question) |
| `chord_chart` | Chord library (jazz standards plus Brazilian, Latin, blues, country and pop) | Changes for a tune in any key, or written for Bb, Eb or F instruments (`instrument`; `key` stays the concert key) |
| `chord_voicings` | Code (`voicings.js`) | Notes of any chord symbol: chord tones, inversions, rootless form, optional chord-scale, checking notes against a chord |
| `random_jazz_fact` | Local JSON | Trivia |
| `search_theory_books` | Workers AI + Vectorize, reranked | Theory, harmony, improvisation, arranging, practice and history questions (max 2 per question). Searches scoped reference material. **Internal only:** the chat uses it; the public `/mcp` endpoint doesn't list or run it. |

## Use the MCP server

Endpoint: `https://jazz-fact-chat.jamalrizki.workers.dev/mcp` (stateless Streamable HTTP, tools only, read-only, 6 public tools).

```bash
curl -s https://jazz-fact-chat.jamalrizki.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Run it locally

**Prerequisites:** Node 20+, Python 3, a free [Groq](https://console.groq.com) API key, and a Cloudflare account logged in with `npx wrangler login`. The reference search uses the remote Vectorize index even in local dev (`wrangler dev` has no local Vectorize), so without the index that one tool returns nothing and everything else still works. An [OpenRouter](https://openrouter.ai) key (fallback) and a [Tavily](https://tavily.com) key (web search beyond Wikipedia) are optional.

All `npm` and `npx wrangler` commands run from the `worker/` folder.

1. From the repo root: `cd worker && npm install`
2. In `worker/`: `cp .dev.vars.example .dev.vars` and fill in your keys. `.dev.vars` is gitignored; never commit it.
3. In `worker/`: `npm run dev`. The Worker runs at http://localhost:8787. (If the full chord library isn't there, this copies in the 12-tune sample first.)
4. In a second terminal, from the repo root: `python3 -m http.server 8000`, then open http://localhost:8000.

Port 8000 or 8787 already taken? `lsof -nP -iTCP:8000 -iTCP:8787 -sTCP:LISTEN` shows what's holding it.

**Tests** (from `worker/`): `npm test` (copies in the sample chord library first if the full one isn't there, so it works on a fresh clone)

**Logs from the deployed Worker** (from `worker/`): `npx wrangler tail`

## Deploy

**Before the first deploy:** run `npx wrangler login`, set your GitHub Pages origin in `ALLOWED_ORIGINS` in `worker/wrangler.toml`, set the deployed Worker URL in `config.js`, and create the Vectorize index once from `worker/`: `npx wrangler vectorize create jazz-books --dimensions=384 --metric=cosine`.

1. From `worker/`, add secrets: `npx wrangler secret put GROQ_API_KEY` (likewise `OPENROUTER_API_KEY`, `TAVILY_API_KEY`).
2. From `worker/`: `npm run deploy`
3. From the repo root: push to `main`. GitHub Pages serves the repo root (about a minute; hard-refresh to see it).

Deploy the Worker first when a change touches both, so the page never calls a Worker that's behind it.

## Chord library

The repo includes a small sample library (`worker/src/chord-charts.sample.json`, 12 standards). The full library of jazz charts is **not published** (`worker/src/chord-charts.json` is gitignored and deployed with the Worker).

**Warning:** a plain import **replaces** the whole library. Back up `worker/src/chord-charts.json` first, and use `--merge` to add charts to an existing library. From `worker/`:

```bash
npm run import -- --merge path/to/export.html   # add to the library (existing charts win on a clash)
npm run import -- path/to/export.html           # replace the library
```

Each chart keeps two views: `written` (the bars as written, with repeats, endings, signs and codas in place; the page draws this) and `sections` (the form as played; `chart_text`, `form` and the bar count come from it). For D.C./D.S. al Coda/al Fine charts the importer plays the jumps through: the body with its repeats, back to the top or the segno with repeats not taken (last ending only), then on to the coda or stop at Fine. If the signs don't add up (no segno, not exactly two coda signs, two jumps, 3rd endings), the chart keeps the repeats-only expansion. Charts imported before this rule keep their old `sections` until you import again.

## Reference search (RAG)

`search_theory_books` searches scoped reference material on jazz theory, harmony, arranging and history. The material is not in the repo (`knowledge/` is gitignored).

How a search works (`worker/src/books.js`): Workers AI embeds the question (`bge-small-en-v1.5`, 384 dims) → Vectorize returns 30 candidates → `bge-reranker-base` re-scores them → passages scoring at least 0.5 are kept, near-duplicates dropped, and the best 3 go to the model. If none pass, the tool says nothing was found and the model says so. Answers explain the material in the chat's own words.

Building the index (only needed once, or after adding material):

1. From the repo root: `bash rag/ocr_books.sh` (needs poppler and tesseract), then `python3 rag/ingest_books.py`. Source list: `rag/books.json`.
2. From `worker/`: `CLOUDFLARE_ACCOUNT_ID=<your account id> CLOUDFLARE_API_TOKEN=$(npx wrangler auth token) node scripts/embed-books.mjs` (never print or paste the token). The script resumes where it stopped.
3. From `worker/`: `npx wrangler vectorize insert jazz-books --file=../knowledge/vectors.ndjson` (insert skips ids already in the index; use `upsert` to re-embed).

For local debugging, `DEBUG_BOOKS=1` in `worker/.dev.vars` prints which passages were picked and their scores to the dev terminal.

## Project layout

```
index.html, app.js, style.css    chat page (lounge theme, chord-chart renderer, chart menu, setlist)
charts.js                        chart row layout (shared) and PDF export (jsPDF, loaded on demand)
setlist-print.js                 setlist "Print for" switch: re-asks chord_chart over /mcp for another instrument
docs.html, docs.js               "How it works" page (tool list loaded live via tools/list)
config.js                        Worker URL (local vs deployed)
worker/src/index.js              chat endpoint, system prompt, tool-use loop, provider fallback, source-tag filter
worker/src/mcp.js                hand-written MCP server (JSON-RPC 2.0); hides internal-only tools from /mcp
worker/src/mcp-client.js         in-process MCP client + MCP → OpenAI tool conversion
worker/src/tools.js              tool definitions and implementations
worker/src/voicings.js           chord-symbol grammar and note spelling (chord_voicings)
worker/src/books.js              reference search: embed, vector search, rerank, pick passages
worker/src/retry-wait.js         reads Groq's "try again in …" waits (435ms, 11.2s, 1m5.2s)
worker/scripts/import-charts.mjs chart export → chord library
worker/scripts/embed-books.mjs   reference chunks → vectors (Workers AI)
worker/test/voicings.test.js     chord-spelling tests
worker/test/album-lineup.test.js original-pressing choice (MusicBrainz stubbed, offline)
worker/test/instrument-charts.test.js  charts for Bb, Eb and F instruments
worker/test/setlist-print.test.js      setlist "Print for" switch, end to end through /mcp
rag/                             text extraction and chunking for the reference material
```

## Credits

Data from [Wikipedia](https://www.wikipedia.org), [MusicBrainz](https://musicbrainz.org), [All About Jazz](https://www.allaboutjazz.com), [Discogs](https://www.discogs.com), and the [Jazz Discography Project](https://www.jazzdisco.org). Embeddings and reranking by Cloudflare Workers AI (BAAI bge models).
