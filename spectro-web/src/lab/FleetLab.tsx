// The fleet machine room (card 59): the lab-style view of an ENTERED FLEET.
// Every node is its own agent-loop card on ONE shared machine — the OS band,
// the gate states, the LLM stations (remote beyond the boundary, local inside
// when a node runs ollama) — with packets riding the rails exactly like the
// single-run map. Driven by the same FleetModel the canvas and lanes fold.
//
// The transport is SELF-CONTAINED (deliberately not the single-run stepper
// store): the scene fold is pure and deterministic over any events prefix, so
// a cursor + two memos give scrubbing, play, and live-follow for free — for a
// live fleet and a loaded scenario alike.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { FleetModel } from "../spectrum/fleetModel";
import { buildFleetLabScene } from "./fleetLabScene";
import { fleetToFlow } from "./flowmap/fleetToFlow";
import { activity, deriveDetail } from "./flowmap/sceneToFlow";
import { ExpandAllContext } from "./flowmap/expandContext";
import { DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS } from "../state/stepper";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { nodeTypes } from "./flowmap/nodes";
import { edgeTypes } from "./flowmap/PacketEdge";
import "@xyflow/react/dist/style.css";
import "./flowmap/flowmap.css";
import { beacon } from "../state/levelingBeacon";
/** Same stored preference as the single-run Lab — ONE card-view choice. */
const VIEW_STORAGE_KEY = "spectroscope.lab.view";
function storedExpanded(): boolean {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === "expanded";
  } catch {
    return false;
  }
}
const MINIMAP_COLOR: Record<string, string> = {
  subagent: "var(--agent-worker)",
  llm: "var(--sand)",
  user: "var(--text-dim)",
  os: "var(--border-strong)",
  ext: "var(--border-strong)",
};
/** The tempo slider snaps in steps of this many milliseconds. */
const TEMPO_SLIDER_STEP_MS = 20;
/** True while the user is typing, so transport keys never eat keystrokes. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
export function FleetLab(props: { model: FleetModel; running: boolean }) {
  // Seeing the machine room IS the criterion; it has no other observable act.
  useEffect(() => beacon("machine-room"), []);
  const { model, running } = props;
  const lang = useLang();
  const de = lang === "de";
  const total = model.events.length;
  // cursor === null → follow the live edge (every new event applies at once).
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  // The card-view choice (shared with the single-run Lab) + the replay tempo
  // (same owner-tuned default and range as the stepper — 110ms/event was a
  // blur, owner report).
  const [expanded, setExpanded] = useState<boolean>(storedExpanded);
  const [intervalMs, setIntervalMs] = useState(DEFAULT_INTERVAL_MS);
  const pickView = (next: boolean): void => {
    setExpanded(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next ? "expanded" : "compact");
    } catch {
      // private mode: the toggle simply does not stick
    }
  };
  const at = cursor ?? total;
  const clamped = Math.max(0, Math.min(at, total));
  // Auto-play: advance one event per tick until the end, then resume following.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setCursor((prev) => {
        const cur = prev ?? total;
        if (cur >= total) {
          setPlaying(false);
          return null; // reached the edge — follow live again
        }
        return cur + 1;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [playing, total, intervalMs]);
  // Keyboard: ←/→ scrub one event, space toggles play. Tab-gated by this mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (e.key === " " && (el?.tagName === "BUTTON" || el?.tagName === "A")) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setCursor((prev) => Math.min((prev ?? total) + 1, total));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setCursor((prev) => Math.max((prev ?? total) - 1, 0));
      } else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);
  const visible = useMemo(() => model.events.slice(0, clamped), [model.events, clamped]);
  const scene = useMemo(
    () =>
      buildFleetLabScene({
        roster: model.roster,
        events: visible,
        frames: model.frames.slice(0, clamped),
        epochBySender: model.epochBySender,
      }),
    [model.roster, visible, model.frames, clamped, model.epochBySender],
  );
  const detail = useMemo(() => deriveDetail(visible), [visible]);
  const flow = useMemo(() => fleetToFlow(scene, detail, { lang, expanded }), [scene, detail, lang, expanded]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // The card count AND the card view: both decide the seats, so both have to
  // drop stale positions (compact and expanded are two different frames).
  const seatingRef = useRef(`${scene.nodes.length}:${expanded}`);
  // Sync fold → flow, keeping drag positions unless the card grid changed
  // (a joined/left node recomputes the whole frame) — the FlowMap pattern.
  useEffect(() => {
    const seating = `${scene.nodes.length}:${expanded}`;
    const relayout = seatingRef.current !== seating;
    seatingRef.current = seating;
    setNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      return flow.nodes.map((node) => {
        const old = byId.get(node.id);
        return old && !relayout ? { ...node, position: old.position } : node;
      });
    });
    setEdges(flow.edges);
  }, [flow, scene.nodes.length, expanded, setNodes, setEdges]);
  // The "now" line: the active node and what it is doing right now.
  const active = scene.activeNode !== null ? scene.nodes.find((n) => n.id === scene.activeNode) : undefined;
  const nowText =
    active !== undefined
      ? `${active.id} · ${activity(active.focus, active.disk, active.activeFile, active.activeCommand, active.activeMcp, active.gate, lang).text}`
      : de
        ? "bereit"
        : "ready";
  const following = cursor === null;
  return (
    <section className="lab-center" aria-label={t(lang, "fleetlab.aria")}>
      <div className="lab-now" aria-live="polite">
        <span className="lab-now-tag">{de ? "gerade" : "now"}</span>
        <span className="lab-now-dot" aria-hidden="true" />
        {/* CARD 319, the same group as the lab's own band: the two chips come
            and go while the reader scrubs, and as direct children of `.lab-now`
            their arrival re-decided how many lines it takes. */}
        <div className="lab-now-say">
          <span className="lab-now-label mono" title={nowText}>
            {nowText}
          </span>
          {following && running && <span className="lab-now-queue mono">{t(lang, "fleetlab.live")}</span>}
          {!following && (
            <span className="lab-now-queue mono tabular">
              {t(lang, "fleetlab.behind", { n: total - clamped })}
            </span>
          )}
        </div>
        <div className="lab-seg lab-view-seg" role="group" aria-label={t(lang, "lab.viewAria")}>
          <button
            type="button"
            className={!expanded ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
            aria-pressed={!expanded}
            title={t(lang, "lab.viewCompactTitle")}
            onClick={() => pickView(false)}
          >
            {t(lang, "lab.viewCompact")}
          </button>
          <button
            type="button"
            className={expanded ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
            aria-pressed={expanded}
            title={t(lang, "lab.viewExpandedTitle")}
            onClick={() => pickView(true)}
          >
            {t(lang, "lab.viewExpanded")}
          </button>
        </div>
      </div>
      <div className="lab-flowmap" onContextMenu={(e) => e.preventDefault()}>
        <ExpandAllContext.Provider value={expanded}>
          <ReactFlow
            // A card's disclosures seed their state at mount, so the flip has to
            // remount the canvas — the FlowMap rule, same reason.
            key={expanded ? "expanded" : "compact"}
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
            fitViewOptions={{ padding: 0.14 }}
            minZoom={0.25}
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
              </div>
            </Panel>
          </ReactFlow>
        </ExpandAllContext.Provider>
      </div>
      <div className="lab-transport">
        <div className="lab-ctrl-btns">
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              setCursor(0);
            }}
            disabled={clamped === 0}
            title={t(lang, "lab.reset")}
            aria-label={t(lang, "lab.reset")}
          >
            ⟲
          </button>
          <button
            type="button"
            onClick={() => setCursor(Math.max(clamped - 1, 0))}
            disabled={playing || clamped === 0}
            title={t(lang, "lab.stepBackTitle")}
            aria-label="Step back"
          >
            ‹
          </button>
          <button
            type="button"
            className="play"
            onClick={() => {
              if (playing) {
                setPlaying(false);
              } else {
                if (clamped >= total) setCursor(0); // play from the start at the edge
                setPlaying(true);
              }
            }}
            disabled={total === 0}
            title={playing ? "pause" : de ? "abspielen" : "play"}
            aria-label={playing ? "pause" : "play"}
          >
            {playing ? "❚❚" : "▸"}
          </button>
          <button
            type="button"
            onClick={() => setCursor(clamped + 1 >= total ? null : clamped + 1)}
            disabled={playing || clamped >= total}
            title={t(lang, "lab.stepTitle")}
            aria-label="Step forward"
          >
            ›
          </button>
        </div>
        <div className="lab-scrub">
          <input
            type="range"
            min={0}
            max={Math.max(total, 1)}
            step={1}
            value={clamped}
            disabled={total === 0}
            aria-label={de ? "replay-position" : "replay position"}
            onChange={(e) => {
              setPlaying(false);
              const next = Number(e.target.value);
              setCursor(next >= total ? null : next);
            }}
          />
          <span className="lab-counter mono tabular">
            {clamped + " / " + total + (following ? " · " + t(lang, "fleetlab.live") : "")}
          </span>
        </div>
        <details className="lab-advanced">
          <summary title={de ? "tempo" : "tempo"}>{de ? "mehr" : "more"}</summary>
          <div className="lab-advanced-body">
            <label className="lab-speed" title={t(lang, "lab.tempoTitle")}>
              <span className="lab-speed-label">{t(lang, "lab.tempo")}</span>
              <input
                type="range"
                min={MIN_INTERVAL_MS}
                max={MAX_INTERVAL_MS}
                step={TEMPO_SLIDER_STEP_MS}
                value={MIN_INTERVAL_MS + MAX_INTERVAL_MS - intervalMs}
                onChange={(e) => setIntervalMs(MIN_INTERVAL_MS + MAX_INTERVAL_MS - Number(e.target.value))}
                aria-label={t(lang, "lab.tempoTitle")}
              />
              <span className="lab-speed-rate mono tabular">{(1000 / intervalMs).toFixed(1)}×/s</span>
            </label>
          </div>
        </details>
      </div>
    </section>
  );
}
