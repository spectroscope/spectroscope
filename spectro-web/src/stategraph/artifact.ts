// Reading a run's two artifacts.
//
// Two sibling JSONL files share a stem and join on (runId, node, superstep):
// `<stem>.graph.jsonl` carries the topology and the lifecycle, and must stay
// safe to attach to a bug report — it never holds a caller's values.
// `<stem>.state.jsonl` is the only file that may. Each side refuses the other's
// vocabulary and COUNTS the refusal, so a miswired writer cannot quietly move
// the corpus into the file people paste into tickets.
//
// Three facts stay apart on purpose, because fusing them is how a viewer starts
// lying: what a node WROTE (`updateKeys` / `updateBytes`), what was RECORDED
// (a payload's `channels`), and WHY they differ (the policy).

import type { Topology, TopologyEdge } from "./layout";

/** One L1 lifecycle record, in the order the transport steps through them. */
export interface TimelineRecord {
  type: string;
  ts: number;
  node?: string;
  from?: string;
  to?: string;
  superstep?: number;
  durationMs?: number;
  updateKeys?: string[];
  updateBytes?: number;
  /** The failure's CLASS, as a flat string — the shape the reference writer
   *  actually emits. Kept apart from the message because a viewer groups by
   *  class, and a fused "Class: message" would force it to parse its way back
   *  out of a string somebody built. */
  errorClass?: string;
  errorMessage?: string;
}

/** What a node did, folded over every visit. */
export interface NodeRun {
  id: string;
  /** How many times it was entered — the card's `×2`. */
  entered: number;
  /** The LAST visit's duration; a viewer showing the first would age. */
  durationMs: number | null;
  updateKeys: string[];
  updateBytes: number;
  lastSuperstep: number | null;
  failed: boolean;
}

export interface StatePolicy {
  mode: "off" | "summary" | "sample" | "full";
  allowed: string[];
  denied: string[];
  caps: Record<string, number | [string, number, number]>;
  recordCap: number | null;
  /** A STRING, never a boolean — "patterns" while recording, "off" at off. */
  redaction: string;
}

export interface StatePayload {
  runId: string;
  node: string;
  superstep: number;
  channels: Record<string, unknown>;
  /** Channel names whose value is a marker rather than the real thing. */
  truncated: string[];
  /** The node's own write order — `channels` key order carries it. */
  writeOrder: string[];
  ts: number;
}

/** A clipped, sampled, redacted or unserializable value. NEVER a shorter value
 *  of the same type: a marker cannot be mistaken for the whole thing. */
export interface Marker {
  kind: "str" | "list" | "redacted" | "unserializable" | "channel";
  bytes?: number | string;
  omitted?: "cap" | "error" | "recordCap";
  [k: string]: unknown;
}

export interface StateGraphRun {
  topology: Topology;
  runId: string | null;
  /** The conversation the run belongs to, when the writer named one — the
   *  checkpointer seam's graph_start carries it. Null for a threadless run. */
  threadId: string | null;
  supersteps: number;
  records: TimelineRecord[];
  nodes: Map<string, NodeRun>;
  /** `from->to` for every edge the run actually walked. Everything else stays
   *  on the canvas, faded — that is what separates this from a trace. */
  taken: Set<string>;
  policy: StatePolicy | null;
  payloads: StatePayload[];
  /** Lines that were not JSON. Counted and reported, never silently dropped. */
  badLines: number;
  /** Records that turned up in the wrong file. Counted, dropped, and loud. */
  misfiled: number;
  payloadFor(node: string, superstep?: number): StatePayload | null;
}

/** The L1 vocabulary. Anything else in the graph file is misfiled. */
const L1 = new Set([
  "graph_topology",
  "graph_start",
  "graph_end",
  "node_start",
  "node_end",
  "edge_taken",
  "node_error",
]);

interface Parsed {
  records: Record<string, unknown>[];
  bad: number;
}

function parseLines(text: string): Parsed {
  let bad = 0;
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === "object" && v !== null) records.push(v as Record<string, unknown>);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/**
 * Folds a run's two artifacts into what the view renders.
 *
 * @param graphJsonl the `<stem>.graph.jsonl` text — topology and lifecycle
 * @param stateJsonl the `<stem>.state.jsonl` text, or null when none was loaded.
 *                   Absent is a normal state, not an error: the shape is still
 *                   complete, only the values are missing, and the panel says so.
 */
