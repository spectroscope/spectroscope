// The Spectrum tab's pure model: RunEvent[] -> one horizontal lane per agent.
// This is the brand image made literal: every agent is a spectral line, every
// event a discrete mark on it, the whole fleet on one screen. Pure and
// framework-free, the same mental figure as reduce/buildGraph — live stream
// and replayed archive fold through the exact same function.

import type { RunEvent } from "../events";

export type TickKind =
  | "token"      // text_delta            — teal
  | "reasoning"  // thinking_delta        — violet ("the line you follow")
  | "tool"       // tool_call/result      — amber
  | "gate"       // permission events     — red (violet while pending)
  | "subagent"   // spawn + agent_message — ocean
  | "lifecycle"  // run/turn boundaries   — faint
  | "error";     // error / failed result — red, full height

export interface LaneTick {
  /** Position on the shared time axis, normalized 0..1. */
  x: number;
  kind: TickKind;
  /** Index of the source event (stable render key, trace hand-off). */
  seq: number;
  /** Gate request ticks: true while no decision has arrived yet. */
  pending?: boolean;
  /** Gate decision ticks: the recorded outcome. */
  allowed?: boolean;
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
  ticks: LaneTick[];
  inTokens: number;
  outTokens: number;
  /** Marks dropped by density thinning — reported, never silent. */
  dropped: number;
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

/** Per lane: marks beyond this are thinned (token/reasoning first). */
export const MAX_LANE_TICKS = 1200;

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

interface LaneAcc {
  lane: Omit<Lane, "ticks" | "dropped" | "x">;
  ticks: RawTick[];
}

/** Fold a whole stream into the Spectrum model. */
export function buildSpectrum(events: RunEvent[]): SpectrumModel {
  const acc = new Map<string, LaneAcc>();
  const order: string[] = [];
  const runToAgent = new Map<string, string>();
  const callToAgent = new Map<string, string>();
  const undecided = new Set<string>();
  let rootRunId: string | null = null;
  let running = false;

  const laneOf = (id: string): LaneAcc => {
    let l = acc.get(id);
    if (l === undefined) {
      l = {
        lane: { id, parentId: null, label: null, task: "", state: "submitted", lastStatus: null, pendingGate: false, inTokens: 0, outTokens: 0 },
        ticks: [],
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
      case "thinking_delta":
        tick(event.agentId, { ts, kind: "reasoning", seq });
        break;
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
    const { lane, ticks } = acc.get(id)!;
    // A request whose decision never arrived stays pending; everything else
    // reflects the recorded outcome.
    for (const t of ticks) {
      if (t.isRequest === true) t.pending = t.callId !== undefined && undecided.has(t.callId);
    }
    const pendingGate = ticks.some((t) => t.pending === true);
    const { kept, dropped } = thin(ticks);
    return {
      ...lane,
      pendingGate,
      dropped,
      ticks: kept.map((t) => ({
        x: (t.ts - t0) / span,
        kind: t.kind,
        seq: t.seq,
        ...(t.pending !== undefined ? { pending: t.pending } : {}),
        ...(t.allowed !== undefined ? { allowed: t.allowed } : {}),
      })),
    };
  });

  return { lanes, t0, t1, running, totalEvents: events.length };
}

/** Density thinning: structural marks (tool/gate/lifecycle/subagent/error)
 *  always survive; token/reasoning marks are evenly sampled into whatever
 *  room MAX_LANE_TICKS leaves. The dropped count is reported, never silent. */
function thin(ticks: RawTick[]): { kept: RawTick[]; dropped: number } {
  if (ticks.length <= MAX_LANE_TICKS) return { kept: ticks, dropped: 0 };
  const structural: RawTick[] = [];
  const dense: RawTick[] = [];
  for (const t of ticks) {
    if (t.kind === "token" || t.kind === "reasoning") dense.push(t);
    else structural.push(t);
  }
  const room = Math.max(0, MAX_LANE_TICKS - structural.length);
  const sampled: RawTick[] = [];
  if (room > 0 && dense.length > 0) {
    const stride = dense.length / room;
    for (let i = 0; i < room && Math.floor(i * stride) < dense.length; i++) {
      sampled.push(dense[Math.floor(i * stride)]);
    }
  }
  const kept = [...structural, ...sampled].sort((a, b) => a.seq - b.seq);
  return { kept, dropped: ticks.length - kept.length };
}
