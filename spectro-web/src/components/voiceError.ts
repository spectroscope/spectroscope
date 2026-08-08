// Why the microphone did not work, as something a person can read (card 187,
// step 1).
//
// Both failure paths used to be a silent `catch`. Any getUserMedia failure —
// permission denied, no device, a device that vanished mid-session — became
// `setMicAvailable(false)`, which simply hides the button; a network or parse
// failure "dropped this attempt" without a word. So the two most common ways
// voice fails both looked exactly like "this machine has no microphone", and a
// user who once clicked "don't allow" had no way to learn that is what happened.
//
// The browser already tells us which one it was. This turns that into a key.

/**
 * Every way voice fails, as a list rather than a bare union — so the suite can
 * walk it and prove each one has a sentence in both languages. A union type
 * cannot be enumerated at runtime, which is how a reason could otherwise be
 * added and stay mute.
 *
 * - `denied` — the user (or a policy) refused the microphone. Recoverable, and
 *   the only one where the fix is in the browser's own hands.
 * - `noDevice` — no input device at all; nothing to grant.
 * - `deviceBusy` — a device was there and stopped being there, or another app
 *   is holding it.
 * - `sttMissing` — speech to text is not installed on the server (503).
 * - `requestFailed` — the request never completed: network, parse, or a server
 *   that answered something this build cannot read.
 * - `convertFailed` — the recording could not be turned into audio the model
 *   reads (card 187 step 5.4 moved that conversion into the browser). Its own
 *   reason and not `requestFailed`, because nothing was ever sent and pressing
 *   again in the same browser will do the same thing.
 * - `unknown` — something else. Deliberately last, and deliberately not silent.
 */
export const VOICE_ERRORS = [
  "denied",
  "noDevice",
  "deviceBusy",
  "sttMissing",
  "requestFailed",
  "convertFailed",
  "unknown",
] as const;

export type VoiceError = (typeof VOICE_ERRORS)[number];

/**
 * Read a `getUserMedia` rejection into a reason.
 *
 * The DOM spells these in `name`, and the spelling is stable across browsers
 * even where the messages are not — which is why this reads the name and never
 * the message.
 *
 * @param cause whatever the promise rejected with
 * @return the reason to show
 */
export function micErrorOf(cause: unknown): VoiceError {
  const name = typeof cause === "object" && cause !== null ? String((cause as { name?: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "noDevice";
    case "NotReadableError":
    case "AbortError":
      return "deviceBusy";
    default:
      return "unknown";
  }
}

/** The sentence for a reason. One key per reason, so a reason that gains a
 *  sentence cannot silently keep the old one. */
export function voiceErrorKey(reason: VoiceError): string {
  return `voice.err.${reason}`;
}

/**
 * Whether a reason means the feature is gone for this session, or just that
 * this attempt failed.
 *
 * The difference is the whole point of the split: a missing device or a missing
 * server is a state, and hiding the button is honest. A denial or a failed
 * request is an EVENT, and hiding the button for it would mean a person who
 * fixes the cause has no way back in without reloading.
 *
 * @param reason what went wrong
 * @return true when the button should stay gone until something changes
 */
/**
 * Read a transcribe answer's status into a reason.
 *
 * The split matters more than it looks: 503 means "STT is not set up" and the
 * button leaves until the setup changes. The server used to answer 503 for a
 * hosted provider's transient refusal too, so one 429 took the microphone away
 * until reload. 502 is the far side failing -- retryable, the button stays.
 *
 * @param status the HTTP status of /api/transcribe
 * @return the reason, or null for a status the caller handles itself
 */
export function transcribeErrorOf(status: number): VoiceError | null {
  if (status === 503) return "sttMissing";
  if (status === 400) return "convertFailed";
  if (status === 502) return "requestFailed";
  return null;
}

export function silencesTheButton(reason: VoiceError): boolean {
  return reason === "noDevice" || reason === "sttMissing";
}
