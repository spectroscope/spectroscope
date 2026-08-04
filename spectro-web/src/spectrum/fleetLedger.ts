// The fleet ledger: what a fleet SPENT, folded per agent, per role and once for
// the whole fleet. The canvas node card already prints one agent's tokens and
// its span; nothing anywhere adds them up, splits the time into tool work and
// gate wait, or says how much of the wall clock was parallel. This does.
//
// Two honesty rules are load-bearing here:
//
//   1. TOKENS ARE NOT COST. No price, currency or rate exists anywhere on the
//      wire, so this fold reports tokens and milliseconds and never a number
//      with a unit it cannot source. Board cards 46/47 (cost aggregation) stay
//      open; this is not them.
//   2. GATE WAIT IS MEASURED, NOT RECONSTRUCTED. The server puts the parked
//      time on tool_result.gateWaitMs (card 111). The permission_request ->
//      permission_decision ts delta is a WIDER window (it also contains the
//      operator's read of the request and any queueing) and would silently
//      overstate. When a gate produced no measurement, the count is reported
//      and the milliseconds are not claimed (`gateWaitMeasured: false`).

import type { RunEvent } from "../events";
import type { FleetModel } from "./fleetModel";

/** One agent's line in the ledger. */
export interface FleetLedgerRow {
  id: string;
  role: string;
  connected: boolean;
  /** What wakes this node (card 72), or null for a plain one. */
  trigger: string | null;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** First and last observed act, epoch ms; null until the agent acts. */
  firstTs: number | null;
  lastTs: number | null;
  /** lastTs - firstTs, 0 while the agent has acted once or not at all. */
  spanMs: number;
  toolCalls: number;
  /** Summed tool_result.durationMs — execution only, gate wait excluded. */
  toolMs: number;
  toolErrors: number;
  gates: number;
  gatesPending: number;
  /** Summed MEASURED tool_result.gateWaitMs. See the honesty rule above. */
  gateWaitMs: number;
  /** False when this agent hit a gate that reported no measurement, so the
   *  milliseconds are a floor rather than the truth. */
  gateWaitMeasured: boolean;
  /** `error` events attributed to this agent (tool failures are toolErrors). */
  errors: number;
}

/** A role's roll-up — the langfuse aggregate-by-name lever, in numbers. */
export interface FleetLedgerRole {
  role: string;
  agents: number;
  inTokens: number;
  outTokens: number;
  toolCalls: number;
  toolMs: number;
  gates: number;
  gateWaitMs: number;
  errors: number;
}

/** The whole fleet on one line. */
export interface FleetLedgerTotal {
  agents: number;
  online: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCalls: number;
  toolMs: number;
  toolErrors: number;
  gates: number;
  gatesPending: number;
  gateWaitMs: number;
  gateWaitMeasured: boolean;
  errors: number;
  /** The fleet's WALL CLOCK: last act anywhere minus first act anywhere. */
  spanMs: number;
  /** The sum of the agents' own spans. Larger than spanMs exactly when agents
   *  overlapped, so agentMs / spanMs reads as the parallelism. Summing spans
   *  and calling it "the fleet took" is the lie this pair exists to prevent. */
  agentMs: number;
}

export interface FleetLedger {
  rows: FleetLedgerRow[];
  roles: FleetLedgerRole[];
  total: FleetLedgerTotal;
}

function emptyRow(id: string): FleetLedgerRow {
  return {
    id,
    role: "",
    connected: false,
    trigger: null,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    firstTs: null,
    lastTs: null,
    spanMs: 0,
    toolCalls: 0,
    toolMs: 0,
    toolErrors: 0,
    gates: 0,
    gatesPending: 0,
    gateWaitMs: 0,
    gateWaitMeasured: true,
    errors: 0,
  };
}

/**
 * Fold a fleet into its ledger. Pure: same model, same numbers, no clock read.
 *
 * Every roster member gets a row, and so does any agent that only shows up in
 * the events (its card may have been evicted from the hub ring while its
 * spending stayed on the stream).
 */
