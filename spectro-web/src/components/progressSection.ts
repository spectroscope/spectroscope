// The progress guard's three numbers, as facts a control and a summary can both
// read (card 281).
//
// Kept out of the panel deliberately. Criterion 4 asks for one derived summary
// "fed by the same function as the per-control chips so the two cannot
// disagree", and the honest way to make that true is structural rather than
// remembered: there is one predicate here, the chips call it, the summary calls
// it, and nothing else decides what "armed" means.

import type { SettingKey } from "./settingsReach";

/** The three counts, in the order the section draws them. Typed against the
 *  reach table, so a field nobody has classified is a compile error rather than
 *  an unnoticed promise about when a save takes effect. */
export const PROGRESS_FIELDS = [
  "progressGuardWrites",
  "progressGuardFailures",
  "progressGuardPlanTurns",
] as const satisfies readonly SettingKey[];

export type ProgressField = (typeof PROGRESS_FIELDS)[number];

/** The three values as the settings record carries them. */
export type ProgressCounts = Record<ProgressField, number>;

/**
 * Whether one detector is watching.
 *
 * Zero is the off switch and there is no separate flag — one knob per detector,
 * rather than a knob and a boolean that can disagree. A NEGATIVE is off too: all
 * three Java guards are `<= 0`, so a `!== 0` reading here would draw a chip
 * saying armed over a detector that can never fire. `ProgressSettingsArmedTest`
 * is this function's twin and walks the same table.
 *
 * @param value the configured count
 * @returns `"armed"` when the detector can fire, `"off"` when it cannot
 */
export function armedState(value: number): "armed" | "off" {
  return value > 0 ? "armed" : "off";
}

/** What the section's one summary line says. */
export interface ProgressSummary {
  /** The dict key to render. */
  key: "set.progress.summary" | "set.progress.summaryOff";
  /** How many detectors are watching. */
  armed: number;
  /** How many there are. */
  total: number;
}

/**
 * The section's single derived summary.
 *
 * Zero armed gets its OWN sentence rather than "0 of 3": a count reads as a
 * configuration somebody chose a number for, and nothing watching is a different
 * statement about the run.
 *
 * @param counts the three configured values
 * @returns the key to render and the numbers to render it with
 */
export function progressSummary(counts: ProgressCounts): ProgressSummary {
  const armed = PROGRESS_FIELDS.filter((field) => armedState(counts[field]) === "armed").length;
  return {
    key: armed === 0 ? "set.progress.summaryOff" : "set.progress.summary",
    armed,
    total: PROGRESS_FIELDS.length,
  };
}
