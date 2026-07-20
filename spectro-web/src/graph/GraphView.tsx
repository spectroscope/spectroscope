// Rendering layer: maps the buildGraph output onto React Flow. Live and
// replay share buildGraph — the app hands this component the SAME raw event
// array it already holds, so there is no second fetch path.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, Position, ReactFlow } from "@xyflow/react";
import type { Edge as FlowEdge, Node as FlowNode, NodeProps } from "@xyflow/react";
import * as dagre from "dagre"; // namespace import: @types/dagre has NO default export
import "@xyflow/react/dist/style.css";
import type { RunEvent } from "../events";
import { formatRelMs, formatTokens } from "../format";
import { CopyButton } from "../components/CopyButton";
import { JsonTree } from "../components/JsonTree";
import { buildGraph, laneShifts, type GraphNode } from "./buildGraph";
import { FlowOverview } from "./FlowOverview";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";

// Which of the two renderings the tab shows: the BPMN-like flow (spine +
// parallel branch columns) or the React Flow DAG. Sticky across sessions.
type GraphViewMode = "flow" | "graph";
const VIEW_KEY = "spectroscope.graphView";
function initialView(): GraphViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "flow";
  } catch {
    return "flow";
  }
}

const NODE_W = 220;
// Fixed node box (dagre needs it up front; the CSS height must match). 106px
// is the honest content height: eyebrow + label + preview + footer at their
// natural line heights — 96px used to flex-squeeze the rows and overflow:
// hidden then clipped the label's descenders ("use_skill" lost its tail).
const NODE_H = 106;

// Time-lapse pacing: real event gaps replay accelerated, but never slower
// than one step per second. The dagre re-layout is throttled separately.
const TIME_LAPSE_SPEEDUP = 20;
const TIME_LAPSE_MAX_STEP_MS = 1000;
const LAYOUT_THROTTLE_MS = 300;

// Top-down auto-layout with dagre. Pure function: same input, same positions.
// After dagre, the lane pass shifts sequentially spawned subagent subtrees
// sideways so 2 subagents read as 2 parallel lanes (and 3 as 3).
export function layoutGraph(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 56 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const laid = nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
  const gn = (n: FlowNode): GraphNode => (n.data as { graphNode: GraphNode }).graphNode;
  const shifts = laneShifts(
    laid.map((n) => ({ agentId: gn(n).agentId, kind: gn(n).kind, x: n.position.x })),
    NODE_W,
  );
  if (shifts.size === 0) return laid;
  return laid.map((n) => {
    const dx = shifts.get(gn(n).agentId) ?? 0;
    return dx === 0 ? n : { ...n, position: { x: n.position.x + dx, y: n.position.y } };
  });
}

const kindLabel = (kind: GraphNode["kind"], lang: Lang): string => t(lang, `gk.${kind}`);

