// The ESB view (0.7 prototype): one bus rail, every fleet node docked onto it
// as a full agent card — the machine-room anatomy (loop, gate, its OWN inline
// OS row) instead of the small SubagentNode. Spawn ancestry orders the row
// (children dock beside their spawner) but draws no tree: hub nodes are peers
// on a bus, and the rail is the one line that carries colour.
//
// Traffic is read from model.frames (the envelopes buildFleet now keeps):
// agent_message task/result marks travel the rail between the two drops.
// The per-card composer is an HONEST mock — the wire has no message verb yet
// (ctl knows stop and gate only); it ships with the server leg of card 166.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { buildFleetLabScene, type FleetLabNode } from "../lab/fleetLabScene";
import { isLocalProvider } from "../lab/labScene";
import { buildFleetGraph, type FleetGraphNode } from "./fleetGraph";
import { NodeComposer } from "./NodeComposer";
import { buildSpectrum, type Lane, type TickKind } from "./spectrumModel";
import type { FleetModel } from "./fleetModel";
import { FleetSpawnForm } from "./FleetSpawn";
import "../styles/bus.css";

// Role -> brand agent-colour var (the cluster tint), FleetCanvas's map.
const CLUSTER_VAR: Record<string, string> = {
  worker: "--agent-worker",
  explore: "--agent-explore",
  root: "--agent-root",
  conductor: "--agent-root",
  panel: "--agent-root",
};
const clusterColor = (role: string): string => `var(${CLUSTER_VAR[role] ?? "--agent-extra"})`;

const TICK_COLOR: Record<TickKind, string> = {
  token: "var(--ev-token)",
  reasoning: "var(--ev-reasoning)",
  tool: "var(--ev-tool)",
  gate: "var(--ev-gate)",
  subagent: "var(--ev-subagent)",
  lifecycle: "var(--ev-lifecycle)",
  error: "var(--error)",
};

const MARK_COLOR: Record<string, string> = {
  task: "var(--ev-tool)",
  result: "var(--ev-token)",
  status: "var(--ev-lifecycle)",
};

/** Bus order: roots in arrival order, spawned nodes docked right after their
 *  spawner (depth-first) — ancestry as adjacency, never as a tree. */
