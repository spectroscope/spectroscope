// The fleet canvas — a spectral DAG. One React Flow node per agent, its body a
// compact spectral band folded from that agent's slice of the fleet events;
// causal rails (spawn / task / result) wire the topology. Fleet altitude: one
// node per agent, never every event. Reuses the graph tab's dagre layout and
// the spectral tick colors — langfuse structure, spectroscope skin.

import { useMemo } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow } from "@xyflow/react";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps } from "@xyflow/react";
import * as dagre from "dagre";
import "@xyflow/react/dist/style.css";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatTokens } from "../format";
import { buildSpectrum, type Lane, type TickKind } from "./spectrumModel";
import { buildFleetGraph, type FleetEdgeKind, type FleetGraphNode } from "./fleetGraph";
import type { FleetModel } from "./fleetModel";

const NODE_W = 208;
const NODE_H = 82;

const EDGE_COLOR: Record<FleetEdgeKind, string> = {
  spawn: "var(--ev-subagent)", // ocean rail
  task: "var(--ev-tool)", // amber comet (animated in flight)
  result: "var(--ev-token)", // teal rail
};

const TICK_COLOR: Record<TickKind, string> = {
  token: "var(--ev-token)",
  reasoning: "var(--ev-reasoning)",
  tool: "var(--ev-tool)",
  gate: "var(--ev-gate)",
  subagent: "var(--ev-subagent)",
  lifecycle: "var(--ev-lifecycle)",
  error: "var(--error)",
};

const stateDot = (state: FleetGraphNode["state"]): string =>
  state === "failed" ? "error" : state === "working" ? "accent" : state === "completed" ? "ok" : "faint";

function SpectralNode({ data }: NodeProps) {
  const d = data as { node: FleetGraphNode; lane: Lane | null };
  const node = d.node;
  const live = node.state === "working" && node.connected;
  const classes = [
    "fleet-node-card",
    `fleet-node-card--${node.state}`,
    node.pendingGate ? "fleet-node-card--gate pulse" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} />
      <div className="fleet-node-card-head">
        <span className={`dot ${stateDot(node.state)}${live ? " pulse" : ""}`} aria-hidden="true" />
        <span className="fleet-node-card-id mono">{node.id}</span>
        {node.role !== "" && <span className="fleet-node-card-role">{node.role}</span>}
      </div>
      <svg className="fleet-node-band" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="7" x2="200" y2="7" className="fleet-node-baseline" />
        {(d.lane?.ticks ?? []).map((tick, i) => (
          <rect
            key={i}
            x={tick.x * 198 + 1}
            y={2}
            width={tick.kind === "gate" ? 2.4 : 1.2}
            height={10}
            rx={0.5}
            fill={TICK_COLOR[tick.kind]}
            opacity={tick.kind === "token" ? 0.7 : 0.95}
          />
        ))}
      </svg>
      <div className="fleet-node-card-foot mono tabular">
        {formatTokens(node.inTokens)} in · {formatTokens(node.outTokens)} out
        {node.epoch > 0 && <span className="fleet-node-card-epoch"> · #{node.epoch}</span>}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { spectral: SpectralNode };

/** Top-down dagre layout, same pattern as the graph tab's layoutGraph. */
function layout(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}

export function FleetCanvas({ model, events }: { model: FleetModel; events: RunEvent[] }) {
  const lang = useLang();
  const { nodes, edges } = useMemo(() => {
    const fleetGraph = buildFleetGraph(model);
    const spectrum = buildSpectrum(events);
    const laneById = new Map(spectrum.lanes.map((l) => [l.id, l]));
    const flowNodes: FlowNode[] = fleetGraph.nodes.map((n) => ({
      id: n.id,
      type: "spectral",
      position: { x: 0, y: 0 },
      data: { node: n, lane: laneById.get(n.id) ?? null },
    }));
    const flowEdges: FlowEdge[] = fleetGraph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.kind === "task",
      style: { stroke: EDGE_COLOR[e.kind], strokeWidth: 1.4 },
    }));
    return { nodes: layout(flowNodes, flowEdges), edges: flowEdges };
  }, [model, events]);

  if (nodes.length === 0) {
    return (
      <div className="spectrum-empty">
        <p>{t(lang, "fleet.noEvents")}</p>
        <p className="spectrum-empty-sub">{t(lang, "fleet.noEventsHint")}</p>
      </div>
    );
  }

  return (
    <div className="fleet-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        panOnDrag={[1, 2]}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={() => "var(--agent-worker)"} />
      </ReactFlow>
    </div>
  );
}
