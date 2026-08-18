// Whether the socket is still delivering — a question the socket cannot answer.
//
// Card 261. Reconnect used to happen only from `onclose`, and a TCP peer that
// vanishes without a FIN never produces one: the socket stays OPEN, the chip
// keeps reading connected, and nothing ever arrives again. That is half of the
// owner's report — the view stopped while the record on disk stayed whole.
//
// WHY SILENCE ALONE IS NOT AN ANSWER. A run that is waiting on a slow first
// token or a five-minute tool call sends nothing either, and it looks exactly
// like a dead socket from here. Guessing wrong is not free: the server closes a
// session's run when its socket goes away (SessionConnection#onClose aborts the
// run, closes the session's browser and kills what it launched). So a wrong
// verdict does not cost a reconnect, it costs the operator's run.
//
// Therefore the check is a PROBE, not a silence timer. Silence only asks the
// question; an unanswered probe answers it. The server replies to `ping` off
// the socket thread without touching the run, so a healthy connection answers
// in microseconds no matter how busy the agent is.
//
// The numbers below are the whole contract, and they are stated rather than
// tuned by feel — see LIVENESS_WINDOW_MS.

/** How often the transport asks this module anything, in milliseconds. */
export const LIVENESS_TICK_MS = 5000;

/** Silence that has to pass before a probe is worth sending, in milliseconds. */
export const PROBE_AFTER_SILENCE_MS = 15000;

/** How long one probe may go unanswered before it counts as missed. */
export const PROBE_TIMEOUT_MS = 10000;

/** How many probes must be missed in a row before the socket is called dead. */
export const PROBES_BEFORE_DEAD = 2;

/**
 * The whole liveness window: how long a socket may deliver NOTHING — no event,
 * no answered probe — before the transport stops calling it connected.
 *
 * Two missed probes rather than one, because the cost of a false verdict is the
 * run: the socket must be silent through the whole window AND leave two direct
 * questions unanswered. A server answering pings is never within a mile of it.
 */
export const LIVENESS_WINDOW_MS = PROBE_AFTER_SILENCE_MS + PROBES_BEFORE_DEAD * PROBE_TIMEOUT_MS;

/** The exact frame the transport sends as a probe. The server answers `pong`. */
export const PROBE_FRAME = '{"type":"ping"}';

/** What the transport swallows: the answer to a probe is not news for the app. */
export const PROBE_ANSWER_TYPE = "pong";

export interface LivenessState {
  /** When the socket last delivered anything at all, epoch millis. */
  readonly lastInboundAt: number;
  /** When the outstanding probe went out, or null when none is outstanding. */
  readonly probeSentAt: number | null;
  /** Probes that went unanswered in a row. */
  readonly unanswered: number;
}

/** wait: nothing to do · probe: send one · drop: this socket is dead. */
export type LivenessAction = "wait" | "probe" | "drop";

export interface LivenessLimits {
  probeAfterSilenceMs: number;
  probeTimeoutMs: number;
  probesBeforeDead: number;
}

export const DEFAULT_LIMITS: LivenessLimits = {
  probeAfterSilenceMs: PROBE_AFTER_SILENCE_MS,
  probeTimeoutMs: PROBE_TIMEOUT_MS,
  probesBeforeDead: PROBES_BEFORE_DEAD,
};

/** A socket that has just opened counts as having delivered at that moment. */
export function freshLiveness(now: number): LivenessState {
  return { lastInboundAt: now, probeSentAt: null, unanswered: 0 };
}

/**
 * Any frame at all proves the socket delivers — a pong, an event, a fleet
 * roster. There is nothing better to key on, so nothing else is asked of it.
 *
 * @param state the watch before the frame
 * @param now when the frame arrived, epoch millis
 * @return the watch reset to full health
 */
export function noteInbound(state: LivenessState, now: number): LivenessState {
  void state;
  return freshLiveness(now);
}

/**
 * One tick of the watch.
 *
 * A verdict is only ever reached by a probe that was SENT and then observed to
 * go unanswered on a later tick — never by arithmetic on a single reading. That
 * is what makes a frozen clock (a laptop that slept for an hour) harmless: the
 * first tick after the wake can send a probe, it cannot condemn the socket.
 *
 * @param state the watch as of the last tick
 * @param now the current time, epoch millis
 * @param limits the window, injectable so a test can state its own
 * @return the next watch and what the transport should do about it
 */
export function livenessTick(
  state: LivenessState,
  now: number,
  limits: LivenessLimits = DEFAULT_LIMITS,
): { state: LivenessState; action: LivenessAction } {
  if (now - state.lastInboundAt < limits.probeAfterSilenceMs) {
    return { state, action: "wait" };
  }
  if (state.probeSentAt === null) {
    return { state: { ...state, probeSentAt: now }, action: "probe" };
  }
  if (now - state.probeSentAt < limits.probeTimeoutMs) {
    return { state, action: "wait" };
  }
  const unanswered = state.unanswered + 1;
  if (unanswered >= limits.probesBeforeDead) {
    return { state: { ...state, probeSentAt: null, unanswered }, action: "drop" };
  }
  // Missed, but not yet dead — ask again straight away rather than waiting out
  // another silence, so the whole verdict costs the stated window and no more.
  return { state: { ...state, probeSentAt: now, unanswered }, action: "probe" };
}
