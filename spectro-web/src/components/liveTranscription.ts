// Whether the text can appear WHILE someone speaks, and what to say when it
// cannot (card 187 step 6).
//
// Pure on purpose, like voiceButton.ts and voiceNoticeReading.ts beside it: the
// decision is a handful of branches that must be identical in the toggle, in the
// tooltip and in the hook that opens the session, and three copies of a branch
// is how they drift apart.
//
// THE OWNER'S RULE for this control, and it has two halves:
//
//   1. Greyed out whenever the route being taken cannot stream, active when it
//      can, NEVER hidden. A control that disappears teaches nobody anything;
//      the whole first step of this card exists because a vanished button was
//      the app's way of saying "permission denied".
//   2. NEVER silently rerouted. Wanting live text is not consent to send audio
//      off a machine whose owner chose the offline path — so a local user who
//      flips this on gets a grey switch and a sentence, not a hosted session.
//
// WHY LOCAL CANNOT STREAM TODAY: the local route spawns `whisper-cli` once over
// a finished wav. Partials would need whisper.cpp's `stream` example, which is a
// RESIDENT process this app would have to own, start, watch and reap — the road
// the card weighs separately. Nothing here decides that; this module only
// reports what today's routes can do.

import { WHISPER_RATE } from "./wavClip";

/** The two ways a recording becomes text. Mirrors the server's `SttRoute`, and
 *  arrives from `/api/stt/status` as this exact string. */
export type LiveRoute = "hosted" | "local";

/** Why live text is not going to happen on the next press. */
export type LiveBlocked =
  /** The route being taken transcribes a finished file, not a stream. */
  | "localRoute"
  /** The hosted route was chosen explicitly and has no key to call with. */
  | "noKey";

/** The part of `/api/stt/status` this decision needs. Naming only these two
 *  keeps the module testable without a server and honest about its inputs. */
export interface LiveStatus {
  /** The route the server says it would take right now. */
  readonly route: LiveRoute;
  /** Whether that route can actually run — false on hosted means no key. */
  readonly speechWorks: boolean;
}

/** What the toggle renders, what the hook does, and the sentence under both. */
export interface LiveReading {
  /** The route this reading is about. Carried so a caller cannot re-derive it
   *  differently — the rerouting bug would begin exactly there. */
  readonly route: LiveRoute;
  /** Whether the route CAN stream partials at all, regardless of the setting. */
  readonly streams: boolean;
  /** Whether the next press really opens a live session. */
  readonly active: boolean;
  /** Why not, when it is not. Null while the control is free to be on. */
  readonly blocked: LiveBlocked | null;
  /** The sentence for the control, always present — including greyed out. */
  readonly key: string;
}

/**
 * The sample rate the realtime session accepts.
 *
 * Measured against the live API on 2026-08-09, by being refused: a session
 * update carrying `rate: 16000` comes back
 * `integer_below_min_value ... Expected a value >= 24000`. The refusal arrives
 * AFTER the user has spoken, which is the worst moment to discover a constant,
 * so it is pinned here and in a test rather than learned again in production.
 */
export const LIVE_RATE = 24000;

/**
 * What to capture at, given the route and whether live text was asked for.
 *
 * The two paths cannot share a number. {@link WHISPER_RATE} is whisper.cpp's one
 * input rate and anything else transcribes to nonsense; {@link LIVE_RATE} is the
 * realtime session's documented floor. So the rate stops being a constant and
 * becomes a function of the route — decided BEFORE the `AudioContext` is built,
 * because the decoder is constructed at the target rate (step 5.4's measurement
 * is what makes the resample free, and it only holds if the rate is right from
 * the start).
 *
 * @param route the route the server says it would take
 * @param live whether a live session is what this press will open
 * @return the rate to build the capture chain at
 */
export function captureRate(route: LiveRoute, live: boolean): number {
  return live && route === "hosted" ? LIVE_RATE : WHISPER_RATE;
}

/**
 * How the live control reads right now.
 *
 * @param status what the server says about the route
 * @param wanted whether the user has the live setting switched on
 * @return the reading for the toggle, its tooltip and the hook
 */
export function liveReading(status: LiveStatus, wanted: boolean): LiveReading {
  const blocked: LiveBlocked | null =
    status.route === "local" ? "localRoute" : status.speechWorks ? null : "noKey";
  const streams = blocked === null;
  return {
    route: status.route,
    streams,
    // `wanted` is deliberately the LAST term: a route that cannot stream stays
    // inactive no matter how the setting is written, and there is no branch
    // anywhere that turns a local route into a hosted one to satisfy it.
    active: streams && wanted,
    blocked,
    key: sentenceFor(blocked, streams && wanted),
  };
}

/** The one sentence the control carries, in every one of its states. */
function sentenceFor(blocked: LiveBlocked | null, active: boolean): string {
  if (blocked === "localRoute") return "voice.live.localRoute";
  if (blocked === "noKey") return "voice.live.noKey";
  return active ? "voice.live.on" : "voice.live.off";
}
