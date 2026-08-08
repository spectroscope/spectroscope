// The browser side of push-to-talk, as a hook: MediaRecorder -> blob ->
// 16 kHz mono WAV -> POST /api/transcribe -> the transcript goes to the
// caller's callback (never straight at the agent). The conversion is the third
// step and it is new: the server used to run ffmpeg for it, and the browser
// already had the audio (card 187 step 5.4, encoder in wavClip.ts).
//
// The pure label/title/disabled decisions stay in voiceButton.ts, the meter
// arithmetic in micLevel.ts and the encoding in wavClip.ts; this hook owns only
// the DOM-bound wiring (getUserMedia, MediaRecorder, the recording timer).

import { useEffect, useRef, useState } from "react";
import type { MicPhase } from "./voiceButton";
import { noteVoiceExchange } from "../state/voiceWire";
import { micErrorOf, silencesTheButton, transcribeErrorOf, type VoiceError } from "./voiceError";
import { levelOf, mayClick } from "./micLevel";
import { MAX_CLIP_SECONDS, browserAudio, wavFromRecording } from "./wavClip";
import { audioConstraint, readMicDevices, useMicDevice, type MicChoice } from "../state/micDevice";

/** Whether the platform asked for no incidental effects. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The arming click: a short synthesized tick, so there is no asset to ship and
 *  nothing to load before it can be heard. Quiet on purpose — it is a
 *  confirmation, not an alert. */
function playArmClick(ctx: AudioContext): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.06);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.07);
}

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
  /** How loud it is hearing you, 0…1, while recording; 0 otherwise. */
  level: number;
  /** What the browser is willing to say about the inputs, refreshed on demand. */
  choice: MicChoice;
  /** Ask the browser for the device list again (after permission, it has names). */
  refreshDevices: () => Promise<void>;
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
  // The meter (card 187 step 3). Kept here rather than in the button so the
  // analyser lives exactly as long as the stream it listens to.
  const [level, setLevel] = useState(0);
  const [choice, setChoice] = useState<MicChoice>({ devices: [], unnamed: false });
  const deviceId = useMicDevice();
  const audioRef = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  const [recordMs, setRecordMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const armingRef = useRef(false);

  // Tick the recording timer while recording — and end it at the stated ceiling.
  // The limit exists because 16 kHz PCM is 32 kB per second, so a clip has a
  // largest size worth naming; stopping is how it costs the tail of a very long
  // recording rather than the whole thing.
  useEffect(() => {
    if (micPhase !== "recording") return;
    const startedAt = Date.now();
    setRecordMs(0);
    const id = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setRecordMs(elapsed);
      if (elapsed >= MAX_CLIP_SECONDS * 1000) recorderRef.current?.stop();
    }, RECORDING_TIMER_TICK_MS);
    return () => window.clearInterval(id);
  }, [micPhase]);

  // Push-to-talk in the browser. First press records; second press (or the
  // Stop button) ends it — onstop uploads the blob to /api/transcribe and
  // hands the transcript to the caller, exactly like the CLI's /voice. The
  // core never sees audio; a 503 means STT is not installed (button then
  // disabled, its tooltip carries the setup hint).
  /** Ask the browser what inputs it has. Callable before permission, where it
   *  answers with ids and no names — which the pane says rather than paints. */
  async function refreshDevices(): Promise<void> {
    try {
      setChoice(readMicDevices(await navigator.mediaDevices.enumerateDevices()));
    } catch {
      setChoice({ devices: [], unnamed: false });
    }
  }

  async function toggleMic(): Promise<void> {
    if (micPhase === "recording") {
      recorderRef.current?.stop(); // onstop takes over
      return;
    }
    // The await below is a WINDOW: a second press while the permission prompt
    // is open used to start a second recorder and orphan the first stream --
    // a hot microphone nothing would ever stop. A ref and not state, because
    // the second press arrives before any re-render.
    if (armingRef.current) return;
    armingRef.current = true;
    setMicError(null); // a fresh attempt is not the last one's failure
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint(deviceId) });
    } catch (refused) {
      const reason = micErrorOf(refused);
      setMicError(reason);
      // Only a STATE takes the button away. A denial is an event: someone who
      // then allows it in the site settings must be able to press again without
      // reloading the page.
      if (silencesTheButton(reason)) setMicAvailable(false);
      armingRef.current = false;
      return;
    }
    // Permission has just been granted, so the browser will name the devices
    // now — this is the one moment the list stops being blank.
    void refreshDevices();
    // The meter: an analyser on the same stream, alive exactly as long as it is.
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const tick = (): void => {
        analyser.getByteTimeDomainData(samples);
        setLevel(levelOf(samples));
        if (audioRef.current !== null) audioRef.current.raf = requestAnimationFrame(tick);
      };
      audioRef.current = { ctx, raf: 0 };
      audioRef.current.raf = requestAnimationFrame(tick);
      // The click that says it is armed. After the analyser, so a browser that
      // refuses audio output costs the sound and not the meter.
      if (mayClick(prefersReducedMotion(), true)) playArmClick(ctx);
    } catch {
      // No Web Audio: the meter stays flat and everything else works. A missing
      // decoration must never cost the feature it decorates.
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      // The meter dies with the stream it was listening to.
      if (audioRef.current !== null) {
        cancelAnimationFrame(audioRef.current.raf);
        void audioRef.current.ctx.close();
        audioRef.current = null;
      }
      setLevel(0);
      setMicPhase("transcribing");
      // The conversion whisper used to need a child process for (card 187 step
      // 5.4). It happens here because this is where the audio already is, and
      // its own failure is its own sentence: nothing was sent, so calling it a
      // failed request would point at the wrong thing.
      let wav: Uint8Array;
      try {
        wav = await wavFromRecording(await new Blob(chunks).arrayBuffer(), browserAudio);
      } catch {
        setMicError("convertFailed");
        setMicPhase("idle");
        return;
      }
      try {
        const res = await fetch("/api/transcribe", {
          method: "POST",
          // Named on purpose: an untyped body once reached the form parser,
          // which chewed the audio and produced a 200 with nonsense in it.
          headers: { "Content-Type": "audio/wav" },
          body: new Blob([wav], { type: "audio/wav" }),
        });
        if (!res.ok) {
          // The mapping is pinned in voiceError.ts: 503 is "not set up" and
          // silences the button, 502 is the far side failing and stays
          // retryable, 400 is this browser's own encoding.
          const reason = transcribeErrorOf(res.status) ?? "requestFailed";
          setMicError(reason);
          if (silencesTheButton(reason)) setMicAvailable(false);
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
    // From here the button is a STOP button, so the guard has done its job.
    armingRef.current = false;
  }

  // Unmount while recording used to leak the live microphone stream, the
  // meter's AudioContext and its rAF loop -- a hot mic with no UI attached to
  // it. The handlers come off first so the orphaned onstop does not fetch and
  // set state on an unmounted component.
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder !== null) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          /* already stopped */
        }
        recorder.stream.getTracks().forEach((track) => track.stop());
      }
      if (audioRef.current !== null) {
        cancelAnimationFrame(audioRef.current.raf);
        void audioRef.current.ctx.close();
        audioRef.current = null;
      }
    },
    [],
  );

  return { micPhase, micAvailable, micError, level, choice, refreshDevices, recordMs, toggleMic };
}
