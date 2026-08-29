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
import { beacon } from "./levelingBeacon";

export type StepSource = "live" | { replayId: string };
export type StepMode = "step" | "flow";
export type StepGrain = "fine" | "coarse";

/** Auto-play pacing bounds (ms per step); the slider stays inside these.
 *
 *  The slow bound is DERIVED, not chosen: card 299 puts a 0.25x pill on the
 *  transport, and 0.25x of the default pace is 5000 ms. Left at the old 2000 the
 *  store would have clamped that pill to 0.625x while the label kept saying
 *  0.25x — a control lying about what it does. `intervalForFactor(0.25) ===
 *  MAX_INTERVAL_MS` is pinned, so moving either number without the other is red.
 */
export const MIN_INTERVAL_MS = 60;
export const MAX_INTERVAL_MS = 5000;
export const DEFAULT_INTERVAL_MS = 1250; // 0.8 steps/s (owner-tuned default), the pills' 1x

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
function blockCount(queue: readonly RunEvent[]): number {
  if (queue.length === 0 || !isDelta(queue[0])) return Math.min(queue.length, 1);
  const runType = queue[0].type;
  let n = 1;
  while (n < queue.length && queue[n].type === runType) n += 1;
  return n;
}

/** The coarse-step boundaries of a stream: [0, b1, b2, …, length]. The replay
 *  scrubber walks these, so a drag lands on a whole step, never mid-block. */
export function stepBoundaries(events: readonly RunEvent[]): number[] {
  const bs = [0];
  let cursor = 0;
  while (cursor < events.length) {
    cursor += blockCount(events.slice(cursor));
    bs.push(cursor);
  }
  return bs;
}

// ---- card 299: where the interesting part is -------------------------------
//
// Three readings of the same stream the scrubber already walks, all pure and
// all DOM-free, so the gate measures them in plain Node. The transport renders
// them; nothing here knows a transport exists.

/** What a chapter mark stands for — the canon's own vocabulary, one value per
 *  fact the wire already carries. */
export type ChapterKind =
  | "turn"
  | "spawn"
  | "compaction"
  | "gate"
  | "denied"
  | "no_progress"
  | "intervention"
  | "question"
  | "skill"
  | "error"
  | "end";

/** One tick on the scrub bar.
 *
 *  The label rides as a dict KEY plus its placeholders rather than as a
 *  finished sentence: chrome text lives in i18n.ts in both locales, and a
 *  sentence written here would exist in one language only. `chapterLabel`
 *  (src/lab/chapterLabel.ts) turns a mark into the line a reader sees. */
export interface ChapterMark {
  /** Index of the event this mark is about, in the stream it was read from. */
  at: number;
  kind: ChapterKind;
  labelKey: string;
  vars: Record<string, string | number>;
}

/** How much of an error message one tick's label carries. */
const MARK_MESSAGE_CAP = 60;

/** The progress detectors this build has a line for (card 262). A fourth one
 *  still gets a mark, through `.other`, which prints the wire name — going
 *  quiet on a net nobody here has heard of is the worse mistake. */
const MARK_DETECTORS: ReadonlySet<string> = new Set(["identical_writes", "repeated_failure", "stalled_plan"]);

/** The Intervention enum's values (card 281), same rule as above. */
const MARK_INTERVENTIONS: ReadonlySet<string> = new Set(["CARRY_ON", "CHANGE_COURSE", "END"]);

/** The tool names a skill load arrives under. There is NO skill event on the
 *  wire: a skill load IS a tool call, and these are the two names toolViews.ts
 *  reads it by. */
const SKILL_TOOLS: ReadonlySet<string> = new Set(["Skill", "use_skill"]);

/** One line, capped with a visible mark — a tick's tooltip is not a transcript. */
function markMessage(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= MARK_MESSAGE_CAP ? oneLine : `${oneLine.slice(0, MARK_MESSAGE_CAP - 1)}…`;
}

