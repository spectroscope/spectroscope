// The Spectrum tab's pure model: RunEvent[] -> one horizontal lane per agent.
// This is the brand image made literal: every agent is a spectral line, every
// event a discrete mark on it, the whole fleet on one screen. Pure and
// framework-free, the same mental figure as reduce/buildGraph — live stream
// and replayed archive fold through the exact same function.

import type { RunEvent } from "../events";

export type TickKind =
  | "token" // text_delta            — teal
  | "reasoning" // thinking_delta        — violet ("the line you follow")
  | "tool" // tool_call/result      — amber
  | "gate" // permission events     — red (violet while pending)
  | "ask" // question asked/answered — violet: the only mark that means a
  //                                  PERSON is holding the run (card 265)
  | "subagent" // spawn + agent_message — ocean
  | "lifecycle" // run/turn boundaries   — faint
  | "error"; // error / failed result — red, full height

export interface LaneTick {
  /** Position on the shared time axis, normalized 0..1 and clamped: a frame
   *  that carries no timestamp lands on the edge, never off the band. */
  x: number;
  kind: TickKind;
  /** Index of the source event (stable render key, trace hand-off). */
  seq: number;
  /** Request ticks (a gate, or an ask): true while no decision or answer has
   *  arrived yet. */
  pending?: boolean;
  /** Gate decision ticks: the recorded outcome. */
  allowed?: boolean;
}

/**
 * One finished exchange with the model, on the lane's SECOND line (card 184
 * leg 4).
 *
 * The app protocol runs above, the conversation with the backend below, and the
 * two are joined by {@link WireTick.xid} — which is what makes the picture worth
 * having: you can see the call leave under the turn that caused it. Metadata
 * only; the bodies live in the sidecar and the gated endpoint serves them when
 * something asks.
 */
export interface WireTick {
  /** Position on the SAME time axis as the ticks above, normalized 0..1. */
  x: number;
  /** Index of the source event (stable render key, trace hand-off). */
  seq: number;
  /** The sidecar's key. A mark you cannot follow back to its record is
   *  decoration, so this always travels. */
  xid: string;
  /** What the call was for: chat | compaction | image | stt. */
  kind: string;
  /** The model that answered — the lane's own model may differ per call
   *  (compaction runs its own). */
  model: string;
  /** Null when nothing ever answered. Drawing that like a 200 would be the
   *  record lying in a picture. */
  status: number | null;
  /** True when a cancel tore the stream down mid-generation. */
  aborted: boolean;
  durationMs: number;
}

export interface Lane {
  id: string;
  parentId: string | null;
  /** The dev tool that spawned it ("build_plan", …) or null. */
  label: string | null;
  /** The root prompt / the task message — the lane's subtitle. */
  task: string;
  state: "submitted" | "working" | "completed" | "failed";
  lastStatus: string | null;
  /** True while a permission request on this lane awaits its decision. */
  pendingGate: boolean;
  /** True while a QUESTION on this lane awaits an answer (card 265). Its own
   *  flag and not the gate's: a gate is a yes/no on a side effect and has a
   *  verdict to report, a question has none, and the two are answered by two
   *  different surfaces. In fleet mode this is the flag that says which of five
   *  lanes is waiting for you. */
  pendingAsk: boolean;
  /** Every mark the stream produced, sorted by x with seq breaking a tie.
   *  Sorted is a PRECONDITION: the slicer reaches for the visible range with a
   *  binary search. How many of these reach the screen is a question for the
   *  viewport (see laneSlice.ts), not for this fold. */
  ticks: LaneTick[];
  /** The second line: this agent's exchanges with the model, sorted by x.
   *  EMPTY rather than absent for a lane that never called one — an agent that
   *  only ran tools has a line with nothing on it, and that is a fact worth
   *  seeing rather than a case every renderer has to guard. */
  wire: WireTick[];
  inTokens: number;
  outTokens: number;
  /** The lane's latest reasoning text — a bounded buffer (latest wins), so the
   *  Spectrum peek shows current thinking, not a growing transcript. Empty
   *  until the agent emits a thinking_delta. */
  thinking: string;
}

export interface SpectrumModel {
  lanes: Lane[];
  /** Time domain of the stream (epoch ms); equal when the stream is empty. */
  t0: number;
  t1: number;
  /** True while the ROOT run is still open (mirrors the reducer's rule). */
  running: boolean;
  /** Events consumed (all types, including the ones that leave no mark). */
  totalEvents: number;
}

/** Per lane: the reasoning buffer keeps at most this many trailing characters
 *  (latest wins), so a long chain of thought stays a peek, not a memory leak. */
export const MAX_LANE_THINKING = 4096;

/** Divider between distinct reasoning segments in a lane's aggregated thinking
 *  (rendered pre-wrap, so the blank lines + rule read as a break). */
const LANE_THINKING_SEP = "\n\n———\n\n";

interface RawTick {
  ts: number;
  kind: TickKind;
  seq: number;
  callId?: string;
  allowed?: boolean;
  isRequest?: boolean;
  /** Filled in the final pass: request without a recorded decision. */
  pending?: boolean;
}

