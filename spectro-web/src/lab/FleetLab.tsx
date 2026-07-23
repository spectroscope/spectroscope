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
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { nodeTypes } from "./flowmap/nodes";
import { edgeTypes } from "./flowmap/PacketEdge";
import "@xyflow/react/dist/style.css";
import "./flowmap/flowmap.css";

const MINIMAP_COLOR: Record<string, string> = {
  subagent: "var(--agent-worker)",
  llm: "var(--sand)",
  user: "var(--text-dim)",
  os: "var(--border-strong)",
  ext: "var(--border-strong)",
};

/** Auto-play pace — one event per tick; snappy but followable. */
const PLAY_INTERVAL_MS = 110;

/** True while the user is typing, so transport keys never eat keystrokes. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function FleetLab(props: { model: FleetModel; running: boolean }) {
  const { model, running } = props;
  const lang = useLang();
  const de = lang === "de";
  const total = model.events.length;

  // cursor === null → follow the live edge (every new event applies at once).
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
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
    }, PLAY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [playing, total]);

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
    () => buildFleetLabScene({ roster: model.roster, events: visible, epochBySender: model.epochBySender }),
    [model.roster, visible, model.epochBySender],
  );
  const detail = useMemo(() => deriveDetail(visible), [visible]);
  const flow = useMemo(() => fleetToFlow(scene, detail, { lang }), [scene, detail, lang]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const cardCountRef = useRef(scene.nodes.length);

  // Sync fold → flow, keeping drag positions unless the card grid changed
  // (a joined/left node recomputes the whole frame) — the FlowMap pattern.
  useEffect(() => {
    const relayout = cardCountRef.current !== scene.nodes.length;
    cardCountRef.current = scene.nodes.length;
    setNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      return flow.nodes.map((node) => {
        const old = byId.get(node.id);
        return old && !relayout ? { ...node, position: old.position } : node;
      });
    });
    setEdges(flow.edges);
  }, [flow, scene.nodes.length, setNodes, setEdges]);

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
        <span className="lab-now-label mono">{nowText}</span>
        {following && running && <span className="lab-now-queue mono">{t(lang, "fleetlab.live")}</span>}
        {!following && (
          <span className="lab-now-queue mono tabular">
            {t(lang, "fleetlab.behind", { n: total - clamped })}
          </span>
        )}
      </div>

      <div className="lab-flowmap" onContextMenu={(e) => e.preventDefault()}>
        <ReactFlow
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
      </div>
    </section>
  );
}
