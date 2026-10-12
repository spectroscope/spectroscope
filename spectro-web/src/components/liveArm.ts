// Arming a live session (card 527 criterion 8).
//
// The press opens the socket and waits for the server's ready. On the local
// route ready comes after whisper has run once over a second of silence, which
// loads the model. Only then is the microphone captured and the audio graph
// built, so no word is spoken into a session that cannot hear it yet and no
// audio frame leaves before ready. A ready that does not come within the
// timeout closes the socket and leaves the microphone idle.
//
// Pure apart from timers: the hook passes the real socket and getUserMedia,
// the tests pass fakes.

import type { LiveCapture, LiveSession } from "./liveCapture";
import type { Timers } from "./voiceTake";

/**
 * Where arming stopped. `capture` is the audio graph after the microphone
 * opened: the AudioContext, the worklet or the stream source failed.
 */
export type ArmStage = "open" | "ready" | "timeout" | "mic" | "capture";

/** Where arming stopped, and why. */
export class ArmFailure extends Error {
  readonly stage: ArmStage;
  readonly cause: unknown;

  constructor(stage: ArmStage, cause: unknown) {
    super(`live session not armed: ${stage}`);
    this.stage = stage;
    this.cause = cause;
  }
}

/** A session that is ready, with the microphone captured and the audio flowing. */
export interface Armed {
  capture: LiveCapture;
  stream: MediaStream;
  /** The server's warm up wall time, or null when it named none. */
  warmupMs: number | null;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Open, wait for ready, then capture.
 *
 * @param deps the socket, the microphone, the capture rate and the timeout
 * @return the armed session
 * @throws ArmFailure naming the stage that failed; the socket is closed then,
 *     and after a `capture` failure the microphone's tracks are stopped too
 */
export async function armLive(deps: {
  open(): Promise<LiveSession>;
  getMic(): Promise<MediaStream>;
  rate: number;
  timeoutMs: number;
  timers?: Timers;
}): Promise<Armed> {
  const timers = deps.timers ?? realTimers;
  let session: LiveSession;
  try {
    session = await deps.open();
  } catch (cause) {
    throw new ArmFailure("open", cause);
  }
  let timer: unknown = null;
  let ready: { warmupMs: number | null };
  try {
    ready = await Promise.race([
      session.ready,
      new Promise<never>((_, reject) => {
        timer = timers.set(() => reject(new ArmFailure("timeout", null)), deps.timeoutMs);
      }),
    ]);
  } catch (cause) {
    session.close();
    throw cause instanceof ArmFailure ? cause : new ArmFailure("ready", cause);
  } finally {
    if (timer !== null) timers.clear(timer);
  }
  let stream: MediaStream;
  try {
    stream = await deps.getMic();
  } catch (cause) {
    session.close();
    throw new ArmFailure("mic", cause);
  }
  let capture: LiveCapture;
  try {
    capture = await session.attach(stream, deps.rate);
  } catch (cause) {
    // The microphone is open by now, so a failed audio graph stops it here;
    // the caller never sees this stream.
    stream.getTracks().forEach((track) => track.stop());
    session.close();
    throw new ArmFailure("capture", cause);
  }
  return { capture, stream, warmupMs: ready.warmupMs };
}
