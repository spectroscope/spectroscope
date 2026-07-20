// The fleet's pure model: the two socket-only fleet frames folded into a
// roster + the event stream that buildSpectrum turns into lanes. Framework-free
// and side-effect-free, the same mental figure as buildSpectrum — the server
// hosts the hub, the browser folds what crosses it.

import type { RunEvent } from "../events";

/** A node's place in the fleet fold — the `fleet_roster` frame's node shape,
 *  identical to `GET /api/fleet` (server FleetAggregator.nodeJson), so the two
 *  faces cannot drift. */
export interface FleetNode {
  id: string;
  role: string;
  capabilities: string[];
  topic: string;
  connected: boolean;
  lastSeen: number;
}

/** One fleet frame's envelope: the canonical bus line the server sends under
 *  `fleet_event.frame`. The Java `BusEnvelope` has no TS twin, so this mirrors
 *  its nine fields; `payload` is exactly one RunEvent. */
export interface FleetEnvelope {
  sender: string;
  epoch: number;
  contextId: string;
  taskId: string;
  sequence: number;
  parentId: string | null;
  topic: string;
  ts: number;
  payload: RunEvent;
}

/** The two socket-only fleet frames — never in the JSONL, not RunEvents; the
 *  server sends them only when the hub is enabled. */
export type FleetFrame =
  | { type: "fleet_roster"; nodes: FleetNode[] }
  | { type: "fleet_event"; frame: FleetEnvelope };

export interface FleetModel {
  /** The roster: latest-wins full state, one entry per node the hub ever saw. */
  roster: FleetNode[];
  /** The fleet's RunEvent payloads in arrival order — buildSpectrum folds these
   *  into lanes (each node stamps agentId = its own id at the source). */
  events: RunEvent[];
  /** Latest epoch seen per sender — a restart (new epoch) is visible here and
   *  marked on the NodeCard, never silently merged into the lane. */
  epochBySender: Record<string, number>;
}

/** The empty fleet — a stable reference for a hub that is off or silent. */
export const EMPTY_FLEET: FleetModel = { roster: [], events: [], epochBySender: {} };

/** Is this stream item a fleet frame? ws.ts casts anything with a string `type`
 *  to RunEvent, so fleet frames ride the same batch; this splits them back out. */
export function isFleetFrame(event: unknown): event is FleetFrame {
  if (event === null || typeof event !== "object") {
    return false;
  }
  const type = (event as { type?: unknown }).type;
  return type === "fleet_roster" || type === "fleet_event";
}

/** Fold the fleet frames into the model. Roster is latest-wins (each
 *  `fleet_roster` is full state); events accumulate; the epoch is tracked per
 *  sender so a restart shows instead of vanishing. */
export function buildFleet(frames: FleetFrame[]): FleetModel {
  let roster: FleetNode[] = [];
  const events: RunEvent[] = [];
  const epochBySender: Record<string, number> = {};
  for (const frame of frames) {
    if (frame.type === "fleet_roster") {
      roster = frame.nodes;
    } else {
      const envelope = frame.frame;
      events.push(envelope.payload);
      const seen = epochBySender[envelope.sender];
      if (seen === undefined || envelope.epoch > seen) {
        epochBySender[envelope.sender] = envelope.epoch;
      }
    }
  }
  return { roster, events, epochBySender };
}
