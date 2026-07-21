// The fleet canvas — a spectral DAG. One React Flow node per agent, its body a
// compact spectral band folded from that agent's slice of the fleet events;
// causal rails (spawn / task / result) wire the topology. Fleet altitude: one
// node per agent, never every event. Reuses the graph tab's dagre layout and
// the spectral tick colors — langfuse structure, spectroscope skin.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
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
import { collapseFleetGraph, type LegibleGraph, type LegibleNode } from "./fleetLegibility";
import type { FleetModel } from "./fleetModel";

const NODE_W = 208;
const NODE_H = 82;

// Role -> brand agent-colour var, the cluster tint. Unknown roles fall back.
const CLUSTER_VAR: Record<string, string> = {
  worker: "--agent-worker", explore: "--agent-explore", root: "--agent-root",
  conductor: "--agent-root", panel: "--agent-root",
};
const clusterColor = (cluster: string): string => `var(${CLUSTER_VAR[cluster] ?? "--agent-extra"})`;

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

interface SpectralNodeData {
  node: LegibleNode;
  lane: Lane | null;
  detail: LegibleGraph["detail"];
  /** Fold this expanded group back (only set on a member of an expanded group). */
  onCollapse?: (groupId: string) => void;
}

function SpectralNode({ data }: NodeProps) {
  const d = data as unknown as SpectralNodeData;
  const node = d.node;
  const isGroup = node.kind === "group";
  const live = node.state === "working" && node.connected;
  const classes = [
    "fleet-node-card",
    `fleet-node-card--${node.state}`,
    isGroup ? "fleet-node-card--group" : "",
    d.detail !== "full" ? `fleet-node-card--${d.detail}` : "",
    node.pendingGate ? "fleet-node-card--gate pulse" : "",
  ].filter(Boolean).join(" ");
  const style = { "--cluster": clusterColor(node.cluster) } as CSSProperties;
  return (
    <div className={classes} style={style}>
      <Handle type="target" position={Position.Top} />
      <div className="fleet-node-card-head">
        <span className={`dot ${stateDot(node.state)}${live ? " pulse" : ""}`} aria-hidden="true" />
        <span className="fleet-node-cluster" aria-hidden="true" />
        <span className="fleet-node-card-id mono">{isGroup ? node.role : node.id}</span>
        {isGroup ? (
          <span className="fleet-node-count mono">
            ×{node.count}{node.descendants.length > 0 ? ` +${node.descendants.length}` : ""}
            <span className="fleet-node-expand" aria-hidden="true">▸</span>
          </span>
        ) : node.groupId !== undefined && d.onCollapse ? (
          <button type="button" className="fleet-node-collapse mono nodrag"
            title="fold back into the group"
            onClick={(e) => { e.stopPropagation(); d.onCollapse!(node.groupId!); }}>
            ▾ {node.role}
          </button>
        ) : node.role !== "" ? (
          <span className="fleet-node-card-role">{node.role}</span>
        ) : null}
      </div>
      {d.detail !== "dot" && (
        <svg className="fleet-node-band" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true">
          {isGroup ? (
            // a "deck" motif — many agents stacked behind one card
            [3, 6.5, 10].map((y, i) => (
              <line key={i} x1="0" y1={y} x2={200 - i * 20} y2={y}
                stroke="var(--cluster)" strokeWidth={1.4} opacity={0.35 + i * 0.22} />
            ))
          ) : (
            <>
              <line x1="0" y1="7" x2="200" y2="7" className="fleet-node-baseline" />
              {(d.lane?.ticks ?? []).map((tick, i) => (
                <rect key={i} x={tick.x * 198 + 1} y={2}
                  width={tick.kind === "gate" ? 2.4 : 1.2} height={10} rx={0.5}
                  fill={TICK_COLOR[tick.kind]} opacity={tick.kind === "token" ? 0.7 : 0.95} />
              ))}
            </>
          )}
        </svg>
      )}
      {d.detail === "full" && (
        <div className="fleet-node-card-foot mono tabular">
          {formatTokens(node.inTokens)} in · {formatTokens(node.outTokens)} out
          {isGroup && node.descendants.length > 0 && <span> · +{node.descendants.length} rolled up</span>}
          {node.epoch > 0 && <span className="fleet-node-card-epoch"> · #{node.epoch}</span>}
        </div>
      )}
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

export function FleetCanvas({ model, events, onOpenTrace }: {
  model: FleetModel;
  events: RunEvent[];
  /** Drill into an agent's own trace (reuses the sidebar/spectrum hand-off). */
  onOpenTrace?: (agentId: string) => void;
}) {
  const lang = useLang();
  // A folded group is no longer terminal: the ids here are expanded, so their
  // members (and rolled-up descendants) surface as individual, reachable nodes.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const collapseGroup = useCallback((groupId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
  }, []);

  // Product tuning: small fleets stay fully legible as individual cards; only
  // a genuinely wide fan-out (6+ same-role siblings) folds into a group.
  const legible = useMemo(
    () => collapseFleetGraph(buildFleetGraph(model),
      { minGroup: 6, maxNodes: 24, expanded: [...expanded] }),
    [model, expanded],
  );

  // Reconcile the expanded set with the current fold: drop ids that no longer
  // name a live group (their members carry no groupId this round). Without this,
  // a bucket that dissolved (roster shrank below the threshold) and later reforms
  // would silently reappear pre-expanded from its stale deterministic id.
  useEffect(() => {
    const live = new Set(legible.nodes.filter((n) => n.groupId).map((n) => n.groupId));
    setExpanded((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => { if (live.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [legible]);

  const { nodes, edges } = useMemo(() => {
    const spectrum = buildSpectrum(events);
    const laneById = new Map(spectrum.lanes.map((l) => [l.id, l]));
    const flowNodes: FlowNode[] = legible.nodes.map((n) => ({
      id: n.id,
      type: "spectral",
      position: { x: 0, y: 0 },
      data: {
        node: n,
        lane: n.kind === "agent" ? laneById.get(n.id) ?? null : null,
        detail: legible.detail,
        onCollapse: n.groupId !== undefined ? collapseGroup : undefined,
      },
    }));
    const flowEdges: FlowEdge[] = legible.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.kind === "task",
      style: { stroke: EDGE_COLOR[e.kind], strokeWidth: 1.4 },
    }));
    return { nodes: layout(flowNodes, flowEdges), edges: flowEdges };
  }, [legible, events, collapseGroup]);

  // A group card expands; an agent card drills into its own trace. The collapse
  // chip inside an expanded member stops propagation, so it never lands here.
  const onNodeClick = useCallback((_e: MouseEvent, flow: FlowNode) => {
    const node = (flow.data as unknown as SpectralNodeData).node;
    if (node.kind === "group") {
      setExpanded((prev) => new Set(prev).add(node.id));
    } else if (onOpenTrace) {
      onOpenTrace(node.id);
    }
  }, [onOpenTrace]);

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
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.2}
        panOnDrag={[1, 2]}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable
          nodeColor={(n) => clusterColor((n.data as unknown as SpectralNodeData).node.cluster)} />
      </ReactFlow>
    </div>
  );
}
