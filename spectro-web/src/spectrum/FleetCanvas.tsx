// The fleet canvas — a spectral DAG. One React Flow node per agent, its body a
// compact spectral band folded from that agent's slice of the fleet events;
// causal rails (spawn / task / result) wire the topology. Fleet altitude: one
// node per agent, never every event. Reuses the graph tab's dagre layout and
// the spectral tick colors — langfuse structure, spectroscope skin.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { Handle, MiniMap, Position } from "@xyflow/react";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps } from "@xyflow/react";
import { GraphCanvas } from "../reactflow/GraphCanvas";
import { layoutDagre } from "../reactflow/layoutDagre";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { formatDuration, formatTokens } from "../format";
import { buildSpectrum, type Lane, type TickKind } from "./spectrumModel";
import { buildFleetGraph, type FleetEdgeKind, type FleetGraphNode } from "./fleetGraph";
import { collapseFleetGraph, type LegibleGraph, type LegibleNode } from "./fleetLegibility";
import type { FleetModel } from "./fleetModel";
import { FleetSpawn } from "./FleetSpawn";

const NODE_W = 208;
const NODE_H = 82;

// Role -> brand agent-colour var, the cluster tint. Unknown roles fall back.
const CLUSTER_VAR: Record<string, string> = {
  worker: "--agent-worker",
  explore: "--agent-explore",
  root: "--agent-root",
  conductor: "--agent-root",
  panel: "--agent-root",
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
  /** Stop this node over the hub (only wired for a connected single agent). */
  onStop?: (agentId: string) => void;
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
  ]
    .filter(Boolean)
    .join(" ");
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
            ×{node.count}
            {node.descendants.length > 0 ? ` +${node.descendants.length}` : ""}
            <span className="fleet-node-expand" aria-hidden="true">
              ▸
            </span>
          </span>
        ) : node.groupId !== undefined && d.onCollapse ? (
          <button
            type="button"
            className="fleet-node-collapse mono nodrag"
            title="fold back into the group"
            onClick={(e) => {
              e.stopPropagation();
              d.onCollapse!(node.groupId!);
            }}
          >
            ▾ {node.role}
          </button>
        ) : node.role !== "" ? (
          <span className="fleet-node-card-role">{node.role}</span>
        ) : null}
        {!isGroup && node.connected && d.onStop && (
          <button
            type="button"
            className="fleet-node-stop nodrag"
            title="stop this node"
            aria-label={`stop ${node.id}`}
            onClick={(e) => {
              e.stopPropagation();
              d.onStop!(node.id);
            }}
          >
            ⊗
          </button>
        )}
      </div>
      {d.detail !== "dot" && (
        <svg className="fleet-node-band" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true">
          {isGroup ? (
            // a "deck" motif — many agents stacked behind one card
            [3, 6.5, 10].map((y, i) => (
              <line
                key={i}
                x1="0"
                y1={y}
                x2={200 - i * 20}
                y2={y}
                stroke="var(--cluster)"
                strokeWidth={1.4}
                opacity={0.35 + i * 0.22}
              />
            ))
          ) : (
            <>
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
            </>
          )}
        </svg>
      )}
      {d.detail === "full" && (
        <div className="fleet-node-card-foot mono tabular">
          {formatTokens(node.inTokens)} in · {formatTokens(node.outTokens)} out
          {node.firstTs !== null && node.lastTs !== null && node.lastTs > node.firstTs && (
            /* langfuse P1.2 — the activity span right on the card: an agent's
               own first→last act; a group, the span across its members. */
            <span> · {formatDuration(node.lastTs - node.firstTs)}</span>
          )}
          {isGroup && node.descendants.length > 0 && <span> · +{node.descendants.length} rolled up</span>}
          {node.epoch > 0 && <span className="fleet-node-card-epoch"> · #{node.epoch}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { spectral: SpectralNode };

export function FleetCanvas({
  model,
  events,
  onOpenTrace,
  contextId,
  hubPort,
  onStop,
}: {
  model: FleetModel;
  events: RunEvent[];
  /** Drill into an agent's own trace (reuses the sidebar/spectrum hand-off). */
  onOpenTrace?: (agentId: string) => void;
  /** The entered fleet's contextId — enables the spawn panel (prefills context). */
  contextId?: string;
  /** The loopback hub port, for the spawn panel's copy-paste node command. */
  hubPort?: number | null;
  /** Stop a connected node over the hub (POST /api/fleet/{node}/stop). */
  onStop?: (agentId: string) => void;
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

  // Two readings of the same fleet (the one control langfuse gets right, see
  // konzept/LANGFUSE-REVIEW.md): "aggregated" folds same-role siblings into
  // group cards — structure at a glance; "expanded" shows every agent as its
  // own node — following one specific run. Per-group expand still works on top.
  const [mode, setMode] = useState<"aggregated" | "expanded">("aggregated");

  // Product tuning: small fleets stay fully legible as individual cards; only
  // a genuinely wide fan-out (6+ same-role siblings) folds into a group. In
  // expanded mode nothing folds (an unreachable threshold); the LOD tier still
  // degrades on its own, so a huge fleet stays renderable.
  const legible = useMemo(
    () =>
      collapseFleetGraph(buildFleetGraph(model), {
        minGroup: mode === "expanded" ? Number.MAX_SAFE_INTEGER : 6,
        maxNodes: 24,
        expanded: [...expanded],
      }),
    [model, expanded, mode],
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
      prev.forEach((id) => {
        if (live.has(id)) next.add(id);
        else changed = true;
      });
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
        lane: n.kind === "agent" ? (laneById.get(n.id) ?? null) : null,
        detail: legible.detail,
        onCollapse: n.groupId !== undefined ? collapseGroup : undefined,
        onStop: n.kind === "agent" ? onStop : undefined,
      },
    }));
    const flowEdges: FlowEdge[] = legible.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.kind === "task",
      style: { stroke: EDGE_COLOR[e.kind], strokeWidth: 1.4 },
    }));
    return { nodes: layoutDagre(flowNodes, flowEdges, { nodeW: NODE_W, nodeH: NODE_H }), edges: flowEdges };
  }, [legible, events, collapseGroup, onStop]);

  // A group card expands; an agent card drills into its own trace. The collapse
  // chip inside an expanded member stops propagation, so it never lands here.
  const onNodeClick = useCallback(
    (_e: MouseEvent, flow: FlowNode) => {
      const node = (flow.data as unknown as SpectralNodeData).node;
      if (node.kind === "group") {
        setExpanded((prev) => new Set(prev).add(node.id));
      } else if (onOpenTrace) {
        onOpenTrace(node.id);
      }
    },
    [onOpenTrace],
  );

  if (nodes.length === 0) {
    return (
      <div className="spectrum-empty">
        <p>{t(lang, "fleet.noEvents")}</p>
        <p className="spectrum-empty-sub">{t(lang, "fleet.noEventsHint")}</p>
      </div>
    );
  }

  return (
    <GraphCanvas
      className="fleet-canvas"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      minZoom={0.2}
      miniMap={
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => clusterColor((n.data as unknown as SpectralNodeData).node.cluster)}
        />
      }
    >
      <div className="fleet-mode nodrag" role="group" aria-label={t(lang, "fleet.modeAria")}>
        {(["aggregated", "expanded"] as const).map((m) => (
          <button
            key={m}
            type="button"
            className={`fleet-mode-btn${mode === m ? " fleet-mode-btn--on" : ""}`}
            aria-pressed={mode === m}
            title={t(lang, `fleet.mode.${m}.title`)}
            onClick={() => setMode(m)}
          >
            {t(lang, `fleet.mode.${m}`)}
          </button>
        ))}
      </div>
      {contextId !== undefined && <FleetSpawn contextId={contextId} hubPort={hubPort ?? null} />}
    </GraphCanvas>
  );
}
