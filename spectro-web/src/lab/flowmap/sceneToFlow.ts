// The pure mapping layer: a folded Scene (from the REAL labScene reducer) plus a
// little derived Detail (context/tool-input/streamed text, for the expandable
// sections) become React Flow nodes + edges. This is the direct analogue of the
// existing graph/buildGraph.ts — no React, no @xyflow here; SystemFlow.tsx just
// renders whatever this returns. Positions are hand-authored per layout so the
// local/remote flip literally re-places the LLM inside vs. outside "Dein Mac".

import type { Edge, Node } from "@xyflow/react";
import type { DiskState, Focus, GateState, Loop, Scene, SubagentInfo } from "../labScene";
import type { RunEvent } from "../../events";
import { t, type Lang } from "../../i18n/i18n";

// ---------------------------------------------------------------------------
// Derived detail — the raw bits the scene model deliberately doesn't carry.
// ---------------------------------------------------------------------------
export interface CtxPart { label: string; chars: number; estTokens: number; }

/** One agent's slice of the shared LLM's reasoning/answer stream. */
export interface AgentStream { agent: string; text: string; }
export interface Detail {
  prompt: string;
  ctxParts: CtxPart[] | null;
  ctxTotals: { messages: number; estimatedTokens: number; threshold: number } | null;
  /** in-flight tool per agent (set on tool_call, cleared on tool_result). */
  tool: Record<string, { name: string; input: unknown } | undefined>;
  /** rolling last-N chars of the reasoning / answer streams, per agent. */
  think: Record<string, string>;
  answer: Record<string, string>;
}

const CAP = 420;
const tail = (s: string, add: string) => (s + add).slice(-CAP);

