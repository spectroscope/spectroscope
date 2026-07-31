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

/**
 * Whether to actually show the first-run sheet. Beyond the dismissal flag, it is
 * gated on READINESS: a configured/working setup must never see "pick a backend"
 * (the localStorage flag alone is fragile — per-origin, blocked in the desktop
 * shell — so a keyed openai would otherwise re-trigger the sheet every load). It
 * shows only when it hasn't been dismissed AND the boot provider is explicitly
 * `needs-key`. Returns false while the config is still loading (null), so the
 * sheet never flashes before readiness is known.
 */
export function shouldShowOnboarding(
  dismissed: boolean,
  bootProvider: string | null,
  providerStatus: Record<string, string> | null,
): boolean {
  if (dismissed) return false;
  if (bootProvider === null || providerStatus === null) return false;
  return providerStatus[bootProvider] === "needs-key";
}
