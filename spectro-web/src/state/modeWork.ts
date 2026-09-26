// Card 430, criterion 5: in light the browser does no background work for the
// surfaces light closes. Six gates, each a function App calls where the work
// used to run unasked:
//
//   1. the trace rows the live fold builds per frame (and the resume's fold)
//   2. the hidden trace warm-up
//   3. the Lab's live queue
//   4. the fleet store
//   5. the fleet roster fetch when a socket opens
//   6. the /llm-wire/index fetch
//
// Each gate asks the surface table, so a surface light closes does no work.
// And criterion 7: the switch back to learn rebuilds what light did not keep,
// from the full event list the chat, export and translate keep in both modes.

import type { ClientMessage, RunEvent } from "../events";
import type { Place } from "./appRouter";
import type { NavSegmentId } from "../components/navRows";
import { foldArchiveDeferredSliced, foldArchiveSliced, type SlicedFoldOptions } from "./archiveFold";
import { fleetPushLive, hydrateFleet } from "./fleetStore";
import { isSurfaceOpen, type LevelingSnapshot } from "./leveling";
import { planLanding, type Landing } from "./modeRoute";
import {
  initialState,
  LIVE_TRACE_WINDOW,
  recordOutgoing,
  reduceAll,
  reduceAllUntraced,
  reduceUntraced,
  rowModelOf,
  stripLiveTrace,
  traceRowOf,
  windowTrace,
  type TraceEntry,
  type UiState,
} from "./reducer";
import { pushLive as labPushLive } from "./stepper";
import { isOpen } from "./surfaces";
import type { ViewMode } from "./viewMode";

/**
 * Gate 1. One live batch into the live state: with a trace row per frame and
 * the live window where the trace is open (card 246's switch still strips),
 * and through the untraced reducer where it is closed, so no row is built.
 */
export function foldLiveBatch(
  state: UiState,
  batch: RunEvent[],
  mode: ViewMode,
  traceWanted: boolean,
): UiState {
  if (!isOpen("trace", mode)) return reduceAllUntraced(state, batch);
  return windowTrace(stripLiveTrace(reduceAll(state, batch), traceWanted));
}

/** Gate 1, for a frame this window sent: a trace row where the trace is open, nothing where it is closed. */
export function recordLiveOutgoing(
  state: UiState,
  message: ClientMessage,
  mode: ViewMode,
  traceWanted: boolean,
): UiState {
  if (!isOpen("trace", mode)) return state;
  return windowTrace(stripLiveTrace(recordOutgoing(state, message), traceWanted));
}

/**
 * Gate 1, for a resumed session: the fold that becomes the live state. With
 * every trace row where the trace is open, as the resume always folded, and
 * without rows where it is closed. The state is the same in every other field
 * (reduceUntraced's contract).
 *
 * @return the state, or null when `isCurrent` said no before a slice
 */
export async function foldResume(
  events: RunEvent[],
  mode: ViewMode,
  options: SlicedFoldOptions,
): Promise<UiState | null> {
  if (isOpen("trace", mode)) return foldArchiveSliced(events, options);
  const folded = await foldArchiveDeferredSliced(events, options);
  return folded === null ? null : folded.state;
}

/**
 * Gate 2. Where a trace could be shown at all, which is where the hidden trace
 * may be warmed: the trace open in this mode, the sessions segment with no
 * skills view over it and no fleet entered, and no leveling lock on the trace.
 */
export function traceReachableIn(input: {
  mode: ViewMode;
  nav: NavSegmentId;
  skillsOpen: boolean;
  enteredFleet: string | null;
  leveling: LevelingSnapshot | null;
}): boolean {
  return (
    isOpen("trace", input.mode) &&
    input.nav === "sessions" &&
    !input.skillsOpen &&
    input.enteredFleet === null &&
    !(input.leveling !== null && !isSurfaceOpen(input.leveling, "trace"))
  );
}

/** Where a live batch goes besides the chat's fold. */
export interface SurfaceStores {
  lab(batch: RunEvent[]): void;
  fleet(batch: RunEvent[]): void;
}

