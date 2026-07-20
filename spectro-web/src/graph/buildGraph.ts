// Pure reduction: RunEvent[] -> Graph. NO React, no socket, no side effect.
// The live stream and the replay both run through exactly this function.
import type { RunEvent } from "../events";
import { compactJson } from "../format";

export type NodeKind = "user" | "turn" | "tool" | "subagent" | "answer";
export type ToolStatus = "pending" | "ok" | "error";

export interface GraphNode {
  id: string;             // stable, taken directly from the events: runId/agentId/callId
  kind: NodeKind;
  label: string;
  agentId: string;
  running: boolean;       // true = pulse animation in the renderer
  status?: ToolStatus;    // tool only: pending -> ok | error
  durationMs?: number;    // tool: result duration; turn: last delta ts - turn_start ts
  startTs: number;        // ts of the event that created the node
  relMs: number;          // ms since the owning root run's run_start ("t+2.31s")
  preview?: string;       // tool: one-line input (60); turn: first 60 chars; answer: first 80
  tokens?: { input: number; output: number }; // turn/subagent: from usage events
  /** The raw events that formed this node — the detail panel's evidence.
   *  Turn deltas are capped at the first 50; droppedEvents counts the rest. */
  events: RunEvent[];
  droppedEvents?: number;
  detail: {
    text?: string;        // turn/answer: aggregated text; user: full prompt
    input?: unknown; output?: string; isError?: boolean;  // tool
    task?: string;                                         // subagent
    stopReason?: string;                                   // answer
    inputTokens?: number; outputTokens?: number;           // subagent/answer
  };
}
export interface GraphEdge { id: string; source: string; target: string }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

/** What the lane pass needs of a laid-out node (renderer-agnostic). */
export interface LaidNode { agentId: string; kind: NodeKind; x: number }

/** Parallel lanes: every subagent subtree gets its own x-band. dagre already
 *  spreads TRULY concurrent branches; sequentially spawned children stack in
 *  one column — shift each later subtree right until its band is free, so
 *  2 subagents read as 2 lanes (and 3 as 3). Returns agentId -> dx. */
export function laneShifts(nodes: LaidNode[], nodeW: number, gap = 48): Map<string, number> {
  const shifts = new Map<string, number>();
  const bands: { min: number; max: number }[] = [];
  const seen = new Set<string>();
  for (const root of nodes.filter((n) => n.kind === "subagent")) {
    if (seen.has(root.agentId)) continue;
    seen.add(root.agentId);
    const members = nodes.filter((n) => n.agentId === root.agentId);
    const min = Math.min(...members.map((m) => m.x));
    const max = Math.max(...members.map((m) => m.x)) + nodeW;
    let dx = 0;
    let moved = true;
    while (moved) {
      moved = false;
      for (const band of bands) {
        if (min + dx < band.max + gap && max + dx > band.min - gap) {
          dx = band.max + gap - min;
          moved = true;
        }
      }
    }
    if (dx !== 0) shifts.set(root.agentId, dx);
    bands.push({ min: min + dx, max: max + dx });
  }
  return shifts;
}

