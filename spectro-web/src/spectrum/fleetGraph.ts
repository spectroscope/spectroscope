// The fleet-altitude fold: a FleetModel -> a topology graph. Nodes are roster
// members (one per agent); edges are the causal wires between agents, derived
// from the RunEvent PAYLOADS — agent_spawn / run_start.parentId (spawn),
// agent_message from->to (task / result). This is the fleet analogue of
// buildGraph.ts (which stays the per-agent drill-in fold).
//
// LOAD-BEARING CORRECTNESS: edges come from the payload fields, NEVER from the
// bus envelope's parentId. FleetEnvelope.parentId is the sender's OWN previous-
// envelope chain (who-sent-last), not who-spawned-whom — deriving spawn edges
// from it would render a garbage tangle. This fold takes FleetModel, whose
// `events` are already the stripped payloads, so envelope.parentId is not even
// in scope here.

import type { RunEvent } from "../events";
import type { FleetModel } from "./fleetModel";

export type FleetEdgeKind = "spawn" | "task" | "result";

export interface FleetGraphNode {
  id: string;
  role: string;
  connected: boolean;
  epoch: number;
  state: "idle" | "working" | "completed" | "failed";
  /** True while one of this agent's tool calls awaits a permission decision. */
  pendingGate: boolean;
  /** The agent that spawned it (from a spawn payload), or null for a root. */
  spawnedBy: string | null;
  inTokens: number;
  outTokens: number;
}

export interface FleetGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: FleetEdgeKind;
}

export interface FleetGraph {
  nodes: FleetGraphNode[];
  edges: FleetGraphEdge[];
}

export function buildFleetGraph(model: FleetModel): FleetGraph {
  const nodes = new Map<string, FleetGraphNode>();
  const ensure = (id: string): FleetGraphNode => {
    let node = nodes.get(id);
    if (node === undefined) {
      node = {
        id, role: "", connected: false, epoch: model.epochBySender[id] ?? 0,
        state: "idle", pendingGate: false, spawnedBy: null, inTokens: 0, outTokens: 0,
      };
      nodes.set(id, node);
    }
    return node;
  };

  // Roster members are the base node set.
  for (const member of model.roster) {
    const node = ensure(member.id);
    node.role = member.role;
    node.connected = member.connected;
    node.epoch = model.epochBySender[member.id] ?? 0;
    if (member.connected) node.state = "working";
  }

  const edges: FleetGraphEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (source: string, target: string, kind: FleetEdgeKind): void => {
    const id = `${kind}:${source}->${target}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, source, target, kind });
  };

  const undecided = new Set<string>();
  const gateAgent = new Map<string, string>();

  for (const event of model.events) {
    switch (event.type) {
      case "run_start": {
        const node = ensure(event.agentId);
        node.state = "working";
        if (event.parentId != null) {
          node.spawnedBy = event.parentId;
          addEdge(event.parentId, event.agentId, "spawn");
        }
        break;
      }
      case "agent_spawn": {
        ensure(event.agentId).spawnedBy = event.parentId;
        addEdge(event.parentId, event.agentId, "spawn");
        break;
      }
      case "agent_message": {
        if (event.role === "task") {
          ensure(event.to).state = ensure(event.to).state === "idle" ? "working" : ensure(event.to).state;
          addEdge(event.from, event.to, "task");
        } else if (event.role === "result") {
          addEdge(event.from, event.to, "result");
          ensure(event.from).state = event.state === "completed" ? "completed" : "failed";
        } else if (event.role === "status") {
          ensure(event.from).state = "working";
        }
        break;
      }
      case "permission_request": {
        undecided.add(event.callId);
        gateAgent.set(event.callId, event.agentId);
        break;
      }
      case "permission_decision": {
        undecided.delete(event.callId);
        break;
      }
      case "usage": {
        const node = ensure(event.agentId);
        node.inTokens += event.inputTokens;
        node.outTokens += event.outputTokens;
        break;
      }
      default:
        break;
    }
  }

  for (const callId of undecided) {
    const agentId = gateAgent.get(callId);
    if (agentId !== undefined) ensure(agentId).pendingGate = true;
  }

  return { nodes: [...nodes.values()], edges };
}

/** Test helper re-export so a fold test can build a model without the store. */
export type { RunEvent };