export function readStateGraphRun(graphJsonl: string, stateJsonl: string | null): StateGraphRun {
  const g = parseLines(graphJsonl);
  let badLines = g.bad;
  let misfiled = 0;

  const topology: Topology = { entry: null, nodes: [], edges: [] };
  const records: TimelineRecord[] = [];
  const nodes = new Map<string, NodeRun>();
  const taken = new Set<string>();
  let runId: string | null = null;
  let threadId: string | null = null;
  let maxSuperstep = -1;
  // The writer's own step count, from graph_end. Preferred over the maximum
  // superstep seen: the field runs 0..N and counting its values prints one step
  // more than the run took.
  let declaredSteps: number | null = null;

  for (const r of g.records) {
    const type = str(r.type) ?? "";
    if (!L1.has(type)) {
      // A state record in the graph file is the failure this design exists to
      // prevent. Count it, drop it, never render it.
      if (type === "state_payload" || type === "state_policy") misfiled++;
      continue;
    }
    if (type === "graph_topology") {
      topology.entry = str(r.entry) ?? null;
      const ns = Array.isArray(r.nodes) ? r.nodes : [];
      topology.nodes = ns.map((n) => {
        const o = n as Record<string, unknown>;
        const id = str(o.id) ?? "";
        return { id, label: str(o.label) ?? id };
      });
      const es = Array.isArray(r.edges) ? r.edges : [];
      topology.edges = es.map((e) => {
        const o = e as Record<string, unknown>;
        return {
          from: str(o.from) ?? "",
          to: str(o.to) ?? "",
          kind: str(o.kind) === "conditional" ? "conditional" : "direct",
        } satisfies TopologyEdge;
      });
      continue;
    }

    const rec: TimelineRecord = { type, ts: num(r.ts) ?? 0 };
    if (str(r.node) !== undefined) rec.node = str(r.node);
    if (str(r.from) !== undefined) rec.from = str(r.from);
    if (str(r.to) !== undefined) rec.to = str(r.to);
    if (num(r.superstep) !== undefined) rec.superstep = num(r.superstep);
    if (num(r.durationMs) !== undefined) rec.durationMs = num(r.durationMs);
    if (num(r.updateBytes) !== undefined) rec.updateBytes = num(r.updateBytes);
    if (Array.isArray(r.updateKeys)) rec.updateKeys = r.updateKeys.filter((k) => typeof k === "string");
    // `error` is a flat string naming the class, `message` its sibling — read
    // off the reference's own fixture, not guessed. This reader previously
    // expected a nested {class, message} object, so a real run's failure record
    // parsed to nothing and the node showed as failed with no reason.
    if (str(r.error) !== undefined) rec.errorClass = str(r.error);
    if (str(r.message) !== undefined) rec.errorMessage = str(r.message);
    records.push(rec);

    if (runId === null && str(r.runId) !== undefined) runId = str(r.runId)!;
    if (threadId === null && str(r.threadId) !== undefined) threadId = str(r.threadId)!;
    if (type === "graph_end" && num(r.steps) !== undefined) declaredSteps = num(r.steps)!;
    if (rec.superstep !== undefined) maxSuperstep = Math.max(maxSuperstep, rec.superstep);

    if (type === "edge_taken" && rec.from !== undefined && rec.to !== undefined) {
      taken.add(`${rec.from}->${rec.to}`);
      continue;
    }
    if (rec.node === undefined) continue;
    const cur: NodeRun = nodes.get(rec.node) ?? {
      id: rec.node,
      entered: 0,
      durationMs: null,
      updateKeys: [],
      updateBytes: 0,
      lastSuperstep: null,
      failed: false,
    };
    if (type === "node_start") cur.entered++;
    if (type === "node_end") {
      cur.durationMs = rec.durationMs ?? cur.durationMs;
      if (rec.updateKeys !== undefined) cur.updateKeys = rec.updateKeys;
      cur.updateBytes += rec.updateBytes ?? 0;
    }
    if (type === "node_error") cur.failed = true;
    if (rec.superstep !== undefined) cur.lastSuperstep = rec.superstep;
    nodes.set(rec.node, cur);
  }

  // Stable by time. A JSONL file is already in order; sorting makes a
  // concatenated or re-ordered file behave rather than draw its records twice.
  records.sort((a, b) => a.ts - b.ts);

  let policy: StatePolicy | null = null;
  const payloads: StatePayload[] = [];
  if (stateJsonl !== null) {
    const s = parseLines(stateJsonl);
    badLines += s.bad;
    for (const r of s.records) {
      const type = str(r.type);
      if (type === "state_policy") {
        const caps = (typeof r.caps === "object" && r.caps !== null ? r.caps : {}) as StatePolicy["caps"];
        policy = {
          mode: (str(r.mode) ?? "off") as StatePolicy["mode"],
          allowed: Array.isArray(r.allowed) ? (r.allowed as string[]) : [],
          denied: Array.isArray(r.denied) ? (r.denied as string[]) : [],
          caps,
          recordCap: num(r.recordCap) ?? null,
          redaction: str(r.redaction) ?? "off",
        };
        continue;
      }
      if (type !== "state_payload") {
        if (L1.has(type ?? "")) misfiled++;
        continue;
      }
      const channels = (typeof r.channels === "object" && r.channels !== null ? r.channels : {}) as Record<
        string,
        unknown
      >;
      payloads.push({
        runId: str(r.runId) ?? "",
        node: str(r.node) ?? "",
        superstep: num(r.superstep) ?? 0,
        channels,
        // Absent means nothing was clipped. The dialect never writes [].
        truncated: Array.isArray(r.truncated) ? (r.truncated as string[]) : [],
        writeOrder: Object.keys(channels),
        ts: num(r.ts) ?? 0,
      });
    }
  }

  return {
    topology,
    runId,
    threadId,
    supersteps: declaredSteps ?? maxSuperstep + 1,
    records,
    nodes,
    taken,
    policy,
    payloads,
    badLines,
    misfiled,
    payloadFor(node: string, superstep?: number): StatePayload | null {
      const hits = payloads.filter(
        (p) => p.node === node && (superstep === undefined || p.superstep === superstep),
      );
      // The LAST visit's values, for the same reason the duration is the last
      // one: a node that ran twice is showing its current state, not its first.
      return hits.length > 0 ? hits[hits.length - 1] : null;
    },
  };
}

