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
import type { Scene } from "./labScene";
import { agentDirectory } from "./agentDirectory";
import {
  UNDER_SETTLE_MS,
  deriveDetail,
  measuredCards,
  reportOversizeCards,
  sceneToFlow,
} from "./flowmap/sceneToFlow";
import { reportRestlessCard, resetStillnessMemory } from "./flowmap/cardStillness";
import { collectDraggedIds, mergeNodePositions } from "./flowmap/positions";
import { foldSeatPool, workerChip, type RowsPref } from "./flowmap/workerGrid";
import { RailBoxes, railBoxesFrom, seatingKey } from "./flowmap/railBoxes";
import { boxSwitchKey, toggleBox } from "./flowmap/workflowBox";
import type { WorkflowDeclaration } from "./workflowGraph";
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
  /** Selected backend — named on the LLM card. Since card 304 it no longer
   *  decides WHERE that card is drawn: the model always sits outside. */
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
  /** CARD 306: what each workflow run declared about itself — the same map
   *  card 302 built for the lens, which never reached the map. Absent (the
   *  live run, an import with no state file) and the map is what it was. */
  declared?: WorkflowDeclaration;
}) {
  const { scene, applied, provider, model, systemPrompt } = props;
  const rowsPref = props.rowsPref ?? "auto";
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
  // CARD 306: the boxes whose own switch the reader has thrown. Per box, which
  // ExpandAllContext cannot be — a session can hold five runs and the owner
  // asked for a switch on the box. A box nobody has touched follows the global
  // switch, so the global one keeps working exactly as it did.
  const [boxExpanded, setBoxExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const onToggleBox = useCallback((boxId: string) => {
    setBoxExpanded((prev) => toggleBox(prev, boxId));
  }, []);
  // Thrown switches are per MAP-WIDE view: flipping the global one re-seats
  // every box from scratch, so a per-box choice made in the other view would
  // otherwise come back on a box that has been re-laid-out around it.
  useEffect(() => {
    setBoxExpanded(new Set());
  }, [expandAll]);
  const boxSwitch = boxSwitchKey(boxExpanded);
  const flow = useMemo(
    () =>
      sceneToFlow(scene, detail, {
        provider: provider ?? "",
        model: model ?? "",
        systemPrompt,
        lang,
        expanded: expandAll,
        pool,
        paneAspect,
        dir,
        rowsPref,
        declared: props.declared,
        boxExpanded,
        onToggleBox,
      }),
    [
      scene,
      detail,
      provider,
      model,
      systemPrompt,
      lang,
      expandAll,
      pool,
      paneAspect,
      dir,
      rowsPref,
      props.declared,
      boxExpanded,
      onToggleBox,
    ],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // Which seating the rendered nodes came from. Compact and expanded are two
  // different seatings, so switching the card view IS a re-layout — without
  // this the cards keep the seats of the view they were rendered in and the map
  // reads as a mix of both. The measured pane aspect is part of the seating
  // since card 292: it drives the expanded row derivation, so a real resize
  // re-places the map the same way. The provider is NOT part of it any more
  // (card 304): one geometry serves every backend, so a backend switch moves
  // nothing and must not throw the reader's pinned cards away.
  const layoutRef = useRef(seatingKey(expandAll, paneAspect, rowsPref, boxSwitch));
  const rfRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  // Nodes the user has dragged. Once pinned, a node keeps its position across
  // every step (even a subagent, which otherwise re-centres) — so dragging a card
  // is never undone by the next step. Cleared when the layout world flips.
  const pinned = useRef(new Set<string>());
  // The nodes the PREVIOUS fold produced — where the layout said each card went
  // last step, which is not the same question as where each card is now.
  const freshRef = useRef<Node[]>([]);

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

  // Sync folded scene -> flow, preserving positions across steps. A card keeps
  // the seat it is ON for as long as the layout keeps computing that same seat
  // for it, so a step never snaps the reader's cards back; when the layout
  // itself moves a card, the card follows. A dragged card overrides that, and a
  // compact/expanded flip re-lays-out everything and drops the pins.
  //
  // CARD 306: `freshRef` is the previous FOLD, and it is what makes "the layout
  // moved this" a question the merge can answer. Without it the rule was "a
  // main card keeps its previous position", and a growing workflow box then
  // pushed the OS band, the boundary and the LLM in the fold while the screen
  // kept all three where they were — the box drawn through them, with a green
  // suite either side of the seam.
  useEffect(() => {
    const seating = seatingKey(expandAll, paneAspect, rowsPref, boxSwitch);
    const relayout = layoutRef.current !== seating;
    layoutRef.current = seating;
    if (relayout) pinned.current.clear();
    // CARD 319: a view flip and a pane resize are BOTH re-layouts, and a card
    // that lands somewhere else because the world it lives in changed shape is
    // not the defect this arm is looking for. Only movement between two steps
    // of the same seating counts.
    if (relayout) resetStillnessMemory();
    setNodes((prev) => mergeNodePositions(prev, flow.nodes, pinned.current, relayout, freshRef.current));
    freshRef.current = flow.nodes;
    setEdges(flow.edges);
  }, [flow, expandAll, paneAspect, rowsPref, boxSwitch, setNodes, setEdges]);

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

  // CARD 319's runtime half, and the same reason as the block above: the
  // measurement can only happen where the pixels are. The card's HEIGHT comes
  // off React Flow's own measurement (world px, the units the envelope table is
  // in) and its TOP is read against this pane, which is the distance the owner
  // actually watches — his card's top took four values and travelled 53.3px
  // while its world y never moved once. A pane that renders no frames measures
  // nothing, so `measured` stays undefined, the height reads 0 and the arm
  // treats it as no reading rather than as a card of no size.
  useEffect(() => {
    const pane = wrapRef.current;
    const card = pane?.querySelector(".react-flow__node-agent");
    if (pane == null || card == null) return;
    reportRestlessCard({
      top: card.getBoundingClientRect().top - pane.getBoundingClientRect().top,
      height: nodes.find((n) => n.id === "agent")?.measured?.height ?? 0,
    });
  }, [nodes]);

  // The rails' live obstacle set: every card's rendered box (zones excluded),
  // recomputed from the node state so a dragged card re-routes its rails.
  // CARD 306: through `railBoxesFrom`, which resolves a child's position to a
  // WORLD one. The expression that stood here read `n.position` directly, and
  // a boxed member's position is measured from its box — the rail would have
  // been routed hundreds of px from the card it is drawn from, silently.
  const railBoxes = useMemo(() => railBoxesFrom(nodes), [nodes]);

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
          key={expandAll ? "expanded" : "compact"}
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
