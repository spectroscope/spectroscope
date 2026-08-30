// The one command the pin names: rewrite docs/sample-runs/workflow-phases.en.jsonl
// from its scenario (card 310).
//
//   npm run generate:sample-run     (from spectro-web/)
//
// It is deliberately thin. Everything that decides WHAT the file holds — the
// scenario, the language, the path — lives in sampleRecording.ts, which the pin
// imports too, so the regeneration and the check can never disagree about the
// bytes. This file only writes them and reports what it wrote.
//
// Not part of the app: nothing imports it, so it never reaches the bundle. It
// sits under src/ rather than in a scripts/ folder because the module it drives
// reaches into the export path, which is typed against the DOM (jsonl.ts saves
// a Blob) — only the app's tsconfig has those libs, so only here does `tsc -b`
// actually check this script.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_LANG, SAMPLE_PATH, SAMPLE_SCENARIO_ID, renderSampleRecording } from "./sampleRecording";

const target = fileURLToPath(new URL(`../../../${SAMPLE_PATH}`, import.meta.url));
const text = renderSampleRecording();

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text, "utf8");

const lines = text === "" ? 0 : text.trimEnd().split("\n").length;
console.log(
  `${SAMPLE_PATH}: ${lines} lines, ${Buffer.byteLength(text, "utf8")} bytes ` +
    `— compile("${SAMPLE_SCENARIO_ID}", "${SAMPLE_LANG}")`,
);
