// The browser side of push-to-talk, as a hook: MediaRecorder ->
// blob -> POST /api/transcribe -> the transcript goes to the caller's
// callback (never straight at the agent). The pure label/title/disabled
// decisions stay in voiceButton.ts; this hook owns only the DOM-bound wiring
// (getUserMedia, MediaRecorder, the recording timer).

import { useEffect, useRef, useState } from "react";
import type { MicPhase } from "./voiceButton";

/** How often the recording timer refreshes — fast enough to read as live. */
const RECORDING_TIMER_TICK_MS = 250;

export interface VoiceInput {
  /** idle | recording | transcribing — feeds micButtonState. */
  micPhase: MicPhase;
  /** Flips to false after a 503 (STT not installed) or a denied microphone. */
  micAvailable: boolean;
  /** Milliseconds since the recording began — drives the mm:ss timer. */
  recordMs: number;
  /** First press records; second press stops and transcribes. */
  toggleMic: () => Promise<void>;
}

/** Microphone state + recorder wiring. `onTranscript` receives the finished
 *  transcript text — the caller decides where it lands (the draft, for the
 *  composer), so audio never reaches the agent unreviewed. */
export function useVoiceInput(onTranscript: (text: string) => void): VoiceInput {
  const [micPhase, setMicPhase] = useState<MicPhase>("idle");
  const [micAvailable, setMicAvailable] = useState(true);
  const [recordMs, setRecordMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);

  // Tick the recording timer while recording.
  useEffect(() => {
    if (micPhase !== "recording") return;
    const startedAt = Date.now();
    setRecordMs(0);
    const id = window.setInterval(() => setRecordMs(Date.now() - startedAt), RECORDING_TIMER_TICK_MS);
    return () => window.clearInterval(id);
  }, [micPhase]);

  // Push-to-talk in the browser. First press records; second press (or the
  // Stop button) ends it — onstop uploads the blob to /api/transcribe and
  // hands the transcript to the caller, exactly like the CLI's /voice. The
  // core never sees audio; a 503 means STT is not installed (button then
  // disabled, its tooltip carries the setup hint).
  async function toggleMic(): Promise<void> {
    if (micPhase === "recording") {
      recorderRef.current?.stop(); // onstop takes over
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicAvailable(false); // no microphone / permission denied — hide the feature
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      setMicPhase("transcribing");
      try {
        const res = await fetch("/api/transcribe", { method: "POST", body: new Blob(chunks) });
        if (res.status === 503) {
          setMicAvailable(false); // STT not installed — the tooltip explains the fix
          return;
        }
        const { text } = (await res.json()) as { text?: string };
        if (text) onTranscript(text);
      } catch {
        // Network/parse failure: stay usable, just drop this attempt.
      } finally {
        setMicPhase("idle");
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setMicPhase("recording");
  }

  return { micPhase, micAvailable, recordMs, toggleMic };
}