export function busOrder(nodes: FleetGraphNode[]): FleetGraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, FleetGraphNode[]>();
  const roots: FleetGraphNode[] = [];
  for (const n of nodes) {
    if (n.spawnedBy !== null && byId.has(n.spawnedBy)) {
      const list = children.get(n.spawnedBy) ?? [];
      list.push(n);
      children.set(n.spawnedBy, list);
    } else {
      roots.push(n);
    }
  }
  const out: FleetGraphNode[] = [];
  const walk = (n: FleetGraphNode): void => {
    out.push(n);
    for (const c of children.get(n.id) ?? []) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

interface BusMessage {
  from: string;
  to: string;
  role: string;
  seq: number;
}

interface FleetBusProps {
  model: FleetModel;
  events: RunEvent[];
  contextId?: string;
  hubPort?: number | null;
  onStop?: (agentId: string) => void;
  onOpenTrace?: (agentId: string) => void;
  /** The variants wire this to their agent tabs — the card head is the door. */
  onFocusAgent?: (agentId: string) => void;
}

function osChipState(card: FleetLabNode): {
  disk: string | null;
  shell: string | null;
  mcp: string | null;
  llm: string | null;
  llmRemote: boolean;
} {
  return {
    disk: card.disk !== "idle" ? (card.activeFile ?? card.disk) : null,
    shell: card.activeCommand,
    mcp: card.activeMcp,
    llm: card.focus === "llm" ? (card.provider ?? "llm") : null,
    llmRemote: card.focus === "llm" && !isLocalProvider(card.provider),
  };
}

function BusAgentCard({
  lang,
  card,
  graphNode,
  lane,
  epoch,
  onStop,
  onOpenTrace,
  onFocusAgent,
  cardRef,
}: {
  lang: Lang;
  card: FleetLabNode;
  graphNode: FleetGraphNode | undefined;
  lane: Lane | null;
  epoch: number;
  onStop?: (id: string) => void;
  onOpenTrace?: (id: string) => void;
  onFocusAgent?: (id: string) => void;
  cardRef: (el: HTMLDivElement | null) => void;
}) {
  const state = graphNode?.state ?? card.state;
  const live = state === "working" && card.connected;
  const os = osChipState(card);
  const dot =
    state === "failed" ? "error" : state === "working" ? "accent" : state === "completed" ? "ok" : "faint";
  const style = { "--cluster": clusterColor(card.role) } as CSSProperties;
  const gateOn = card.gate === "pending" || (graphNode?.pendingGate ?? false);
  return (
    <div
      ref={cardRef}
      className={`bus-card bus-card--${state}${gateOn ? " bus-card--gate" : ""}`}
      style={style}
    >
      <button
        type="button"
        className="bus-card-head"
        title={onFocusAgent ? t(lang, "bus.openAgent") : undefined}
        onClick={onFocusAgent ? () => onFocusAgent(card.id) : undefined}
      >
        <span className={`dot ${dot}${live ? " pulse" : ""}`} aria-hidden="true" />
        <span className="bus-card-id mono">{card.id}</span>
        <span className="bus-card-role">{card.role}</span>
        {card.provider !== null && <span className="bus-card-provider mono">{card.provider}</span>}
        {epoch > 0 && (
          <span className="bus-card-epoch mono" title={t(lang, "fleet.restarted")}>
            #{epoch}
          </span>
        )}
        {!card.connected && <span className="bus-card-ghost">{t(lang, "fleet.offline")}</span>}
      </button>
      {card.task !== "" && (
        <p className="bus-card-task" title={card.task}>
          {card.task}
        </p>
      )}
      <div className="bus-card-os mono" aria-label={t(lang, "bus.inlineOs")}>
        <span className={`bus-os-chip${os.disk !== null ? " on" : ""}`}>
          disk{os.disk !== null ? ` · ${os.disk}` : ""}
        </span>
        <span className={`bus-os-chip${os.shell !== null ? " on" : ""}`}>
          shell{os.shell !== null ? ` · ${os.shell.slice(0, 18)}` : ""}
        </span>
        <span className={`bus-os-chip${os.mcp !== null ? " on" : ""}`}>
          mcp{os.mcp !== null ? ` · ${os.mcp}` : ""}
        </span>
        <span className={`bus-os-chip${os.llm !== null ? " on" : ""}${os.llmRemote ? " remote" : ""}`}>
          {os.llmRemote ? "☁ " : ""}llm{os.llm !== null ? ` · ${os.llm}` : ""}
        </span>
      </div>
      {gateOn && (
        <div className="bus-card-gaterow mono" role="status">
          {t(lang, "bus.gatePending")}
        </div>
      )}
      <button
        type="button"
        className="bus-card-bandwrap"
        title={onOpenTrace ? t(lang, "bus.openTrace") : undefined}
        onClick={onOpenTrace ? () => onOpenTrace(card.id) : undefined}
      >
        <svg className="bus-card-band" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="7" x2="200" y2="7" className="bus-card-baseline" />
          {(lane?.ticks ?? []).map((tick, i) => (
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
      </button>
      <div className="bus-card-foot mono tabular">
        <span>{graphNode !== undefined ? `${graphNode.inTokens} in · ${graphNode.outTokens} out` : "—"}</span>
        {onStop && card.connected && (
          <button
            type="button"
            className="bus-card-stop"
            title={t(lang, "bus.stopNode")}
            onClick={() => onStop(card.id)}
          >
            ⊗
          </button>
        )}
      </div>
      <NodeComposer nodeId={card.id} card={card} className="bus-card-composer" />
    </div>
  );
}

export function FleetBus({
  model,
  events,
  contextId,
  hubPort,
  onStop,
  onOpenTrace,
  onFocusAgent,
}: FleetBusProps) {
  const lang = useLang();
  const scene = useMemo(() => buildFleetLabScene(model), [model]);
  const graph = useMemo(() => buildFleetGraph(model), [model]);
  const spectrum = useMemo(() => buildSpectrum(events), [events]);
  const laneById = useMemo(() => new Map(spectrum.lanes.map((l) => [l.id, l])), [spectrum]);
  const ordered = useMemo(() => busOrder(graph.nodes), [graph]);
  const cardById = useMemo(() => new Map(scene.nodes.map((n) => [n.id, n])), [scene]);
  const graphById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // The last agent_message envelopes — the traffic the rail shows.
  const traffic = useMemo<BusMessage[]>(() => {
    const out: BusMessage[] = [];
    for (let i = 0; i < model.frames.length; i++) {
      const p = model.frames[i].payload;
      if (p.type === "agent_message") {
        out.push({ from: p.from, to: p.to, role: p.role, seq: i });
      }
    }
    return out.slice(-24);
  }, [model.frames]);

  // Measure card centers so drops, marks and the flight animation share one x-space.
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardEls = useRef(new Map<string, HTMLDivElement>());
  const [xById, setXById] = useState<Map<string, number>>(new Map());
  const [railWidth, setRailWidth] = useState(0);
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (host === null) return;
    const hostRect = host.getBoundingClientRect();
    const next = new Map<string, number>();
    for (const [id, el] of cardEls.current) {
      const r = el.getBoundingClientRect();
      next.set(id, r.left - hostRect.left + host.scrollLeft + r.width / 2);
    }
    setXById(next);
    setRailWidth(Math.max(host.scrollWidth, hostRect.width));
  }, [ordered.length, scene.nodes.length]);

  const latest = traffic.length > 0 ? traffic[traffic.length - 1] : null;
  const [spawnOpen, setSpawnOpen] = useState(false);
  const spawnSlot =
    contextId !== undefined ? (
      spawnOpen ? (
        <FleetSpawnForm contextId={contextId} hubPort={hubPort ?? null} onClose={() => setSpawnOpen(false)} />
      ) : (
        <button type="button" className="bus-spawn-toggle mono" onClick={() => setSpawnOpen(true)}>
          {t(lang, "bus.spawnNode")}
        </button>
      )
    ) : null;

  // No early return for an empty fleet. The rail IS the thing the reader came
  // to see — "ich will den Bus vielleicht schon sehen" — and replacing it with
  // a sentence meant the one surface that explains this app only appeared once
  // it no longer needed explaining. Nothing below requires a node: railWidth
  // measures the scroller on mount, and both maps yield nothing on an empty
  // list, so the rail draws and the sentence sits on it beside the dock button.

  return (
    <div className="bus-canvas">
      <div className="bus-scroll" ref={scrollRef}>
        <div className={`bus-cards${ordered.length === 0 ? " bus-cards--empty" : ""}`}>
          {ordered.length === 0 && <p className="bus-empty">{t(lang, "bus.empty")}</p>}
          {ordered.map((n) => {
            const card = cardById.get(n.id);
            if (card === undefined) return null;
            return (
              <div key={n.id} className={n.spawnedBy !== null ? "bus-slot bus-slot--child" : "bus-slot"}>
                {n.spawnedBy !== null && (
                  <span className="bus-slot-parent mono" title={t(lang, "bus.spawnedBy")}>
                    ⌐ {n.spawnedBy}
                  </span>
                )}
                <BusAgentCard
                  lang={lang}
                  card={card}
                  graphNode={graphById.get(n.id)}
                  lane={laneById.get(n.id) ?? null}
                  epoch={model.epochBySender[n.id] ?? 0}
                  onStop={onStop}
                  onOpenTrace={onOpenTrace}
                  onFocusAgent={onFocusAgent}
                  cardRef={(el) => {
                    if (el === null) cardEls.current.delete(n.id);
                    else cardEls.current.set(n.id, el);
                  }}
                />
              </div>
            );
          })}
          {spawnSlot !== null && <div className="bus-slot bus-slot--spawn">{spawnSlot}</div>}
        </div>
        <svg className="bus-rail" width={railWidth} height="56" aria-hidden="true">
          <defs>
            <linearGradient id="bus-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--ev-reasoning)" />
              <stop offset="30%" stopColor="var(--ev-subagent)" />
              <stop offset="60%" stopColor="var(--ev-token)" />
              <stop offset="100%" stopColor="var(--ev-tool)" />
            </linearGradient>
          </defs>
          {ordered.map((n) => {
            const x = xById.get(n.id);
            if (x === undefined) return null;
            return <line key={n.id} className="bus-rail-drop" x1={x} y1={0} x2={x} y2={26} />;
          })}
          <rect
            className="bus-rail-line"
            x="0"
            y="26"
            width={railWidth}
            height="2.5"
            rx="1.25"
            fill="url(#bus-line)"
          />
          {traffic.map((m) => {
            const x1 = xById.get(m.from);
            const x2 = xById.get(m.to);
            if (x1 === undefined || x2 === undefined) return null;
            const isLatest = latest !== null && m.seq === latest.seq;
            const color = MARK_COLOR[m.role] ?? "var(--ev-lifecycle)";
            if (isLatest) {
              return (
                <circle key={m.seq} className="bus-mark bus-mark--flight" r="3.4" cy="27" fill={color}>
                  <animate attributeName="cx" from={x1} to={x2} dur="1.6s" repeatCount="indefinite" />
                </circle>
              );
            }
            const mid = (x1 + x2) / 2;
            const dir = x2 >= x1 ? "→" : "←";
            return (
              <g key={m.seq} className="bus-mark">
                <circle cx={mid} cy="27" r="2.2" fill={color} opacity="0.8" />
                <text x={mid} y="42" textAnchor="middle" className="bus-mark-dir mono" fill={color}>
                  {dir}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
