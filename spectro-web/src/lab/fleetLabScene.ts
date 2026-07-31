// The fleet machine-room fold (card 59): one FleetModel in, one scene out —
// every fleet node as its OWN agent loop (the same advanceLoop transition the
// single-run map uses), plus the card meta the fleet carries (role, task,
// lifecycle, roster connectivity, provider). Pure and DOM-free like labScene;
// the differences to the single-run scene are deliberate:
//   - no privileged "main" loop — main is just the first card when present;
//   - no scene-wide reset on run_start/run_end (fleet nodes persist across runs);
//   - run_end parks a node at ITSELF (focus "agent"), not at the user — a
//     fleet node has no user of its own. run_end carries no agentId on the
//     wire, so it is attributed through its run_start's runId.

import type { RunEvent } from "../events";
import type { FleetModel } from "../spectrum/fleetModel";
import { advanceLoop, initialLoop, isLocalProvider, type Loop } from "./labScene";

/** One fleet node's card in the machine room — its loop plus the fleet meta. */
export interface FleetLabNode extends Loop {
  id: string;
  role: string;
  /** The task as submitted (agent_message role=task / agent_spawn). */
  task: string;
  /** A2A lifecycle, exactly the single-run card semantics. */
  state: "submitted" | "working" | "completed" | "failed";
  lastStatus: string | null;
  /** Roster connectivity — false for event-only ghosts and left nodes. */
  connected: boolean;
  /** The provider its last run_start named (null before the first run). */
  provider: string | null;
}

export interface FleetLabScene {
  /** All cards, main first, then roster order, event-only nodes appended. */
  nodes: FleetLabNode[];
  /** The node whose event arrived last — the card that pulses. */
  activeNode: string | null;
  /** True when any node runs against a remote / a local backend (LLM stations). */
  hasRemote: boolean;
  hasLocal: boolean;
}

function freshNode(id: string, role: string, connected: boolean): FleetLabNode {
  return {
    id,
    role,
    task: "",
    state: "submitted",
    lastStatus: null,
    connected,
    provider: null,
    ...initialLoop(),
  };
}

/** A node's role from its id when the roster has none — the fleetStore rule. */
function roleFromId(id: string): string {
  if (id === "main") return "root";
  return id.replace(/[-_]?\d+$/, "") || id;
}

/** The fleet transition: advanceLoop, except run_end parks at the agent. */
function advanceFleetLoop(loop: Loop, event: RunEvent): Loop {
  const next = advanceLoop(loop, event);
  if (event.type === "run_end") {
    return { ...next, focus: "agent" };
  }
  return next;
}

/**
 * Fold one fleet model into the machine-room scene. Deterministic: the same
 * model (roster + events prefix) always yields the same scene, so a scrubber
 * can re-fold any prefix.
 */
export function buildFleetLabScene(model: FleetModel): FleetLabScene {
  const byId = new Map<string, FleetLabNode>();
  const order: string[] = [];
  const ensure = (id: string, role?: string, connected?: boolean): FleetLabNode => {
    let card = byId.get(id);
    if (card === undefined) {
      card = freshNode(id, role ?? roleFromId(id), connected ?? false);
      byId.set(id, card);
      order.push(id);
    }
    return card;
  };

  for (const rosterNode of model.roster) {
    ensure(rosterNode.id, rosterNode.role, rosterNode.connected);
  }

  const runOwners = new Map<string, string>(); // runId -> agentId (for run_end)
  const gateOwners = new Map<string, string>(); // callId -> agentId (for decisions)
  let activeNode: string | null = null;
  let hasRemote = false;
  let hasLocal = false;

  const fold = (id: string, event: RunEvent): void => {
    const card = ensure(id);
    byId.set(id, { ...card, ...advanceFleetLoop(card, event) });
    activeNode = id;
  };

  for (const event of model.events) {
    switch (event.type) {
      case "agent_spawn": {
        const card = ensure(event.agentId);
        byId.set(event.agentId, { ...card, task: event.task });
        break;
      }
      case "agent_message": {
        if (event.role === "task") {
          const card = ensure(event.to);
          byId.set(event.to, { ...card, task: event.text, state: "submitted" });
        } else if (event.role === "status") {
          const card = ensure(event.from);
          byId.set(event.from, { ...card, state: "working", lastStatus: event.text });
          activeNode = event.from;
        } else if (event.role === "result") {
          const card = ensure(event.from);
          byId.set(event.from, {
            ...card,
            state: event.state === "completed" ? "completed" : "failed",
          });
          activeNode = event.from;
        }
        break;
      }
      case "run_start": {
        runOwners.set(event.runId, event.agentId);
        const provider = event.provider;
        if (typeof provider === "string" && provider !== "") {
          if (isLocalProvider(provider)) hasLocal = true;
          else hasRemote = true;
          const card = ensure(event.agentId);
          byId.set(event.agentId, { ...card, provider });
        }
        fold(event.agentId, event);
        break;
      }
      case "run_end": {
        const owner = runOwners.get(event.runId);
        if (owner !== undefined) {
          fold(owner, event);
        }
        break;
      }
      case "permission_request": {
        gateOwners.set(event.callId, event.agentId);
        fold(event.agentId, event);
        break;
      }
      case "permission_decision": {
        const owner = gateOwners.get(event.callId);
        gateOwners.delete(event.callId);
        if (owner !== undefined) {
          fold(owner, event);
        }
        break;
      }
      default: {
        const id =
          "agentId" in event && typeof (event as { agentId?: unknown }).agentId === "string"
            ? (event as { agentId: string }).agentId
            : null;
        if (id !== null) {
          fold(id, event);
        }
        break;
      }
    }
  }

  // main first, then arrival order (roster before event-only ghosts).
  const ids = [...order.filter((id) => id === "main"), ...order.filter((id) => id !== "main")];
  return {
    nodes: ids.map((id) => byId.get(id)!),
    activeNode,
    hasRemote,
    hasLocal,
  };
}
