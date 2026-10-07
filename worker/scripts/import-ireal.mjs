#!/usr/bin/env node
/**
 * Import iReal Pro exports into the chord_chart library.
 *
 *   npm run import -- ../../my-playlist.html [more files...]
 *
 * Reads iReal Pro "irealb://" exports (the HTML file or a text file holding the
 * link), converts every song to the app's chart format, and writes
 * src/chord-charts.json = imported charts + any hand-curated sample charts whose
 * titles weren't imported. That output file is gitignored on purpose: the full
 * library is deployed with the Worker but never published in the repo.
 *
 * Decoding notes: the irealb format and its "obfusc50" scrambling are
 * documented by ironss/accompaniser and pianosnake/ireal-reader (MIT); the
 * decoding below follows them. The chart parser is our own, because we need
 * section letters, endings, and alternate chords handled differently.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, "../src/chord-charts.sample.json");
const OUT = join(HERE, "../src/chord-charts.json");
const MUSIC_PREFIX = "1r34LbKcu7";

/* ---------- 1. decode the irealb:// link ---------- */

function obfusc50(s) {
  const a = s.split("");
  for (let i = 0; i < 5; i++) [a[i], a[49 - i]] = [s[49 - i], s[i]];
  for (let i = 10; i < 24; i++) [a[i], a[49 - i]] = [s[49 - i], s[i]];
  return a.join("");
}

function unscramble(s) {
  let r = "";
  while (s.length > 50) {
    const p = s.slice(0, 50);
    s = s.slice(50);
    r += s.length < 2 ? p : obfusc50(p);
  }
  return r + s;
}