const STORES: SurfaceStores = { lab: labPushLive, fleet: fleetPushLive };

/** Gates 3 and 4. The Lab's live queue and the fleet store are fed where their surface is open. */
export function feedSurfaceStores(batch: RunEvent[], mode: ViewMode, stores: SurfaceStores = STORES): void {
  if (isOpen("lab", mode)) stores.lab(batch);
  if (isOpen("fleets", mode)) stores.fleet(batch);
}

/** Gate 5. The fleet roster is fetched where the fleets are open. */
export function fetchFleetRosterIn(mode: ViewMode, hydrate: () => Promise<void> = hydrateFleet): void {
  if (isOpen("fleets", mode)) void hydrate();
}

/**
 * Gate 6. Whether an open or a resume asks for the session's /llm-wire/index.
 * The index feeds two things: the exchange rows merged into the trace and the
 * sidecar download link in the chat's export menu. Where the trace is closed,
 * neither is offered (owner call 8, at its default), so nothing waits for it.
 */
export function indexWanted(mode: ViewMode): boolean {
  return isOpen("trace", mode);
}

/** The live state as light keeps it: no trace rows and no count of dropped ones. */
export function enterLight(state: UiState): UiState {
  return stripLiveTrace(state, false);
}

/**
 * Criterion 7. The live state with the trace learn would hold after `events`:
 * `windowTrace(reduceAll(initialState, events))`, built in one pass that pushes
 * the rows rather than copying the list per row, and none when the live trace
 * switch is off. Every other field is the light state's.
 *
 * Frames this window sent while in light were never rows, and a resume's
 * marker and merged exchanges are not in the list, so those rows are not
 * rebuilt.
 */
export function returnToLearn(state: UiState, events: readonly RunEvent[], traceWanted: boolean): UiState {
  if (!traceWanted) return stripLiveTrace(state, false);
  const rows: TraceEntry[] = [];
  let folded = initialState;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    rows.push({ seq: i + 1, ...traceRowOf(event, rowModelOf(folded, event), Date.now) });
    folded = reduceUntraced(folded, event);
  }
  const dropped = Math.max(0, rows.length - LIVE_TRACE_WINDOW);
  return { ...state, trace: dropped > 0 ? rows.slice(dropped) : rows, traceDropped: dropped };
}

/** What a switch reaches in App. */
export interface ModeSwitchDeps {
  /** What is on screen. */
  place(): Place;
  /** The rail's segment. */
  nav(): NavSegmentId;
  /** Run a landing (state/modeRoute.ts). */
  land(landing: Landing): void;
  /** Every live event this window has received, at the moment of the switch. */
  liveEvents(): RunEvent[];
  setLive(update: (state: UiState) => UiState): void;
  /** Card 246's live trace switch. */
  traceWanted(): boolean;
  lab: { reset(): void; backToLive(events: RunEvent[]): void };
  fetchFleetRoster(): void;
}

/**
 * Run a switch to `next`, synchronously, the moment the store changes: land on
 * the chat if the surface on screen closes, then free what the new mode does
 * not keep or rebuild what it needs. Synchronous because the live fold reads
 * the mode at call time: a batch that arrives after this call is folded in the
 * new mode, and every batch before it is in `liveEvents()`.
 */
export function applyModeSwitch(next: ViewMode, deps: ModeSwitchDeps): void {
  const landing = planLanding(deps.place(), deps.nav(), next);
  if (landing.leaveFleet || landing.nav !== null || landing.tab !== null || landing.route !== null) {
    deps.land(landing);
  }
  if (isOpen("trace", next)) {
    const events = deps.liveEvents();
    const wanted = deps.traceWanted();
    deps.setLive((state) => returnToLearn(state, events, wanted));
  } else {
    deps.setLive(enterLight);
  }
  if (isOpen("lab", next)) deps.lab.backToLive(deps.liveEvents());
  else deps.lab.reset();
  if (isOpen("fleets", next)) deps.fetchFleetRoster();
}