/** The four states a node can be in, and they must stay four: a run that never
 *  reached a node is a different fact from one that reached it and wrote
 *  nothing. Lives here rather than in the view because the export SVG folds
 *  the same truth, and two folds would drift. */
export type Lifecycle = "pending" | "active" | "done" | "error";

/** The node's lifecycle with the transport standing on record `upto`. */
export function lifecycleAt(run: StateGraphRun, upto: number, id: string): Lifecycle {
  let seen: Lifecycle = "pending";
  for (let i = 0; i <= upto && i < run.records.length; i++) {
    const r = run.records[i];
    if (r.node !== id) continue;
    if (r.type === "node_start") seen = "active";
    else if (r.type === "node_end") seen = "done";
    else if (r.type === "node_error") seen = "error";
  }
  return seen;
}

/** `from->to` for every edge walked up to record `upto` — the whole-run
 *  `taken` set, cut to where the transport stands. */
export function takenUpTo(run: StateGraphRun, upto: number): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i <= upto && i < run.records.length; i++) {
    const r = run.records[i];
    if (r.type === "edge_taken" && r.from !== undefined && r.to !== undefined) {
      s.add(`${r.from}->${r.to}`);
    }
  }
  return s;
}

/** Why a channel is not in a payload — and the two reasons are different. */
export interface Absence {
  absent: boolean;
  reason: "recorded" | "not-allowed" | "denied" | "off";
  note: string;
}

/**
 * Whether this channel could be recorded at all, and if not, why.
 *
 * "Not recorded" and "was empty" are different statements, and so are the two
 * reasons for not recording: a channel that is simply not on the allow list,
 * and one that was explicitly denied. A panel that renders both as a blank
 * teaches the reader that the run had no value, which is false.
 */
export function channelAbsence(policy: StatePolicy, channel: string): Absence {
  if (policy.mode === "off") {
    return { absent: true, reason: "off", note: "recording is off" };
  }
  if (policy.denied.includes(channel)) {
    return { absent: true, reason: "denied", note: "denied" };
  }
  if (policy.allowed.length > 0 && !policy.allowed.includes(channel)) {
    return { absent: true, reason: "not-allowed", note: "not on the allow list" };
  }
  return { absent: false, reason: "recorded", note: "recorded" };
}