export function decodeExport(text) {
  const links = [...text.matchAll(/irealb:\/\/([^"'\s<>]+)/g)].map((m) => decodeURIComponent(m[1]));
  if (links.length === 0) throw new Error("No irealb:// link found. Export in iReal Pro format (HTML), not PDF or MusicXML.");
  const songs = [];
  for (const link of links) {
    const parts = link.split("===");
    if (parts.length > 1 && !parts[parts.length - 1].includes(MUSIC_PREFIX)) parts.pop(); // playlist name
    for (const raw of parts) {
      const fields = raw.split("=");
      const musicIdx = fields.findIndex((f) => f.startsWith(MUSIC_PREFIX));
      if (musicIdx < 0) continue;
      const nonEmpty = fields.slice(0, musicIdx).filter((f) => f !== "");
      const [title, composer, style, key] = nonEmpty;
      songs.push({
        title,
        composer,
        style,
        key,
        music: unscramble(fields[musicIdx].slice(MUSIC_PREFIX.length)),
      });
    }
  }
  return songs;
}

/* ---------- 2. iReal chord symbols → standard symbols ---------- */

// iReal qualities, longest first so the tokenizer matches greedily but safely.
const QUALITIES = [
  "7b9#11", "7b9b13", "7#9#11", "7#9b5", "7#9#5", "7b9b5", "7b9#5", "7b9#9", "7b9sus", "7susadd3", "7b13sus",
  "-^7", "-^9", "^7#11", "^9#11", "^7#5", "13#11", "13#9", "13b9", "13sus", "9#11", "9b5", "9#5", "9sus",
  "7#11", "7b13", "7alt", "7sus", "7b9", "7#9", "7b5", "7#5", "-7b5", "-b6", "-#5", "-11", "-69", "-7", "-9", "-6",
  "^13", "^7", "^9", "add9", "sus", "h7", "h9", "o7", "69", "13", "11", "9", "7", "6", "5", "2",
  "-", "^", "h", "o", "+", "",
].sort((a, b) => b.length - a.length);

const QUALITY_MAP = {
  "-^7": "mMaj7", "-^9": "mMaj9", "-7b5": "m7b5", "-": "m", "^": "maj7", "h": "m7b5", "h7": "m7b5", "h9": "m9b5",
  "o": "dim", "o7": "dim7", "+": "aug", "69": "6/9", "-69": "m6/9", "2": "add9", "5": "5", "-b6": "mb6", "-#5": "m#5",
};

export function convertQuality(q) {
  if (q in QUALITY_MAP) return QUALITY_MAP[q];
  return q.replace(/^-/, "m").replace(/\^/g, "maj");
}

/* ---------- 3. music string → sections of bars ---------- */

export function parseMusic(music) {
  const bars = []; // { label, chords: [] }
  let cur = { label: "", chords: [] };
  let pendingLabel = "";
  let lastChord = null;
  let repeatStart = null; // index into bars where "{" began
  let ending1Start = null;
  const notes = new Set();
  let time = null;

  const closeBar = () => {
    if (cur.chords.length) {
      bars.push(cur);
    }
    cur = { label: "", chords: [] };
  };
  const startBar = () => {
    if (pendingLabel && !cur.label) {
      cur.label = pendingLabel;
      pendingLabel = "";
    }
  };
  const copyBars = (from, to) => bars.slice(from, to).map((b) => ({ label: b.label, chords: [...b.chords] }));

  let i = 0;
  const s = music;
  while (i < s.length) {
    const rest = s.slice(i);
    let m;

    if (rest.startsWith("XyQ")) { i += 3; continue; }
    if ((m = rest.match(/^\*(\w)/))) {
      const l = m[1];
      pendingLabel = l === "i" ? "In" : l === "V" ? "V" : l;
      if (!cur.chords.length) { cur.label = ""; startBar(); }
      i += 2; continue;
    }
    if ((m = rest.match(/^<([^>]*)>/))) {
      const c = m[1].toLowerCase();
      if (/d\.?c\.|d\.?s\.|coda|fine/.test(c)) notes.add(m[1].trim());
      i += m[0].length; continue;
    }
    if ((m = rest.match(/^T(\d)(\d)/))) { time = `${m[1]}/${m[2]}`; i += 3; continue; }
    if ((m = rest.match(/^\(([^)]*)\)/))) { i += m[0].length; continue; } // alternate chord: skip
    if (rest.startsWith("Kcl")) {
      closeBar();
      const prev = bars[bars.length - 1];
      if (prev) bars.push({ label: "", chords: [...prev.chords] });
      i += 3; continue;
    }
    if (rest.startsWith("r|XyQ") || (rest[0] === "r" && !/^[A-G]/.test(rest))) {
      // repeat previous two bars
      closeBar();
      const two = copyBars(bars.length - 2, bars.length).map((b) => ({ ...b, label: "" }));
      bars.push(...two);
      i += rest.startsWith("r|XyQ") ? 5 : 1; continue;
    }
    if (rest[0] === "x") {
      const prev = bars[bars.length - 1];
      if (prev && !cur.chords.length) cur.chords.push(...prev.chords);
      i += 1; continue;
    }
    if ((m = rest.match(/^N(\d)/))) {
      closeBar();
      const n = Number(m[1]);
      if (n === 1) ending1Start = bars.length;
      else if (repeatStart !== null && ending1Start !== null) {
        // Second (or third) ending: replay the repeated part up to ending 1, then continue.
        bars.push(...copyBars(repeatStart, ending1Start));
      }
      i += 2; continue;
    }
    if (rest[0] === "{") { closeBar(); repeatStart = bars.length; ending1Start = null; startBar(); i += 1; continue; }
    if (rest[0] === "}") {
      closeBar();
      if (repeatStart !== null && ending1Start === null) bars.push(...copyBars(repeatStart, bars.length));
      // with endings, the replay happens at N2
      i += 1; continue;
    }
    if (rest.startsWith("LZ") || "|[]Z".includes(rest[0])) {
      closeBar();
      startBar();
      i += rest.startsWith("LZ") ? 2 : 1; continue;
    }
    if (rest[0] === "n") { startBar(); cur.chords.push("N.C."); i += 1; continue; }
    if (rest[0] === "S") { notes.add("Segno"); i += 1; continue; }
    if (rest[0] === "Q") { notes.add("Coda"); i += 1; continue; }

    // Chord: root (or W = invisible root), quality, optional slash bass.
    if ((m = rest.match(/^([A-GW])([b#]?)/))) {
      let j = m[0].length;
      const after = rest.slice(j);
      const q = QUALITIES.find((qq) => after.startsWith(qq)) ?? "";
      j += q.length;
      let bass = "";
      const bm = rest.slice(j).match(/^\/([A-G][b#]?)/);
      if (bm) { bass = "/" + bm[1]; j += bm[0].length; }
      let root = m[1] + m[2];
      if (m[1] === "W") root = lastChord ? lastChord.root : "";
      if (root) {
        const quality = m[1] === "W" ? lastChord.quality : convertQuality(q);
        startBar();
        cur.chords.push(root + quality + bass);
        lastChord = { root, quality };
      }
      i += j; continue;
    }

    i += 1; // spacers (Y), commas, size marks (s/l), pause slashes (p), fermatas (f), U, etc.
  }
  closeBar();

  // Group bars into sections at each label.
  const sections = [];
  for (const b of bars) {
    if (!sections.length || b.label) sections.push({ label: b.label || "", bars: [] });
    sections[sections.length - 1].bars.push(b.chords.join(" "));
  }
  return { sections, notes: [...notes], time };
}

/* ---------- 4. song → library entry ---------- */

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function fixTitle(t) {
  const m = t.match(/^(.*),\s*(The|A|An)$/i);
  return (m ? `${m[2]} ${m[1]}` : t).trim();
}

function fixComposer(c) {
  if (!c) return "unknown";
  const parts = c.trim().split(/\s+/);
  return parts.length === 2 ? `${parts[1]} ${parts[0]}` : c.trim(); // iReal stores "Last First"
}

export function toEntry(song) {
  const { sections, notes, time } = parseMusic(song.music);
  const keyRaw = (song.key || "C").trim();
  const minor = keyRaw.endsWith("-");
  const key = keyRaw.replace(/-$/, "");
  if (!/^[A-G][b#]?$/.test(key) || PC[key[0]] === undefined) throw new Error(`unrecognized key "${song.key}"`);
  const total = sections.reduce((n, s) => n + s.bars.length, 0);
  if (total === 0) throw new Error("no bars parsed");
  const letters = sections.map((s) => s.label).filter(Boolean).join("");
  const form = [letters ? `${letters}, ${total} bars` : `${total} bars`, time && time !== "4/4" ? time : null]
    .filter(Boolean)
    .join(" · ");
  const entry = {
    title: fixTitle(song.title),
    aliases: [],
    composer: fixComposer(song.composer),
    key,
    mode: minor ? "minor" : "major",
    form,
    sections,
    source: "iReal Pro",
  };
  if (notes.length) entry.notes = notes;
  return entry;
}

/* ---------- 5. CLI ---------- */

function normalize(t) {
  return t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\bthe\b/g, " ").replace(/\s+/g, " ").trim();
}

function main(files) {
  if (!files.length) {
    console.error("Usage: npm run import -- <ireal-export.html> [more files...]");
    process.exit(1);
  }
  const imported = [];
  const failed = [];
  for (const f of files) {
    for (const song of decodeExport(readFileSync(f, "utf8"))) {
      try { imported.push(toEntry(song)); }
      catch (e) { failed.push(`${song.title}: ${e.message}`); }
    }
  }
  // De-duplicate by title (first one wins).
  const seen = new Set();
  const unique = imported.filter((e) => !seen.has(normalize(e.title)) && seen.add(normalize(e.title)));

  // Keep hand-curated sample charts only for titles iReal didn't supply.
  const sample = existsSync(SAMPLE) ? JSON.parse(readFileSync(SAMPLE, "utf8")) : [];
  const extras = sample.filter((c) => !seen.has(normalize(c.title)));
  const library = [...unique, ...extras].sort((a, b) => a.title.localeCompare(b.title));

  writeFileSync(OUT, JSON.stringify(library) + "\n");
  const kb = (Buffer.byteLength(JSON.stringify(library)) / 1024).toFixed(0);
  console.log(`Imported ${unique.length} charts (+${extras.length} curated extras) → src/chord-charts.json (${kb} KB)`);
  if (failed.length) console.log(`Skipped ${failed.length}:\n  ` + failed.slice(0, 20).join("\n  "));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