/** The skill's own name out of a Skill call's input; null when it names none. */
function skillNameOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["name", "skill"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * The chapters of a run: the moments somebody scrubbing several hundred coarse
 * steps is actually looking for.
 *
 * @param events the stream to read — applied plus queued, the whole run
 * @return one mark per interesting event, in the stream's own order
 */
export function chapterMarks(events: readonly RunEvent[]): ChapterMark[] {
  const marks: ChapterMark[] = [];
  events.forEach((e, at) => {
    switch (e.type) {
      case "turn_start":
        marks.push({ at, kind: "turn", labelKey: "lab.mark.turn", vars: { n: e.turn } });
        break;
      case "agent_spawn":
        marks.push({ at, kind: "spawn", labelKey: "lab.mark.spawn", vars: { id: e.agentId } });
        break;
      case "compaction":
        marks.push({ at, kind: "compaction", labelKey: "lab.mark.compaction", vars: { n: e.removedTurns } });
        break;
      case "permission_request":
        marks.push({ at, kind: "gate", labelKey: "lab.mark.gate", vars: { name: e.name } });
        break;
      case "permission_decision":
        // Only a refusal is a chapter. An allowed call is the run carrying on,
        // and a tick on every gate would bury the one that stopped something.
        if (!e.allowed) marks.push({ at, kind: "denied", labelKey: "lab.mark.denied", vars: {} });
        break;
      case "no_progress":
        marks.push({
          at,
          kind: "no_progress",
          labelKey: MARK_DETECTORS.has(e.detector)
            ? `lab.mark.noProgress.${e.detector}`
            : "lab.mark.noProgress.other",
          vars: { n: e.count, detector: e.detector },
        });
        break;
      case "progress_intervention":
        marks.push({
          at,
          kind: "intervention",
          labelKey: MARK_INTERVENTIONS.has(e.intervention)
            ? `lab.mark.intervention.${e.intervention}`
            : "lab.mark.intervention.other",
          vars: { intervention: e.intervention },
        });
        break;
      case "question_asked":
        marks.push({ at, kind: "question", labelKey: "lab.mark.question", vars: { n: e.questions.length } });
        break;
      case "error":
        marks.push({
          at,
          kind: "error",
          labelKey: "lab.mark.error",
          vars: { message: markMessage(e.message) },
        });
        break;
      case "run_end":
        // The reason travels as the WIRE value; the label resolves it through
        // stopReasonKey, so the tick and the transcript footer say the same word.
        marks.push({ at, kind: "end", labelKey: "lab.mark.end", vars: { reason: e.stopReason } });
        break;
      case "tool_call": {
        if (!SKILL_TOOLS.has(e.name)) break;
        const name = skillNameOf(e.input);
        marks.push(
          name === null
            ? { at, kind: "skill", labelKey: "lab.mark.skill.unnamed", vars: {} }
            : { at, kind: "skill", labelKey: "lab.mark.skill", vars: { name } },
        );
        break;
      }
      default:
        break;
    }
  });
  return marks;
}

/** A mark placed on the scrub bar. */
export interface MarkPosition {
  mark: ChapterMark;
  /** The boundary index to seek to. The first boundary PAST the marked event,
   *  never the one before it: seeking to the boundary before shows the run just
   *  short of the thing the tick promised. */
  index: number;
  /** Where the tick sits along the bar, 0-100. */
  pct: number;
}

/**
 * The coarse step that SHOWS the event at `at`: the first boundary past it,
 * never the one before, because the step before stops the run just short of the
 * thing the caller pointed at.
 *
 * ONE PLACE, THREE READERS (card 309). The tick has used this rule since card
 * 299; the moments panel and the file rows now print the same number and seek
 * to it. Copied a second time, the panel and the tick would eventually name
 * different steps for one moment, and neither would look wrong on its own.
 *
 * @param boundaries stepBoundaries of the stream `at` indexes into
 * @param at an event index in that stream
 * @return an index INTO `boundaries` — the step number the transport counter
 *         shows, and `boundaries[step]` is the cursor to seek to
 */
export function stepOfEvent(boundaries: readonly number[], at: number): number {
  const found = boundaries.findIndex((b) => b > at);
  return found < 0 ? Math.max(0, boundaries.length - 1) : found;
}

/**
 * Place marks on the coarse-step bar the scrubber walks.
 *
 * @param marks what chapterMarks read off the same stream
 * @param boundaries stepBoundaries of that stream
 */
export function markPositions(marks: readonly ChapterMark[], boundaries: readonly number[]): MarkPosition[] {
  const last = Math.max(0, boundaries.length - 1);
  return marks.map((mark) => {
    const index = stepOfEvent(boundaries, mark.at);
    return { mark, index, pct: last === 0 ? 0 : (index / last) * 100 };
  });
}

/**
 * Where the transport's jump-to-the-end lands: the whole stream applied.
 *
 * A one-line reading that lives here rather than inside the view because the
 * view pinned it by the button's LABEL alone — seeking to `all.length - 1`,
 * which stops the run one event short of its own ending, renders an identical
 * button. It is also the tie to the slider: this is the LAST value
 * stepBoundaries hands back for the same stream, so the ⇥ and the bar's right
 * end are one place and cannot drift into two.
 *
 * @param all the whole stream — applied plus queued
 * @return the cursor to seek to
 */
export function endSeekTarget(all: readonly RunEvent[]): number {
  return all.length;
}

/**
 * The narrowest gap two ticks may keep, in percent of the scrub bar.
 *
 * Not a taste question. A tick's clickable box is 11px wide (lab.css
 * `.lab-mark`), so two ticks closer than that overlap and the nearer half of
 * each stops being reachable. Measured on a plain 60-turn single-agent run —
 * 422 events, 242 coarse steps, the "several hundred coarse steps" this card
 * was written for — every turn drew a tick: 61 of them, 1.65% apart, which is
 * 9.9px on a 600px bar. At 2% they stand 12px apart on that same bar, one hit
 * box clear of each other, and no run can put more than 51 of them up.
 */
export const MARK_MIN_GAP_PCT = 2;

/**
 * Which of two crowding ticks keeps the place: the rarer kind.
 *
 * `turn` is the only kind that fires every turn, and `spawn` fires per child —
 * on any run long enough to need thinning those two ARE the crowd. The other
 * nine are exceptions, and being rare is exactly what makes them the part
 * somebody scrubbing several hundred coarse steps is looking for.
 *
 * The number is a rank, not a weight: nothing adds these up, they are only ever
 * compared. A Record over the whole ChapterKind union on purpose — a twelfth
 * kind will not COMPILE until somebody says whether it is crowd or chapter.
 */
const MARK_RANK: Record<ChapterKind, number> = {
  turn: 0,
  spawn: 0,
  compaction: 1,
  gate: 1,
  denied: 1,
  no_progress: 1,
  intervention: 1,
  question: 1,
  skill: 1,
  error: 1,
  end: 1,
};

/**
 * Thin placed marks down to ticks a reader can tell apart and a pointer can
 * hit, dropping the ones that crowd their neighbour.
 *
 * Read from the END backwards, so the last chapter of the run always survives:
 * it is the tick a presenter jumps to, and thinning from the front would keep
 * the turn just before the finish and throw the finish away.
 *
 * Position alone is not enough to choose between two ticks that crowd. Measured
 * on a plain 60-turn run carrying ONE error (chapterMarks.test.ts builds it):
 * 62 marks thin to 31, and by position alone the error was not among them — it
 * stood 0.41% before an ordinary turn boundary, the backwards walk kept the
 * later one, and the single failure of the run vanished behind thirty turns
 * that all said the same thing. So a crowded pair is settled by MARK_RANK
 * first and by position only on a tie.
 *
 * @param marks placed marks, in the run's own order
 * @param minGapPct the floor, in percent of the bar
 * @return the survivors, still in the run's order
 */
export function thinMarks(marks: readonly MarkPosition[], minGapPct: number): MarkPosition[] {
  const kept: MarkPosition[] = [];
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const m = marks[i];
    const held = kept[kept.length - 1];
    if (held === undefined || held.pct - m.pct >= minGapPct) {
      kept.push(m);
      continue;
    }
    // They crowd, so one of the two goes. The rarer kind takes the place; on a
    // tie the later one holds it, which is what keeps the run's ending.
    //
    // Swapping is safe without a second pass: m stands EARLIER than the tick it
    // replaces, so its gap to the neighbour already kept behind it can only
    // grow, and the floor holds for the whole row.
    if (MARK_RANK[m.mark.kind] > MARK_RANK[held.mark.kind]) kept[kept.length - 1] = m;
  }
  return kept.reverse();
}

