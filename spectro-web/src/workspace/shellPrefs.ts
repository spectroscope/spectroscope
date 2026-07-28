// What the terminal pane remembers between visits (card 93): whether it is open
// at all, and how much of the Files tab it takes. Split out from the component
// so the junk-value behaviour is testable without a DOM.
//
// Opening the pane spawns a real shell, so a value that cannot be read as a
// clear "yes" leaves it shut. Nobody gets a PTY from a corrupt storage entry.

export const TERM_OPEN_KEY = "spectroscope:wsTerminalOpen";
export const TERM_SPLIT_KEY = "spectroscope:wsTerminalSplit";

/** The terminal's share of the Files tab, in percent. */
export const DEFAULT_TERM_SPLIT = 40;
export const MIN_TERM_SPLIT = 12;
export const MAX_TERM_SPLIT = 85;

export function clampTermPct(pct: number): number {
  return Math.max(MIN_TERM_SPLIT, Math.min(MAX_TERM_SPLIT, pct));
}

/** Parse the stored height; missing, junk, or out of range means the default. */
export function readStoredTermSplit(stored: string | null): number {
  const n = stored === null ? NaN : Number(stored);
  return Number.isFinite(n) && n >= MIN_TERM_SPLIT && n <= MAX_TERM_SPLIT ? n : DEFAULT_TERM_SPLIT;
}

/** Only a literal "1" reopens the pane. */
export function readStoredTermOpen(stored: string | null): boolean {
  return stored === "1";
}
