// The Lab's "Flow" centre view: the React Flow System-Map, driven by the SAME
// stepper state the schematic "Karte" and the "Netz" use. It is render-only —
// no timeline, no pickers, no brand chrome. The Lab owns the timeline (stepper),
// the provider/model (props from run_start / the header picker) and the genome
// (the global [data-design] attribute). This component just maps the folded
// scene to nodes/edges and renders the canvas. Extracted from the prototype's
// SystemFlow orchestrator; the pure render pieces live in ./flowmap.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { agentDirectory } from "./agentDirectory";
import {
  UNDER_SETTLE_MS,
  deriveDetail,
  measuredCards,
  reportOversizeCards,
  sceneToFlow,
} from "./flowmap/sceneToFlow";
import { collectDraggedIds, mergeNodePositions } from "./flowmap/positions";
import { foldSeatPool, workerChip, type RowsPref } from "./flowmap/workerGrid";
import { RailBoxes } from "./flowmap/railBoxes";
import { panMove, panStart, type PanDrag } from "./flowmap/panDrag";
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
  /** How deep the expanded worker grid stacks (card 296). Absent or "auto" is
   *  the derivation the map always did. */
  rowsPref?: RowsPref;
}) {
  const { scene, applied, provider, model, systemPrompt } = props;
  const rowsPref = props.rowsPref ?? "auto";
  const local = isLocalProvider(provider);
  const lang = useLang();

  const expandAll = useContext(ExpandAllContext);
  const detail = useMemo(() => deriveDetail(applied), [applied]);
  // The seat pool (card 292): folded over the SAME applied prefix as the scene,
  // so scrubbing re-folds deterministically and seats say what was concurrent.
  const pool = useMemo(() => foldSeatPool(applied), [applied]);
  // The agent handles (card 298): folded over the SAME applied prefix, so a
  // station names its occupant by a tag that survives scrubbing.
  const dir = useMemo(() => agentDirectory(applied), [applied]);
  // The pane's measured aspect (card 292), for the expanded row derivation.
  // null until a real measurement arrives — a HIDDEN pane delivers no frames
  // and no ResizeObserver, so headless (and in tests) this stays null and the
  // layout falls back to its constant rows instead of breaking.
  const [paneAspect, setPaneAspect] = useState<number | null>(null);
  const flow = useMemo(
    () =>
      sceneToFlow(scene, detail, {
        local,
        provider: provider ?? "",
        model: model ?? "",
        systemPrompt,
        lang,
        expanded: expandAll,
        pool,
        paneAspect,
        dir,
        rowsPref,
      }),
    [
      scene,
      detail,
      local,
      provider,
      model,
      systemPrompt,
      lang,
      expandAll,
      pool,
      paneAspect,
      dir,
      rowsPref,
    ],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Which seating the rendered nodes came from. Compact and expanded are two
  // different seatings, so switching the card view is as much a re-layout as
  // flipping local/remote — without this the cards keep the seats of the view
  // they were rendered in and the map reads as a mix of both. The measured
  // pane aspect is part of the seating since card 292: it drives the expanded
  // row derivation, so a real resize re-places the map the same way.
  const layoutRef = useRef(`${local}:${expandAll}:${paneAspect}:${rowsPref}`);
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
    const seating = `${local}:${expandAll}:${paneAspect}:${rowsPref}`;
    const relayout = layoutRef.current !== seating;
    layoutRef.current = seating;
    if (relayout) pinned.current.clear();
    setNodes((prev) => mergeNodePositions(prev, flow.nodes, pinned.current, relayout));
    setEdges(flow.edges);
  }, [flow, local, expandAll, paneAspect, rowsPref, setNodes, setEdges]);

  // The envelope check's runtime half (card 296). Every expanded seat is
  // derived from EXPANDED_CARD, and until now NOTHING in src/ ever held the
  // cards the browser actually laid out against those numbers —
  // reportOversizeCards had no caller outside its own test, so the half of the
  // check that needs a real browser never ran, and a seat that reserved twice
  // its card shipped in silence. It is cheap: each finding is said once, and a
  // hidden pane measures nothing, so nothing is said.
  //
  // TWO CALLS, because the two arms judge different things (re-review). A card
  // OVER its seat is drawing on top of its neighbour right now, so it is said
  // on the spot. A seat holding air is a judgement about a whole run, and this
  // effect fires while cards are still filling up — a worker is bare for its
  // first frames and 237 world px trips the check against a 480 seat. So the
  // second call is scheduled for UNDER_SETTLE_MS later and cancelled by the
  // next change: it only ever lands on a layout that has stopped moving.
  useEffect(() => {
    const cards = measuredCards(nodes, expandAll);
    reportOversizeCards(cards);
    const settled = setTimeout(() => reportOversizeCards(cards), UNDER_SETTLE_MS);
    return () => clearTimeout(settled);
  }, [nodes, expandAll]);

  // The rails' live obstacle set: every card's rendered box (zones excluded),
  // recomputed from the node state so a dragged card re-routes its rails.
  const railBoxes = useMemo(
    () =>
      nodes
        .filter((n) => n.type !== "zone")
        .map((n) => ({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          w: (n.measured?.width ?? n.width ?? 200) as number,
          h: (n.measured?.height ?? n.height ?? 100) as number,
        })),
    [nodes],
  );

  // Right-drag pans EVEN WHEN IT STARTS ON A CARD (card 287): React Flow
  // writes `nopan` on draggable nodes and d3-zoom refuses the mousedown, so
  // those pixels are panned here. The pure model (panDrag.ts) owns the rules —
  // including the three ways a drag ends; this effect is only wiring.
  const panRef = useRef<PanDrag>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Measure the pane for the row derivation (card 292). A hidden pane measures
  // 0x0 and must not poison the fallback, so only positive sizes count; the
  // aspect is quantized to 1/100 so resize jitter does not re-lay-out the map.
  // jsdom has no ResizeObserver — then the one direct measurement has to do.
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setPaneAspect(Math.round((r.width / r.height) * 100) / 100);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const down = (e: MouseEvent) => {
      // Only when the press lands on a card — the canvas itself already pans
      // via panOnDrag, and doubling that would fight d3-zoom.
      const target = e.target as Element | null;
      if (target === null || target.closest(".react-flow__node") === null) return;
      panRef.current = panStart(e.button, e.clientX, e.clientY);
    };
    const move = (e: MouseEvent) => {
      const r = panMove(panRef.current, e.buttons, e.clientX, e.clientY);
      panRef.current = r.next;
      if (r.dx !== 0 || r.dy !== 0) {
        const inst = rfRef.current;
        if (inst !== null) {
          const vp = inst.getViewport();
          inst.setViewport({ x: vp.x + r.dx, y: vp.y + r.dy, zoom: vp.zoom });
        }
      }
    };
    const up = () => {
      panRef.current = null;
    };
    el.addEventListener("mousedown", down, true);
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    return () => {
      panRef.current = null; // the third way a drag ends
      el.removeEventListener("mousedown", down, true);
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, []);

  return (
    // Right mouse button pans (context menu suppressed), left only clicks and
    // drags nodes — owner request, same rule as the Graph tab. Since card 287
    // the right-drag works over cards too (the capture listener above).
    <div className="lab-flowmap" ref={wrapRef} onContextMenu={(e) => e.preventDefault()}>
      <RailBoxes.Provider value={railBoxes}>
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
          // 0.1 since card 287: an expanded eight-worker map needs a fit zoom
          // near 0.21 — the old 0.3 floor made fitView clip the grid.
          minZoom={0.1}
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
              // The honest chip (card 292): the live count at the cursor and
              // the run total, loud about a gap past the seating ceiling.
              const drawn = flow.nodes.filter((n) => n.type === "subagent").length;
              const chip = workerChip(pool, drawn, lang);
              return chip === null ? null : (
                <div className={`pf-count-chip${chip.gap ? " pf-count-chip--gap" : ""}`}>{chip.text}</div>
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
      </RailBoxes.Provider>
    </div>
  );
}
