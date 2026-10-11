/**
 * Jazz Fact Chat — theory-book retrieval (RAG).
 *
 * RAG = Retrieval-Augmented Generation. Instead of hoping the model remembers
 * what the books say, we:
 *   1. EMBED the question: an embedding model turns text into a list of numbers
 *      (a vector) so that texts with similar MEANING land close together.
 *   2. SEARCH a vector database (Cloudflare Vectorize) for the stored chunks
 *      whose vectors are nearest the question's vector.
 *   3. hand those chunks to the chat model as background to explain in its own words.
 *
 * Rule that makes it work: the SAME embedding model must be used at index time
 * (worker/scripts/embed-books.mjs) and at query time (here). Vectors from two
 * different models live in different "spaces" and can't be compared.
 *
 * The raw chunk text is copyrighted book material, so it only ever travels
 * Vectorize → this function → the chat loop → the model. It is never returned
 * by the public /mcp endpoint (see internalOnly in tools.js) or shown in the
 * tool trace (see index.js).
 */

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
export const EMBED_DIMS = 384;
// A reranker reads the question and each candidate passage TOGETHER and scores how well that passage
// answers that question. Embedding similarity (above) is fast but coarse: the question and every
// passage were turned into vectors separately, and for a small model the scores all bunch into a
// narrow band (0.73 to 0.79 for both on-topic and off-topic passages). So: embeddings fetch a wide
// candidate pool cheaply, then the reranker picks the best few.
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

const FETCH_K = 30;            // candidate pool pulled from Vectorize, then reranked (Vectorize allows up to 50 with metadata)
const RETURN_N = 3;            // passages given to the model (Groq's free tier allows ~8k tokens/minute)
const MIN_SCORE = 0.5;         // coarse floor on embedding similarity. It only drops garbage; the reranker does the real choosing.
const RERANK_MIN = 0.5;        // reranker scores run 0 to 1. On Oct 11 real data, on-topic passages scored 0.69-0.97 and off-topic ones 0.00-0.44.
const MAX_PASSAGE_CHARS = 2200;

/** "ligon-0042" → { book: "ligon", n: 42 } */
function idParts(id) {
  const m = /^(.*)-(\d+)$/.exec(String(id));
  return m ? { book: m[1], n: Number(m[2]) } : { book: String(id), n: -1 };
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return cut.slice(0, space > max * 0.8 ? space : max) + "…";
}

/**
 * Choose which matches to use. Pure function (no network), so it's easy to test.
 * Deterministic work lives in code, not the prompt: threshold, dedupe, size cap.
 */
export function pickPassages(matches, { max = RETURN_N, minScore = MIN_SCORE, minRerank = RERANK_MIN } = {}) {
  const picked = [];
  const reranked = matches.length > 0 && matches.every((m) => typeof m.rerank === "number");
  const ordered = [...matches]
    .filter((m) => m.score >= minScore && (!reranked || m.rerank >= minRerank))
    .sort((a, b) => (reranked ? b.rerank - a.rerank : b.score - a.score));
  for (const m of ordered) {
    if (picked.length >= max) break;
    const text = m.metadata?.text;
    if (typeof text !== "string" || !text.trim()) continue;
    const p = idParts(m.id);
    // Chunks overlap by 50 words, so the neighbour of one we already have is mostly repeated text.
    if (picked.some((q) => q.book === p.book && Math.abs(q.n - p.n) === 1)) continue;
    picked.push({ ...p, id: m.id, score: m.score, rerank: m.rerank, cite: m.metadata?.cite, text: clip(text, MAX_PASSAGE_CHARS) });
  }
  return picked;
}

/**
 * Score every candidate against the question with the reranker. Returns the matches with a numeric
 * `rerank` added, or null if anything about the reply looks wrong (then we fall back to embedding order,
 * so a reranker hiccup degrades the answer slightly instead of breaking the tool).
 */
async function rerank(query, matches, env) {
  const usable = matches.filter((m) => typeof m.metadata?.text === "string" && m.metadata.text.trim());
  if (usable.length < 2) return null;
  try {
    const out = await env.AI.run(RERANK_MODEL, {
      query,
      contexts: usable.map((m) => ({ text: m.metadata.text })),
      top_k: usable.length,
    });
    const rows = out?.response;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const scored = new Map();
    for (const r of rows) {
      if (!Number.isInteger(r?.id) || r.id < 0 || r.id >= usable.length || typeof r.score !== "number" || !Number.isFinite(r.score)) return null;
      scored.set(r.id, r.score);
    }
    if (scored.size !== usable.length) return null;
    return usable.map((m, i) => ({ ...m, rerank: scored.get(i) }));
  } catch (err) {
    console.warn("reranker failed, using embedding order:", err.message);
    return null;
  }
}

export async function searchBooks(query, env) {
  if (!env?.AI || !env?.BOOKS) {
    return {
      found: false,
      message: "The theory-book index isn't set up on this server. Tell the user that, and don't answer the theory question from memory.",
    };
  }

  // 1. Embed the question (same model as the index).
  const emb = await env.AI.run(EMBED_MODEL, { text: [query] });
  const vector = emb?.data?.[0];
  if (!Array.isArray(vector) || vector.length !== EMBED_DIMS) throw new Error("embedding failed");

  // 2. Nearest neighbours. returnMetadata "all" brings back the stored chunk text.
  const res = await env.BOOKS.query(vector, { topK: FETCH_K, returnMetadata: "all" });
  const candidates = res?.matches || [];
  const reranked = await rerank(query, candidates.filter((m) => m.score >= MIN_SCORE), env);
  const passages = pickPassages(reranked || candidates);

  // Local debugging only: set DEBUG_BOOKS=1 in worker/.dev.vars. Prints to the Worker's console
  // (the terminal running `npm run dev`), never into the response, the trace or the model's input.
  if (env.DEBUG_BOOKS === "1") {
    console.log("[books]", JSON.stringify({
      query,
      reranked: Boolean(reranked),
      pool: (reranked || candidates).map((m) => ({ id: m.id, sim: Number(m.score.toFixed(3)), rerank: m.rerank === undefined ? undefined : Number(m.rerank.toFixed(3)), cite: m.metadata?.cite })),
      used: passages.map((p) => ({ id: p.id, sim: Number(p.score.toFixed(3)), rerank: p.rerank === undefined ? undefined : Number(p.rerank.toFixed(3)), cite: p.cite, starts: p.text.slice(0, 200) })),
    }));
  }

  if (passages.length === 0) {
    return {
      found: false,
      message:
        "Nothing in the theory books matched that closely. Tell the user you couldn't find it in the reference books, and don't guess. " +
        "For facts about people, albums or recordings, try search_jazz instead.",
    };
  }

  return {
    found: true,
    passages: passages.map((p) => ({ text: p.text })),
    scores: passages.map((p) => Number(p.score.toFixed(3))), // for the debug trace only
    note:
      "Background from jazz-theory reference books. Explain it in your own words: do not quote or copy phrasing, " +
      "and do not name or cite the books or their authors. If the passages don't actually answer the question, say so instead of guessing.",
  };
}
