// The transport's replay clock and keyboard grammar, ported from the measured
// template (docs/graph-view-reference/graphview.html, its play()/pause()/
// schedule() and keydown handler).
//
// DOM-free on purpose, like layout.ts: the component's effects never run in
// this tree's plain-Node suite, so the thing that owns time is a closure fake
// timers can drive, and the component only wires it to state.
//
// One deliberate divergence from the template, on the owner's order: "instant"
// JUMPS to the last record. The template plays it as a 90 ms cadence, which on
// a 400-record run is still half a minute of waiting for a word that promises
// none.

/** The five speeds the select offers, as its option values. */
export type SpeedChoice = "0.5" | "1" | "2" | "4" | "instant";

export const SPEED_CHOICES: readonly SpeedChoice[] = ["0.5", "1", "2", "4", "instant"];

/**
 * How long the step from record `i` to `i + 1` waits: the recorded gap scaled
 * by speed and clamped to the template's 45..760 ms window, with 260/speed for
 * a pair that carries no usable timestamps.
 */
export function stepDelayMs(records: readonly { ts: number }[], i: number, speed: number): number {
  const cur = records[i];
  const nxt = records[i + 1];
  if (cur !== undefined && nxt !== undefined && cur.ts > 0 && nxt.ts > 0) {
    return Math.min(760, Math.max(45, (nxt.ts - cur.ts) / speed));
  }
  return 260 / speed;
}

export type TransportIntent = "toggle" | "next" | "prev" | "first" | "last" | null;

export interface KeyContext {
  key: string;
  /** The event target's tag name, lowercase. */
  tag: string;
  /** The input's `type` when the target is an <input>. */
  inputType?: string;
  /** Whether the target sits inside the right panel (.sg-panel). */
  inPanel: boolean;
  /** contentEditable targets — a text field by another name. */
  editable: boolean;
  /** Any of meta/ctrl/alt held. Cmd+Arrow is App.tsx's history hotkey. */
  modified: boolean;
}

/**
 * What a keydown means to the transport, or null when it is not the
 * transport's business. The template's rules, one seam:
 *
 *   - a text field keeps every key; a range input keeps only its arrows
 *   - space belongs to whatever the reader has focused inside the panel —
 *     a disclosure, a scrollable value — and is never stolen from there
 *   - a modified key is the app's, not this pane's
 */
export function transportIntent(k: KeyContext): TransportIntent {
  if (k.modified) return null;
  if (k.tag === "textarea" || k.tag === "select" || k.editable) return null;
  if (k.tag === "input" && k.inputType !== "range") return null;
  if (k.key === " ") return k.inPanel ? null : "toggle";
  if (k.key === "ArrowRight") return k.tag === "input" ? null : "next";
  if (k.key === "ArrowLeft") return k.tag === "input" ? null : "prev";
  if (k.key === "Home") return "first";
  if (k.key === "End") return "last";
  return null;
}

export interface ClockIo {
  /** How many records there are NOW — a new file can arrive mid-play. */
  count: () => number;
  /** Where the transport stands, read fresh between ticks. */
  cursor: () => number;
  seek: (i: number) => void;
  /** The wait before stepping past record `at`, or "instant" to jump. */
  delay: (at: number) => number | "instant";
  /** Fired on every play/pause flip, so the button can repaint. */
  onPlaying: (playing: boolean) => void;
}

export interface ReplayClock {
  playing(): boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Re-time the pending step — a speed change takes effect NOW, not after
   *  the old wait has run out. */
  reschedule(): void;
  /** Stops cold without the onPlaying callback: unmount teardown. */
  dispose(): void;
}

/**
 * The template's play/pause/schedule triple as a closure over injected IO.
 *
 * The chained setTimeout is deliberate — an interval cannot carry a
 * per-record cadence. Each step computes its successor from the position it
 * just seeked to, never from `cursor()`, because the caller's cursor is React
 * state and within one tick the ref behind it is still the old value.
 */
export function createReplayClock(io: ClockIo): ReplayClock {
  let playing = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const pause = (): void => {
    clear();
    if (!playing) return;
    playing = false;
    io.onPlaying(false);
  };

  const scheduleFrom = (at: number): void => {
    clear();
    if (!playing) return;
    const last = io.count() - 1;
    if (at >= last) {
      pause();
      return;
    }
    const d = io.delay(at);
    if (d === "instant") {
      io.seek(last);
      pause();
      return;
    }
    timer = setTimeout(() => {
      const next = Math.min(io.count() - 1, at + 1);
      io.seek(next);
      if (next >= io.count() - 1) pause();
      else scheduleFrom(next);
    }, d);
  };

  const play = (): void => {
    if (playing || io.count() === 0) return;
    let at = io.cursor();
    if (at >= io.count() - 1) {
      // The template's restart: pressing play on a finished replay is a wish
      // to see it again, not a no-op.
      at = 0;
      io.seek(0);
    }
    playing = true;
    io.onPlaying(true);
    scheduleFrom(at);
  };

  return {
    playing: () => playing,
    play,
    pause,
    toggle: (): void => {
      if (playing) pause();
      else play();
    },
    reschedule: (): void => {
      if (playing) scheduleFrom(io.cursor());
    },
    dispose: (): void => {
      clear();
      playing = false;
    },
  };
}