function SpectroNode({ data }: NodeProps) {
  const node = (data as { graphNode: GraphNode }).graphNode;
  const lang = useLang();
  const classes = ["graph-node", `graph-node--${node.kind}`,
    node.running ? "graph-node--running" : "",
    node.status === "error" ? "graph-node--error" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <Handle type="target" position={Position.Top} />
      <span className="graph-node__eyebrow">{kindLabel(node.kind, lang)}</span>
      <span className="graph-node__label">{node.label}</span>
      {/* Second line: what the node did — one truncated line, height stays fixed. */}
      <span className="graph-node__preview">{node.preview || "\u00a0"}</span>
      <span className="graph-node__foot">
        <span className="graph-node__rel tabular">{formatRelMs(node.relMs)}</span>
        {node.kind === "tool" && node.durationMs !== undefined &&
          <span className="graph-node__badge tabular">{node.durationMs} ms</span>}
        {node.kind === "turn" && node.tokens !== undefined &&
          <span className="graph-node__badge tabular">
            {formatTokens(node.tokens.input)} in &middot; {formatTokens(node.tokens.output)} out
          </span>}
        {node.status === "error" && <span className="graph-node__badge graph-node__badge--error">{t(lang, "chat.error")}</span>}
      </span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { spectroscope: SpectroNode };

/** The event that created the node is expanded by default in the detail
 *  panel; an answer node is created by its run_end, which sits last. */
function primaryEventIndex(node: GraphNode): number {
  return node.kind === "answer" ? node.events.length - 1 : 0;
}

export interface GraphViewProps {
  /** Raw events of the shown session — live accumulation or a fetched archive. */
  events: RunEvent[];
  /** Archives get the replay bar (time-lapse, scrubber); live renders as it grows. */
  isReplay: boolean;
}

export function GraphView({ events, isReplay }: GraphViewProps) {
  const lang = useLang();
  const [view, setView] = useState<GraphViewMode>(initialView);
  const switchView = (v: GraphViewMode) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  };

  // Replay cursor: how many events are visible. Live mode always shows all.
  const [cursor, setCursor] = useState(events.length);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setCursor(events.length); // a newly opened archive starts fully drawn
    setPlaying(false);
  }, [events, isReplay]);

  // Time-lapse: advance along the ts gaps, accelerated and capped.
  useEffect(() => {
    if (!playing || !isReplay) return;
    if (cursor >= events.length) { setPlaying(false); return; }
    const gap = cursor === 0 ? 0
      : Math.max(0, events[cursor].ts - events[cursor - 1].ts);
    const timer = setTimeout(() => setCursor((c) => c + 1),
      Math.min(gap / TIME_LAPSE_SPEEDUP, TIME_LAPSE_MAX_STEP_MS));
    return () => clearTimeout(timer);
  }, [playing, cursor, events, isReplay]);

  // One code path for both modes: buildGraph just gets a different slice.
  // Memoized so the array identity stays stable across renders — a fresh
  // events.slice() every render made `graph` re-memoize each render, which
  // re-fired the layout effect below in an endless setState loop ("Maximum
  // update depth exceeded") whenever an archive (isReplay) was open.
  const shownEvents = useMemo(
    () => (isReplay ? events.slice(0, cursor) : events),
    [isReplay, events, cursor],
  );
  const graph = useMemo(() => buildGraph(shownEvents), [shownEvents]);
  const flowEdges: FlowEdge[] = useMemo(
    () => graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    [graph.edges],
  );

  // Update node contents immediately, pull the layout along throttled (at most every 300 ms).
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const lastLayout = useRef(0);
  useEffect(() => {
    const immediate: FlowNode[] = graph.nodes.map((n) => ({ id: n.id, type: "spectroscope",
      position: positions.current.get(n.id) ?? { x: 0, y: 0 }, data: { graphNode: n } }));
    setFlowNodes(immediate); // pulse/status/text immediately, keep the old positions
    const wait = Math.max(0, LAYOUT_THROTTLE_MS - (Date.now() - lastLayout.current));
    const timer = setTimeout(() => {
      lastLayout.current = Date.now();
      const laidOut = layoutGraph(immediate, flowEdges);
      for (const n of laidOut) positions.current.set(n.id, n.position);
      setFlowNodes(laidOut);
    }, wait);
    return () => clearTimeout(timer);
  }, [graph, flowEdges]);

  // Detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const onNodeClick = useCallback((_: unknown, node: FlowNode) => setSelectedId(node.id), []);

  return (
    <div className="graph-view">
      <div className="graph-viewbar">
        <div className="lab-grain" role="radiogroup" aria-label="Graph view">
          {([["flow", "Flow"], ["graph", "Graph"]] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              className={`lab-grain-opt${view === v ? " lab-grain-opt--on" : ""}`}
              onClick={() => switchView(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {isReplay && (
        <div className="graph-replay-bar">
          <button type="button" onClick={() => { setPlaying(false); setCursor(events.length); }}>{t(lang, "gv.full")}</button>
          <button type="button" onClick={() => { if (cursor >= events.length) setCursor(0); setPlaying(true); }}>{t(lang, "gv.lapse")}</button>
          <button type="button" onClick={() => setPlaying(false)}>{t(lang, "gv.pause")}</button>
          <input type="range" min={0} max={events.length} value={cursor}
            onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} />
          <span className="tabular">{t(lang, "gv.events", { n: cursor, total: events.length })}</span>
        </div>
      )}
      {view === "flow" ? (
        <div className="graph-body">
          <FlowOverview
            events={events}
            n={isReplay ? cursor : events.length}
            onSeek={isReplay
              ? (to) => { setPlaying(false); setCursor(Math.min(to, events.length)); }
              : undefined}
          />
        </div>
      ) : (
      <div className="graph-body">
        {/* Right mouse button pans the canvas (context menu suppressed), the
            left button only clicks/selects — owner request. */}
        <div className="graph-canvas" onContextMenu={(e) => e.preventDefault()}>
          <ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes}
            onNodeClick={onNodeClick} fitView proOptions={{ hideAttribution: true }}
            panOnDrag={[1, 2]}>
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {selected && <GraphDetail node={selected} onClose={() => setSelectedId(null)} />}
      </div>
      )}
    </div>
  );
}

/** The inspector panel for a selected node: timing line, the node's raw
 *  event evidence (each a collapsible JSON root — the defining one starts
 *  open), and the dropped-events note. Purely presentational. */
function GraphDetail({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  const lang = useLang();
  return (
    <aside className="graph-detail">
      <div className="graph-detail__head">
        <div>
          <span className="graph-node__eyebrow">{kindLabel(node.kind, lang)}</span>
          <h3>{node.label}</h3>
        </div>
        <button type="button" onClick={onClose}>{t(lang, "common.close")}</button>
      </div>

      {/* Timing block: when it started on the run's clock, how long it
          took (tools/turns) or what it cost (turns/subagents/answers). */}
      <p className="graph-detail__timing tabular">
        {t(lang, "gv.started", { t: formatRelMs(node.relMs) })}
        {node.durationMs !== undefined && <> &middot; {node.durationMs} ms</>}
        {node.tokens !== undefined &&
          <> &middot; {formatTokens(node.tokens.input)} in / {formatTokens(node.tokens.output)} out</>}
        {node.kind === "answer" && node.detail.inputTokens !== undefined &&
          <> &middot; {formatTokens(node.detail.inputTokens)} in / {formatTokens(node.detail.outputTokens ?? 0)} out</>}
        {node.status !== undefined && <> &middot; {node.status}</>}
        {node.detail.stopReason !== undefined && <> &middot; {node.detail.stopReason}</>}
      </p>

      <div className="graph-detail__events">
        <div className="graph-detail__events-head">
          <h4>Events &middot; {node.events.length}</h4>
          <CopyButton
            text={() => JSON.stringify(node.events, null, 2)}
            label={t(lang, "common.copyAll")}
          />
        </div>
        {node.events.map((e, i) => (
          <div className="graph-detail__event" key={`${node.id}:${i}`}>
            <JsonTree
              value={e}
              rootLabel={e.type}
              defaultDepth={i === primaryEventIndex(node) ? 2 : 0}
            />
          </div>
        ))}
        {node.droppedEvents !== undefined && node.droppedEvents > 0 && (
          <p className="graph-detail__note">
            {t(lang, "gv.omitted", { n: node.droppedEvents })}
          </p>
        )}
      </div>
    </aside>
  );
}