interface RawWire {
  ts: number;
  seq: number;
  xid: string;
  kind: string;
  model: string;
  status: number | null;
  aborted: boolean;
  durationMs: number;
}

interface LaneAcc {
  lane: Omit<Lane, "ticks" | "wire">;
  ticks: RawTick[];
  wire: RawWire[];
}

/** Fold a whole stream into the Spectrum model. */
export function buildSpectrum(events: RunEvent[]): SpectrumModel {
  const acc = new Map<string, LaneAcc>();
  const order: string[] = [];
  const runToAgent = new Map<string, string>();
  const callToAgent = new Map<string, string>();
  const undecided = new Set<string>();
  /** callIds of questions no answer has arrived for (card 265). Separate from
   *  `undecided`, so a parked question never lights the gate flag. */
  const unanswered = new Set<string>();
  let rootRunId: string | null = null;
  let running = false;

  const laneOf = (id: string): LaneAcc => {
    let l = acc.get(id);
    if (l === undefined) {
      l = {
        lane: {
          id,
          parentId: null,
          label: null,
          task: "",
          state: "submitted",
          lastStatus: null,
          pendingGate: false,
          pendingAsk: false,
          inTokens: 0,
          outTokens: 0,
          thinking: "",
        },
        ticks: [],
        wire: [],
      };
      acc.set(id, l);
      order.push(id);
    }
    return l;
  };
  const tick = (id: string, t: RawTick): void => {
    laneOf(id).ticks.push(t);
  };

  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  events.forEach((event, seq) => {
    const ts = typeof (event as { ts?: unknown }).ts === "number" ? (event as { ts: number }).ts : 0;
    if (ts > 0) {
      t0 = Math.min(t0, ts);
      t1 = Math.max(t1, ts);
    }
    switch (event.type) {
      case "run_start": {
        const l = laneOf(event.agentId);
        l.lane.parentId = event.parentId ?? l.lane.parentId;
        l.lane.state = "working";
        if (event.parentId == null) {
          l.lane.task = event.prompt;
          rootRunId = event.runId;
          running = true;
        }
        runToAgent.set(event.runId, event.agentId);
        tick(event.agentId, { ts, kind: "lifecycle", seq });
        break;
      }
      case "turn_start":
        tick(event.agentId, { ts, kind: "lifecycle", seq });
        break;
      case "text_delta":
        tick(event.agentId, { ts, kind: "token", seq });
        break;
      case "thinking_delta": {
        const l = laneOf(event.agentId);
        // A distinct reasoning segment: thinking that RESUMES after any
        // non-reasoning activity (a new turn, an answer, a tool) gets a divider,
        // so the whole run's aggregated reasoning doesn't read as one glued blob.
        const prevKind = l.ticks[l.ticks.length - 1]?.kind;
        const resumed = prevKind !== undefined && prevKind !== "reasoning" && l.lane.thinking.length > 0;
        const merged = l.lane.thinking + (resumed ? LANE_THINKING_SEP : "") + event.text;
        // Bounded, latest wins: keep the tail so the peek shows the most
        // recent reasoning rather than an unbounded transcript.
        l.lane.thinking =
          merged.length > MAX_LANE_THINKING ? merged.slice(merged.length - MAX_LANE_THINKING) : merged;
        tick(event.agentId, { ts, kind: "reasoning", seq });
        break;
      }
      case "tool_call":
        callToAgent.set(event.callId, event.agentId);
        tick(event.agentId, { ts, kind: "tool", seq });
        break;
      case "tool_result": {
        const agent = callToAgent.get(event.callId) ?? event.agentId;
        tick(agent, { ts, kind: event.isError ? "error" : "tool", seq });
        break;
      }
      case "permission_request": {
        callToAgent.set(event.callId, event.agentId);
        undecided.add(event.callId);
        laneOf(event.agentId).lane.pendingGate = true;
        tick(event.agentId, { ts, kind: "gate", seq, callId: event.callId, isRequest: true });
        break;
      }
      case "permission_decision": {
        const agent = callToAgent.get(event.callId);
        undecided.delete(event.callId);
        if (agent !== undefined) {
          tick(agent, { ts, kind: "gate", seq, callId: event.callId, allowed: event.allowed });
        }
        break;
      }
      // Card 265, the concept's leg 26. The tool_call for the ask already stamped
      // this lane; these two marks say WHY it stands still and for how long.
      case "question_asked": {
        callToAgent.set(event.callId, event.agentId);
        unanswered.add(event.callId);
        tick(event.agentId, { ts, kind: "ask", seq, callId: event.callId, isRequest: true });
        break;
      }
      case "question_answered": {
        // Answered and RELEASED both land here: either way the run is moving
        // again, so the lane must stop claiming it waits. Whether an answer came
        // is the transcript's business (`cancelled` travels on the event), not
        // this flag's.
        const agent = callToAgent.get(event.callId);
        unanswered.delete(event.callId);
        if (agent !== undefined) {
          tick(agent, { ts, kind: "ask", seq, callId: event.callId });
        }
        break;
      }
      case "agent_spawn": {
        const child = laneOf(event.agentId);
        child.lane.parentId = event.parentId;
        if (child.lane.task === "") child.lane.task = event.task;
        tick(event.parentId, { ts, kind: "subagent", seq });
        tick(event.agentId, { ts, kind: "lifecycle", seq });
        break;
      }
      case "agent_message": {
        if (event.role === "task") {
          const to = laneOf(event.to);
          to.lane.task = event.text;
          to.lane.label = event.label ?? to.lane.label;
          to.lane.state = "submitted";
          tick(event.to, { ts, kind: "subagent", seq });
        } else if (event.role === "status") {
          const from = laneOf(event.from);
          from.lane.state = "working";
          from.lane.lastStatus = event.text;
          tick(event.from, { ts, kind: "subagent", seq });
        } else if (event.role === "result") {
          const from = laneOf(event.from);
          from.lane.state = event.state === "completed" ? "completed" : "failed";
          tick(event.from, { ts, kind: "subagent", seq });
        }
        break;
      }
      case "usage": {
        const l = laneOf(event.agentId);
        l.lane.inTokens += event.inputTokens;
        l.lane.outTokens += event.outputTokens;
        break;
      }
      case "run_end": {
        const agent = runToAgent.get(event.runId);
        if (agent !== undefined) {
          tick(agent, { ts, kind: "lifecycle", seq });
          const l = laneOf(agent);
          if (l.lane.state === "working") l.lane.state = "completed";
        }
        if (rootRunId === null || event.runId === rootRunId) {
          running = false;
          rootRunId = null;
        }
        break;
      }
      case "error":
        tick(event.agentId ?? order[0] ?? "main", { ts, kind: "error", seq });
        break;
      case "compaction":
        tick(event.agentId, { ts, kind: "lifecycle", seq });
        break;
      // The second line (card 184 leg 4). Deliberately NOT a tick on the upper
      // track: the app protocol and the conversation with the model are two
      // different stories about the same moment, and flattening them into one
      // row is exactly the picture this leg exists to replace.
      case "llm_exchange":
        laneOf(event.agentId).wire.push({
          ts,
          seq,
          xid: event.xid,
          kind: event.kind,
          model: event.model,
          // A transport failure has no status, and the record says so with an
          // absent field rather than a zero.
          status: typeof event.status === "number" ? event.status : null,
          aborted: event.aborted,
          durationMs: event.durationMs,
        });
        break;
      case "image_generated":
        tick(event.agentId, { ts, kind: "tool", seq });
        break;
      default:
        // context_info, plan, unknown future types: meta, no mark.
        break;
    }
  });

  if (!Number.isFinite(t0)) {
    t0 = 0;
    t1 = 0;
  }
  const span = Math.max(1, t1 - t0);

  const lanes: Lane[] = order.map((id) => {
    const { lane, ticks, wire } = acc.get(id)!;
    // A request whose decision never arrived stays pending; everything else
    // reflects the recorded outcome.
    for (const t of ticks) {
      if (t.isRequest !== true) continue;
      const open = t.kind === "ask" ? unanswered : undecided;
      t.pending = t.callId !== undefined && open.has(t.callId);
    }
    // Two waits, two flags, each read off its OWN marks: one boolean for both
    // would raise the permission bar for a question and the question bar for a
    // permission.
    const pendingGate = ticks.some((t) => t.kind === "gate" && t.pending === true);
    const pendingAsk = ticks.some((t) => t.kind === "ask" && t.pending === true);
    const marks: LaneTick[] = ticks.map((t) => {
      const raw = (t.ts - t0) / span;
      return {
        x: raw < 0 ? 0 : raw > 1 ? 1 : raw,
        kind: t.kind,
        seq: t.seq,
        ...(t.pending !== undefined ? { pending: t.pending } : {}),
        ...(t.allowed !== undefined ? { allowed: t.allowed } : {}),
      };
    });
    // Event order is USUALLY time order, but an imported transcript can arrive
    // out of step, and the slicer binary-searches this array. Seq breaks a tie,
    // which the importer manufactures by the thousand: it stamps every content
    // block of one transcript record with that record's single timestamp.
    marks.sort((p, q) => p.x - q.x || p.seq - q.seq);
    // The second line rides the SAME axis, which is what makes "above and
    // below" mean anything: a mark down here sits under the moment it happened.
    const exchanges: WireTick[] = wire
      .map((w) => {
        const raw = (w.ts - t0) / span;
        return {
          x: raw < 0 ? 0 : raw > 1 ? 1 : raw,
          seq: w.seq,
          xid: w.xid,
          kind: w.kind,
          model: w.model,
          status: w.status,
          aborted: w.aborted,
          durationMs: w.durationMs,
        };
      })
      .sort((p, q) => p.x - q.x || p.seq - q.seq);
    return { ...lane, pendingGate, pendingAsk, ticks: marks, wire: exchanges };
  });

  return { lanes, t0, t1, running, totalEvents: events.length };
}
