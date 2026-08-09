// What the live socket's frames mean for the composer (card 187 step 6).
//
// Pure, like voiceButton.ts and liveTranscription.ts beside it. The hook owns
// the socket and the microphone; this owns the only question that has a wrong
// answer: when does a guess become the transcript.
//
// The rule the whole card set turns on: a partial is a MODEL GUESS. It is worth
// showing — faded — because watching the words appear is the feature. It is
// never worth committing, because the model corrects itself once it has heard
// the end of the sentence. So `provisional` is what you see and `committed` is
// what reaches the draft, and only a `final` frame ever fills the second one.

/** Why a live session did not produce a transcript. */
export type LiveFailure =
  /** The route being taken cannot stream — it was never opened. */
  | "localRoute"
  /** The hosted route was chosen and has no key. */
  | "noKey"
  /** The provider refused or dropped the session. */
  | "upstream"
  /** The socket ended before the transcript arrived. */
  | "closed";

/** Everything the composer needs to know about a live session in flight. */
export interface LiveText {
  /** The far side is configured; audio is flowing rather than being held. */
  readonly ready: boolean;
  /** What has been heard so far. Shown faded, never committed. */
  readonly provisional: string;
  /** The transcript. Null until the model says it is finished. */
  readonly committed: string | null;
  /** Why it failed, or null. */
  readonly failed: LiveFailure | null;
}

/** Before the socket has said anything. */
export const LIVE_START: LiveText = {
  ready: false,
  provisional: "",
  committed: null,
  failed: null,
};

const FAILURES: readonly string[] = ["localRoute", "noKey", "upstream", "closed"];

/** The `reason` a frame carries, when it is one we know. */
function failureOf(value: unknown): LiveFailure {
  return typeof value === "string" && FAILURES.includes(value) ? (value as LiveFailure) : "upstream";
}

/**
 * One frame, folded into the session.
 *
 * Tolerant on purpose: the socket also carries `wire`, and a server is free to
 * send events a build has never seen. A reducer that corrupts its state on an
 * unknown frame throws away a recording that was going fine.
 *
 * @param state where the session stood
 * @param frame the parsed frame, or anything at all
 * @return the new state, or the old one unchanged
 */
export function liveStep(state: LiveText, frame: unknown): LiveText {
  if (typeof frame !== "object" || frame === null) return state;
  const type = (frame as { type?: unknown }).type;
  const text = (frame as { text?: unknown }).text;
  // A session that refused cannot then answer. Accepting text after a refusal
  // would put words in the composer that nothing explains.
  if (state.failed !== null) return state;

  switch (type) {
    case "ready":
      return { ...state, ready: true };
    case "partial": {
      if (typeof text !== "string" || text === "") return state;
      // Every delta is space-prefixed because it is a word inside a sentence.
      // The first one is not inside anything yet.
      const grown = state.provisional === "" ? text.trimStart() : state.provisional + text;
      return { ...state, provisional: grown };
    }
    case "final": {
      if (typeof text !== "string") return state;
      // REPLACES, never appends. The model is free to correct punctuation,
      // casing or a whole word once it has heard the end, and the concatenated
      // guesses are not the answer even when they happen to match it.
      return { ...state, provisional: "", committed: text };
    }
    case "error":
      // The heard text stays visible — it is what the microphone picked up and
      // it is worth seeing. It just never becomes the transcript.
      return { ...state, failed: failureOf((frame as { reason?: unknown }).reason) };
    case "closed":
      // A close after the transcript is how a session ends. Before it, the
      // recording was lost and saying so beats an empty composer.
      return state.committed === null ? { ...state, failed: "closed" } : state;
    default:
      return state;
  }
}
