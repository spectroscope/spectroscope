// The one recording this repo ships as a file (card 310).
//
// The owner asked for the JSONL of the declared-workflow run — the one the
// workflow box draws — and asked for it IN the project rather than as a
// download: "oder noch besser als neues beispiel als sample mit in das projekt
// bauen? also in spectro?". So it lives under docs/, next to the other shipped
// reference artefacts, and nothing in the app has to change to hand it over.
//
// WHY IT CAN BE A FILE AT ALL. compile() takes a fixed base timestamp and mints
// its own ids in order, so one scenario plus one language is one exact byte
// string, today and next month. That is what makes a committed recording
// checkable instead of merely plausible.
//
// THIS MODULE IS THE SINGLE SOURCE for both halves of that check: the generator
// script writes what renderSampleRecording() returns, and the pin compares the
// file on disk against the same call. A generator with its own copy of the
// compile arguments would drift from the pin, and the pin would then be green
// about the wrong bytes.
//
// Test-and-tooling only by construction: no app module imports it, so it never
// reaches the shipped bundle.

import type { Lang } from "../i18n/i18n";
import { compile } from "./compile";
import { SCENARIOS } from "./registry";
import { toJsonl } from "../export/jsonl";

/** The scenario the file records — the declared 5-phase, 13-agent workflow. */
export const SAMPLE_SCENARIO_ID = "workflow-phases";

/**
 * English, and deliberately only English.
 *
 * compile() bakes the language into the events: every think, say and status
 * line in the file is prose, so a recording IS a language. This is a public
 * repo whose docs, code and cards are business English, and a reader who opens
 * the file to see the shape of the wire should not have to read German to do
 * it. A German twin would be a second artefact with a second pin, and nobody
 * has asked for one.
 */
export const SAMPLE_LANG: Lang = "en";

/** Where the file lives, relative to the repo root — the path the README, the
 *  generator and the pin all quote, so they cannot disagree about it. */
export const SAMPLE_PATH = "docs/sample-runs/workflow-phases.en.jsonl";

/** The npm script that rewrites the file; named in the pin's failure message. */
export const SAMPLE_REGEN_COMMAND = "npm run generate:sample-run";

/**
 * The exact bytes the shipped recording must have.
 *
 * @return the JSONL text, one wire event per line, newline-terminated
 * @throws Error when the scenario is no longer in the registry — a missing
 *         scenario must say so, not silently render an empty file
 */
export function renderSampleRecording(): string {
  const dsl = SCENARIOS.find((s) => s.id === SAMPLE_SCENARIO_ID);
  if (dsl === undefined) {
    throw new Error(
      `scenario "${SAMPLE_SCENARIO_ID}" is not in SCENARIOS — ${SAMPLE_PATH} has no source any more`,
    );
  }
  return toJsonl(compile(dsl, SAMPLE_LANG));
}