const LABEL_MAX = 40;
const DELTA_CAP = 50; // stored per turn node; the aggregated text is never capped
// Preview clip widths: the one truncated "what it did" line per node kind.
const TURN_PREVIEW_CHARS = 60;
const TOOL_INPUT_PREVIEW_CHARS = 60;
const ANSWER_PREVIEW_CHARS = 80;
function short(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= LABEL_MAX ? t : t.slice(0, LABEL_MAX - 1) + "…";
}
/** One-line preview, whitespace collapsed, hard-capped at max chars. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

export function buildGraph(events: RunEvent[]): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeById = new Map<string, GraphNode>();
  const edgeIds = new Set<string>();
  const lastNode = new Map<string, string>();    // last node in the causal flow per agent
  const currentTurn = new Map<string, string>(); // active turn node per agent (text_delta target)
  const fanOut = new Map<string, string[]>();    // open tool/subagent nodes since the turn started
  const usage = new Map<string, { input: number; output: number }>();
  const agentByRunId = new Map<string, string>();
  const parentOf = new Map<string, string>();   // child agentId -> parent agentId
  const runByAgent = new Map<string, string>(); // current run per agent (namespace of the turn ids)
  const rootRuns = new Set<string>();           // runIds of all root runs (one per prompt)
  let rootAgentId = "";
  let rootStartTs = 0; // run_start ts of the current root run — the t+ origin

  function addNode(n: GraphNode): void { nodes.push(n); nodeById.set(n.id, n); }
  const rel = (ts: number): number => Math.max(0, ts - rootStartTs);
  function addEdge(source: string | undefined, target: string): void {
    if (!source || source === target) return;
    const id = `${source}->${target}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id); edges.push({ id, source, target });
  }
  // A new node attaches to the open fan-out (parallel tools/subagents), otherwise to the last node.
  function connectFrom(agentId: string, target: string): void {
    const open = fanOut.get(agentId) ?? [];
    if (open.length > 0) { for (const s of open) addEdge(s, target); fanOut.set(agentId, []); }
    else addEdge(lastNode.get(agentId), target);
  }

  for (const event of events) {
    switch (event.type) {
      case "run_start": {
        agentByRunId.set(event.runId, event.agentId);
        runByAgent.set(event.agentId, event.runId);
        if (event.parentId === undefined || event.parentId === null) {
          // Root run: EVERY prompt of the session gets its own user node.
          // The turn counter restarts at 1 per run(), so the turn
          // ids below carry the runId as a namespace — otherwise the second
          // prompt of the same session collides with the first (duplicate ids).
          rootRuns.add(event.runId); rootAgentId = event.agentId;
          rootStartTs = event.ts; // every prompt restarts the t+ clock
          addNode({ id: event.runId, kind: "user", label: short(event.prompt),
            agentId: event.agentId, running: false, startTs: event.ts, relMs: 0,
            events: [event], detail: { text: event.prompt } });
          connectFrom(event.agentId, event.runId); // a follow-up prompt hangs off the last answer
          lastNode.set(event.agentId, event.runId);
        } else {
          parentOf.set(event.agentId, event.parentId);
          if (!lastNode.has(event.agentId) && nodeById.has(event.agentId)) {
            // run_start of a child: no node — the entry point is the subagent node.
            lastNode.set(event.agentId, event.agentId);
          }
        }
        break;
      }
      case "turn_start": {
        const id = `${runByAgent.get(event.agentId) ?? ""}:${event.agentId}:turn:${event.turn}`;
        const prev = nodeById.get(currentTurn.get(event.agentId) ?? "");
        if (prev) prev.running = false; // this agent's previous turn is done
        addNode({ id, kind: "turn", label: `Turn ${event.turn}`, agentId: event.agentId,
          running: true, startTs: event.ts, relMs: rel(event.ts), preview: "",
          events: [event], detail: { text: "" } });
        connectFrom(event.agentId, id);
        currentTurn.set(event.agentId, id); lastNode.set(event.agentId, id);
        break;
      }
      case "text_delta": {
        // NO node of its own — aggregate into the active turn node.
        let turnId = currentTurn.get(event.agentId);
        if (!turnId) { // defensive: a session with no turn_start -> implicit turn 0
          turnId = `${runByAgent.get(event.agentId) ?? ""}:${event.agentId}:turn:0`;
          if (!nodeById.has(turnId)) {
            addNode({ id: turnId, kind: "turn", label: "Turn 0", agentId: event.agentId,
              running: true, startTs: event.ts, relMs: rel(event.ts), preview: "",
              events: [], detail: { text: "" } });
            connectFrom(event.agentId, turnId); lastNode.set(event.agentId, turnId);
          }
          currentTurn.set(event.agentId, turnId);
        }
        const node = nodeById.get(turnId);
        if (node) {
          node.detail.text = (node.detail.text ?? "") + event.text;
          node.preview = clip(node.detail.text, TURN_PREVIEW_CHARS);
          node.durationMs = Math.max(0, event.ts - node.startTs); // last delta so far
          // Keep the real deltas as evidence, but bounded: 50 is plenty to
          // read; the aggregated text above stays complete.
          if (node.events.filter((e) => e.type === "text_delta").length < DELTA_CAP) {
            node.events.push(event);
          } else {
            node.droppedEvents = (node.droppedEvents ?? 0) + 1;
          }
        }
        break;
      }
      case "tool_call": {
        addNode({ id: event.callId, kind: "tool", label: event.name, agentId: event.agentId,
          running: true, status: "pending", startTs: event.ts, relMs: rel(event.ts),
          preview: clip(compactJson(event.input), TOOL_INPUT_PREVIEW_CHARS), events: [event],
          detail: { input: event.input } });
        addEdge(currentTurn.get(event.agentId) ?? lastNode.get(event.agentId), event.callId);
        const open = fanOut.get(event.agentId) ?? [];
        open.push(event.callId); fanOut.set(event.agentId, open); // fan out
        break;
      }
      case "permission_request":
      case "permission_decision": {
        // Still NO node of their own — but they belong to the tool node's raw
        // evidence, so the detail panel can show the full approval story.
        nodeById.get(event.callId)?.events.push(event);
        break;
      }
      case "tool_result": {
        // Same callId -> the SAME node: only a status change, duration, output.
        const node = nodeById.get(event.callId);
        if (!node) break;
        node.running = false; node.status = event.isError ? "error" : "ok";
        node.durationMs = event.durationMs;
        node.detail.output = event.output; node.detail.isError = event.isError;
        node.events.push(event);
        break;
      }
      case "agent_spawn": {
        parentOf.set(event.agentId, event.parentId);
        addNode({ id: event.agentId, kind: "subagent", label: short(event.task),
          agentId: event.agentId, running: true, startTs: event.ts, relMs: rel(event.ts),
          tokens: { input: 0, output: 0 }, events: [event],
          detail: { task: event.task, inputTokens: 0, outputTokens: 0 } });
        addEdge(currentTurn.get(event.parentId) ?? lastNode.get(event.parentId), event.agentId);
        const open = fanOut.get(event.parentId) ?? [];
        open.push(event.agentId); fanOut.set(event.parentId, open);
        lastNode.set(event.agentId, event.agentId); // child events hang under the subagent node
        break;
      }
      case "usage": {
        const u = usage.get(event.agentId) ?? { input: 0, output: 0 };
        u.input += event.inputTokens; u.output += event.outputTokens;
        usage.set(event.agentId, u);
        const sub = nodeById.get(event.agentId);
        if (sub?.kind === "subagent") {
          sub.detail.inputTokens = u.input; sub.detail.outputTokens = u.output;
          sub.tokens = { input: u.input, output: u.output };
        }
        // The turn that consumed these tokens is the agent's active turn —
        // usage follows the provider call that the turn made.
        const turnNode = nodeById.get(currentTurn.get(event.agentId) ?? "");
        if (turnNode?.kind === "turn") {
          const t = turnNode.tokens ?? { input: 0, output: 0 };
          turnNode.tokens = {
            input: t.input + event.inputTokens,
            output: t.output + event.outputTokens,
          };
        }
        break;
      }
      case "run_end": {
        const agentId = agentByRunId.get(event.runId) ?? rootAgentId;
        const turnNode = nodeById.get(currentTurn.get(agentId) ?? "");
        if (rootRuns.has(event.runId)) {
          const u = usage.get(agentId);
          const id = `${event.runId}:answer`;
          // The answer's evidence: the closing turn's text deltas (already
          // capped there) plus the run_end that sealed it.
          const closing = turnNode?.events.filter((e) => e.type === "text_delta") ?? [];
          addNode({ id, kind: "answer", label: "Answer", agentId, running: false,
            startTs: event.ts, relMs: rel(event.ts),
            preview: clip(turnNode?.detail.text ?? "", ANSWER_PREVIEW_CHARS),
            events: [...closing, event], droppedEvents: turnNode?.droppedEvents,
            detail: { text: turnNode?.detail.text ?? "", stopReason: event.stopReason,
              inputTokens: u?.input, outputTokens: u?.output } });
          connectFrom(agentId, id); lastNode.set(agentId, id);
          for (const n of nodes) n.running = false; // run over, nothing pulses anymore
        } else {
          const sub = nodeById.get(agentId); // child run done: the subagent stops
          if (sub) sub.running = false;
          if (turnNode) turnNode.running = false;
          // Lead the finished branch BACK into the flow: the child's dangling
          // tip(s) take the subagent's place in the parent's open fan-out, so
          // the parent's next node (turn or answer) closes the diamond through
          // the child's chain instead of leaving it hanging.
          const parentId = parentOf.get(agentId);
          if (parentId !== undefined) {
            const childOpen = fanOut.get(agentId) ?? [];
            const last = lastNode.get(agentId);
            const tips = childOpen.length > 0 ? childOpen : last !== undefined ? [last] : [];
            fanOut.set(agentId, []);
            const parentOpen = fanOut.get(parentId) ?? [];
            const at = parentOpen.indexOf(agentId);
            if (at >= 0) parentOpen.splice(at, 1, ...tips);
            else parentOpen.push(...tips);
            fanOut.set(parentId, parentOpen);
          }
        }
        break;
      }
      default:
        // compaction/context_info/error and anything future: NO nodes.
        // Forward compatibility = ignore, never throw.
        break;
    }
  }
  return { nodes, edges };
}
