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

// Wikipedia and MusicBrainz both ask API clients to identify themselves.
const USER_AGENT = "JazzFactChat/0.3 (+https://github.com/YOUR-GITHUB-USERNAME/jazz-fact-chat)";
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESULT_CHARS = 4000; // tool results cost tokens on every later model round

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
export async function runTool(name, args) {
  const tool = BY_NAME.get(name);
  if (!tool) return { result: { error: `Unknown tool "${name}".` }, isError: true };
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { result: { error: "Tool arguments must be a JSON object." }, isError: true };
  }
  try {
    return { result: await tool.handler(args), isError: false };
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
