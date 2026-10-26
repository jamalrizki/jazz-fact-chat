/**
 * Jaizz Chat — spell any chord symbol, computed entirely in code.
 *
 * Why this exists (decision 19): the model got note spelling wrong ("G" as the
 * major 7th of A, G# in an A13) and ignored a prompt rule telling it not to
 * spell notes. Spelling is rule-based, so it lives here.
 *
 * The theory, in two rules (no per-chord tables):
 *  1. A chord symbol is a list of DEGREES counted from the root's major scale:
 *     3 = 3rd note of that scale, b7 = its 7th lowered, #11 = its 4th raised.
 *     The grammar below turns any standard symbol into that list:
 *       triad (C, Cm, Cdim, Caug, Csus4) + number (6, 7, 9, 11, 13, 6/9)
 *       + alterations (b5 #5 b9 #9 #11 b13) + add/omit + alt + /bass.
 *  2. Each degree is spelled by LETTER first (3rd = two letters above the root,
 *     5th = four, ...) and the accidental is whatever lands on the right pitch.
 *     So Amaj7 is A C# E G#, never Ab-style, and G#maj7 gets F## as its 7th.
 *
 * Chord-scale (optional): the usual textbook scale for the chord, chosen from its
 * 3rd, 5th, 7th and alterations (e.g. m7 -> Dorian, 7#11 -> Lydian dominant).
 * check_notes verifies notes from anywhere (a book, the model) against the chord and that scale.
 *
 * Pure functions, no network. The arguments are untrusted, so everything is
 * validated here, and nothing the caller typed is echoed back unless the whole
 * symbol parsed through the whitelist grammar.
 */

const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTALS = { "-2": "bb", "-1": "b", 0: "", 1: "#", 2: "##" };
const MAX_CHORD_CHARS = 24;
const MAX_CHECK_NOTES = 8;

// Every degree: letters above the root letter, semitones above the root (both from the root's major scale).
const DEGREES = {
  "1": [0, 0], "2": [1, 2], b3: [2, 3], "3": [2, 4], "4": [3, 5], b5: [4, 6], "5": [4, 7], "#5": [4, 8],
  "6": [5, 9], bb7: [6, 9], b7: [6, 10], "7": [6, 11],
  // Scale-only spellings of the same pitches as b9/#9/#11/b13, for named scales labelled 1-7.
  b2: [1, 1], "#2": [1, 3], "#4": [3, 6], b6: [5, 8],
  b9: [1, 13], "9": [1, 14], "#9": [1, 15], "11": [3, 17], "#11": [3, 18], b13: [5, 20], "13": [5, 21],
};
// Explicit: Object.keys() would put number-like keys ("3", "5", "9") before "b3", "b7".
const ORDER = ["1", "2", "b3", "3", "4", "b5", "5", "#5", "6", "bb7", "b7", "7", "b9", "9", "#9", "11", "#11", "b13", "13"];
const EXTENSION_DEGREES = new Set(["b9", "9", "#9", "11", "#11", "b13", "13"]);
const INVERSION_NAMES = ["root position", "1st inversion", "2nd inversion", "3rd inversion", "4th inversion", "5th inversion"];

const mod = (n, m) => ((n % m) + m) % m;
const unreadable = () =>
  new Error("Could not read that chord symbol. Use standard symbols such as Cmaj7, Cm7b5, C7#9, C7alt, Csus4, C6/9, Cadd9 or C/E. Do not spell the notes yourself.");

/* ---------- spelling ---------- */

function spellDegree(rootLetter, rootPc, degree) {
  const [steps, semis] = DEGREES[degree];
  const letter = LETTERS[(LETTERS.indexOf(rootLetter) + steps) % 7];
  let diff = mod(rootPc + semis - NATURAL_PC[letter], 12);
  if (diff > 6) diff -= 12;
  if (Math.abs(diff) > 2) {
    throw new Error("Could not spell that chord with at most a double sharp or flat. Ask the user to use the enharmonic root (for example C instead of B#).");
  }
  return letter + ACCIDENTALS[diff];
}

