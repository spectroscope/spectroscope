// Pure logic for the built-in model's first-use notice (card 91): shown ONCE
// when the ACTIVE provider becomes spectro-local — the wire-truth provider_info
// covers both the picker switch and a fresh boot landing on the built-in model.
// Split out so it is testable without a DOM, the onboardingFlag pattern (file named apart from
// LocalModelNotice.tsx — tsc's case-collision check refuses near-twins).

/** localStorage flag — set once the notice has been dismissed. */
export const LOCAL_NOTICE_KEY = "spectroscope:localModelNotice";

/**
 * Whether to show the notice: never after a dismissal, and only while the
 * built-in model is actually the active backend. Tolerates a missing/blocked
 * localStorage (stored null → not yet dismissed).
 */
export function shouldShowLocalNotice(stored: string | null, activeProvider: string | null): boolean {
  return stored !== "1" && activeProvider === "spectro-local";
}
