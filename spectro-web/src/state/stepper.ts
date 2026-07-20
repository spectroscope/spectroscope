// The Lab's event dam — a tiny external store (useSyncExternalStore, same
// pattern as designPrefs). Live events keep queueing here even while the Lab
// tab is unmounted; a step applies the next event(s) through the SAME pure
// reducer the chat uses, plus the Petri marking. Mode "flow" opens the dam.
//
// The store is deliberately pure-logic-only (no DOM): fully unit-testable in
// plain Node.

import { useSyncExternalStore } from "react";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "./reducer";
import type { UiState } from "./reducer";
import { fire, initialMarking, isDelta } from "../lab/petriModel";
import type { Firing, Marking } from "../lab/petriModel";
import { advanceScene, initialScene } from "../lab/labScene";
import type { Scene } from "../lab/labScene";

export type StepSource = "live" | { replayId: string };
export type StepMode = "step" | "flow";
export type StepGrain = "fine" | "coarse";

/** Auto-play pacing bounds (ms per step); the slider stays inside these. */
export const MIN_INTERVAL_MS = 60;
export const MAX_INTERVAL_MS = 2000;
export const DEFAULT_INTERVAL_MS = 1250; // 0.8 steps/s (owner-tuned default)

export interface StepperState {
  source: StepSource;
  mode: StepMode;
  grain: StepGrain;
  queue: RunEvent[];
  applied: RunEvent[];
  ui: UiState;
  marking: Marking;
  /** The scene model, folded alongside the marking (drives the Flow map). */
  scene: Scene;
  /** What the most recently applied event did to the net (null before step 1). */
  lastFired: Firing | null;
  /** Monotonic counter — lets the SVG re-trigger pulse animations per step. */
  fireSeq: number;
  /** Flow auto-play pace in ms per step; the LabView timer reads this. */
  intervalMs: number;
  /** applied-length after each step — a boundary stack so stepBack undoes a
   *  whole step (coarse groups included), symmetric with step(). */
  marks: number[];
}

function freshState(source: StepSource, mode: StepMode, grain: StepGrain, intervalMs: number): StepperState {
  return {
    source,
    mode,
    grain,
    queue: [],
    applied: [],
    ui: initialState,
    marking: initialMarking(),
    scene: initialScene(),
    lastFired: null,
    fireSeq: 0,
    intervalMs,
    marks: [],
  };
}

let state: StepperState = freshState("live", "step", "coarse", DEFAULT_INTERVAL_MS);
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Apply the first n queued events to ui + marking (n clamped to the queue). */
function applyN(s: StepperState, n: number): StepperState {
  const take = Math.min(n, s.queue.length);
  if (take === 0) return s;
  const events = s.queue.slice(0, take);
  let marking = s.marking;
  let scene = s.scene;
  let lastFired = s.lastFired;
  for (const event of events) {
    const fired = fire(marking, event);
    marking = fired.marking;
    lastFired = fired.firing;
    scene = advanceScene(scene, event);
  }
  const applied = [...s.applied, ...events];
  return {
    ...s,
    queue: s.queue.slice(take),
    applied,
    ui: reduceAll(s.ui, events),
    marking,
    scene,
    lastFired,
    fireSeq: s.fireSeq + 1,
    marks: [...s.marks, applied.length],
  };
}

/** Re-fold the derived views (chat, marking, scene) from scratch over `events`. */
function foldFrom(events: RunEvent[]): Pick<StepperState, "ui" | "marking" | "scene" | "lastFired"> {
  let marking = initialMarking();
  let scene = initialScene();
  let lastFired: StepperState["lastFired"] = null;
  for (const event of events) {
    const fired = fire(marking, event);
    marking = fired.marking;
    lastFired = fired.firing;
    scene = advanceScene(scene, event);
  }
  return { ui: reduceAll(initialState, events), marking, scene, lastFired };
}

/** Block step size (the "blocks" grain): a block is the maximal run of consecutive
 *  deltas OF THE SAME TYPE (one thinking run, one answer run — separate
 *  clicks), or exactly one non-delta event. */
function blockCount(queue: RunEvent[]): number {
  if (queue.length === 0 || !isDelta(queue[0])) return Math.min(queue.length, 1);
  const runType = queue[0].type;
  let n = 1;
  while (n < queue.length && queue[n].type === runType) n += 1;
  return n;
}

// ---- actions ---------------------------------------------------------------

/** App feeds every live batch here; ignored while a replay is loaded. */
export function pushLive(batch: RunEvent[]): void {
  if (state.source !== "live" || batch.length === 0) return;
  // Always just queue — in flow mode the LabView timer drains at the chosen
  // pace (see setMode). This is what turns "Flow" into a watchable playback
  // instead of a teleport to the end.
  state = { ...state, queue: [...state.queue, ...batch] };
  emit();
}

/** One click of the Step button. */
export function step(): void {
  if (state.queue.length === 0) return;
  state = applyN(state, state.grain === "fine" ? 1 : blockCount(state.queue));
  emit();
}

/** Undo the last step: pop the whole last step-group back onto the queue and
 *  re-fold chat + marking + scene from scratch. Symmetric with step() (a coarse
 *  step that applied 3 events is undone as 3). */
export function stepBack(): void {
  if (state.applied.length === 0) return;
  const marks = state.marks;
  const target = marks.length >= 2 ? marks[marks.length - 2] : 0;
  const movedBack = state.applied.slice(target);
  const applied = state.applied.slice(0, target);
  state = {
    ...state,
    applied,
    queue: [...movedBack, ...state.queue],
    ...foldFrom(applied),
    fireSeq: state.fireSeq + 1,
    marks: marks.slice(0, -1),
  };
  emit();
}

/** "flow" = auto-play: the LabView timer calls step() every intervalMs. "step"
 *  = manual. Neither drains the queue directly, so switching to flow does not
 *  jump to the end — the timer plays it out at the chosen pace. */
export function setMode(mode: StepMode): void {
  if (state.mode === mode) return;
  state = { ...state, mode };
  emit();
}

export function setGrain(grain: StepGrain): void {
  if (state.grain === grain) return;
  state = { ...state, grain };
  emit();
}

/** Set the flow auto-play pace (ms per step), clamped to a sane range. */
export function setSpeed(intervalMs: number): void {
  const clamped = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));
  if (state.intervalMs === clamped) return;
  state = { ...state, intervalMs: clamped };
  emit();
}

/** Re-step the current source from zero (applied events go back in front). */
export function reset(): void {
  state = {
    ...freshState(state.source, "step", state.grain, state.intervalMs),
    queue: [...state.applied, ...state.queue],
  };
  emit();
}

/** Load an archived session — replaces the source, dam closed. */
export function loadReplay(replayId: string, events: RunEvent[]): void {
  state = { ...freshState({ replayId }, "step", state.grain, state.intervalMs), queue: [...events] };
  emit();
}

/** Back to the live run: App passes its raw event list; stepping restarts. */
export function backToLive(allLiveEvents: RunEvent[]): void {
  state = { ...freshState("live", "step", state.grain, state.intervalMs), queue: [...allLiveEvents] };
  emit();
}

/** "New chat": everything starts over. */
export function resetLive(): void {
  state = freshState("live", state.mode, state.grain, state.intervalMs);
  emit();
}

// ---- store plumbing ---------------------------------------------------------

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): StepperState {
  return state; // state is replaced immutably on every action
}

export function useStepper(): StepperState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only. */
export function __getState(): StepperState {
  return state;
}
export function __resetForTests(): void {
  state = freshState("live", "step", "coarse", DEFAULT_INTERVAL_MS);
  listeners.clear();
}
