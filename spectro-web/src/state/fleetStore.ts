// The fleet's external store (à la useSyncExternalStore, the house pattern): it
// accumulates the socket-only fleet frames the reducer leaves alone and folds
// them — PARTITIONED BY contextId — into one FleetModel per coexisting fleet.
// buildFleet stays pure; the partition is the seam. Global and singleton like
// the connection itself.

import { useCallback, useSyncExternalStore } from "react";
import type { RunEvent } from "../events";
import type { PendingPermission } from "./reducer";
import {
  buildFleet,
  EMPTY_FLEET,
  isFleetFrame,
  type FleetEnvelope,
  type FleetFrame,
  type FleetModel,
  type FleetNode,
} from "../spectrum/fleetModel";

/** A fleet's one-line identity for the sidebar list (derived on read). */
export interface FleetSummary {
  /** The grouping key — the fleet ref (a contextId). */
  contextId: string;
  /** The fold's roster, for the sigil and the counts. */
  roster: FleetNode[];
  agentCount: number;
  onlineCount: number;
  /** Max wall-clock activity (roster last-seen ∪ event ts) — for sorting. */
  lastActivity: number;
  /** True while any of the fleet's tool calls awaits a permission decision. */
  pendingGate: boolean;
}

/** A node's topic is `<contextId>.events`; strip the suffix to get the fleet. */
const TOPIC_SUFFIX = ".events";
function contextOfTopic(topic: string): string {
  return topic.endsWith(TOPIC_SUFFIX) ? topic.slice(0, -TOPIC_SUFFIX.length) : topic;
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

let frames: FleetFrame[] = [];
// Envelope identities already folded (contextId·sender·epoch·sequence) — the
// hydration replay and the live socket overlap for frames in flight while the
// page loads; the store keeps exactly one of each.
let seenEnvelopes = new Set<string>();
// The loopback hub port from GET /api/fleet (null when the hub is off) — the
// spawn panel prints it into the exact copy-paste node command.
let hubPort: number | null = null;
// Per-context models, cached so useSyncExternalStore sees a stable reference for
// a fleet that did not change this push.
let byContext = new Map<string, FleetModel>();
// The all-frames merged model — the no-arg useFleet() / __getFleet() view.
let merged: FleetModel = EMPTY_FLEET;
// The sidebar list, cached; a new array only when something changed.
let summaries: FleetSummary[] = [];

/** Split all frames by fleet: a fleet_event by its envelope contextId; a global
 *  fleet_roster into one per-context roster keyed by each node's topic. */
function partition(all: FleetFrame[]): Map<string, FleetFrame[]> {
  const out = new Map<string, FleetFrame[]>();
  const add = (ctx: string, frame: FleetFrame): void => {
    const list = out.get(ctx);
    if (list) list.push(frame);
    else out.set(ctx, [frame]);
  };
  for (const frame of all) {
    if (frame.type === "fleet_event") {
      add(frame.frame.contextId, frame);
    } else {
      const nodesByCtx = new Map<string, FleetNode[]>();
      for (const node of frame.nodes) {
        const ctx = contextOfTopic(node.topic);
        const list = nodesByCtx.get(ctx);
        if (list) list.push(node);
        else nodesByCtx.set(ctx, [node]);
      }
      for (const [ctx, nodes] of nodesByCtx) {
        add(ctx, { type: "fleet_roster", nodes });
      }
    }
  }
  return out;
}

function summarize(contextId: string, model: FleetModel): FleetSummary {
  const undecided = new Set<string>();
  let lastActivity = 0;
  for (const node of model.roster) {
    lastActivity = Math.max(lastActivity, node.lastSeen);
  }
  for (const event of model.events) {
    const ev = event as { type: string; callId?: string; ts?: number };
    if (ev.type === "permission_request" && ev.callId !== undefined) {
      undecided.add(ev.callId);
    } else if (ev.type === "permission_decision" && ev.callId !== undefined) {
      undecided.delete(ev.callId);
    }
    if (typeof ev.ts === "number") {
      lastActivity = Math.max(lastActivity, ev.ts);
    }
  }
  return {
    contextId,
    roster: model.roster,
    agentCount: model.roster.length,
    onlineCount: model.roster.filter((node) => node.connected).length,
    lastActivity,
    pendingGate: undecided.size > 0,
  };
}

/** Recompute the models, reusing a fleet's cached model when it did not change
 *  this push (stable ref for useSyncExternalStore); merged + summaries refresh. */
function rebuild(changed: Set<string>): void {
  const parts = partition(frames);
  const next = new Map<string, FleetModel>();
  for (const [ctx, ctxFrames] of parts) {
    const prev = byContext.get(ctx);
    next.set(ctx, changed.has(ctx) || prev === undefined ? buildFleet(ctxFrames) : prev);
  }
  byContext = next;
  merged = buildFleet(frames);
  summaries = [...next.entries()]
    .map(([ctx, model]) => summarize(ctx, model))
    .sort((a, b) => a.contextId.localeCompare(b.contextId)); // deterministic; the UI re-sorts attention-first
}

function changedContexts(incoming: FleetFrame[]): Set<string> {
  const changed = new Set<string>();
  for (const frame of incoming) {
    if (frame.type === "fleet_event") {
      changed.add(frame.frame.contextId);
    } else {
      for (const node of frame.nodes) {
        changed.add(contextOfTopic(node.topic));
      }
    }
  }
  return changed;
}

/** One fleet_event's identity for the hydration/live dedup. */
function envelopeKey(frame: FleetFrame): string | null {
  if (frame.type !== "fleet_event") return null; // rosters are latest-wins, never deduped
  const e = frame.frame;
  return `${e.contextId}·${e.sender}·${e.epoch}·${e.sequence}`;
}

/** Accept only frames the store has not folded yet (see seenEnvelopes). */
function acceptNew(incoming: FleetFrame[]): FleetFrame[] {
  const fresh: FleetFrame[] = [];
  for (const frame of incoming) {
    const key = envelopeKey(frame);
    if (key !== null) {
      if (seenEnvelopes.has(key)) continue;
      seenEnvelopes.add(key);
    }
    fresh.push(frame);
  }
  return fresh;
}

/** Ingest a live socket batch: pull out the fleet frames the reducer ignores,
 *  fold (per fleet), and notify. A batch with no fleet frames is a no-op. */
export function fleetPushLive(batch: RunEvent[]): void {
  // Filter over unknown[]: isFleetFrame is an (event: unknown) => event is
  // FleetFrame guard, and FleetFrame is not a RunEvent subtype, so narrowing
  // straight off RunEvent[] can't apply the guard (tsc -b rejects the cast).
  const incoming = acceptNew((batch as unknown[]).filter(isFleetFrame));
  if (incoming.length === 0) {
    return;
  }
  frames = [...frames, ...incoming];
  rebuild(changedContexts(incoming));
  emit();
}

/** Which fleet a frame belongs to (single-context frames — as scenario frames
 *  are by construction; a live multi-context roster is identified by its first
 *  node, which never matches a synthetic `scenario:…` id). */
function contextOf(frame: FleetFrame): string {
  return frame.type === "fleet_event"
    ? frame.frame.contextId
    : frame.nodes.length > 0
      ? contextOfTopic(frame.nodes[0].topic)
      : "";
}

/** A node's role from its id: a trailing "-N" / "N" is dropped so a fan-out of
 *  worker-1…worker-7 all cluster as "worker"; "main" is the fleet root. */
function roleFromAgentId(id: string): string {
  if (id === "main") return "root";
  return id.replace(/[-_]?\d+$/, "") || id;
}

/**
 * Load a compiled scenario's events as a REPLAY fleet under `contextId`: derive
 * a roster from the agents in the stream and wrap each event as a fleet_event
 * envelope, then fold them in exactly like live frames — so the whole
 * entered-fleet UI (canvas, roster, drill-in, gate bar) works with no live hub.
 * Idempotent: re-loading the same contextId replaces its prior frames.
 */
export function fleetLoadScenario(contextId: string, events: RunEvent[]): void {
  const topic = contextId + TOPIC_SUFFIX;
  const roles = new Map<string, string>();
  const note = (id: string | undefined): void => {
    if (id !== undefined && id !== "" && !roles.has(id)) roles.set(id, roleFromAgentId(id));
  };
  for (const ev of events) {
    const e = ev as { agentId?: string; from?: string; to?: string; type: string };
    note(e.agentId);
    if (e.type === "agent_message") {
      note(e.from);
      note(e.to);
    }
  }
  const roster: FleetNode[] = [...roles].map(([id, role]) => ({
    id,
    role,
    capabilities: [],
    topic,
    connected: false,
    lastSeen: 0,
  }));
  const fresh: FleetFrame[] = [
    { type: "fleet_roster", nodes: roster },
    ...events.map((payload, i) => ({
      type: "fleet_event" as const,
      frame: {
        sender: (payload as { agentId?: string }).agentId ?? "main",
        epoch: 0,
        contextId,
        taskId: contextId,
        sequence: i,
        parentId: null,
        topic,
        ts: (payload as { ts?: number }).ts ?? 0,
        payload,
      },
    })),
  ];
  frames = frames.filter((f) => contextOf(f) !== contextId).concat(fresh);
  const changed = changedContexts(fresh);
  changed.add(contextId); // ensure the (possibly emptied-then-refilled) context rebuilds
  rebuild(changed);
  emit();
}

// The fetch seam — swappable in tests via __setTestHooks.
let doFetch: typeof fetch = (...args) => fetch(...args);

/** Hydrate once from GET /api/fleet: the roster, PLUS each node's ring replay
 *  (GET /api/fleet/{node}/events) — so a browser opened after the fact still
 *  sees the fleet's recent history, most importantly a gate parked BEFORE this
 *  page loaded. Live frames take over from there; the envelope dedup drops the
 *  overlap. Bounded honestly by the hub ring — older evicted frames stay gone.
 *  A hub that is off, or any failure, leaves the view empty (never throws). */
export async function hydrateFleet(): Promise<void> {
  try {
    const res = await doFetch("/api/fleet");
    if (!res.ok) {
      return;
    }
    const body = (await res.json()) as { enabled?: boolean; hubPort?: number; nodes?: FleetNode[] };
    if (body.enabled !== true || !Array.isArray(body.nodes)) {
      return;
    }
    hubPort = typeof body.hubPort === "number" ? body.hubPort : null;
    const roster: FleetFrame = { type: "fleet_roster", nodes: body.nodes };
    frames = [roster, ...frames]; // oldest frame; a later live roster overrides it
    rebuild(changedContexts([roster]));
    emit();

    // Per-node ring replay, all nodes in parallel; a failed node is skipped.
    const replays = await Promise.all(
      body.nodes.map(async (n) => {
        try {
          const r = await doFetch(`/api/fleet/${encodeURIComponent(n.id)}/events`);
          if (!r.ok) return [];
          const data = (await r.json()) as { events?: FleetEnvelope[] };
          return Array.isArray(data.events) ? data.events : [];
        } catch {
          return [];
        }
      }),
    );
    const envelopes = replays
      .flat()
      .filter((e): e is FleetEnvelope => e !== null && typeof e === "object" && "payload" in e)
      .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.sequence - b.sequence));
    const fresh = acceptNew(envelopes.map((frame) => ({ type: "fleet_event" as const, frame })));
    if (fresh.length > 0) {
      frames = [...frames, ...fresh];
      rebuild(changedContexts(fresh));
      emit();
    }
  } catch {
    // The fleet view simply stays empty — never break the app over a probe.
  }
}