/** The run's wall clock, in milliseconds. */
export interface RunClock {
  elapsedMs: number;
  totalMs: number;
}

/** The event's timestamp, or null when it carries none a clock can read. */
function timestampOf(e: RunEvent): number | null {
  const ts = (e as { ts?: unknown }).ts;
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * How far into the run the cursor stands, in wall clock.
 *
 * @param all the whole stream (applied plus queued)
 * @param cursor how many events are applied
 * @return the span, or NULL when the recording carries no readable one — an
 *         imported transcript without timestamps, a single line, or a whole run
 *         stamped on one millisecond. A "0:00 / 0:00" would be a claim about a
 *         run's duration that nothing measured.
 */
export function runClock(all: readonly RunEvent[], cursor: number): RunClock | null {
  // A bounds guard, not a second rule: it is what makes the two index reads
  // below safe. A ONE-event stream is caught by the zero-span rule underneath
  // anyway, which is why no test can tell `< 2` from `< 1` here.
  if (all.length < 2) return null;
  const first = timestampOf(all[0]);
  const last = timestampOf(all[all.length - 1]);
  if (first === null || last === null) return null;
  const totalMs = last - first;
  if (totalMs <= 0) return null;
  const applied = Math.max(0, Math.min(all.length, Math.round(cursor)));
  if (applied === 0) return { elapsedMs: 0, totalMs };
  const here = timestampOf(all[applied - 1]);
  if (here === null) return { elapsedMs: 0, totalMs };
  // Clamped into the span: a session file may carry stamps out of order, and an
  // elapsed larger than the total would read as a bug in the clock.
  return { elapsedMs: Math.max(0, Math.min(totalMs, here - first)), totalMs };
}

/** Milliseconds as a transport clock: "0:07", "10:00", "1:02:05". Truncated,
 *  because this labels a position that has been reached. */
export function clockLabel(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** The multipliers the transport offers, slowest first. 1x is the shipped
 *  default pace — a speed control with no baseline names nothing. */
export const SPEED_FACTORS: readonly number[] = [0.25, 0.5, 1, 2, 5];

/** The interval one multiplier means. */
export function intervalForFactor(factor: number): number {
  return Math.round(DEFAULT_INTERVAL_MS / factor);
}

/** The pill that matches a pace, or null for a pace set off the grid (the
 *  tempo slider under "more" still moves freely). */
export function speedFactorOf(intervalMs: number): number | null {
  return SPEED_FACTORS.find((f) => intervalForFactor(f) === intervalMs) ?? null;
}

/** The marks stack for an arbitrary applied prefix — coarse boundaries, or one
 *  per event in fine grain — so stepBack stays symmetric after a seek(). */
function marksFor(applied: RunEvent[], grain: StepGrain): number[] {
  if (grain === "fine") return applied.map((_, i) => i + 1);
  return stepBoundaries(applied).slice(1);
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
  // Stepping is the act the ladder watches, and it is distinct from opening the
  // lab: walking a run one event at a time is the thing worth crediting.
  beacon("lab-step");
  emit();
}

/** Undo the last step: pop the whole last step-group back onto the queue and
 *  re-fold chat + marking + scene from scratch. Symmetric with step() (a coarse
 *  step that applied 3 events is undone as 3). */
export function stepBack(): void {
  if (state.applied.length === 0) return;
  beacon("lab-step");
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

/** Scrub to an absolute cursor: fold the first n events, re-queue the rest, and
 *  rebuild the coarse marks stack (so stepBack still undoes a whole block). n is
 *  clamped to [0, total]; a no-op when already there. */
export function seek(n: number): void {
  const all = [...state.applied, ...state.queue];
  const target = Math.max(0, Math.min(all.length, Math.round(n)));
  if (target === state.applied.length) return;
  const applied = all.slice(0, target);
  state = {
    ...state,
    applied,
    queue: all.slice(target),
    ...foldFrom(applied),
    fireSeq: state.fireSeq + 1,
    marks: marksFor(applied, state.grain),
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
