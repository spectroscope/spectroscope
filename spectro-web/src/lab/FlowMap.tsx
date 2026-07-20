// The Lab's "Flow" centre view: the React Flow System-Map, driven by the SAME
// stepper state the schematic "Karte" and the "Netz" use. It is render-only —
// no timeline, no pickers, no brand chrome. The Lab owns the timeline (stepper),
// the provider/model (props from run_start / the header picker) and the genome
// (the global [data-design] attribute). This component just maps the folded
// scene to nodes/edges and renders the canvas. Extracted from the prototype's
// SystemFlow orchestrator; the pure render pieces live in ./flowmap.

import { useEffect, useMemo, useRef } from "react";
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
} from "@xyflow/react";
import type { RunEvent } from "../events";
import { isLocalProvider, type Scene } from "./labScene";
import { deriveDetail, sceneToFlow } from "./flowmap/sceneToFlow";
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
}) {
  const { scene, applied, provider, model, systemPrompt } = props;
  const local = isLocalProvider(provider);
  const lang = useLang();

  const detail = useMemo(() => deriveDetail(applied), [applied]);
  const flow = useMemo(
    () => sceneToFlow(scene, detail, { local, provider: provider ?? "", model: model ?? "", systemPrompt, lang }),
    [scene, detail, local, provider, model, systemPrompt, lang],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const layoutRef = useRef(local);

  // Sync folded scene -> flow, preserving drag positions unless the layout
  // flipped (local/remote). Subagent nodes always take their freshly computed
  // deterministic position so adding a second/third agent re-centres the group
  // instead of stranding earlier cards (the clump bug from the prototype).
  useEffect(() => {
    const relayout = layoutRef.current !== local;
    layoutRef.current = local;
    setNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      return flow.nodes.map((node) => {
        const old = byId.get(node.id);
        const keep = old && !relayout && !node.id.startsWith("sub-");
        return keep ? { ...node, position: old.position } : node;
      });
    });
    setEdges(flow.edges);
  }, [flow, local, setNodes, setEdges]);

  return (
    // Right mouse button pans (context menu suppressed), left only clicks and
    // drags nodes — owner request, same rule as the Graph tab.
    <div className="lab-flowmap" onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow
        key={local ? "local" : "remote"}
        className="pf-flow"
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
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

        <Panel position="bottom-left">
          <div className="pf-legend">
            <span><i className="on" />{t(lang, "map.legend.activeRail")}</span>
            <span><i />{t(lang, "map.legend.inside")}</span>
            <span><i className="net" />{t(lang, "map.legend.out")}</span>
            <span><b style={{ background: "var(--ok)" }} />{t(lang, "map.legend.read")}</span>
            <span><b style={{ background: "var(--accent)" }} />{t(lang, "map.legend.writeLive")}</span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
