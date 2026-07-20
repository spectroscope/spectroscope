// The fleet's external store (à la useSyncExternalStore, the house pattern): it
// accumulates the socket-only fleet frames the reducer leaves alone and folds
// them — PARTITIONED BY contextId — into one FleetModel per coexisting fleet.
// buildFleet stays pure; the partition is the seam. Global and singleton like
// the connection itself.

import { useCallback, useSyncExternalStore } from "react";
import type { RunEvent } from "../events";
import {
  buildFleet,
  EMPTY_FLEET,
  isFleetFrame,
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
// Per-context models, cached so useSyncExternalStore sees a stable reference for
// a fleet that did not change this push.
let byContext = new Map<string, FleetModel>();
// The all-frames merged model — the no-arg useFleet()/​__getFleet() view.
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

/** Ingest a live socket batch: pull out the fleet frames the reducer ignores,
 *  fold (per fleet), and notify. A batch with no fleet frames is a no-op. */
export function fleetPushLive(batch: RunEvent[]): void {
  const incoming = batch.filter(isFleetFrame) as FleetFrame[];
  if (incoming.length === 0) {
    return;
  }
  frames = [...frames, ...incoming];
  rebuild(changedContexts(incoming));
  emit();
}

// The fetch seam — swappable in tests via __setTestHooks.
let doFetch: typeof fetch = (...args) => fetch(...args);

/** Hydrate the roster once from GET /api/fleet, so a tab opened after nodes
 *  joined shows them immediately; live fleet_roster frames take over (latest-
 *  wins). A hub that is off, or any failure, leaves it empty. */
export async function hydrateFleet(): Promise<void> {
  try {
    const res = await doFetch("/api/fleet");
    if (!res.ok) {
      return;
    }
    const body = (await res.json()) as { enabled?: boolean; nodes?: FleetNode[] };
    if (body.enabled !== true || !Array.isArray(body.nodes)) {
      return;
    }
    const roster: FleetFrame = { type: "fleet_roster", nodes: body.nodes };
    frames = [roster, ...frames]; // oldest frame; a later live roster overrides it
    rebuild(changedContexts([roster]));
    emit();
  } catch {
    // The fleet view simply stays empty — never break the app over a probe.
  }
}

/** React binding. No arg = the merged all-fleets model (back-compat); a
 *  contextId = that one fleet's model (the entered-fleet event source). */
export function useFleet(contextId?: string): FleetModel {
  const getSnap = useCallback(
    () => (contextId === undefined ? merged : byContext.get(contextId) ?? EMPTY_FLEET),
    [contextId],
  );
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}

/** React binding: the coexisting fleets, for the sidebar list. */
export function useFleets(): FleetSummary[] {
  return useSyncExternalStore(subscribe, getSummaries, getSummaries);
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
  byContext = new Map();
  merged = EMPTY_FLEET;
  summaries = [];
  doFetch = (...args) => fetch(...args);
  listeners.clear();
}
