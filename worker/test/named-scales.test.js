// Tests for named scales in chord_voicings (scale_name + a bare root). Pure code, no network.
// Run from worker/:  npm test
import test from "node:test";
import assert from "node:assert/strict";
import { chordVoicings } from "../src/voicings.js";
import { runTool } from "../src/tools.js";
import { handleRpc } from "../src/mcp.js";

const spell = (chord, scale_name) => chordVoicings({ chord, scale_name }).scale.text;

test("every named scale, in C", () => {
  const cases = {
    major: "C D E F G A B", Dorian: "C D E♭ F G A B♭", Phrygian: "C D♭ E♭ F G A♭ B♭", Lydian: "C D E F♯ G A B",
    Mixolydian: "C D E F G A B♭", Aeolian: "C D E♭ F G A♭ B♭", Locrian: "C D♭ E♭ F G♭ A♭ B♭",
    "harmonic minor": "C D E♭ F G A♭ B", "melodic minor": "C D E♭ F G A B", "Dorian b2": "C D♭ E♭ F G A B♭",
    "Lydian augmented": "C D E F♯ G♯ A B", "Lydian dominant": "C D E F♯ G A B♭", "Mixolydian b13": "C D E F G A♭ B♭",
    "Locrian ♮2": "C D E♭ F G♭ A♭ B♭", altered: "C D♭ D♯ E F♯ A♭ B♭", "Phrygian dominant": "C D♭ E F G A♭ B♭",
    "whole tone": "C D E F♯ G♯ B♭", "half-whole diminished": "C D♭ D♯ E F♯ G A B♭",
    "whole-half diminished": "C D E♭ F G♭ A♭ B♭♭ B", "major pentatonic": "C D E G A", "minor pentatonic": "C E♭ F G B♭",
    blues: "C E♭ F G♭ G B♭", "major blues": "C D E♭ E G A", "bebop dominant": "C D E F G A B♭ B", "bebop major": "C D E F G G♯ A B",
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(spell("C", name), expected, name);
});

test("spelled by letter in any key: sharps, flats, double sharps", () => {
  assert.equal(spell("D", "harmonic minor"), "D E F G A B♭ C♯");
  assert.equal(spell("G#", "harmonic minor"), "G♯ A♯ B C♯ D♯ E F♯♯"); // F## is the raised 7th
  assert.equal(spell("Bb", "bebop dominant"), "B♭ C D E♭ F G A♭ A");
  assert.equal(spell("Eb", "blues"), "E♭ G♭ A♭ B♭♭ B♭ D♭");
  assert.equal(spell("F#", "Lydian"), "F♯ G♯ A♯ B♯ C♯ D♯ E♯");
  assert.equal(spell("G", "altered"), "G A♭ A♯ B C♯ E♭ F");
  assert.equal(spell("A", "minor pentatonic"), "A C D E G");
  // a seven-note mode uses all seven letters once, in every key
  for (const root of ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]) {
    const r = chordVoicings({ chord: root, scale_name: "Dorian" });
    const letters = r.scale.text.split(" ").map((n) => n[0]);
    assert.equal(new Set(letters).size, 7, root);
  }
});

test("the named scales agree with the chord-scales scale: true already picks", () => {
  const pairs = [["Cm7", "Dorian"], ["C7#11", "Lydian dominant"], ["C7alt", "altered"], ["Cm7b5", "Locrian"], ["Cmaj7", "major"], ["CmMaj7", "melodic minor"], ["C7#5", "whole tone"], ["C7b9", "half-whole diminished"], ["Cdim7", "whole-half diminished"]];
  for (const [chord, name] of pairs) {
    const fromChord = chordVoicings({ chord, scale: true }).scale.text.split(" ").sort().join(" ");
    assert.equal(spell("C", name).split(" ").sort().join(" "), fromChord, `${chord} / ${name}`);
  }
});

test("name variants: case, hyphens, 'scale'/'mode', ♭/♮, flat/natural, other common names", () => {
  const same = [
    ["Harmonic Minor Scale", "harmonic minor"], ["super-locrian", "altered"], ["Diminished whole tone", "altered"],
    ["Mixolydian flat 13", "Mixolydian ♭13"], ["mixolydian ♭6", "Mixolydian ♭13"], ["Locrian natural 2", "Locrian ♮2"],
    ["Dorian mode", "Dorian"], ["natural minor", "Aeolian (natural minor)"], ["Phrygian ♮6", "Dorian ♭2"], ["jazz minor", "melodic minor"],
    ["half whole", "half-whole diminished"], ["Whole-Tone", "whole tone"], ["bebop", "bebop dominant"],
  ];
  for (const [input, name] of same) assert.equal(chordVoicings({ chord: "C", scale_name: input }).scale.name, name, input);
});

test("result shape: degrees labelled 1-7, short note, no chord fields", () => {
  const r = chordVoicings({ chord: "D", scale_name: "harmonic minor" });
  assert.equal(r.found, true);
  assert.equal(r.root, "D");
  assert.deepEqual(r.scale, { name: "harmonic minor", degrees: "1 2 ♭3 4 5 ♭6 7", text: "D E F G A B♭ C♯" });
  assert.equal(r.chord_tones, undefined);
  assert.match(r.note, /copy them/);
});

test("check_notes against a named scale", () => {
  const r = chordVoicings({ chord: "D", scale_name: "harmonic minor", check_notes: ["C#", "Db", "C", "Bb"] });
  assert.deepEqual(r.checked_notes.map((c) => c.status), ["scale_tone", "wrong_spelling", "outside", "scale_tone"]);
  assert.equal(r.checked_notes[1].should_be, "C#");
  assert.equal(r.all_notes_ok, false);
  assert.equal(chordVoicings({ chord: "A", scale_name: "blues", check_notes: ["Eb", "G"] }).all_notes_ok, true);
});

test("bad input: errors, no echo of caller text", async () => {
  const bad = [
    { chord: "Cm7", scale_name: "Dorian" }, // quality with a scale name
    { chord: "C/E", scale_name: "Dorian" },
    { chord: "C", scale_name: "<script>klingon</script>" },
    { chord: "C", scale_name: "x".repeat(31) },
    { chord: "C", scale_name: 7 },
    { chord: "C", scale_name: "   " },
  ];
  for (const args of bad) {
    const r = await runTool("chord_voicings", args);
    assert.equal(r.isError, true, JSON.stringify(args).slice(0, 40));
    assert.ok(!JSON.stringify(r.result).includes("klingon"), "never echo caller text");
  }
  const unknown = await runTool("chord_voicings", { chord: "C", scale_name: "klingon" });
  assert.match(unknown.result.error, /Known: .*harmonic minor/);
  // too many accidentals still errors instead of returning a triple flat
  assert.equal((await runTool("chord_voicings", { chord: "Cb", scale_name: "whole-half diminished" })).isError, true);
});

test("a bare root without scale_name still asks for a quality", () => {
  assert.equal(chordVoicings({ chord: "D" }).needs_quality, true);
  assert.equal(chordVoicings({ chord: "D", scale_name: null }).needs_quality, true);
});

test("MCP: public /mcp spells a named scale", async () => {
  const call = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chord_voicings", arguments: { chord: "Eb", scale_name: "Dorian" } } }, {});
  assert.equal(call.result.isError, false);
  assert.equal(call.result.structuredContent.scale.text, "E♭ F G♭ A♭ B♭ C D♭");
});
