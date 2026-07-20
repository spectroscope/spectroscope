// The prototype orchestrator. It folds the demo events through the REAL
// labScene reducer (advanceScene) exactly like the app does, maps the resulting
// Scene to React Flow nodes/edges (sceneToFlow), and renders a free canvas with a
// timeline, a live local/remote provider flip, and a genome switcher. Dragging is
// preserved while stepping; flipping the provider re-lays-out the whole map.

import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Panel, useEdgesState, useNodesState, type Edge, type Node } from "@xyflow/react";
import { advanceScene, initialScene } from "../lab/labScene";
import { DEMO_SYSTEM_PROMPT, SCENARIOS, eventLabel } from "./demoScript";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./PacketEdge";

const PROVIDERS = [
  { id: "anthropic", model: "claude-opus-4-8", name: "Claude · remote" },
  { id: "ollama", model: "qwen3", name: "Ollama · local" },
  { id: "openai", model: "gpt-4o", name: "OpenAI · remote" },
];
const GENOMES = [
  { id: "spectroscope", name: "spectro dark" },
  { id: "paper", name: "spectro bright" },
  { id: "still", name: "spectro white" },
];

const MINIMAP_COLOR: Record<string, string> = {
  agent: "var(--accent)", subagent: "var(--agent-worker)", llm: "var(--sand)",
  user: "var(--text-dim)", os: "var(--border-strong)", ext: "var(--border-strong)",
};

export function SystemFlow() {
  const [n, setN] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(950);
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("claude-opus-4-8");
  const [design, setDesign] = useState("spectroscope");
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);

  const local = provider === "ollama";
  const events = useMemo(() => SCENARIOS.find((s) => s.id === scenarioId)?.events ?? SCENARIOS[0].events, [scenarioId]);
  const TOTAL = events.length;

  const scene = useMemo(() => events.slice(0, n).reduce(advanceScene, initialScene()), [events, n]);
  const detail = useMemo(() => deriveDetail(events.slice(0, n)), [events, n]);
  const flow = useMemo(() => sceneToFlow(scene, detail, { local, provider, model, systemPrompt: DEMO_SYSTEM_PROMPT }), [scene, detail, local, provider, model]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const layoutRef = useRef(local);

  // Sync folded scene -> flow, preserving drag positions unless the layout flipped.
  useEffect(() => {
    const relayout = layoutRef.current !== local;
    layoutRef.current = local;
    setNodes((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]));
      return flow.nodes.map((node) => {
        const old = byId.get(node.id);
        // Subagent nodes always take their freshly computed (deterministic)
        // position, so adding a second or third agent re-centers the whole group
        // instead of stranding earlier cards at their old spots (the clump bug).
        const keep = old && !relayout && !node.id.startsWith("sub-");
        return keep ? { ...node, position: old.position } : node;
      });
    });
    setEdges(flow.edges);
  }, [flow, local, setNodes, setEdges]);

  // Auto-play: advance one event per `speed` ms.
  useEffect(() => {
    if (!playing) return;
    if (n >= TOTAL) { setPlaying(false); return; }
    const t = setTimeout(() => setN((x) => Math.min(TOTAL, x + 1)), speed);
    return () => clearTimeout(t);
  }, [playing, n, speed]);

  // Genome switch — flip the one attribute; every token-based node reskins.
  useEffect(() => {
    document.documentElement.dataset.design = design;
  }, [design]);

  // Switching scenario restarts the timeline.
  useEffect(() => { setN(0); setPlaying(false); }, [scenarioId]);

  const atEnd = n >= TOTAL;
  const current = n > 0 ? events[n - 1] : null;

  const togglePlay = () => {
    if (!playing && atEnd) setN(0);
    setPlaying((p) => !p);
  };
  const pickProvider = (id: string) => {
    setProvider(id);
    setModel(PROVIDERS.find((p) => p.id === id)?.model ?? "");
  };

  return (
    <div className="pf-root">
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

        {/* ---- brand ---- */}
        <Panel position="top-left">
          <div className="pf-panel-tl">
            <div className="pf-brand">
              <span className="pf-brand__mark"><span /></span>
              <div>
                <div className="pf-brand__title">spectroscope · System-Map</div>
                <div className="pf-brand__sub">React Flow prototype</div>
              </div>
            </div>
          </div>
        </Panel>

        {/* ---- controls ---- */}
        <Panel position="top-right">
          <div className="pf-bar">
            <div className="pf-bar__label">Timeline</div>
            <div className="pf-bar__group">
              <button className="pf-btn" onClick={() => setN(0)} disabled={n === 0} title="Reset">⏮</button>
              <button className="pf-btn" onClick={() => { setPlaying(false); setN((x) => Math.max(0, x - 1)); }} disabled={n === 0} title="Step back">◀</button>
              <button className="pf-btn pf-btn--primary" onClick={togglePlay} title={playing ? "Pause" : "Play"}>{playing ? "⏸" : atEnd ? "↻" : "▶"}</button>
              <button className="pf-btn" onClick={() => { setPlaying(false); setN((x) => Math.min(TOTAL, x + 1)); }} disabled={atEnd} title="Step forward">▶▏</button>
            </div>
            <div className="pf-progress">
              <div className="pf-progress__track"><div className="pf-progress__fill" style={{ width: `${(n / TOTAL) * 100}%` }} /></div>
              <div className="pf-progress__meta">
                <span>{n} / {TOTAL}</span>
                <span className="pf-progress__ev">{current ? eventLabel(current) : "idle"}</span>
              </div>
            </div>

            <div className="pf-bar__group">
              <span className="pf-bar__label" style={{ margin: 0 }}>Scenario</span>
              <select className="pf-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} style={{ flex: 1 }}>
                {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>

            <div className="pf-bar__group" style={{ justifyContent: "space-between" }}>
              <span className="pf-bar__label" style={{ margin: 0 }}>Speed</span>
              <input className="pf-range" type="range" min={250} max={1600} step={50} value={1850 - speed} onChange={(e) => setSpeed(1850 - Number(e.target.value))} />
            </div>

            <div className="pf-bar__group">
              <select className="pf-select" value={provider} onChange={(e) => pickProvider(e.target.value)} style={{ flex: 1 }}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="pf-bar__group">
              <span className="pf-bar__label" style={{ margin: 0 }}>Skin</span>
              <select className="pf-select" value={design} onChange={(e) => setDesign(e.target.value)} style={{ flex: 1 }}>
                {GENOMES.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>
        </Panel>

        {/* ---- legend ---- */}
        <Panel position="bottom-left">
          <div className="pf-legend">
            <span><i className="on" />active rail (where it happens)</span>
            <span><i />in the agent system</span>
            <span><i className="net" />to the outside (net)</span>
            <span><b style={{ background: "var(--ok)" }} />read</span>
            <span><b style={{ background: "var(--accent)" }} />write · live packet</span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