export function buildFleetLedger(model: FleetModel): FleetLedger {
  const rows = new Map<string, FleetLedgerRow>();
  const ensure = (id: string): FleetLedgerRow => {
    let row = rows.get(id);
    if (row === undefined) {
      row = emptyRow(id);
      rows.set(id, row);
    }
    return row;
  };

  for (const member of model.roster) {
    const row = ensure(member.id);
    row.role = member.role;
    row.connected = member.connected;
    row.trigger = member.trigger ?? null;
  }

  // callId -> the agent that asked, so a decision (which names no agent) and a
  // result can both be attributed.
  const gateOwner = new Map<string, string>();
  const undecided = new Set<string>();

  const stamp = (id: string, ts: number): void => {
    const row = ensure(id);
    if (row.firstTs === null || ts < row.firstTs) row.firstTs = ts;
    if (row.lastTs === null || ts > row.lastTs) row.lastTs = ts;
  };

  for (const event of model.events) {
    // The ACTOR of an event: a message is stamped on its sender (the receiver
    // has not acted yet, its own events stamp it); a decision names no agent.
    const actor = event.type === "agent_message" ? event.from : "agentId" in event ? event.agentId : null;
    if (typeof actor === "string" && actor !== "" && typeof event.ts === "number") {
      stamp(actor, event.ts);
    }
    switch (event.type) {
      case "usage": {
        const row = ensure(event.agentId);
        row.inTokens += event.inputTokens;
        row.outTokens += event.outputTokens;
        row.cacheReadTokens += event.cacheReadTokens ?? 0;
        row.cacheCreationTokens += event.cacheCreationTokens ?? 0;
        break;
      }
      case "tool_result": {
        const row = ensure(event.agentId);
        row.toolCalls += 1;
        row.toolMs += event.durationMs;
        if (event.isError) row.toolErrors += 1;
        if (event.gateWaitMs !== undefined) {
          row.gateWaitMs += event.gateWaitMs;
        } else if (gateOwner.get(event.callId) === event.agentId) {
          // This call WAS parked and came back without a measurement: the sum
          // below it is a floor, and the view must say so.
          row.gateWaitMeasured = false;
        }
        break;
      }
      case "permission_request": {
        const row = ensure(event.agentId);
        row.gates += 1;
        gateOwner.set(event.callId, event.agentId);
        undecided.add(event.callId);
        break;
      }
      case "permission_decision": {
        undecided.delete(event.callId);
        break;
      }
      case "error": {
        if (typeof event.agentId === "string" && event.agentId !== "") {
          ensure(event.agentId).errors += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  for (const callId of undecided) {
    const owner = gateOwner.get(callId);
    if (owner !== undefined) ensure(owner).gatesPending += 1;
  }

  const list = [...rows.values()];
  for (const row of list) {
    row.spanMs = row.firstTs !== null && row.lastTs !== null ? row.lastTs - row.firstTs : 0;
  }
  // A row that never acted has no first act; it sorts after everyone who did,
  // then by id so the order is stable across re-folds.
  list.sort((a, b) => {
    const at = a.firstTs ?? Number.POSITIVE_INFINITY;
    const bt = b.firstTs ?? Number.POSITIVE_INFINITY;
    return at !== bt ? at - bt : a.id.localeCompare(b.id);
  });

  const roles = new Map<string, FleetLedgerRole>();
  const total: FleetLedgerTotal = {
    agents: list.length,
    online: 0,
    inTokens: 0,
    outTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: 0,
    toolMs: 0,
    toolErrors: 0,
    gates: 0,
    gatesPending: 0,
    gateWaitMs: 0,
    gateWaitMeasured: true,
    errors: 0,
    spanMs: 0,
    agentMs: 0,
  };
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const row of list) {
    if (row.connected) total.online += 1;
    total.inTokens += row.inTokens;
    total.outTokens += row.outTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cacheCreationTokens += row.cacheCreationTokens;
    total.toolCalls += row.toolCalls;
    total.toolMs += row.toolMs;
    total.toolErrors += row.toolErrors;
    total.gates += row.gates;
    total.gatesPending += row.gatesPending;
    total.gateWaitMs += row.gateWaitMs;
    if (!row.gateWaitMeasured) total.gateWaitMeasured = false;
    total.errors += row.errors;
    total.agentMs += row.spanMs;
    if (row.firstTs !== null && (firstTs === null || row.firstTs < firstTs)) firstTs = row.firstTs;
    if (row.lastTs !== null && (lastTs === null || row.lastTs > lastTs)) lastTs = row.lastTs;

    let role = roles.get(row.role);
    if (role === undefined) {
      role = {
        role: row.role,
        agents: 0,
        inTokens: 0,
        outTokens: 0,
        toolCalls: 0,
        toolMs: 0,
        gates: 0,
        gateWaitMs: 0,
        errors: 0,
      };
      roles.set(row.role, role);
    }
    role.agents += 1;
    role.inTokens += row.inTokens;
    role.outTokens += row.outTokens;
    role.toolCalls += row.toolCalls;
    role.toolMs += row.toolMs;
    role.gates += row.gates;
    role.gateWaitMs += row.gateWaitMs;
    role.errors += row.errors + row.toolErrors;
  }
  total.spanMs = firstTs !== null && lastTs !== null ? lastTs - firstTs : 0;

  return {
    rows: list,
    roles: [...roles.values()].sort((a, b) =>
      b.inTokens + b.outTokens !== a.inTokens + a.outTokens
        ? b.inTokens + b.outTokens - (a.inTokens + a.outTokens)
        : a.role.localeCompare(b.role),
    ),
    total,
  };
}
