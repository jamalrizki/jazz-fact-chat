// D.C./D.S./coda charts are played through in code at import time (scripts/import-charts.mjs),
// so the chart text and bar count match what a band actually plays.
// The strings below are made-up changes in the export's chart syntax, not real tunes.
import test from "node:test";
import assert from "node:assert/strict";
import { parseMusic, parseWritten, playThrough, toEntry } from "../scripts/import-charts.mjs";

const played = (music) => playThrough(parseWritten(music));
const flat = (sections) => sections.flatMap((s) => s.bars);

test("D.C. al Coda: body, back to the top, to the coda sign, then the coda", () => {
  const music = "*A[C^7 |A-7 |D-7 |G7 Q|*B[E-7 |A7 |D-7 |G7 <D.C. al Coda>Z Q[C^7 |C^7 Z";
  assert.deepEqual(played(music), [
    { label: "A", bars: ["Cmaj7", "Am7", "Dm7", "G7"] },
    { label: "B", bars: ["Em7", "A7", "Dm7", "G7"] },
    { label: "A", bars: ["Cmaj7", "Am7", "Dm7", "G7", "Cmaj7", "Cmaj7"] },
  ]);
  // Before this change the coda was glued onto the B section and the jump was lost.
  assert.deepEqual(flat(parseMusic(music).sections), ["Cmaj7", "Am7", "Dm7", "G7", "Em7", "A7", "Dm7", "G7", "Cmaj7", "Cmaj7"]);
});

test("D.S. al Fine: back to the segno, stop at Fine; % bars resolve to the bar before", () => {
  const music = "*A[C^7 |C^7 |*BS[F^7 |G7 <Fine>]*C[A-7 |D7 |G7 |x <D.S. al Fine>Z";
  assert.deepEqual(played(music), [
    { label: "A", bars: ["Cmaj7", "Cmaj7"] },
    { label: "B", bars: ["Fmaj7", "G7"] },
    { label: "C", bars: ["Am7", "D7", "G7", "G7"] },
    { label: "B", bars: ["Fmaj7", "G7"] },
  ]);
});

test("D.S. al Coda: back to the segno, not the top", () => {
  const music = "*i[C^7 |C^7 ]*AS[D-7 |G7 Q|C^7 |C^7 <D.S. al Coda>Z Q[E-7 A7 |D-7 G7 |C^7 Z";
  assert.deepEqual(flat(played(music)), [
    "Cmaj7", "Cmaj7", // intro, once
    "Dm7", "G7", "Cmaj7", "Cmaj7", // A
    "Dm7", "G7", // from the segno to the coda sign
    "Em7 A7", "Dm7 G7", "Cmaj7", // coda
  ]);
});

test("Repeats and endings are taken the first time, not after the D.C. (last ending only)", () => {
  const music = "*A{C^7 |A-7 |N1D-7 |G7 }|N2D-7 |G7 Q]*B[E-7 |A7 <D.C. al Coda>Z Q[C^7 Z";
  assert.deepEqual(flat(played(music)), [
    "Cmaj7", "Am7", "Dm7", "G7", // A, 1st ending
    "Cmaj7", "Am7", "Dm7", "G7", // A again, 2nd ending
    "Em7", "A7", // B
    "Cmaj7", "Am7", "Dm7", "G7", // D.C.: no repeat, straight to the 2nd ending, which has the coda sign
    "Cmaj7", // coda
  ]);
});

test("No jump, or marks that don't add up: null, so the importer keeps today's sections", () => {
  const cases = {
    "no jump at all": "*A[C^7 |A-7 |D-7 |G7 Z",
    "D.S. but no segno": "*A[C^7 |G7 Q|D-7 <D.S. al Coda>Z Q[C^7 Z",
    "al Coda with one coda sign": "*A[C^7 |G7 |D-7 <D.C. al Coda>Z Q[C^7 Z",
    "al Coda with three coda signs": "*A[C^7 Q|G7 Q|D-7 <D.C. al Coda>Z Q[C^7 Z",
    "al Fine with no Fine": "*A[C^7 |G7 |D-7 <D.C. al Fine>Z",
    "two jumps": "*A[C^7 <D.C. al Fine>|G7 <Fine>|D-7 <D.C. al Fine>Z",
    "unsupported wording": "*A[C^7 |G7 |D-7 <D.C. al 2nd End.>Z",
    "coda sign only in the 1st ending": "*A{C^7 |N1G7 Q}|N2D-7 ]*B[E-7 <D.C. al Coda>Z Q[C^7 Z",
    "3rd ending": "*A{C^7 |N1G7 }|N2D-7 }|N3A7 |G7 Q|E-7 <D.C. al Coda>Z Q[C^7 Z",
  };
  for (const [name, music] of Object.entries(cases)) assert.equal(played(music), null, name);
});

test("toEntry: a D.C. chart's form counts the bars as played; other charts are unchanged", () => {
  const dc = toEntry({ title: "Test Tune", composer: "Writer Some", key: "C", music: "*A[C^7 |A-7 |D-7 |G7 Q|*B[E-7 |A7 |D-7 |G7 <D.C. al Coda>Z Q[C^7 |C^7 Z" });
  assert.equal(dc.form, "ABA, 14 bars");
  assert.ok(dc.written.some((b) => b.m === "D.C. al Coda"), "the page still gets the chart as written");

  const plainMusic = "*A{C^7 |A-7 |N1D-7 |G7 }|N2D-7 |G7 ]*B[E-7 |A7 |D-7 |G7 Z";
  const plain = toEntry({ title: "Plain Tune", composer: "Writer Some", key: "C", music: plainMusic });
  assert.deepEqual(plain.sections, parseMusic(plainMusic).sections);
});
