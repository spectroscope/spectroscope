// Pure logic for the built-in model's first-use notice (card 91): shown ONCE
// when the ACTIVE provider becomes spectro-local — the wire-truth provider_info
// covers both the picker switch and a fresh boot landing on the built-in model.
// Split out so it is testable without a DOM, the onboardingFlag pattern (file named apart from
// LocalModelNotice.tsx — tsc's case-collision check refuses near-twins).
//
// Card 144: every way out of the sheet means the same thing — "understood, go
// away" — so every exit records the dismissal. The old rule let only the
// button write the flag, and the owner met the sheet again on every boot after
// dismissing it the way people dismiss modals. The deliberate way back lives
// in Settings, not in an exit that forgets.

/** localStorage flag — set once the notice has been dismissed. */
export const LOCAL_NOTICE_KEY = "spectroscope:localModelNotice";

// Storage seams — real localStorage by default, swappable in tests (the suite
// runs in plain Node with no jsdom), the designPrefs pattern.
let storageGet: () => string | null = () => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_NOTICE_KEY) : null;
  } catch {
    // Blocked storage: the notice may repeat — better than never showing.
    return null;
  }
};
let storageSet: () => void = () => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LOCAL_NOTICE_KEY, "1");
  } catch {
    /* blocked storage (private mode) */
  }
};

/** The persisted dismissal — `"1"` once seen, `null` while it never was. */
export function readLocalNoticeSeen(): string | null {
  return storageGet();
}

/**
 * Records the dismissal. Deliberately parameterless: the moment one exit is
 * allowed to skip the write, the sheet returns on every boot for exactly the
 * readers who understood it (card 144).
 */
export function markLocalNoticeSeen(): void {
  storageSet();
}

/**
 * Whether to show the notice: never after a dismissal, and only while the
 * built-in model is actually the active backend. Tolerates a missing/blocked
 * localStorage (stored null → not yet dismissed).
 */
export function shouldShowLocalNotice(stored: string | null, activeProvider: string | null): boolean {
  return stored !== "1" && activeProvider === "spectro-local";
}

/** Test-only: inject in-memory storage seams (the suite has no jsdom). */
export function __setLocalNoticeTestHooks(hooks: { get?: () => string | null; set?: () => void }): void {
  if (hooks.get) storageGet = hooks.get;
  if (hooks.set) storageSet = hooks.set;
}
