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
import { openLiveSession, type LiveCapture, type LiveSession } from "./liveCapture";
import { ArmFailure, armLive } from "./liveArm";
import { LIVE_START, heardText, type LiveFailure, type LiveText } from "./liveSession";
import { captureRate, type LiveRoute } from "./liveTranscription";
import { TakeGate, finishBoundMs, liveTakeHandler, startFinish } from "./voiceTake";

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
  /** Card 528: the server said this press loads the speech model, so the
   *  loading card covers the composer until ready. False against a resident
   *  model and outside the wait for ready. */
  modelLoading: boolean;
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
  /** What a live session has heard so far. Empty on the batch path, and shown
   *  FADED wherever it is rendered: it is a model guess until `final` replaces
   *  it, and it never reaches the draft on its own. */
  provisional: string;
  /** Why a live session produced no transcript, or null. Its sentence is
   *  `voice.live.<reason>` — separate from `micError`, because "the provider
   *  refused" and "you denied the microphone" are not the same kind of news. */
  liveFailed: LiveFailure | null;
  /** First press records; second press stops and transcribes. */
  toggleMic: () => Promise<void>;
  /**
   * Card 527: Enter or Send while recording. Stops the capture, waits for the
   * last words (bounded on the live routes) and resolves with them, never
   * putting them into the draft; a transcript that arrives later is dropped.
   * Resolves with "" when nothing is recording.
   */
  finish: () => Promise<string>;
}

/** Where a recording goes and how often the local route runs (card 527). */
export interface VoiceRoute {
  /** The route the server says it takes. */
  route?: LiveRoute;
  /** The local chunk step from /api/stt/status. */
  chunkMs?: number;
  /** How long to wait for the live session's ready, from /api/stt/status. */
  warmupTimeoutMs?: number;
}

/** The wait for ready when the server names none: the governed
 *  `STT_WARMUP_TIMEOUT_MS` of spectro-core, 20000 ms on 2026-10-11. */
export const WARMUP_TIMEOUT_FALLBACK_MS = 20000;

/**
 * Microphone state + recorder wiring. `onTranscript` receives the finished
 * transcript text — the caller decides where it lands (the draft, for the
 * composer), so audio never reaches the agent unreviewed.
 *
 * @param onTranscript where a finished transcript goes
 * @param live whether this press should open a LIVE session, which the caller
 *             decides with `liveReading` — never this hook, because the rule it
 *             encodes (a local route is not rerouted to get live text) is a
 *             decision about consent and belongs in one place
 */
