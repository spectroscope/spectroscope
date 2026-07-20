// Pure state logic for the composer's microphone button. The DOM-bound
// parts (getUserMedia, MediaRecorder) live in Chat.tsx and are exercised in the
// browser walkthrough; the label/title/disabled decisions are pinned here so they
// can be unit-tested without a MediaRecorder — the same split as AttachmentPreview's
// formatSize.

import { t, type Lang } from "../i18n/i18n";

export type MicPhase = "idle" | "recording" | "transcribing";

export interface MicView {
  /** Accessible label + tooltip; carries the setup hint when STT is unavailable. */
  title: string;
  /** true while recording (drives the pulsing coral dot + timer). */
  recording: boolean;
  /** true when the button must not be pressed (unavailable, or busy transcribing). */
  disabled: boolean;
}

/** The hint the server returns in its 503 body — mirrored in the tooltip. */
export const STT_SETUP_HINT =
  "Speech-to-text is not installed — run bash scripts/setup-stt.sh.";

/**
 * Decides how the mic button presents itself.
 * - unavailable (a prior 503): disabled, tooltip points at the setup script.
 * - transcribing: disabled (the POST is in flight), never a second recording.
 * - recording: enabled (press stops it), the caller renders the dot + timer.
 * - idle: enabled, ready to record.
 * While a run streams the composer is busy, so the button is disabled then too.
 */
export function micButtonState(phase: MicPhase, available: boolean, running: boolean, lang: Lang = "en"): MicView {
  if (!available) {
    return { title: lang === "en" ? STT_SETUP_HINT : t(lang, "mic.sttHint"), recording: false, disabled: true };
  }
  if (phase === "transcribing") {
    return { title: t(lang, "mic.transcribing"), recording: false, disabled: true };
  }
  if (phase === "recording") {
    return { title: t(lang, "mic.stop"), recording: true, disabled: false };
  }
  return { title: t(lang, "mic.record"), recording: false, disabled: running };
}

/** mm:ss for the recording timer — seconds since the recording began. */
export function formatTimer(elapsedMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
