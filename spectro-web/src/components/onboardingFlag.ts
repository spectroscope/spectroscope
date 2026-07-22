// Pure logic for the first-run onboarding dialog, split out so it is testable
// without a DOM. The dialog itself is an info sheet (Onboarding.tsx) shown ONCE
// when a fresh install has no settings yet.

/** localStorage flag — set once the dialog has been seen. */
export const ONBOARDED_KEY = "spectroscope:onboarded";

/** First run = the flag was never set to "1". Tolerates a missing/blocked
 *  localStorage (the stored value comes back null), defaulting to "show it". */
export function shouldOnboard(stored: string | null): boolean {
  return stored !== "1";
}