export function useVoiceInput(
  onTranscript: (text: string) => void,
  live: boolean = false,
  where: VoiceRoute = {},
): VoiceInput {
  const [micPhase, setMicPhase] = useState<MicPhase>("idle");
  const [modelLoading, setModelLoading] = useState(false);
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
  // The live half. A ref for the handle because the second press arrives before
  // any re-render, exactly like the arming guard; state for the text because
  // that is what gets drawn.
  const captureRef = useRef<LiveCapture | null>(null);
  // The open socket while the model loads, before a capture exists (card 527).
  const sessionRef = useRef<LiveSession | null>(null);
  const [liveText, setLiveText] = useState<LiveText>(LIVE_START);
  // The same value as `liveText`, readable synchronously. The frame handler has
  // to compare the state BEFORE and after a frame to know whether this is the
  // moment a transcript landed, and doing that inside a setState updater would
  // fire the side effects twice under StrictMode.
  const liveRef = useRef<LiveText>(LIVE_START);
  // Card 527: one gate per take. A send claims the take's transcript through
  // it, and a transcript that arrives after the send is swallowed there.
  const gateRef = useRef<TakeGate>(new TakeGate());

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
      if (elapsed < MAX_CLIP_SECONDS * 1000) return;
      // The same ceiling on both paths, and it means the same thing: the tail of
      // a very long take is lost rather than the whole thing. On the live path
      // it is also the only thing that ends a metered session somebody walked
      // away from mid-sentence.
      if (captureRef.current !== null) captureRef.current.commit();
      else recorderRef.current?.stop();
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

  /** The meter dies with the stream it was listening to. */
  function stopMeter(): void {
    if (audioRef.current !== null) {
      cancelAnimationFrame(audioRef.current.raf);
      void audioRef.current.ctx.close();
      audioRef.current = null;
    }
    setLevel(0);
  }

  /** A getUserMedia refusal, read into a reason. Only a STATE takes the button
   *  away; a denial is an event, and someone who then allows it in the site
   *  settings must be able to press again without reloading the page. */
  function refuseMicrophone(refused: unknown): void {
    const reason = micErrorOf(refused);
    setMicError(reason);
    if (silencesTheButton(reason)) setMicAvailable(false);
  }

  /** The meter: an analyser on the same stream, alive exactly as long as it is. */
  function startMeter(stream: MediaStream): void {
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
  }

  /**
   * The live path. A different instrument for a different job: no
   * MediaRecorder, no blob, no conversion at the end. The audio leaves in
   * pieces while it is being spoken (liveCapture.ts), and what comes back is
   * words.
   *
   * Card 527 criterion 8: the socket opens first and the press waits for the
   * server's ready, which on the local route comes once whisper has loaded the
   * model. The phase is `warming` meanwhile and the composer shows the loading
   * surface; the microphone is captured and the timer starts only on ready.
   */
  async function armLiveTake(): Promise<void> {
    liveRef.current = LIVE_START;
    setLiveText(LIVE_START);
    setModelLoading(false);
    setMicPhase("warming");
    let stream: MediaStream | null = null;
    // The microphone stops; the SOCKET does not. Closing it the moment the
    // transcript lands is what lost the record: the server sends `final` and
    // then `wire`, and a socket closed in between drops the second one.
    const releaseTheMicrophone = (): void => {
      stream?.getTracks().forEach((track) => track.stop());
      stopMeter();
      setMicPhase("idle");
    };
    const finish = (): void => {
      captureRef.current?.close();
      captureRef.current = null;
      sessionRef.current?.close();
      sessionRef.current = null;
      releaseTheMicrophone();
    };
    // The frame rules live in voiceTake.ts, where a fake socket drives them:
    // only a `final` reaches the draft, and only when no send claimed it.
    // The record's `wire` frame is what closes the socket.
    const take = liveTakeHandler({
      gate: gateRef.current,
      onTranscript,
      onState: (now) => {
        liveRef.current = now;
        setLiveText(now);
      },
      // The record this session left, announced on the socket it already
      // has. The batch path has to carry it in a POST answer instead.
      noteWire: noteVoiceExchange,
      // Microphone off, socket open: the wire frame is still on its way.
      releaseMicrophone: releaseTheMicrophone,
      close: finish,
    });
    try {
      const armed = await armLive({
        open: async () => {
          const session = await openLiveSession((frame) => {
            // Card 528: the warm up loads the model only when the server says so.
            if ((frame as { type?: unknown } | null)?.type === "loading") setModelLoading(true);
            take.onFrame(frame);
          });
          sessionRef.current = session;
          return session;
        },
        getMic: () => navigator.mediaDevices.getUserMedia({ audio: audioConstraint(deviceId) }),
        rate: captureRate(where.route ?? "hosted", true),
        timeoutMs: where.warmupTimeoutMs ?? WARMUP_TIMEOUT_FALLBACK_MS,
      });
      setModelLoading(false);
      stream = armed.stream;
      captureRef.current = armed.capture;
      void refreshDevices();
      startMeter(armed.stream);
      setMicPhase("recording");
    } catch (failure) {
      const stage = failure instanceof ArmFailure ? failure.stage : "open";
      // The socket never opened: nothing was captured and nothing was sent, so
      // this is the request-failed shape. A refusal before ready already said
      // why through the frame handler (`liveFailed`).
      // A failed audio graph after the microphone opened is the same shape for
      // the person: armLive has already stopped the tracks and closed the socket.
      if (stage === "open" || stage === "capture") setMicError("requestFailed");
      if (stage === "timeout") setMicError("warmupTimeout");
      if (stage === "mic") refuseMicrophone((failure as ArmFailure).cause);
      sessionRef.current = null;
      setModelLoading(false);
      setMicPhase("idle");
    } finally {
      armingRef.current = false;
    }
  }

  async function toggleMic(): Promise<void> {
    if (micPhase === "recording") {
      // Both paths end on the second press; only what "end" means differs. The
      // live one keeps its socket open afterwards, because the transcript is
      // still on its way.
      if (captureRef.current !== null) {
        captureRef.current.commit();
        setMicPhase("transcribing");
      } else {
        recorderRef.current?.stop(); // onstop takes over
      }
      return;
    }
    // The await below is a WINDOW: a second press while the permission prompt
    // is open used to start a second recorder and orphan the first stream --
    // a hot microphone nothing would ever stop. A ref and not state, because
    // the second press arrives before any re-render.
    if (armingRef.current) return;
    armingRef.current = true;
    gateRef.current = new TakeGate();
    setMicError(null); // a fresh attempt is not the last one's failure
    if (live) {
      await armLiveTake();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint(deviceId) });
    } catch (refused) {
      refuseMicrophone(refused);
      armingRef.current = false;
      return;
    }
    // Permission has just been granted, so the browser will name the devices
    // now — this is the one moment the list stops being blank.
    void refreshDevices();
    startMeter(stream);
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
      // A send that is waiting keeps the finishing phase (card 527).
      setMicPhase((phase) => (phase === "finishing" ? "finishing" : "transcribing"));
      const gate = gateRef.current;
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
        gate.fail();
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
          gate.fail();
          return;
        }
        const answer = (await res.json()) as { text?: string; wire?: unknown };
        // The exchange this call left behind. Voice has no session socket to
        // mirror it on (card 184 leg 2b), so this answer is the only place the
        // browser ever hears about its own record — and without it the spoken
        // bytes and the transcript show up in no trace anywhere.
        noteVoiceExchange(answer.wire);
        // A send that is waiting takes the answer; a late one is dropped (card 527).
        if (!gate.offer(answer.text ?? "") && answer.text) onTranscript(answer.text);
      } catch {
        // Network or parse failure. It stays usable — but it says so now,
        // because a recording that vanishes without a word is the defect.
        setMicError("requestFailed");
        gate.fail();
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

  /**
   * Enter or Send while recording (card 527): stop, wait for the last words,
   * hand them over. The draft never sees them; the caller sends them.
   */
  async function finish(): Promise<string> {
    const gate = gateRef.current;
    if (micPhase === "finishing" || gate.waiting) return "";
    const capture = captureRef.current;
    if (capture !== null) {
      setMicPhase("finishing");
      const text = await startFinish({
        gate,
        capture: {
          // A second press of the microphone already committed; a second
          // commit would ask the provider to transcribe an empty buffer.
          commit: () => {
            if (micPhase === "recording") capture.commit();
          },
          close: () => {
            capture.close();
            if (captureRef.current === capture) captureRef.current = null;
          },
        },
        heard: () => heardText(liveRef.current),
        boundMs: finishBoundMs(where.route ?? "hosted", where.chunkMs ?? 0, liveRef.current.runMs),
      });
      // The microphone is off either way: the final released it, or the bound
      // passed and the capture was closed.
      if (audioRef.current !== null) stopMeter();
      setMicPhase("idle");
      return text;
    }
    if (micPhase === "recording" || micPhase === "transcribing") {
      // The batch route: the one answer is the transcript, however long it takes.
      const text = gate.finish(() => "", null);
      setMicPhase("finishing");
      if (micPhase === "recording") recorderRef.current?.stop();
      return text;
    }
    return "";
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
      // A live session left running is worse than a leaked recorder: it is a
      // metered connection at a provider, and closing our socket is what takes
      // the provider's session down with it.
      const capture = captureRef.current;
      captureRef.current = null;
      capture?.close();
      // A socket still waiting for the model goes too.
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.close();
    },
    [],
  );

  return {
    micPhase,
    modelLoading,
    micAvailable,
    micError,
    level,
    choice,
    refreshDevices,
    recordMs,
    // Everything heard in this recording: closed windows and the open one.
    provisional: heardText(liveText),
    liveFailed: liveText.failed,
    toggleMic,
    finish,
  };
}
