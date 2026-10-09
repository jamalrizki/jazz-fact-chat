/**
 * Jazz Fact Chat — tools. The single source of truth.
 *
 * Each tool is defined ONCE, in MCP's native shape:
 *   name, title, description, inputSchema (JSON Schema), annotations, handler
 *
 * - The MCP server (mcp.js) publishes these as-is via tools/list.
 * - The chat loop (index.js) reaches them THROUGH the MCP client adapter
 *   (mcp-client.js), which converts them to the OpenAI "function" format the
 *   LLM providers expect. Same tool, two wire formats.
 *
 * The model only ever sees name + description + inputSchema. It decides whether
 * and how to call a tool from those words alone, so descriptions are written
 * like instructions to a colleague. Arguments come from the model (or any MCP
 * client), so handlers validate them like user input.
 */

import FACTS from "./jazz-facts.json" with { type: "json" };
import CHARTS from "./chord-charts.json" with { type: "json" };

// Wikipedia and MusicBrainz both ask API clients to identify themselves.
const USER_AGENT = "JazzFactChat/0.3 (+https://github.com/jamalrizki/jazz-fact-chat)";
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULT_CHARS = 5000; // tool results cost tokens on every later model round

/* ---------- definitions ---------- */

export const TOOLS = [
  {
    name: "lookup_musician",
    title: "Look up a jazz musician",
    description:
      "Get a short, factual biography of a jazz musician (or band) from Wikipedia. " +
      "Use this whenever the user asks who someone is, when they were born or died, what instrument they played, " +
      "or for background on their career. Prefer this over answering from memory.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The musician's or group's name, e.g. \"Mary Lou Williams\"." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    // Annotations are hints to MCP clients (not the model): this tool only reads,
    // and it reaches out to the open internet.
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: lookupMusician,
  },
  {
    name: "album_lineup",
    title: "Album personnel and release year",
    description:
      "Look up an album in MusicBrainz and return its release year and personnel (who played what). " +
      "ALWAYS use this for any question about who played on a record, its lineup, sidemen, or release year. " +
      "Never state album personnel from memory. Include the artist when you know it, because many albums share titles.",
    inputSchema: {
      type: "object",
      properties: {
        album: { type: "string", description: "Album title, e.g. \"Kind of Blue\"." },
        artist: { type: "string", description: "Leader or credited artist, e.g. \"Miles Davis\". Optional but strongly recommended." },
      },
      required: ["album"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: albumLineup,
  },
  {
    name: "search_jazz",
    title: "Search jazz sources",
    description:
      "General jazz research. Searches Wikipedia, plus All About Jazz, Discogs and the Jazz Discography Project " +
      "when available, and returns the most relevant passages with their URLs. Use it whenever you're not sure of " +
      "an answer, for anything specific or obscure (who a player recorded with, what albums someone played on, " +
      "how many records two musicians made together, session dates), and as the fallback when another tool finds nothing. " +
      "Write a focused query, e.g. \"Miles Davis John Coltrane albums together\".",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look up, in plain words." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: searchJazz,
  },
  {
    name: "random_jazz_fact",
    title: "Random jazz fact",
    description:
      "Return one random, pre-verified jazz fact from a curated list. Use when the user asks for a fun fact, trivia, " +
      "or something random about jazz. Do not use it to answer specific questions.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["any", "musician", "album", "history", "theory"],
          description: "Optional category. Defaults to \"any\".",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false }, // local data only
    handler: randomJazzFact,
  },
  {
    name: "chord_chart",
    title: "Chord chart for a tune",
    description:
      "Return the chord changes for a tune from the chord library (jazz standards, plus Brazilian, Latin, blues, country and pop songs), optionally transposed to any key. " +
      "Use this whenever the user asks for the chords, changes, a chord chart, or a lead sheet for a tune. " +
      "The result includes chart_text (plain text) and layout (the chart as written, iReal-style). " +
      "If the tune isn't in the library, the result suggests close matches; never improvise a chart instead.",
    inputSchema: {
      type: "object",
      properties: {
        tune: { type: "string", description: "Tune title, e.g. \"Autumn Leaves\" or \"rhythm changes\"." },
        key: {
          type: "string",
          description: "Optional target key, e.g. \"F\", \"Bb\", \"F#\". Omit to use the tune's usual key.",
        },
      },
      required: ["tune"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: chordChart,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function hasTool(name) {
  return BY_NAME.has(name);
}

/** The public definition, without the handler: what tools/list returns. */
export function publicDefinition({ name, title, description, inputSchema, annotations }) {
  return { name, title, description, inputSchema, annotations };
}

/**
 * Run one tool. Never throws: returns { result, isError }. A failure comes back
 * as data so the model can read what went wrong and tell the user.
 */
export async function runTool(name, args, env = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) return { result: { error: `Unknown tool "${name}".` }, isError: true };
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { result: { error: "Tool arguments must be a JSON object." }, isError: true };
  }
  try {
    return { result: await tool.handler(args, env), isError: false };
  } catch (err) {
    return { result: { error: `${name} failed: ${err.message}` }, isError: true };
  }
}

/** Serialize a tool result as text, trimmed so one big result can't blow the context. */
export function serializeResult(result) {
  const text = JSON.stringify(result);
  return text.length <= MAX_RESULT_CHARS ? text : text.slice(0, MAX_RESULT_CHARS) + "…(truncated)";
}

/* ---------- implementations ---------- */

async function lookupMusician({ name }) {
  name = requireString(name, "name", 100);

  // Step 1: search, so "Trane" or "mingus" still finds the right page.
  const searchUrl =
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" +
    encodeURIComponent(name);
  const search = await getJson(searchUrl);
  const hits = search?.query?.search || [];
  if (hits.length === 0) return { found: false, message: `No Wikipedia article found for "${name}".` };

  // Prefer a hit whose snippet looks like a musician; otherwise take the top hit.
  const musical = /jazz|musician|pianist|saxophon|trumpet|bassist|drummer|guitarist|singer|vocalist|composer|bandleader|band/i;
  const pick = hits.find((h) => musical.test(h.snippet || "")) || hits[0];

  // Step 2: the REST summary endpoint gives a clean plain-text intro.
  const summary = await getJson(
    "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(pick.title.replace(/ /g, "_"))
  );
  if (!summary) return { found: false, message: `Could not load the Wikipedia summary for "${pick.title}".` };
  if (summary.type === "disambiguation") {
    return {
      found: false,
      message: `"${pick.title}" is ambiguous on Wikipedia. Ask the user which person they mean.`,
      candidates: hits.map((h) => h.title),
    };
  }
  return {
    found: true,
    source: "Wikipedia",
    title: summary.title,
    description: summary.description || null,
    summary: summary.extract,
    url: summary?.content_urls?.desktop?.page || null,
  };
}

async function albumLineup({ album, artist }) {
  album = requireString(album, "album", 150);
  if (artist !== undefined && artist !== null && artist !== "") artist = requireString(artist, "artist", 100);
  else artist = null;

  // Step 1: search releases. MusicBrainz uses Lucene query syntax, so strip characters
  // that would break out of our quoted phrases.
  const clean = (s) => s.replace(/["\\]/g, " ").trim();
  let query = `release:"${clean(album)}"`;
  if (artist) query += ` AND artist:"${clean(artist)}"`;
  const search = await getJson(
    "https://musicbrainz.org/ws/2/release?fmt=json&limit=10&query=" + encodeURIComponent(query)
  );

  const candidates = (search?.releases || []).filter((r) => (r.score ?? 0) >= 80);
  if (candidates.length === 0) {
    return {
      found: false,
      message: `MusicBrainz has no release matching "${album}"${artist ? ` by ${artist}` : ""}.`,
    };
  }

  // Many pressings exist per album, and personnel credits are often on only one of them.
  // Try up to 3 pressings of the top match's release group and keep the best-credited one.
  const groupId = candidates[0]["release-group"]?.id;
  const sameAlbum = candidates.filter((r) => r["release-group"]?.id === groupId).slice(0, 3);

  let best = null;
  for (const [i, release] of sameAlbum.entries()) {
    if (i > 0) await sleep(1100); // MusicBrainz allows about 1 request per second
    const full = await getJson(
      `https://musicbrainz.org/ws/2/release/${release.id}?fmt=json` +
        "&inc=artist-credits+release-groups+artist-rels+recordings+recording-level-rels"
    );
    if (!full) continue;
    const parsed = parseRelease(full);
    if (!best || parsed.personnel.length > best.personnel.length) best = parsed;
    if (best.personnel.length >= 3) break; // good enough; don't spend more requests
  }
  if (!best) return { found: false, message: "MusicBrainz search matched, but the release details could not be loaded." };

  return {
    found: true,
    source: "MusicBrainz",
    ...best,
    note:
      best.personnel.length === 0
        ? "MusicBrainz lists this album but has no personnel credits for it. Tell the user that; do not fill in names from memory."
        : undefined,
  };
}

/* ---------- general search (the fallback) ---------- */

const STOPWORDS = new Set(("the and for with who what when where which how many much did does was were are " +
  "his her their about from that this have has had any some other play played playing record records").split(" "));
const SEARCH_SITES = ["allaboutjazz.com", "en.wikipedia.org", "discogs.com", "jazzdisco.org"];

function queryTerms(q) {
  return [...new Set(q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

/** Pick the passages of a Wikipedia article most relevant to the query. */
export function relevantExcerpt(text, query, limit = 900) {
  const terms = queryTerms(query);
  const wantsRecords = /album|record|discograph|played on|sideman|session|lineup|personnel/i.test(query);
  const parts = text.split(/\n(={2,})\s*(.+?)\s*\1\n/);
  const intro = parts[0].trim();
  const sections = [];
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    sections.push({ title: parts[i + 1], body: (parts[i + 2] || "").trim() });
  }
  const score = (sec) => {
    const t = sec.title.toLowerCase();
    const b = sec.body.toLowerCase();
    let sc = terms.reduce((n, w) => n + (t.includes(w) ? 3 : 0) + Math.min(b.split(w).length - 1, 5), 0);
    if (wantsRecords && /discograph|personnel|recordings|albums|as sideman|as leader/.test(t)) sc += 6;
    return sc;
  };
  // Within a long section, lines that mention the query come first.
  const condense = (body, max) => {
    if (body.length <= max) return body;
    const lines = body.split("\n").filter(Boolean);
    const hit = lines.filter((l) => terms.some((w) => l.toLowerCase().includes(w)));
    const rest = lines.filter((l) => !hit.includes(l));
    return [...hit, ...rest].join("\n").slice(0, max) + "…";
  };
  const top = sections
    .filter((s) => s.body)
    .map((s) => ({ ...s, sc: score(s) }))
    .filter((s) => s.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 2);
  let out = condense(intro, 300);
  for (const s of top) out += `\n\n## ${s.title}\n` + condense(s.body, Math.max(200, (limit - out.length) / 2));
  return out.slice(0, limit);
}

async function wikipediaSearch(query, pagesWanted = 2) {
  const search = await getJson(
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=" +
      encodeURIComponent(query)
  );
  const hits = (search?.query?.search || []).slice(0, pagesWanted);
  const pages = await Promise.all(
    hits.map(async (h) => {
      const data = await getJson(
        "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=wiki" +
          "&redirects=1&format=json&titles=" + encodeURIComponent(h.title)
      );
      const page = Object.values(data?.query?.pages || {})[0];
      if (!page?.extract) return null;
      return {
        source: "Wikipedia",
        title: page.title,
        url: "https://en.wikipedia.org/wiki/" + encodeURIComponent(page.title.replace(/ /g, "_")),
        excerpt: relevantExcerpt(page.extract, query),
      };
    })
  );
  return pages.filter(Boolean);
}

async function webSearch(query, apiKey) {
  // Tavily: a search API built for LLM apps (free tier, no card). Restricted to jazz reference sites.
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 3, search_depth: "basic", include_domains: SEARCH_SITES }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    source: new URL(r.url).hostname.replace(/^www\./, ""),
    title: r.title,
    url: r.url,
    excerpt: String(r.content || "").slice(0, 350),
  }));
}

async function searchJazz({ query }, env = {}) {
  query = requireString(query, "query", 200);
  const [wiki, web] = await Promise.allSettled([
    // With the web search available, one Wikipedia page is enough; keeps results small
    // (free-tier models have tight tokens-per-minute limits).
    wikipediaSearch(query, env.TAVILY_API_KEY ? 1 : 2),
    env.TAVILY_API_KEY ? webSearch(query, env.TAVILY_API_KEY) : Promise.resolve([]),
  ]);
  const results = [
    ...(web.status === "fulfilled" ? web.value : []),
    ...(wiki.status === "fulfilled" ? wiki.value : []),
  ];
  if (results.length === 0) {
    return {
      found: false,
      message: "No sources found for that. Tell the user you couldn't find it, and don't guess.",
    };
  }
  return {
    found: true,
    query,
    results,
    note: "Answer from these excerpts and name the site you used. If they don't actually contain the answer, say so instead of guessing.",
  };
}

function parseRelease(r) {
  const leader = (r["artist-credit"] || []).map((c) => c.name + (c.joinphrase || "")).join("").trim();

  // Credits live in two places: on the release itself and on each track's recording.
  const relations = [...(r.relations || [])];
  for (const medium of r.media || []) {
    for (const track of medium.tracks || []) relations.push(...(track.recording?.relations || []));
  }

  const byPerson = new Map(); // name -> Set of roles
  for (const rel of relations) {
    if (rel["target-type"] !== "artist" || !rel.artist?.name) continue;
    let roles;
    if (rel.type === "instrument") roles = rel.attributes?.length ? rel.attributes : ["instrument"];
    else if (rel.type === "vocal") roles = ["vocals"];
    else if (["performer", "conductor", "producer"].includes(rel.type)) roles = [rel.type];
    else continue; // skip engineers, mastering, artwork, etc.
    const set = byPerson.get(rel.artist.name) || new Set();
    roles.forEach((x) => set.add(x));
    byPerson.set(rel.artist.name, set);
  }

  const personnel = [...byPerson.entries()]
    .slice(0, 25)
    .map(([name, roles]) => ({ name, roles: [...roles] }));

  const firstDate = r["release-group"]?.["first-release-date"] || r.date || "";
  return {
    title: r.title,
    artist: leader || null,
    release_year: firstDate ? Number(firstDate.slice(0, 4)) : null,
    personnel,
    url: `https://musicbrainz.org/release/${r.id}`,
  };
}

async function randomJazzFact({ topic = "any" }) {
  const pool = topic && topic !== "any" ? FACTS.filter((f) => f.topic === topic) : FACTS;
  const list = pool.length ? pool : FACTS;
  const pick = list[Math.floor(Math.random() * list.length)];
  return { source: "curated list", topic: pick.topic, fact: pick.fact };
}

/* ---------- chord charts ----------
 * Transposition lives in code, not in the model, on purpose: it's exact
 * arithmetic, and LLMs routinely botch it (wrong accidentals, dropped bars).
 * A tool is the right home for anything deterministic.
 */

const PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SHARP_MAJOR_KEYS = new Set(["G", "D", "A", "E", "B", "F#", "C#"]);
const SHARP_MINOR_KEYS = new Set(["E", "B", "F#", "C#", "G#", "D#", "A#"]);

function noteToPc(letter, accidental) {
  return (PITCH[letter] + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0) + 12) % 12;
}

function parseKey(input) {
  const m = String(input).trim().match(/^([A-Ga-g])\s*(#|♯|sharp|b|♭|flat)?/i);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const acc = !m[2] ? "" : /^(#|♯|sharp)$/i.test(m[2]) ? "#" : "b";
  return { pc: noteToPc(letter, acc), name: letter + acc };
}

function transposeChord(chord, semis, names) {
  const m = chord.match(/^([A-G])([b#]?)(.*?)(?:\/([A-G])([b#]?))?$/);
  if (!m) return chord; // leave anything unexpected untouched
  const [, root, rootAcc, quality, bass, bassAcc] = m;
  const out = names[(noteToPc(root, rootAcc) + semis + 12) % 12] + quality;
  return bass ? `${out}/${names[(noteToPc(bass, bassAcc) + semis + 12) % 12]}` : out;
}

function normalizeTitle(s) {
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, "") // "bernies tune" should find "Bernie's Tune"
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\bthe\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const names = (c) => [c.title, ...(c.aliases || [])].map(normalizeTitle);

// Words that may wrap a title in a request ("autumn leaves chords in bb") without changing which tune is meant.
const REQUEST_FILLER = new Set(["in", "key", "of", "chord", "chords", "changes", "chart", "for", "lead", "sheet", "to", "major", "minor", "flat", "sharp"]);

// True when the request is the title n plus only filler words and/or a key name. This stops
// "stairway to heaven" from matching a different, shorter tune ("Heaven") that it merely contains.
function titlePlusFiller(q, n) {
  const padded = ` ${q} `;
  if (!padded.includes(` ${n} `)) return false;
  return padded.replace(` ${n} `, " ").split(" ").filter(Boolean).every((w) => REQUEST_FILLER.has(w) || /^[a-g]b?$/.test(w));
}

// Exact title/alias match first, then "starts with", then "contains" (shortest title wins).
function findChart(tune) {
  const q = normalizeTitle(tune);
  if (!q) return undefined;
  const exact = CHARTS.find((c) => names(c).includes(q));
  if (exact || q.length < 4) return exact;
  const byLength = (a, b) => a.title.length - b.title.length;
  const starts = CHARTS.filter((c) => names(c).some((n) => n.startsWith(q))).sort(byLength);
  if (starts.length) return starts[0];
  const contains = CHARTS.filter((c) => names(c).some((n) => n.includes(q) || (n.length >= 4 && titlePlusFiller(q, n)))).sort(byLength);
  return contains[0];
}

// Up to 8 titles sharing words with the query, so a miss costs a few tokens, not the whole catalog.
function suggestCharts(tune) {
  const words = normalizeTitle(tune).split(" ").filter((w) => w.length >= 3);
  const scored = CHARTS.map((c) => ({
    title: c.title,
    score: words.filter((w) => normalizeTitle(c.title).includes(w)).length,
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return scored.slice(0, 8).map((x) => x.title);
}

async function chordChart({ tune, key }) {
  tune = requireString(tune, "tune", 100);
  const chart = findChart(tune);
  if (!chart) {
    return {
      found: false,
      message: `"${tune}" isn't in the chord-chart library (${CHARTS.length} tunes). Tell the user that, and mention any close matches in "suggestions". Do not write a chart for it from memory.`,
      suggestions: suggestCharts(tune),
    };
  }

  const original = parseKey(chart.key);
  let target = original;
  if (key !== undefined && key !== null && key !== "") {
    target = parseKey(requireString(key, "key", 20));
    if (!target) throw new Error(`"${key}" is not a key I understand. Use a note name like F, Bb, or F#.`);
  }
  const semis = (target.pc - original.pc + 12) % 12;
  const sharpSet = chart.mode === "minor" ? SHARP_MINOR_KEYS : SHARP_MAJOR_KEYS;
  const useSharps = sharpSet.has(target.name);
  const names = useSharps ? SHARP_NAMES : FLAT_NAMES;
  const keyName = semis === 0 ? chart.key : names[target.pc];

  const tx = (c) => (semis === 0 ? c : transposeChord(c, semis, names));
  const sections = chart.sections.map((sec) => ({
    label: sec.label,
    bars: sec.bars.map((bar) => bar.split(" ").map(tx).join(" ")),
  }));
  // The chart as written (repeats, endings, codas in place). Hand-curated charts
  // don't have one, so build a simple version from their sections.
  const written = (chart.written || writtenFromSections(chart.sections)).map((b) => (b.c ? { ...b, c: b.c.map(tx) } : { ...b }));

  const totalBars = sections.reduce((n, s) => n + s.bars.length, 0);
  const keyLabel = `${keyName} ${chart.mode}`;
  const lines = [`${chart.title} (${chart.composer}) · ${keyLabel} · ${chart.form}`];
  for (const sec of sections) {
    for (let i = 0; i < sec.bars.length; i += 4) {
      const label = (i === 0 ? sec.label : "").padEnd(2, " ");
      lines.push(`${label} | ${sec.bars.slice(i, i + 4).join(" | ")} |`);
    }
  }

  return {
    found: true,
    source: chart.source || "curated chord library",
    title: chart.title,
    composer: chart.composer,
    key: keyLabel,
    transposed: semis !== 0,
    form: chart.form,
    bars: totalBars,
    chart_text: lines.join("\n"),
    layout: { style: chart.style || null, bars: written },
    note: "Common changes as typically played. Published versions and players' reharmonizations vary.",
  };
}

function writtenFromSections(sections) {
  const out = [];
  sections.forEach((sec, si) => {
    sec.bars.forEach((bar, bi) => {
      const b = { c: bar.split(" ") };
      if (bi === 0) {
        if (sec.label) b.l = sec.label;
        if (si > 0) b.o = "[";
      }
      if (bi === sec.bars.length - 1) b.e = si === sections.length - 1 ? "Z" : "]";
      out.push(b);
    });
  });
  if (out.length) out[0].t = "4/4";
  return out;
}

/* ---------- helpers ---------- */

function requireString(value, field, maxLen) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${field}" must be a non-empty string`);
  if (value.length > maxLen) throw new Error(`"${field}" is too long`);
  return value.trim();
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
