// The Lab's "Flow" centre view: the React Flow System-Map, driven by the SAME
// stepper state the schematic "Karte" and the "Netz" use. It is render-only —
// no timeline, no pickers, no brand chrome. The Lab owns the timeline (stepper),
// the provider/model (props from run_start / the header picker) and the genome
// (the global [data-design] attribute). This component just maps the folded
// scene to nodes/edges and renders the canvas. Extracted from the prototype's
// SystemFlow orchestrator; the pure render pieces live in ./flowmap.

import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import type { RunEvent } from "../events";
import { isLocalProvider, type Scene } from "./labScene";
import { deriveDetail, sceneToFlow } from "./flowmap/sceneToFlow";
import { collectDraggedIds, mergeNodePositions } from "./flowmap/positions";
import { workerChip } from "./flowmap/workerGrid";
import { ExpandAllContext } from "./flowmap/expandContext";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { nodeTypes } from "./flowmap/nodes";
import { edgeTypes } from "./flowmap/PacketEdge";
import "@xyflow/react/dist/style.css";
import "./flowmap/flowmap.css";

const MINIMAP_COLOR: Record<string, string> = {
  agent: "var(--accent)",
  subagent: "var(--agent-worker)",
  llm: "var(--sand)",
  user: "var(--text-dim)",
  os: "var(--border-strong)",
  ext: "var(--border-strong)",
};

export function FlowMap(props: {
  /** The folded scene from the stepper (same source as the SVG map + Petri net). */
  scene: Scene;
  /** The applied events, for the derived detail (context/tool-input/streams). */
  applied: RunEvent[];
  /** Selected backend — decides remote (beyond the boundary) vs local (inside). */
  provider?: string;
  /** Current model name, shown in the LLM node. */
  model?: string;
  /** The main agent's system prompt (from /api/context) for the agent card. */
  systemPrompt?: string;
  /** Bump this to re-fit the map when its container resizes (e.g. a side drawer
   *  opened/closed) — the `fitView` prop only fits on init. */
  fitSignal?: number;
}) {
  const { scene, applied, provider, model, systemPrompt } = props;
  const local = isLocalProvider(provider);
  const lang = useLang();

  const expandAll = useContext(ExpandAllContext);
  const detail = useMemo(() => deriveDetail(applied), [applied]);
  const flow = useMemo(
    () =>
      sceneToFlow(scene, detail, {
        local,
        provider: provider ?? "",
        model: model ?? "",
        systemPrompt,
        lang,
        expanded: expandAll,
      }),
    [scene, detail, local, provider, model, systemPrompt, lang, expandAll],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Which seating the rendered nodes came from. Compact and expanded are two
  // different seatings, so switching the card view is as much a re-layout as
  // flipping local/remote — without this the cards keep the seats of the view
  // they were rendered in and the map reads as a mix of both.
  const layoutRef = useRef(`${local}:${expandAll}`);
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  // Nodes the user has dragged. Once pinned, a node keeps its position across
  // every step (even a subagent, which otherwise re-centres) — so dragging a card
  // is never undone by the next step. Cleared when the layout world flips.
  const pinned = useRef(new Set<string>());

  // Record a drag so the node stays put across the next step.
  const onNodesChangePinned = useCallback(
    (changes: NodeChange<Node>[]) => {
      collectDraggedIds(changes, pinned.current);
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  // Re-fit when the caller bumps fitSignal (a side drawer opened/closed, so the
  // container width changed). The `fitView` prop fits only on init, so without
  // this the map stays anchored top-left and clips. setTimeout(0) lets React
  // Flow's own ResizeObserver settle first; no rAF loop (the embedded preview
  // pane stalls rAF).
  useEffect(() => {
    if (props.fitSignal === undefined) return;
    // Instant fit (no `duration`): an animated fit runs an rAF loop, which the
    // embedded preview pane stalls; a one-shot fit applies in a single frame and
    // reads correctly. On a real browser the snap is immediate and clean.
    const id = setTimeout(() => rfRef.current?.fitView({ padding: 0.16 }), 0);
    return () => clearTimeout(id);
  }, [props.fitSignal]);

  // Sync folded scene -> flow, preserving positions across steps. A main card
  // keeps its position by default; a subagent keeps its freshly computed one so a
  // new worker re-centres the group instead of stranding earlier cards (the clump
  // bug from the prototype) — UNLESS the user dragged it, in which case it is
  // pinned and stays. A local/remote flip or a compact/expanded flip re-lays-out
  // everything and drops pins.
  useEffect(() => {
    const seating = `${local}:${expandAll}`;
    const relayout = layoutRef.current !== seating;
    layoutRef.current = seating;
    if (relayout) pinned.current.clear();
    setNodes((prev) => mergeNodePositions(prev, flow.nodes, pinned.current, relayout));
    setEdges(flow.edges);
  }, [flow, local, expandAll, setNodes, setEdges]);

  return (
    // Right mouse button pans (context menu suppressed), left only clicks and
    // drags nodes — owner request, same rule as the Graph tab.
    <div className="lab-flowmap" onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow
        // A disclosure seeds its open/closed state when the card mounts, so a
        // view flip has to remount the canvas — otherwise the cards carry the
        // other view's open panels into seats that never reserved for them.
        key={`${local ? "local" : "remote"}:${expandAll ? "expanded" : "compact"}`}
        className="pf-flow"
        onInit={(inst) => {
          rfRef.current = inst;
        }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChangePinned}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={[1, 2]}
        fitView
        fitViewOptions={{ padding: 0.16 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "rail" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="var(--border-strong)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          maskColor="color-mix(in srgb, var(--bg) 72%, transparent)"
          nodeColor={(nd) => MINIMAP_COLOR[nd.type ?? ""] ?? "transparent"}
          nodeStrokeColor="var(--border-strong)"
        />

        <Panel position="top-right">
          {(() => {
            // The honest chip (card 287): quiet while every spawned worker is
            // drawn, loud about the gap past the seating ceiling. Data, not
            // chrome — the text stays untranslated like other wire-derived text.
            const drawn = flow.nodes.filter((n) => n.type === "subagent").length;
            const chip = workerChip(scene.subagents.length, drawn);
            return chip === null ? null : (
              <div className={`pf-chip${chip.gap ? " pf-chip--gap" : ""}`}>{chip.text}</div>
            );
          })()}
        </Panel>

        <Panel position="bottom-left">
          <div className="pf-legend">
            <span>
              <i className="on" />
              {t(lang, "map.legend.activeRail")}
            </span>
            <span>
              <i />
              {t(lang, "map.legend.inside")}
            </span>
            <span>
              <i className="net" />
              {t(lang, "map.legend.out")}
            </span>
            <span>
              <b style={{ background: "var(--ok)" }} />
              {t(lang, "map.legend.read")}
            </span>
            <span>
              <b style={{ background: "var(--accent)" }} />
              {t(lang, "map.legend.writeLive")}
            </span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
