#!/usr/bin/env node
// Runs before `npm run dev` and `npm run deploy`.
// The full chord library (src/chord-charts.json) is gitignored. On a fresh clone
// it doesn't exist yet, so fall back to the small sample library that IS committed.
import { existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
const full = join(src, "chord-charts.json");
if (!existsSync(full)) {
  copyFileSync(join(src, "chord-charts.sample.json"), full);
  console.log("chord-charts.json not found; using the sample library. Run `npm run import -- <file>` for the full one.");
}
