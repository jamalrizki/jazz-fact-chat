#!/usr/bin/env node
/**
 * Embed the book chunks with Workers AI (bge-small-en-v1.5, 384 dims) and write
 * Vectorize-ready NDJSON. Run from the worker/ folder:
 *
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/embed-books.mjs [--limit N] [--out FILE]
 *
 * - Resumable: vectors already in the output file are skipped, so a crash or Ctrl-C costs nothing.
 * - The token needs the "Workers AI" permission (account-level). It is read from the environment
 *   only: never put it in a file in this repo and never paste it into a chat.
 * - Input and output live in knowledge/ (gitignored: copyrighted text).
 *
 * The vector's metadata carries the chunk text (that's what search_theory_books returns to the
 * chat loop) plus the citation fields. Text ≤ ~3.7 KB, well under Vectorize's 10 KiB limit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);

const IN = path.resolve(opt("--in", path.join(here, "../../knowledge/chunks.jsonl")));
const OUT = path.resolve(opt("--out", path.join(here, "../../knowledge/vectors.ndjson")));
const SKIPPED = OUT.replace(/\.ndjson$/, "") + ".skipped.txt";
const LIMIT = Number(opt("--limit", 0)) || Infinity;
const BASE = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";
const MODEL = "@cf/baai/bge-small-en-v1.5"; // must match EMBED_MODEL in src/books.js
const DIMS = 384;
const BATCH = 20;

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!ACCOUNT || !TOKEN) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in this terminal first (see the steps).");
  process.exit(1);
}
if (!fs.existsSync(IN)) {
  console.error(`Can't find ${IN}. Run the ingest first (python3 rag/ingest_books.py).`);
  process.exit(1);
}

/** Table-of-contents / index pages: mostly page numbers. They'd match queries and say nothing. */
function isJunk(text) {
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length < 40) return true;
  const numeric = toks.filter((t) => /^[\dIVXivx.,()\-–]+$/.test(t)).length;
  return numeric / toks.length > 0.25;
}

const textToEmbed = (c) => (c.section ? `${c.section}. ${c.text}` : c.text);

function metadataFor(c) {
  const m = { book_id: c.book_id, book: c.book, author: c.author, cite: c.cite, text: c.text };
  if (c.section) m.section = c.section;
  if (c.page != null) m.page = c.page;
  return m;
}

// ---- resume: collect ids already written; drop a half-written last line ----
const done = new Set();
if (fs.existsSync(OUT)) {
  const good = [];
  for (const line of fs.readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).id); good.push(line); } catch { /* partial tail */ }
  }
  fs.writeFileSync(OUT, good.length ? good.join("\n") + "\n" : "");
}

const chunks = fs.readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const skipped = chunks.filter((c) => isJunk(c.text));
fs.writeFileSync(SKIPPED, skipped.map((c) => `${c.id}\t${c.text.slice(0, 80).replace(/\s+/g, " ")}`).join("\n") + "\n");
const todo = chunks.filter((c) => !isJunk(c.text) && !done.has(c.id)).slice(0, LIMIT);
console.log(`${chunks.length} chunks · ${skipped.length} skipped as contents/index pages (see ${path.basename(SKIPPED)}) · ${done.size} already embedded · ${todo.length} to do`);

async function embed(texts) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(`${BASE}/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: texts }),
      });
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retry: true });
      const body = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 403) {
        throw new Error(`HTTP ${res.status}: the API token was rejected. It needs the "Workers AI" permission on this account.`);
      }
      if (!res.ok || !body?.success) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body?.errors ?? "").slice(0, 300)}`);
      const data = body.result?.data;
      if (!Array.isArray(data) || data.length !== texts.length || data.some((v) => !Array.isArray(v) || v.length !== DIMS)) {
        throw new Error("unexpected embedding shape from Workers AI");
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (!err.retry && !/fetch failed|ECONN|ETIMEDOUT/i.test(err.message)) throw err;
      const wait = 1500 * attempt;
      console.warn(`  attempt ${attempt} failed (${err.message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

let words = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const vectors = await embed(batch.map(textToEmbed));
  const lines = batch.map((c, j) =>
    JSON.stringify({ id: c.id, values: vectors[j].map((x) => Math.round(x * 1e6) / 1e6), metadata: metadataFor(c) })
  );
  fs.appendFileSync(OUT, lines.join("\n") + "\n");
  words += batch.reduce((n, c) => n + c.words, 0);
  const doneNow = Math.min(i + BATCH, todo.length);
  if (doneNow % 200 === 0 || doneNow === todo.length) {
    // ~1.35 tokens per word; Workers AI bills this model at 1,841 neurons per million tokens (free: 10,000/day)
    console.log(`  ${doneNow}/${todo.length} embedded · ≈${Math.round((words * 1.35 * 1841) / 1e6)} neurons used this run`);
  }
}
console.log(`Done. ${OUT}`);