/** "C#" -> "C♯", "Bbb" -> "B♭♭": only the accidental is converted, never the letter B. */
const pretty = (note) => note[0] + note.slice(1).replace(/#/g, "♯").replace(/b/g, "♭");
const prettyList = (notes) => notes.map(pretty).join(" ");
const notePc = (note) => mod(NATURAL_PC[note[0]] + [...note.slice(1)].reduce((s, c) => s + (c === "#" ? 1 : -1), 0), 12);
const rotate = (list, n) => [...list.slice(n), ...list.slice(0, n)];

/* ---------- parsing ---------- */

function normalize(raw) {
  return raw
    .replace(/♯/g, "#")
    .replace(/♭/g, "b")
    .replace(/[△]/g, "Δ")
    .replace(/[−–]/g, "-")
    .replace(/[\s(),]/g, "") // C7(b9, #11) -> C7b9#11
    .replace(/6\/9/g, "69");
}

/** Read the part after the root ("m7b5", "7alt", "maj9#11") into a sorted list of degrees. Throws on anything unknown. */
function parseQuality(q) {
  let i = 0;
  const take = (re) => {
    const m = q.slice(i).match(re);
    if (m) i += m[0].length;
    return m;
  };
  let third = "3", fifth = "5", sixth = null, seventh = null;
  let triad = "major", major7 = false, number = null, alt = false;
  const exts = new Set();

  // 1. Triad type
  if (take(/^(dim|o|°)/)) triad = "dim";
  else if (take(/^(ø|Ø)/)) triad = "halfdim";
  else if (take(/^(aug|\+)/)) triad = "aug";
  else if (take(/^(min|mi|m(?=add)|m(?!a)|-)/)) triad = "minor"; // "madd9" is minor; "ma7" is major

  // 2. Major-7th marker (also inside m(maj7), +maj7)
  const majorToken = take(/^(maj|Maj|MAJ|Ma|ma|M|Δ|\^)/);
  if (majorToken) major7 = true;

  // 3. Number
  const num = take(/^(69|13|11|9|7|6|5)/);
  if (num) number = num[1];
  if (majorToken && !number) {
    if (/^(Δ|\^)$/.test(majorToken[1])) number = "7"; // CΔ = Cmaj7
    else if (triad === "major") major7 = false; // Cmaj / CM = major triad
    else throw unreadable(); // CmM, C+M
  }
  if (majorToken && (number === "6" || number === "69")) major7 = false; // Cmaj6 = C6
  if (triad === "halfdim" && !number) number = "7";
  if (major7 && !["7", "9", "11", "13"].includes(number)) throw unreadable();

  if (triad === "minor" || triad === "dim" || triad === "halfdim") third = "b3";
  if (triad === "dim" || triad === "halfdim") fifth = "b5";
  if (triad === "aug") fifth = "#5";
  const seventhDegree = major7 ? "7" : triad === "dim" ? "bb7" : "b7";

  switch (number) {
    case "5":
      if (triad === "aug" && !majorToken) break; // C+5 = augmented triad
      if (triad !== "major" || majorToken) throw unreadable();
      third = null; // power chord
      break;
    case "6": sixth = "6"; break;
    case "69": sixth = "6"; exts.add("9"); break;
    case "7": seventh = seventhDegree; break;
    case "9": seventh = seventhDegree; exts.add("9"); break;
    case "11": seventh = seventhDegree; exts.add("9"); exts.add("11"); break;
    case "13":
      seventh = seventhDegree; exts.add("9"); exts.add("13");
      if (third === "b3") exts.add("11"); // m13 keeps the 11; on major/dominant 13ths it is left out by convention
      break;
  }

  // 4. Modifiers, in any order (none on a power chord: "C5b9" is not a real symbol)
  if (number === "5" && third === null && i < q.length) throw unreadable();
  while (i < q.length) {
    let m;
    if (take(/^alt/)) {
      alt = true;
    } else if ((m = take(/^sus(2|4)?/))) {
      third = m[1] === "2" ? "2" : "4";
    } else if ((m = take(/^add(b9|#9|9|#11|11|b13|13|2|4|6)/))) {
      if (m[1] === "6") sixth = "6";
      else exts.add(m[1]);
    } else if ((m = take(/^(omit|no)(3|5)/))) {
      if (m[2] === "3") third = null;
      else fifth = null;
    } else if ((m = take(/^([#b+-])(5|9|11|13)/))) {
      const d = (m[1] === "+" ? "#" : m[1] === "-" ? "b" : m[1]) + m[2];
      if (d === "b5" || d === "#5") fifth = d;
      else if (d === "b9" || d === "#9") { exts.delete("9"); exts.add(d); }
      else if (d === "#11") { exts.delete("11"); exts.add(d); }
      else if (d === "b13") { exts.delete("13"); exts.add(d); }
      else throw unreadable(); // b11, #13, ...
    } else if (take(/^\+$/)) {
      fifth = "#5"; // C7+
    } else {
      throw unreadable();
    }
  }

  if (alt) {
    // Altered dominant: 3rd, b7, and the altered 5ths/9ths (spelled b9 #9 #11 b13), no natural 5th.
    if (third !== "3" || seventh === "7" || sixth) throw unreadable();
    seventh = "b7";
    fifth = null;
    for (const d of ["9", "11", "13"]) exts.delete(d);
    for (const d of ["b9", "#9", "#11", "b13"]) exts.add(d);
  }

  const degrees = ["1", third, fifth, sixth, seventh, ...exts].filter(Boolean);
  return [...new Set(degrees)].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

/* ---------- chord-scale ---------- */

/** The usual textbook scale for a chord, from its degrees. Returns [name, degrees] or null when there is no clear default. */
function chooseScale(degrees) {
  const has = (d) => degrees.includes(d);
  let pick = null;
  if (has("b3") && has("b5") && has("bb7")) pick = ["whole-half diminished", ["1", "9", "b3", "11", "b5", "b13", "bb7", "7"]];
  else if (has("b3") && has("b5") && has("b7")) pick = has("9") ? ["Locrian ♮2", ["1", "9", "b3", "11", "b5", "b13", "b7"]] : ["Locrian", ["1", "b9", "b3", "11", "b5", "b13", "b7"]];
  else if (has("b3") && has("b5")) pick = null; // diminished triad: no single default
  else if (has("b3")) {
    if (has("7")) pick = ["melodic minor", ["1", "9", "b3", "11", "5", "13", "7"]];
    else if (has("b9")) pick = ["Phrygian", ["1", "b9", "b3", "11", "5", "b13", "b7"]];
    else if (has("b13")) pick = ["Aeolian (natural minor)", ["1", "9", "b3", "11", "5", "b13", "b7"]];
    else pick = ["Dorian", ["1", "9", "b3", "11", "5", "13", "b7"]];
  } else if (has("b7")) {
    const flat9 = has("b9"), sharp9 = has("#9"), sharp11 = has("#11"), flat13 = has("b13") || has("#5");
    // Phrygian dominant keeps the natural 5th, so only b9 + b13 with nothing else altered (C7#5b9 is altered).
    if (flat9 && has("b13") && !has("#5") && !has("b5") && !sharp9 && !sharp11) pick = ["Phrygian dominant", ["1", "b9", "3", "11", "5", "b13", "b7"]];
    else if ((flat9 || sharp9) && (flat13 || sharp11 || has("b5"))) pick = ["altered", ["1", "b9", "#9", "3", "#11", "b13", "b7"]];
    else if (flat9 || sharp9) pick = ["half-whole diminished", ["1", "b9", "#9", "3", "#11", "5", "13", "b7"]];
    else if (has("#5") || has("b5")) pick = ["whole tone", ["1", "9", "3", "#11", "#5", "b7"]]; // 7#5 and 7b5
    else if (has("b13")) pick = ["Mixolydian ♭13", ["1", "9", "3", "11", "5", "b13", "b7"]];
    else if (sharp11) pick = ["Lydian dominant", ["1", "9", "3", "#11", "5", "13", "b7"]];
    else if (has("3") || has("4")) pick = ["Mixolydian", ["1", "9", "3", "11", "5", "13", "b7"]];
  } else if (has("3")) {
    if (has("#5")) pick = has("7") ? ["Lydian augmented", ["1", "9", "3", "#11", "#5", "13", "7"]] : ["whole tone", ["1", "9", "3", "#11", "#5", "b7"]];
    else if (has("#11") || has("b5")) pick = ["Lydian", ["1", "9", "3", "#11", "5", "13", "7"]];
    else pick = ["major (Ionian)", ["1", "9", "3", "11", "5", "13", "7"]];
  }
  if (!pick) return null;
  // Spell the scale's #5/b13 the way the chord does (C7#5 has G#, so its scale does too).
  let [name, list] = pick;
  if (has("#5") && !has("b13")) list = list.map((d) => (d === "b13" ? "#5" : d));
  return [name, list];
}

/* ---------- named scales ---------- */

// Any scale by name, as degrees of the root's major scale (labelled 1-7), spelled with
// the same letter-first rule as the chords. The spellings match chooseScale above:
// altered = 1 b2 #2 3 #4 b6 b7 (C: C Db D# E F# Ab Bb), blues has a b5, bebop major a #5.
const NAMED_SCALES = [
  ["major (Ionian)", ["1", "2", "3", "4", "5", "6", "7"], ["major", "ionian"]],
  ["Dorian", ["1", "2", "b3", "4", "5", "6", "b7"], ["dorian"]],
  ["Phrygian", ["1", "b2", "b3", "4", "5", "b6", "b7"], ["phrygian"]],
  ["Lydian", ["1", "2", "3", "#4", "5", "6", "7"], ["lydian"]],
  ["Mixolydian", ["1", "2", "3", "4", "5", "6", "b7"], ["mixolydian"]],
  ["Aeolian (natural minor)", ["1", "2", "b3", "4", "5", "b6", "b7"], ["aeolian", "natural minor", "minor"]],
  ["Locrian", ["1", "b2", "b3", "4", "b5", "b6", "b7"], ["locrian"]],
  ["harmonic minor", ["1", "2", "b3", "4", "5", "b6", "7"], ["harmonic minor"]],
  ["melodic minor", ["1", "2", "b3", "4", "5", "6", "7"], ["melodic minor", "jazz minor"]],
  ["Dorian ♭2", ["1", "b2", "b3", "4", "5", "6", "b7"], ["dorian b2", "phrygian nat 6", "phrygian 6"]],
  ["Lydian augmented", ["1", "2", "3", "#4", "#5", "6", "7"], ["lydian augmented", "lydian #5"]],
  ["Lydian dominant", ["1", "2", "3", "#4", "5", "6", "b7"], ["lydian dominant", "lydian b7", "overtone"]],
  ["Mixolydian ♭13", ["1", "2", "3", "4", "5", "b6", "b7"], ["mixolydian b13", "mixolydian b6", "aeolian dominant"]],
  ["Locrian ♮2", ["1", "2", "b3", "4", "b5", "b6", "b7"], ["locrian nat 2", "locrian 2", "locrian #2", "half diminished"]],
  ["altered", ["1", "b2", "#2", "3", "#4", "b6", "b7"], ["altered", "super locrian", "diminished whole tone"]],
  ["Phrygian dominant", ["1", "b2", "3", "4", "5", "b6", "b7"], ["phrygian dominant", "spanish phrygian"]],
  ["whole tone", ["1", "2", "3", "#4", "#5", "b7"], ["whole tone"]],
  ["half-whole diminished", ["1", "b2", "#2", "3", "#4", "5", "6", "b7"], ["half whole diminished", "half whole", "dominant diminished"]],
  ["whole-half diminished", ["1", "2", "b3", "4", "b5", "b6", "bb7", "7"], ["whole half diminished", "whole half", "diminished"]],
  ["major pentatonic", ["1", "2", "3", "5", "6"], ["major pentatonic", "pentatonic"]],
  ["minor pentatonic", ["1", "b3", "4", "5", "b7"], ["minor pentatonic"]],
  ["blues", ["1", "b3", "4", "b5", "5", "b7"], ["blues", "minor blues"]],
  ["major blues", ["1", "2", "b3", "3", "5", "6"], ["major blues"]],
  ["bebop dominant", ["1", "2", "3", "4", "5", "6", "b7", "7"], ["bebop dominant", "bebop"]],
  ["bebop major", ["1", "2", "3", "4", "5", "#5", "6", "7"], ["bebop major"]],
];
const SCALE_BY_ALIAS = new Map(NAMED_SCALES.flatMap((s) => s[2].map((a) => [a, s])));
const MAX_SCALE_NAME_CHARS = 30;

/** "Harmonic-Minor scale", "Locrian ♮2", "super-locrian mode" -> alias key. Never echoed back. */
function scaleKey(raw) {
  return raw
    .toLowerCase()
    .replace(/♭/g, "b")
    .replace(/♯/g, "#")
    .replace(/♮|natural(?= ?\d)/g, "nat ")
    .replace(/\bflat ?(?=\d)/g, "b")
    .replace(/\bsharp ?(?=\d)/g, "#")
    .replace(/[-_()]/g, " ")
    .replace(/\b(scale|mode)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const prettyDegree = (d) => d.replace(/#/g, "♯").replace(/b/g, "♭");

function namedScale(letter, root, rootPc, scaleName, checkNotes) {
  const s = SCALE_BY_ALIAS.get(scaleKey(scaleName));
  if (!s) {
    throw new Error(`Unknown scale name. Known: ${NAMED_SCALES.map((x) => x[0]).join(", ")}. Do not spell the scale yourself.`);
  }
  const [name, list] = s;
  const tones = list.map((d) => ({ degree: d, note: spellDegree(letter, rootPc, d) }));
  const result = {
    found: true,
    root,
    scale: {
      name,
      degrees: list.map(prettyDegree).join(" "),
      text: prettyList(tones.map((t) => t.note)),
    },
  };
  if (checkNotes.length) {
    result.checked_notes = checkNotes.map((n) => {
      const exact = tones.find((t) => t.note === n);
      if (exact) return { note: n, status: "scale_tone", degree: exact.degree };
      const same = tones.find((t) => notePc(t.note) === notePc(n));
      if (same) return { note: n, status: "wrong_spelling", should_be: same.note, degree: same.degree };
      return { note: n, status: "outside" };
    });
    result.checked_against = `the ${root} ${name} scale`;
    result.all_notes_ok = result.checked_notes.every((c) => c.status === "scale_tone");
  }
  result.note =
    "Note names are exact: copy them, add nothing." +
    (checkNotes.length ? " wrong_spelling: use should_be. outside: not in the scale." : "");
  return result;
}

/* ---------- the tool ---------- */

/**
 * The parser reads "6/9" as "69" (so the slash isn't taken for a bass note), but the
 * echoed symbol should look the way musicians write it: C6/9, not C69. The quality has
 * already parsed through the whitelist grammar, where "69" only ever means 6/9.
 */
const displayQuality = (quality) => quality.replace("69", "6/9");

function describe(letter, root, rootPc, quality, bass, { scale = false, checkNotes = [] } = {}) {
  const degrees = parseQuality(quality);
  const spell = (d) => spellDegree(letter, rootPc, d);
  const tones = degrees.map((d) => ({ degree: d, note: spell(d) }));

  // Inversions rotate the chord's own stack (root to 7th); extensions stay on top and aren't rotated.
  const core = tones.filter((t) => !EXTENSION_DEGREES.has(t.degree)).map((t) => t.note);
  const result = {
    found: true,
    chord: root + displayQuality(quality) + (bass ? "/" + bass : ""),
    chord_tones: tones,
    chord_tones_text: prettyList(tones.map((t) => t.note)),
    inversions: core.map((_, i) => `${INVERSION_NAMES[i]}: ${prettyList(rotate(core, i))}`),
    rootless: prettyList(tones.slice(1).map((t) => t.note)),
  };

  if (bass) {
    const t = tones.find((x) => x.note === bass);
    result.bass = t ? { note: bass, degree: t.degree } : { note: bass, in_chord: false };
  }

  const chosen = scale || checkNotes.length ? chooseScale(degrees) : null;
  if (scale) {
    result.scale = chosen ? { name: chosen[0], text: prettyList(chosen[1].map(spell)) } : null;
  }

  if (checkNotes.length) {
    const candidates = tones.map((t) => ({ ...t, kind: t.degree === "1" ? "root" : "chord_tone" }));
    for (const d of chosen ? chosen[1] : []) {
      const note = spell(d);
      if (!candidates.some((c) => notePc(c.note) === notePc(note))) candidates.push({ degree: d, note, kind: "scale_tone" });
    }
    result.checked_notes = checkNotes.map((n) => {
      const exact = candidates.find((c) => c.note === n);
      if (exact) return { note: n, status: exact.kind, degree: exact.degree };
      const same = candidates.find((c) => notePc(c.note) === notePc(n));
      if (same) return { note: n, status: "wrong_spelling", should_be: same.note, degree: same.degree };
      return { note: n, status: "outside" };
    });
    result.checked_against = chosen ? `chord tones and the ${chosen[0]} scale` : "chord tones only";
    result.all_notes_ok = result.checked_notes.every((c) => ["root", "chord_tone", "scale_tone"].includes(c.status));
  }

  // Short on purpose: the whole result is sent to the model on every call.
  result.note =
    "Note names are exact: copy them, add nothing." +
    (scale && chosen ? " The scale is the usual textbook choice; others are possible." : "") +
    (checkNotes.length ? " wrong_spelling: use should_be. outside: not in the chord or its scale." : "");
  return result;
}

/**
 * The tool. Throws Error for bad arguments and unreadable chords (runTool turns
 * a throw into an isError result). A bare root is NOT an error: it returns
 * labelled examples and asks which quality, instead of assuming one.
 */
export function chordVoicings(args = {}) {
  const { chord, scale, scale_name: scaleName, check_notes: checkNotesArg } = args;
  if (typeof chord !== "string" || !chord.trim()) throw new Error('"chord" must be a non-empty string such as "Amaj7"');
  if (chord.length > MAX_CHORD_CHARS) throw new Error('"chord" is too long');
  if (scale !== undefined && scale !== null && typeof scale !== "boolean") throw new Error('"scale" must be true or false');
  const hasScaleName = scaleName !== undefined && scaleName !== null;
  if (hasScaleName && (typeof scaleName !== "string" || !scaleName.trim() || scaleName.length > MAX_SCALE_NAME_CHARS)) {
    throw new Error(`"scale_name" must be a scale name of at most ${MAX_SCALE_NAME_CHARS} characters, e.g. "harmonic minor"`);
  }

  let checkNotes = [];
  if (checkNotesArg !== undefined && checkNotesArg !== null) {
    const bad = () => new Error(`"check_notes" must be a list of at most ${MAX_CHECK_NOTES} note names such as C, Eb, F#`);
    if (!Array.isArray(checkNotesArg) || checkNotesArg.length > MAX_CHECK_NOTES) throw bad();
    checkNotes = checkNotesArg.map((n) => {
      if (typeof n !== "string") throw bad();
      const x = normalize(n);
      if (!/^[A-G](##|#|bb|b)?$/.test(x)) throw bad();
      return x;
    });
  }

  const match = normalize(chord).match(/^([A-G])(#|b)?([\s\S]*?)(?:\/([A-G](?:#|b)?))?$/);
  if (!match) throw new Error('"chord" must start with a capital note name A-G, e.g. "Amaj7" or "Bb7"');
  const [, letter, acc, quality, bass] = match;
  const root = letter + (acc || "");
  const rootPc = mod(NATURAL_PC[letter] + (acc === "#" ? 1 : acc === "b" ? -1 : 0), 12);

  if (hasScaleName) {
    if (quality !== "" || bass) throw new Error('With "scale_name", "chord" must be just the root note, e.g. "D" or "Bb".');
    return namedScale(letter, root, rootPc, scaleName, checkNotes);
  }

  if (quality === "" && !bass) {
    const ex = (q, label) => {
      const r = describe(letter, root, rootPc, q, null);
      return { chord: label, chord_tones: r.chord_tones_text, rootless: r.rootless };
    };
    return {
      found: false,
      needs_quality: true,
      root,
      message: `No quality given for ${root}. Ask which one, or show these labelled examples; do not pick one for the user.`,
      examples: [ex("", `${root} (major triad)`), ex("m", `${root}m`), ex("maj7", `${root}maj7`), ex("m7", `${root}m7`), ex("7", `${root}7`)],
    };
  }

  return describe(letter, root, rootPc, quality, bass || null, { scale: scale === true, checkNotes });
}
