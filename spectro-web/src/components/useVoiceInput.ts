// The browser side of push-to-talk, as a hook: MediaRecorder ->
// blob -> POST /api/transcribe -> the transcript goes to the caller's
// callback (never straight at the agent). The pure label/title/disabled
// decisions stay in voiceButton.ts; this hook owns only the DOM-bound wiring
// (getUserMedia, MediaRecorder, the recording timer).

import { useEffect, useRef, useState } from "react";
import type { MicPhase } from "./voiceButton";
import { noteVoiceExchange } from "../state/voiceWire";
import { micErrorOf, silencesTheButton, type VoiceError } from "./voiceError";

/** How often the recording timer refreshes — fast enough to read as live. */
const RECORDING_TIMER_TICK_MS = 250;

export interface VoiceInput {
  /** idle | recording | transcribing — feeds micButtonState. */
  micPhase: MicPhase;
  /** Flips to false only for a STATE — no device, or a server without stt.
   *  A denial or a failed request leaves the button, because both are events
   *  somebody can act on and press again (card 187, `silencesTheButton`). */
  micAvailable: boolean;
  /** Why the last attempt failed, or null. The sentence is `voice.err.<reason>`. */
  micError: VoiceError | null;
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
  // Why the last attempt failed, or null. Card 187 step 1: both paths below used
  // to swallow the cause, so "you denied permission" and "the request failed"
  // both read as "this machine has no microphone" — a vanished button and no
  // sentence anywhere.
  const [micError, setMicError] = useState<VoiceError | null>(null);
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
    setMicError(null); // a fresh attempt is not the last one's failure
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (refused) {
      const reason = micErrorOf(refused);
      setMicError(reason);
      // Only a STATE takes the button away. A denial is an event: someone who
      // then allows it in the site settings must be able to press again without
      // reloading the page.
      if (silencesTheButton(reason)) setMicAvailable(false);
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
          setMicError("sttMissing"); // and the sentence points at the settings pane
          setMicAvailable(false);
          return;
        }
        if (!res.ok) {
          setMicError("requestFailed");
          return;
        }
        const answer = (await res.json()) as { text?: string; wire?: unknown };
        // The exchange this call left behind. Voice has no session socket to
        // mirror it on (card 184 leg 2b), so this answer is the only place the
        // browser ever hears about its own record — and without it the spoken
        // bytes and the transcript show up in no trace anywhere.
        noteVoiceExchange(answer.wire);
        if (answer.text) onTranscript(answer.text);
      } catch {
        // Network or parse failure. It stays usable — but it says so now,
        // because a recording that vanishes without a word is the defect.
        setMicError("requestFailed");
      } finally {
        setMicPhase("idle");
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setMicPhase("recording");
  }

  return { micPhase, micAvailable, micError, recordMs, toggleMic };
}
