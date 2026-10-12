// Pure state logic for the composer's microphone button. The DOM-bound
// parts (getUserMedia, MediaRecorder) live in Chat.tsx and are exercised in the
// browser walkthrough; the label/title/disabled decisions are pinned here so they
// can be unit-tested without a MediaRecorder — the same split as AttachmentPreview's
// formatSize.

import { t, type Lang } from "../i18n/i18n";
import type { LiveRoute } from "./liveTranscription";

// "finishing" is card 527's send gesture: Enter or Send while recording stops
// the capture, waits for the last words and sends them with the draft.
// "warming" is criterion 8: the live socket is open and the server is loading
// the speech model; the microphone is not captured yet.
export type MicPhase = "idle" | "warming" | "recording" | "transcribing" | "finishing";

export interface MicView {
  /** Accessible label + tooltip; carries the setup hint when STT is unavailable. */
  title: string;
  /** true while recording (drives the pulsing coral dot + timer). */
  recording: boolean;
  /** true when the button must not be pressed (unavailable, or busy transcribing). */
  disabled: boolean;
  /** Card 528: the microphone glyph, filled while it records (owner: no square). */
  glyph: "filled" | "outline";
}

/** The hint the server returns in its 503 body — mirrored in the tooltip. */
export const STT_SETUP_HINT = "Speech-to-text is not installed — run bash scripts/setup-stt.sh.";

/**
 * Decides how the mic button presents itself.
 * - unavailable (a prior 503): disabled, tooltip points at the setup script.
 * - transcribing: disabled (the POST is in flight), never a second recording.
 * - recording: enabled (press stops it), the caller renders the dot + timer.
 * - idle: enabled, ready to record — even mid-run: the transcript only lands
 *   in the DRAFT, and since card 78 the composer stays alive while a run
 *   streams (queue-while-running), so there is nothing to protect.
 */
export function micButtonState(
  phase: MicPhase,
  available: boolean,
  lang: Lang = "en",
  route: LiveRoute = "local",
): MicView {
  if (!available) {
    return {
      title: lang === "en" ? STT_SETUP_HINT : t(lang, "mic.sttHint"),
      recording: false,
      disabled: true,
      glyph: "outline",
    };
  }
  if (phase === "warming") {
    // On the hosted route the wait is for the provider's session.
    return {
      title: t(lang, route === "hosted" ? "mic.connecting" : "mic.warming"),
      recording: false,
      disabled: true,
      glyph: "outline",
    };
  }
  if (phase === "finishing") {
    return { title: t(lang, "mic.finishing"), recording: false, disabled: true, glyph: "outline" };
  }
  if (phase === "transcribing") {
    return { title: t(lang, "mic.transcribing"), recording: false, disabled: true, glyph: "outline" };
  }
  if (phase === "recording") {
    return { title: t(lang, "mic.stop"), recording: true, disabled: false, glyph: "filled" };
  }
  return { title: t(lang, "mic.record"), recording: false, disabled: false, glyph: "outline" };
}

/**
 * Whether the speech model card covers the composer (card 527 criterion 8).
 * Only the local route loads a model before ready; a hosted press waits for
 * the provider's session and says so on the mic button instead. Card 528: and
 * only while the server says the model really loads. A resident whisper-server
 * answers the second press with a probe, and the card would flash for nothing.
 *
 * @param phase the microphone's phase
 * @param route the route the press takes
 * @param loading whether the server sent its loading frame for this press
 * @return true while the local route waits for its model to load
 */
export function speechModelLoads(phase: MicPhase, route: LiveRoute, loading: boolean): boolean {
  return phase === "warming" && route === "local" && loading;
}

/** mm:ss for the recording timer — seconds since the recording began. */
export function formatTimer(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
