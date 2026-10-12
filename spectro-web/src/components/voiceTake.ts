// The send gesture while the microphone is on (card 527 criteria 3 and 5).
//
// Enter or Send while recording stops the capture, waits for the last words
// and sends them with the draft. The wait is bounded on the live routes: one
// chunk step plus the last measured whisper run on the local route, a fixed
// ceiling on the hosted one. When the bound passes, the heard text is taken as
// it stands. On the batch route the wait has no bound: the one answer is the
// transcript.
//
// The rule with teeth: a transcript that arrives after the send never reaches
// the draft. The TakeGate owns that. Once a send has asked for the take, every
// later answer for it is swallowed, so nothing lands in the composer the send
// just emptied.
//
// Pure apart from timers, which are injected: the hook in useVoiceInput.ts
// wires these to the socket and the recorder, and the tests drive them with a
// fake socket.

import type { LiveRoute } from "./liveTranscription";
import { liveStep, LIVE_START, type LiveText } from "./liveSession";

/**
 * The run time assumed before the first run of a recording reports its own.
 * 1000 ms is the slowest of 40 standalone whisper-cli runs measured for card
 * 527 on 2026-10-11 (953 ms, 3 to 30 s windows, ggml-small.bin, Apple M4 Pro,
 * load average 21 to 29), rounded up. It is not the slowest run seen: the live
 * checks of the same day recorded single runs of 1713, 2008 and 4113 ms under
 * heavier load. A final slower than the bound is not waited for; the send
 * takes what was heard.
 */
export const LOCAL_RUN_FALLBACK_MS = 1000;

/**
 * How long the hosted route gets to send its last words after the commit.
 * Not measured for card 527: the hosted route was not called in its live
 * check. A ceiling, not a typical value.
 */
export const HOSTED_FINISH_MS = 3000;

/**
 * How long a send waits for the last words.
 *
 * @param route the route of the recording
 * @param chunkMs the local chunk step from /api/stt/status
 * @param runMs the last local run's wall time, or null before the first
 * @return milliseconds to wait before taking the heard text as it stands
 */
export function finishBoundMs(route: LiveRoute, chunkMs: number, runMs: number | null): number {
  if (route === "hosted") return HOSTED_FINISH_MS;
  return chunkMs + (runMs ?? LOCAL_RUN_FALLBACK_MS);
}

/** Timers, injectable. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One recording's transcript, claimed by a send or not. */
export class TakeGate {
  private resolve: ((text: string) => void) | null = null;
  private fallback: () => string = () => "";
  private timer: unknown = null;
  private spent = false;
  /** True when the bound passed before the last words arrived. */
  timedOut = false;

  constructor(private readonly timers: Timers = realTimers) {}

  /** Whether a send is waiting for this take. */
  get waiting(): boolean {
    return this.resolve !== null;
  }

  /**
   * A send asks for the take.
   *
   * @param fallback what was heard, read when the bound passes or the take fails
   * @param boundMs how long to wait; null waits for the answer, however long
   * @return the text to send
   */
  finish(fallback: () => string, boundMs: number | null): Promise<string> {
    this.fallback = fallback;
    return new Promise<string>((resolve) => {
      this.resolve = resolve;
      if (boundMs !== null) {
        this.timer = this.timers.set(() => {
          this.timedOut = true;
          this.settle(this.fallback());
        }, boundMs);
      }
    });
  }

  /**
   * A transcript arrived.
   *
   * @param text the transcript
   * @return true when the send took it or it came too late, so it must not
   *         reach the draft; false when nobody asked and it goes to the draft
   */
  offer(text: string): boolean {
    if (this.resolve !== null) {
      this.settle(text);
      return true;
    }
    return this.spent;
  }

  /** The take ended without a transcript: the send gets what was heard. */
  fail(): void {
    if (this.resolve !== null) this.settle(this.fallback());
  }

  private settle(text: string): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.spent = true;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    resolve?.(text);
  }
}

/** What a live take's frames do outside the reducer. */
export interface LiveTakeDeps {
  gate: TakeGate;
  /** A transcript for the draft, when no send asked for it. */
  onTranscript(text: string): void;
  /** The reducer's new state, for drawing. */
  onState(state: LiveText): void;
  /** The record this session left, announced on its socket. */
  noteWire(frame: unknown): void;
  /** Microphone off; the socket stays open for the wire frame. */
  releaseMicrophone(): void;
  /** Socket, worklet and microphone, all of it. */
  close(): void;
}

/**
 * The frame handler of one live take.
 *
 * @param deps what the frames do
 * @return the handler, and the state it holds
 */
export function liveTakeHandler(deps: LiveTakeDeps): { onFrame(frame: unknown): void; state(): LiveText } {
  let state: LiveText = LIVE_START;
  return {
    state: () => state,
    onFrame(frame: unknown): void {
      const type = (frame as { type?: unknown } | null)?.type;
      if (type === "wire") deps.noteWire(frame);
      const was = state;
      const now = liveStep(was, frame);
      state = now;
      deps.onState(now);
      if (type === "wire") {
        // The record has announced itself, so there is nothing left to wait
        // for. NOW the socket may go.
        deps.close();
        return;
      }
      if (now.committed !== null && was.committed === null) {
        // Only a final ever reaches the draft, and only when no send took it.
        // An empty transcript is what silence sounds like: a real answer, not
        // something for the draft.
        if (!deps.gate.offer(now.committed) && now.committed !== "") deps.onTranscript(now.committed);
        deps.releaseMicrophone();
      } else if (now.failed !== null && was.failed === null) {
        deps.gate.fail();
        deps.close();
      }
    },
  };
}

/**
 * Enter or Send during a live take: stop the capture and wait for the last
 * words.
 *
 * @param opts the take's gate, its capture, what was heard so far and the bound
 * @return the text to send
 */
export async function startFinish(opts: {
  gate: TakeGate;
  capture: { commit(): void; close(): void };
  heard: () => string;
  boundMs: number;
}): Promise<string> {
  const text = opts.gate.finish(opts.heard, opts.boundMs);
  opts.capture.commit();
  const taken = await text;
  // The last words did not come in time: nobody is waiting for this session
  // any more, so it goes now rather than when the server gets round to it.
  if (opts.gate.timedOut) opts.capture.close();
  return taken;
}
