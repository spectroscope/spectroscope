// Card 187 step 7: the once-per-home flag for the first-run voice sheet.
//
// Same shape as localNoticeFlag (card 91/144), including the lesson that cost
// the owner a repeat on every boot: EVERY exit records the dismissal, because
// every exit means the same thing. The deliberate way back is Settings, not an
// exit that forgets.
//
// Named apart from VoiceNotice.tsx on purpose — tsc's case-collision check
// refuses near-twins — and split out so it is testable in plain Node.

/** localStorage flag — set once the sheet has been dismissed. */
export const VOICE_NOTICE_KEY = "spectroscope:voiceNotice";

let storageGet: () => string | null = () => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(VOICE_NOTICE_KEY) : null;
  } catch {
    // Blocked storage: the sheet may repeat — better than never showing it.
    return null;
  }
};
let storageSet: () => void = () => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(VOICE_NOTICE_KEY, "1");
  } catch {
    /* blocked storage (private mode) */
  }
};

/** The persisted dismissal — `"1"` once seen, `null` while it never was. */
export function readVoiceNoticeSeen(): string | null {
  return storageGet();
}

/** Records the dismissal. Parameterless, for the reason in the header. */
export function markVoiceNoticeSeen(): void {
  storageSet();
}

/**
 * Whether reaching for the microphone should raise the sheet.
 *
 * Two ways in, and the second is why this is not just a flag read:
 *
 *  - the FIRST reach on a home, so the three facts arrive before the first
 *    failure rather than after it;
 *  - any time the setup is what is wrong, dismissed or not. `sttMissing`
 *    removes the microphone button, so its tooltip goes with the button and a
 *    reader who dismissed the sheet once would be left with nothing at all.
 *
 * @param stored the persisted dismissal
 * @param reason the current voice error, or null
 * @param reasonOpensSheet whether that reason is the setup case
 * @return true when the sheet should be raised
 */
export function shouldShowVoiceNotice(
  stored: string | null,
  reason: string | null,
  reasonOpensSheet: boolean,
): boolean {
  if (reason !== null && reasonOpensSheet) return true;
  return stored !== "1";
}

/** Test-only: inject in-memory storage seams (the suite has no jsdom). */
export function __setVoiceNoticeTestHooks(hooks: { get?: () => string | null; set?: () => void }): void {
  if (hooks.get) storageGet = hooks.get;
  if (hooks.set) storageSet = hooks.set;
}