/** The undecided permission requests of a fleet model, as the GateBar's
 *  `PendingPermission[]` — the same request-minus-decision-by-callId fold as
 *  {@link summarize}'s pendingGate flag, but KEEPING each request's payload so
 *  an operator can answer it (block 4). {@code agentId} names the node the
 *  answer POSTs to; order is first-parked-first (the queue the GateBar shows). */
export function fleetPending(model: FleetModel): PendingPermission[] {
  const byCallId = new Map<string, PendingPermission>();
  for (const event of model.events) {
    if (event.type === "permission_request") {
      byCallId.set(event.callId, {
        callId: event.callId,
        agentId: event.agentId,
        name: event.name,
        input: event.input,
      });
    } else if (event.type === "permission_decision") {
      byCallId.delete(event.callId);
    }
  }
  return [...byCallId.values()];
}

/** React binding. No arg = the merged all-fleets model (back-compat); a
 *  contextId = that one fleet's model (the entered-fleet event source). */
export function useFleet(contextId?: string): FleetModel {
  const getSnap = useCallback(
    () => (contextId === undefined ? merged : (byContext.get(contextId) ?? EMPTY_FLEET)),
    [contextId],
  );
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}

/** React binding: the coexisting fleets, for the sidebar list. */
export function useFleets(): FleetSummary[] {
  return useSyncExternalStore(subscribe, getSummaries, getSummaries);
}

/** React binding: the loopback hub port (null when the hub is off), for the
 *  spawn panel's copy-paste node command. */
export function useFleetHubPort(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => hubPort,
    () => hubPort,
  );
}
function getSummaries(): FleetSummary[] {
  return summaries;
}

/** Swap the fetch seam (hydration) for a test double. */
export function __setTestHooks(hooks: { fetch?: typeof fetch }): void {
  if (hooks.fetch !== undefined) {
    doFetch = hooks.fetch;
  }
}

/** The merged model, for pure store tests (no React needed). */
export function __getFleet(): FleetModel {
  return merged;
}

/** The fleet summaries, for pure store tests. */
export function __getFleets(): FleetSummary[] {
  return summaries;
}

/** One fleet's model by contextId, for pure store tests. */
export function __getFleetOf(contextId: string): FleetModel {
  return byContext.get(contextId) ?? EMPTY_FLEET;
}

/** Reset all module state — call in beforeEach so tests never bleed. */
export function __resetForTests(): void {
  frames = [];
  seenEnvelopes = new Set();
  hubPort = null;
  byContext = new Map();
  merged = EMPTY_FLEET;
  summaries = [];
  doFetch = (...args) => fetch(...args);
  listeners.clear();
}