export function deriveDetail(applied: RunEvent[]): Detail {
  const d: Detail = { prompt: "", ctxParts: null, ctxTotals: null, tool: {}, think: {}, answer: {} };
  for (const e of applied) {
    switch (e.type) {
      case "run_start":
        d.think[e.agentId] = "";
        d.answer[e.agentId] = "";
        if (e.agentId === "main") d.prompt = e.prompt;
        break;
      case "context_info":
        if (e.agentId === "main") {
          d.ctxParts = e.parts;
          d.ctxTotals = { messages: e.messages, estimatedTokens: e.estimatedTokens, threshold: e.threshold };
        }
        break;
      case "thinking_delta":
        d.think[e.agentId] = tail(d.think[e.agentId] ?? "", e.text);
        break;
      case "text_delta":
        d.answer[e.agentId] = tail(d.answer[e.agentId] ?? "", e.text);
        break;
      case "tool_call":
      case "permission_request":
        d.tool[e.agentId] = { name: e.name, input: e.input };
        break;
      case "tool_result":
        d.tool[e.agentId] = undefined;
        break;
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Labels / colours (wording kept from the retired SVG System-Map via the i18n dict).
// ---------------------------------------------------------------------------
export const gateNote = (g: GateState, lang: Lang): string => t(lang, `map.gate.${g}`);
export const GATE_COLOR: Record<GateState, string> = {
  none: "var(--border-strong)", pending: "var(--warn)", allowed: "var(--ok)", denied: "var(--error)",
};
export const lifecycleLabel = (s: SubagentInfo["state"], lang: Lang): string => t(lang, `map.life.${s}`);
export const STATE_COLOR: Record<SubagentInfo["state"], string> = {
  submitted: "var(--text-faint)", working: "var(--warn)", completed: "var(--ok)", failed: "var(--error)",
};

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function activity(
  f: Focus, disk: DiskState, file: string | null, cmd: string | null,
  mcp: string | null, gate: GateState, lang: Lang,
) {
  const file_ = file ?? t(lang, "map.act.file");
  switch (f) {
    case "llm": return { text: t(lang, "map.act.thinking"), color: "var(--accent)" };
    case "disk": return disk === "write"
      ? { text: t(lang, "map.act.writes", { f: file_ }), color: "var(--accent)" }
      : { text: t(lang, "map.act.reads", { f: file_ }), color: "var(--ok)" };
    case "cmd": return { text: `$ ${cut(cmd ?? "run_command", 26)}`, color: "var(--sand)" };
    case "mcp": return { text: mcp ?? "mcp-server", color: "var(--sand)" };
    case "gate": return { text: gateNote(gate, lang), color: GATE_COLOR[gate] };
    case "agent": return { text: t(lang, "map.act.plans"), color: "var(--text-dim)" };
    default: return { text: t(lang, "map.gate.none"), color: "var(--text-faint)" };
  }
}

// ---------------------------------------------------------------------------
// Layout — two hand-authored placements; the flip swaps the whole thing.
// ---------------------------------------------------------------------------
interface XY { x: number; y: number; }
interface Zone { id: string; x: number; y: number; w: number; h: number; variant: "mac" | "os" | "outside"; label: string; }
interface Layout {
  pos: Record<string, XY>;
  zones: Zone[];
  boundary: { x: number; y: number; h: number } | null;
  subBase: XY;
  subGap: number;
}

const COMMON: Record<string, XY> = {
  user: { x: 40, y: 380 },
  agent: { x: 250, y: 150 },
  // OS band, left→right, equal 26px gaps, matched to the per-kind widths in
  // prototype.css (disk 152 · shell 200 wide · mcp 190 · net 104 — just a globe),
  // and dropped to y748 so the row sits in the vertical middle of the band.
  "os-disk": { x: 58, y: 748 },
  "os-shell": { x: 236, y: 748 },
  "os-mcp": { x: 462, y: 748 },
  "os-net": { x: 678, y: 748 }, // the network stack sits right of the MCP client — the exit to the outside
};

// Generous vertical room so an expanded node (context / JSON) never collides with
// the OS band below it, and a tall aspect so wide screens get side margins that
// keep the floating panels off the nodes.
const LAYOUTS: { remote: Layout; local: Layout } = {
  remote: {
    // Wider "Dein Mac" box → more room for the subagent loops. Netz + MCP-Server
    // sit lower and side by side (horizontally aligned) below the LLM. The LLM
    // card is 440px wide (2.5x), so the OUTSIDE zone is widened to hold it.
    pos: { ...COMMON, llm: { x: 1092, y: 240 }, netz: { x: 1090, y: 660 }, mcpserver: { x: 1290, y: 660 } },
    zones: [
      { id: "z-mac", x: 0, y: 24, w: 1000, h: 900, variant: "mac", label: "AGENTENSYSTEM · DEIN MAC" },
      { id: "z-os", x: 24, y: 668, w: 792, h: 236, variant: "os", label: "BETRIEBSSYSTEM" },
      { id: "z-outside", x: 1052, y: 24, w: 520, h: 900, variant: "outside", label: "AUSSERHALB" },
    ],
    boundary: { x: 1016, y: 24, h: 900 },
    subBase: { x: 685, y: 110 }, // centered in the free space right of the agent hub, started higher so the 3rd clears the OS band
    subGap: 180,
  },
  local: {
    // The 440px LLM sits inside "Dein Mac", so the mac zone grows and the
    // OUTSIDE zone (Netz + MCP-Server only) shifts right accordingly.
    pos: { ...COMMON, llm: { x: 860, y: 260 }, netz: { x: 1400, y: 660 }, mcpserver: { x: 1580, y: 660 } },
    zones: [
      { id: "z-mac", x: 0, y: 24, w: 1340, h: 900, variant: "mac", label: "AGENTENSYSTEM · DEIN MAC" },
      { id: "z-os", x: 24, y: 668, w: 792, h: 236, variant: "os", label: "BETRIEBSSYSTEM" },
      { id: "z-outside", x: 1372, y: 24, w: 380, h: 900, variant: "outside", label: "AUSSERHALB" },
    ],
    boundary: null,
    subBase: { x: 610, y: 110 }, // centered between the agent hub and the inside LLM, started higher so the 3rd clears the OS band
    subGap: 180,
  },
};

// focus → the node the packet rests on (gate stays at the agent).
const FOCUS_NODE: Record<Focus, string> = {
  user: "user", agent: "agent", gate: "agent", llm: "llm", disk: "os-disk", cmd: "os-shell", mcp: "os-mcp",
};

const SUB_MAX = 3;
const SUB_H = 132; // approximate subagent card height, used to vertically center the group
const SUB_MIN_GAP = 44; // hard minimum visual gap between subagent cards
const SUB_BAND_BOTTOM = 630; // subagents stay above the OS band (top ~668)

/**
 * Deterministic vertical layout for the subagent column. Rules:
 *  - a preferred top-to-top spacing (subGap), kept when it fits the band;
 *  - a hard minimum spacing (card height + SUB_MIN_GAP) so cards never clump;
 *  - the whole group centered in its band;
 *  - clamped so the column never overflows into the OS band.
 * Result: one agent lands centered, two as a centered pair, three fill the band
 * evenly, and the spacing is identical whether one arrives before the others.
 */
function subagentYs(count: number, bandTop: number, bandBottom: number, preferredGap: number): number[] {
  if (count <= 0) return [];
  const band = bandBottom - bandTop;
  const minStep = SUB_H + SUB_MIN_GAP;
  const span = (step: number) => (count - 1) * step + SUB_H;
  let step = preferredGap;
  if (span(step) > band) step = Math.max(minStep, (band - SUB_H) / (count - 1 || 1));
  const start = bandTop + Math.max(0, (band - span(step)) / 2);
  return Array.from({ length: count }, (_, i) => Math.round(start + i * step));
}

export interface FlowResult { nodes: Node[]; edges: Edge[]; }

export function sceneToFlow(
  scene: Scene,
  detail: Detail,
  opts: { local: boolean; provider: string; model: string; systemPrompt?: string; lang?: Lang },
): FlowResult {
  const L = opts.local ? LAYOUTS.local : LAYOUTS.remote;
  const lang: Lang = opts.lang ?? "en";
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // ----- zones (non-interactive background) -----
  const ZONE_LABEL: Record<Zone["variant"], string> = {
    mac: t(lang, "map.zone.mac"), os: t(lang, "map.zone.os"), outside: t(lang, "map.zone.outside"),
  };
  for (const z of L.zones) {
    if (z.variant === "outside" && opts.local) {
      // keep it, but it only holds Netz + MCP-Server when local
    }
    nodes.push({
      id: z.id,
      type: "zone",
      position: { x: z.x, y: z.y },
      data: { variant: z.variant, label: ZONE_LABEL[z.variant] },
      draggable: false,
      selectable: false,
      zIndex: 0,
      style: { width: z.w, height: z.h },
    });
  }
  if (L.boundary) {
    nodes.push({
      id: "z-boundary",
      type: "zone",
      position: { x: L.boundary.x, y: L.boundary.y },
      data: { variant: "boundary", label: t(lang, "map.zone.boundary") },
      draggable: false,
      selectable: false,
      zIndex: 1,
      style: { width: 20, height: L.boundary.h },
    });
  }

  const N = (id: string, type: string, data: Record<string, unknown>, z = 10) =>
    nodes.push({ id, type, position: L.pos[id], data, zIndex: z });

  // ----- user -----
  N("user", "user", { active: scene.focus === "user", prompt: detail.prompt });

  // ----- agent hub -----
  const mainAct = activity(scene.focus, scene.disk, scene.activeFile, scene.activeCommand, scene.activeMcp, scene.gate, lang);
  N("agent", "agent", {
    active: scene.focus === "agent" || scene.focus === "gate",
    error: scene.isError,
    focus: scene.focus,
    activity: mainAct,
    gate: scene.gate,
    gateNote: gateNote(scene.gate, lang),
    gateColor: GATE_COLOR[scene.gate],
    activeTool: scene.activeTool,
    ctxParts: detail.ctxParts,
    ctxTotals: detail.ctxTotals,
    prompt: detail.prompt,
    systemPrompt: opts.systemPrompt ?? null,
    tool: detail.tool["main"] ?? null,
  });

  // ----- OS band ----- Stations are SHARED infrastructure: disk, shell and
  // the whole MCP chain (client → net → Netz → server) light for WHICHEVER
  // loop is on them right now — the main agent or any subagent.
  const loops: { id: string; loop: Loop }[] = [
    { id: "main", loop: scene },
    ...scene.subagents.map((c) => ({ id: c.id, loop: c })),
  ];
  const atDisk = loops.find((l) => l.loop.focus === "disk");
  const atCmd = loops.find((l) => l.loop.focus === "cmd");
  const mcpUser = loops.find((l) => l.loop.activeMcp !== null);
  const mcpInUse = mcpUser !== undefined;
  const mcpTool = mcpUser ? detail.tool[mcpUser.id] : undefined;
  N("os-disk", "os", { kind: "disk", active: atDisk !== undefined, disk: atDisk?.loop.disk ?? "idle", file: atDisk?.loop.activeFile ?? null });
  N("os-shell", "os", { kind: "shell", active: atCmd !== undefined, command: atCmd?.loop.activeCommand ?? null });
  N("os-mcp", "os", {
    kind: "mcp", active: mcpInUse, mcp: mcpUser?.loop.activeMcp ?? null,
    tool: mcpTool?.name?.startsWith("mcp__") ? mcpTool : null,
  });
  N("os-net", "os", { kind: "net", active: mcpInUse });

  // ----- LLM ----- (the SHARED model — it works for main and every subagent,
  // so it animates and streams for whichever agent is at it right now)
  const llmBusy = scene.focus === "llm" || scene.subagents.some((c) => c.focus === "llm");
  const streamsOf = (rec: Record<string, string>): AgentStream[] =>
    ["main", ...scene.subagents.map((c) => c.id)]
      .map((id) => ({ agent: id, text: rec[id] ?? "" }))
      .filter((s) => s.text.length > 0);
  N("llm", "llm", {
    active: llmBusy,
    local: opts.local,
    provider: opts.provider,
    model: opts.model,
    think: streamsOf(detail.think),
    answer: streamsOf(detail.answer),
  });

  // ----- external services -----
  N("netz", "ext", { kind: "netz", active: mcpInUse });
  N("mcpserver", "ext", { kind: "mcpserver", active: mcpInUse, mcp: mcpUser?.loop.activeMcp ?? null });

  // ----- subagents (each its own loop) -----
  const subs = scene.subagents.slice(0, SUB_MAX);
  const subYs = subagentYs(subs.length, L.subBase.y, SUB_BAND_BOTTOM, L.subGap);
  subs.forEach((c, i) => {
    const id = `sub-${c.id}`;
    L.pos[id] = { x: L.subBase.x, y: subYs[i] };
    const act = activity(c.focus, c.disk, c.activeFile, c.activeCommand, c.activeMcp, c.gate, lang);
    N(id, "subagent", {
      id: c.id,
      label: c.label,
      task: c.task,
      state: c.state,
      stateLabel: lifecycleLabel(c.state, lang),
      stateColor: STATE_COLOR[c.state],
      lastStatus: c.lastStatus,
      activity: act,
      focus: c.focus,
      active: scene.activeChild === c.id,
      think: detail.think[c.id] ?? "",
    });
  });

  // ----- edges (the rails) -----
  const net = !opts.local; // LLM legs cross the boundary only when remote
  const E = (
    id: string, source: string, target: string, sh: string, th: string,
    active: boolean, opt: { net?: boolean; err?: boolean; dim?: boolean; flow?: boolean } = {},
  ) => {
    edges.push({
      id, source, target, sourceHandle: sh, targetHandle: th, type: "rail",
      data: { active, net: opt.net ?? false, err: opt.err ?? false, dim: opt.dim ?? false, flow: opt.flow ?? active },
      zIndex: active ? 1001 : 1,
    });
  };

  const mainLit = FOCUS_NODE[scene.focus];
  const litUserAgent = scene.focus === "agent" || scene.focus === "gate" || scene.focus === "user";
  E("e-user-agent", "user", "agent", "rs", "lt", litUserAgent, { err: scene.isError && scene.focus === "user" });
  E("e-agent-llm", "agent", "llm", "rs", "lt", mainLit === "llm", { net });
  E("e-agent-osdisk", "agent", "os-disk", "bs", "tt", mainLit === "os-disk");
  E("e-agent-osshell", "agent", "os-shell", "bs", "tt", mainLit === "os-shell");
  // The MCP call rides the whole chain and lights it end to end while in use:
  //   <caller> → MCP-client → network stack →⟂ Netz → MCP-server
  // The first leg belongs to the CALLING agent (main's rail or the child's
  // own rail below); the chain from the client outward is shared.
  const mcpErr = !!mcpUser?.loop.isError;
  const mainOnMcp = scene.activeMcp !== null;
  E("e-agent-osmcp", "agent", "os-mcp", "bs", "tt", mainLit === "os-mcp" || mainOnMcp, { err: mcpErr && mcpUser?.id === "main" });
  E("e-osmcp-osnet", "os-mcp", "os-net", "rs", "lt", mcpInUse, { err: mcpErr });
  E("e-osnet-netz", "os-net", "netz", "rs", "lt", mcpInUse, { net: true, err: mcpErr });
  E("e-netz-mcpserver", "netz", "mcpserver", "rs", "lt", mcpInUse, { net: true, err: mcpErr });

  subs.forEach((c) => {
    const id = `sub-${c.id}`;
    E(`e-${id}-agent`, id, "agent", "ls", "rt", false, { dim: true });
    E(`e-${id}-llm`, id, "llm", "rs", "lt", c.focus === "llm", { net });
    // A child's packet flies its OWN rail to the shared station it is using;
    // these rails only exist while in use (no permanent clutter).
    if (c.focus === "disk") E(`e-${id}-osdisk`, id, "os-disk", "bs", "tt", true, { err: c.isError });
    if (c.focus === "cmd") E(`e-${id}-osshell`, id, "os-shell", "bs", "tt", true, { err: c.isError });
    if (c.focus === "mcp") E(`e-${id}-osmcp`, id, "os-mcp", "bs", "tt", true, { err: c.isError });
  });

  return { nodes, edges };
}
