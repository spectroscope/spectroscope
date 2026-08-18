// When the buffered batch is handed to the app — and why that is not just rAF.
//
// Card 261. The transport batched with requestAnimationFrame alone, and a frame
// is not a clock: it is a favour the compositor does a window somebody is
// looking at. An occluded, minimised or backgrounded window gets none, so the
// buffer grew for as long as nobody looked and the view showed nothing of a run
// the session file on disk had in full. CLAUDE.md already records the same trap
// from the other side ("a hidden pane renders NO frame — no requestAnimationFrame,
// and therefore no ResizeObserver delivery either"); this is that trap on the
// live path.
//
// So the pump arms BOTH: the frame, which is what keeps the batching rule
// exactly as it was for a visible window, and a plain timer as the floor under
// it. Whichever comes first folds and disarms the other. For a visible window
// the frame always wins (~16 ms against HIDDEN_FLUSH_MS), so nothing about a
// watched run changes; for a hidden one the timer is the only thing that fires
// and the batch is folded anyway.

/**
 * How long a batch may sit unfolded when no frame ever comes, in milliseconds.
 *
 * A number rather than a feeling: 250 ms is far enough behind a frame (~16 ms)
 * that a visible window never sees this timer at all, and near enough that a
 * window brought back to the front is current instead of replaying minutes.
 * A browser that is throttling a backgrounded page will stretch it — that is
 * the browser's policy and not ours, and a stretched fold is still a fold,
 * which is the whole difference from folding never.
 */
export const HIDDEN_FLUSH_MS = 250;

/** The two clocks the pump arms. Injected so a test can drive both by hand. */
export interface PumpHost {
  requestFrame(run: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(run: () => void, ms: number): number;
  clearTimer(handle: number): void;
}

export interface FlushPump {
  /** Arm both clocks, unless a fold is already pending (this is the batching). */
  schedule(): void;
  /** Disarm both without folding — the caller decides what to do with the buffer. */
  cancel(): void;
  /** True while a fold is armed. */
  pending(): boolean;
}

/**
 * A fold trigger that does not depend on anyone looking at the window.
 *
 * @param host the frame and timer clocks
 * @param fold what to run when the batch is due
 * @param fallbackMs how long to wait for a frame that may never come
 * @return the pump the transport arms on every buffered event
 */
export function createFlushPump(
  host: PumpHost,
  fold: () => void,
  fallbackMs: number = HIDDEN_FLUSH_MS,
): FlushPump {
  let frame: number | null = null;
  let timer: number | null = null;

  const disarm = (): void => {
    if (frame !== null) {
      host.cancelFrame(frame);
      frame = null;
    }
    if (timer !== null) {
      host.clearTimer(timer);
      timer = null;
    }
  };

  // Disarm BEFORE folding: the fold may buffer nothing new, and a pump that
  // still looked armed would swallow the next event's schedule() forever.
  const fire = (): void => {
    disarm();
    fold();
  };

  return {
    schedule(): void {
      if (frame !== null || timer !== null) return;
      frame = host.requestFrame(fire);
      timer = host.setTimer(fire, fallbackMs);
    },
    cancel(): void {
      disarm();
    },
    pending(): boolean {
      return frame !== null || timer !== null;
    },
  };
}
