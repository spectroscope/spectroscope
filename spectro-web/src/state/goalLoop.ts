// Card 504: the goal and the loop of a session, as the page reads them.
//
// Both arrive as socket-only frames: goal_info (card 267) says what the
// session is for, loop_info says whether a loop runs, when it wakes next and
// why. Neither is history: the verdict of a goal check rides the union as
// goal_check, and the record of a loop is the server's .loop.jsonl.
//
// Pure, so the suite pins it in node; the reducer, the goal line, the loop
// chip and the gear's goal section read it.

import type { ClientMessage } from "../events";

/** The goal in force, from goal_info. */
export interface GoalInfo {
  stated: boolean;
  outcome: string;
  check: string;
  file: string;
}

/** The last verdict of the goal check, from goal_check. */
export interface GoalVerdictView {
  outcome: string;
  evidence: string;
}

/** The loop of the session, from loop_info. */
export interface LoopInfo {
  active: boolean;
  loopId: string | null;
  pacing: "fixed" | "self" | null;
  prompt: string;
  intervalSeconds: number | null;
  nextAt: number | null;
  reason: string | null;
  keepalive: boolean;
  held: boolean;
  fires: number;
  startedAt: number;
  endedReason: string | null;
  /** Fix round 1: the loop ended and no page heard its end yet. */
  endUnseen: boolean;
  maxTurns: number | null;
}

/** The three ways a loop ends; each has a chat line. */
export const LOOP_END_REASONS: readonly string[] = ["model_stopped", "aged_out", "user_abort"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @param frame a goal_info frame, of any shape
 * @returns the goal, or null when the frame cannot be read
 */
export function parseGoalInfo(frame: unknown): GoalInfo | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (typeof f.stated !== "boolean") return null;
  return { stated: f.stated, outcome: str(f.outcome), check: str(f.check), file: str(f.file) };
}

/**
 * @param frame a loop_info frame, of any shape
 * @returns the loop, or null when the frame cannot be read
 */
export function parseLoopInfo(frame: unknown): LoopInfo | null {
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (typeof f.active !== "boolean") return null;
  const pacing = f.pacing === "fixed" || f.pacing === "self" ? f.pacing : null;
  return {
    active: f.active,
    loopId: typeof f.loopId === "string" ? f.loopId : null,
    pacing,
    prompt: str(f.prompt),
    intervalSeconds: num(f.intervalSeconds),
    nextAt: num(f.nextAt),
    reason: typeof f.reason === "string" ? f.reason : null,
    keepalive: f.keepalive === true,
    held: f.held === true,
    fires: num(f.fires) ?? 0,
    startedAt: num(f.startedAt) ?? 0,
    endedReason: typeof f.endedReason === "string" ? f.endedReason : null,
    endUnseen: f.endUnseen === true,
    maxTurns: num(f.maxTurns),
  };
}

/**
 * The frame the gear's goal section sends. A blank outcome clears the goal.
 *
 * @param outcome what the session is for
 * @param check   the command whose exit code decides it
 * @returns the set_goal frame
 */
export function goalFrame(outcome: string, check: string): ClientMessage {
  return { type: "set_goal", outcome: outcome.trim(), check: check.trim() };
}

/** @returns the frame that clears the goal: an empty one */
export function clearGoalFrame(): ClientMessage {
  return { type: "set_goal", outcome: "", check: "" };
}

/** @returns the loop chip's Stop */
export function stopLoopFrame(): ClientMessage {
  return { type: "set_loop", action: "stop" };
}

/** What the loop chip says. */
export interface LoopChipView {
  /** "turn 3 of 1000" while a run is live, else null. */
  turn: { n: number; of: number } | null;
  /** When the next wakeup falls due, HH:MM, or null while none is armed. */
  next: string | null;
  reason: string | null;
  held: boolean;
  keepalive: boolean;
}

/**
 * @param at epoch millis
 * @returns the local wall clock, HH:MM
 */
export function clockOf(at: number): string {
  const d = new Date(at);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * The loop chip's reading, a pure fold (card 268 criterion 6).
 *
 * @param loop    the loop, or null
 * @param runTurn the root run's current turn while it is live, else null
 * @returns what the chip shows, or null when no loop runs
 */
export function loopChipView(loop: LoopInfo | null, runTurn: number | null): LoopChipView | null {
  if (loop === null || !loop.active) return null;
  return {
    turn: runTurn !== null && loop.maxTurns !== null ? { n: runTurn, of: loop.maxTurns } : null,
    next: loop.nextAt === null ? null : clockOf(loop.nextAt),
    reason: loop.reason,
    held: loop.held,
    keepalive: loop.keepalive,
  };
}
