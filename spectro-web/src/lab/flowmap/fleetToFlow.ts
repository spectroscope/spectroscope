// The fleet machine room's layout fold (card 59): one FleetLabScene in, React
// Flow nodes/edges out — REUSING the single-run map's pieces (SubagentNode as
// the per-node card, the OS band stations, the LLM node, the zones, the rail
// edges), never forking them. Where the single-run layout is hand-authored for
// one agent + up to three children, this one is COMPUTED from the node count:
// the card grid wraps into columns, and the zones, OS band, boundary and LLM
// stations move outward so nothing ever overlaps.
//
// Honesty notes baked into the geometry:
//   - the boundary + remote LLM only claim "outside" for genuinely remote
//     providers; nodes on ollama rail to a LOCAL station inside the machine;
//   - the user station only exists when a "main" node exists (a process fleet
//     without main has no user-facing entry, so none is drawn).

import type { Edge, Node } from "@xyflow/react";
import type { Lang } from "../../i18n/i18n";
import { t } from "../../i18n/i18n";
import { isLocalProvider } from "../labScene";
import type { FleetLabNode, FleetLabScene } from "../fleetLabScene";
import {
  activity,
  lifecycleLabel,
  STATE_COLOR,
  type AgentStream,
  type Detail,
  type FlowResult,
} from "./sceneToFlow";

// ---- geometry constants (px, the flowmap.css card sizes) -------------------
const CARD_W = 216; // .pf-sub width
const CARD_H = 150; // generous card height incl. status line
export const FLEET_CARD_STEP_Y = 190; // vertical card pitch
const CARD_STEP_X = 280; // column pitch (card + gap)
const GRID_X = 250; // first column (right of the user station)
const GRID_Y = 110; // first row
const OS_GAP = 56; // space between the deepest card and the OS band
const OS_H = 236; // the OS band's height (matches the single-run map)
const OS_W = 792; // the OS band's width (disk/shell/mcp/net row)
const LLM_W = 440; // .pf-llm width
const MAC_PAD = 24;

/** Column count: one for small fleets, then wrap to keep the column readable. */
function columnsFor(count: number): number {
  if (count <= 4) return 1;
  if (count <= 10) return 2;
  return 3;
}

/** Join the distinct providers of one station's nodes for its label. */
function providerLabel(nodes: FleetLabNode[]): string {
  const seen: string[] = [];
  for (const n of nodes) {
    if (n.provider !== null && !seen.includes(n.provider)) seen.push(n.provider);
  }
  return seen.join(" · ");
}

/**
 * The machine-room layout. Deterministic for a given scene + detail, so the
 * scrubber can re-render any fold prefix.
 */
export function fleetToFlow(
  scene: FleetLabScene,
  detail: Detail,
  opts: { lang?: Lang; expanded?: boolean },
): FlowResult {
  const lang: Lang = opts.lang ?? "en";
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const cards = scene.nodes;
  // Expanded cards open task & history inline and grow tall — widen the pitch
  // so open cards never overlap (owner: the map must spread with the view).
  const stepY = opts.expanded === true ? 330 : FLEET_CARD_STEP_Y;
  const cols = columnsFor(cards.length);
  const rows = Math.max(1, Math.ceil(cards.length / cols));

  // ---- computed frame ------------------------------------------------------
  const gridBottom = GRID_Y + (rows - 1) * stepY + CARD_H;
  const osTop = Math.max(668, gridBottom + OS_GAP);
  const gridRight = GRID_X + (cols - 1) * CARD_STEP_X + CARD_W;
  // The mac zone must hold the card grid, the OS band, and (when a local
  // backend is in play) the local LLM station right of the OS band.
  const localLlmX = MAC_PAD + OS_W + 64;
  const macW = Math.max(1000, gridRight + 120, scene.hasLocal ? localLlmX + LLM_W + MAC_PAD : 0);
  const macH = osTop + OS_H + 36;
  const boundaryX = macW + 16;
  const outsideX = macW + 52;
  const llmX = outsideX + 40;
  const llmY = Math.max(240, GRID_Y + Math.floor(((rows - 1) * stepY) / 2));

  // ---- zones ---------------------------------------------------------------
  nodes.push({
    id: "z-mac",
    type: "zone",
    position: { x: 0, y: 24 },
    data: { variant: "mac", label: t(lang, "map.zone.fleetMac") },
    draggable: false,
    selectable: false,
    zIndex: 0,
    style: { width: macW, height: macH },
  });
  nodes.push({
    id: "z-os",
    type: "zone",
    position: { x: MAC_PAD, y: osTop },
    data: { variant: "os", label: t(lang, "map.zone.os") },
    draggable: false,
    selectable: false,
    zIndex: 0,
    style: { width: OS_W, height: OS_H },
  });
  nodes.push({
    id: "z-outside",
    type: "zone",
    position: { x: outsideX, y: 24 },
    data: { variant: "outside", label: t(lang, "map.zone.outside") },
    draggable: false,
    selectable: false,
    zIndex: 0,
    style: { width: 520, height: macH },
  });
  nodes.push({
    id: "z-boundary",
    type: "zone",
    position: { x: boundaryX, y: 24 },
    data: { variant: "boundary", label: t(lang, "map.zone.boundary") },
    draggable: false,
    selectable: false,
    zIndex: 1,
    style: { width: 20, height: macH },
  });

  // ---- the user station (only when a main node exists) ---------------------
  const main = cards.find((c) => c.id === "main");
  if (main !== undefined) {
    nodes.push({
      id: "user",
      type: "user",
      position: { x: 40, y: GRID_Y + 40 },
      data: { active: false, prompt: detail.prompt },
      zIndex: 10,
    });
  }

  // ---- the node cards (SubagentNode reused as the per-node card) -----------
  cards.forEach((card, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const id = `card-${card.id}`;
    const act = activity(
      card.focus,
      card.disk,
      card.activeFile,
      card.activeCommand,
      card.activeMcp,
      card.gate,
      lang,
    );
    nodes.push({
      id,
      type: "subagent",
      position: { x: GRID_X + col * CARD_STEP_X, y: GRID_Y + row * stepY },
      data: {
        id: card.id,
        label: card.role === "root" ? null : card.role,
        task: card.task,
        state: card.state,
        stateLabel: lifecycleLabel(card.state, lang),
        stateColor: STATE_COLOR[card.state],
        lastStatus: card.lastStatus,
        activity: act,
        focus: card.focus,
        active: scene.activeNode === card.id,
        think: detail.think[card.id] ?? "",
      },
      zIndex: 10,
    });
  });

  // ---- shared OS band ------------------------------------------------------
  const atDisk = cards.find((c) => c.focus === "disk");
  const atCmd = cards.find((c) => c.focus === "cmd");
  const mcpUser = cards.find((c) => c.activeMcp !== null);
  const mcpInUse = mcpUser !== undefined;
  const mcpTool = mcpUser ? detail.tool[mcpUser.id] : undefined;
  const osY = osTop + 80;
  const OS_STATIONS: { id: string; x: number; data: Record<string, unknown> }[] = [
    {
      id: "os-disk",
      x: MAC_PAD + 34,
      data: {
        kind: "disk",
        active: atDisk !== undefined,
        disk: atDisk?.disk ?? "idle",
        file: atDisk?.activeFile ?? null,
      },
    },
    {
      id: "os-shell",
      x: MAC_PAD + 212,
      data: { kind: "shell", active: atCmd !== undefined, command: atCmd?.activeCommand ?? null },
    },
    {
      id: "os-mcp",
      x: MAC_PAD + 438,
      data: {
        kind: "mcp",
        active: mcpInUse,
        mcp: mcpUser?.activeMcp ?? null,
        tool: mcpTool?.name?.startsWith("mcp__") ? mcpTool : null,
      },
    },
    { id: "os-net", x: MAC_PAD + 654, data: { kind: "net", active: mcpInUse } },
  ];
  for (const station of OS_STATIONS) {
    nodes.push({
      id: station.id,
      type: "os",
      position: { x: station.x, y: osY },
      data: station.data,
      zIndex: 10,
    });
  }

  // ---- LLM stations --------------------------------------------------------
  const remoteNodes = cards.filter((c) => c.provider !== null && !isLocalProvider(c.provider));
  const localNodes = cards.filter((c) => c.provider !== null && isLocalProvider(c.provider));
  const streamsOf = (rec: Record<string, string>, of: FleetLabNode[]): AgentStream[] =>
    of.map((c) => ({ agent: c.id, text: rec[c.id] ?? "" })).filter((s) => s.text.length > 0);

  // The remote station shows when remote traffic exists — or before ANY
  // provider is known (the default expectation, like the single-run map). A
  // purely local fleet hides it: an unused remote box would claim traffic
  // that never crosses the boundary.
  const remoteShown = scene.hasRemote || !scene.hasLocal;
  if (remoteShown) {
    nodes.push({
      id: "llm",
      type: "llm",
      position: { x: llmX, y: llmY },
      data: {
        active: remoteNodes.some((c) => c.focus === "llm"),
        local: false,
        provider: providerLabel(remoteNodes),
        model: "",
        think: streamsOf(detail.think, remoteNodes),
        answer: streamsOf(detail.answer, remoteNodes),
      },
      zIndex: 10,
    });
  }
  if (scene.hasLocal) {
    nodes.push({
      id: "llm-local",
      type: "llm",
      position: { x: localLlmX, y: osTop + 8 },
      data: {
        active: localNodes.some((c) => c.focus === "llm"),
        local: true,
        provider: providerLabel(localNodes),
        model: "",
        think: streamsOf(detail.think, localNodes),
        answer: streamsOf(detail.answer, localNodes),
      },
      zIndex: 10,
    });
  }

  // ---- external services (the MCP chain's far side) ------------------------
  nodes.push({
    id: "netz",
    type: "ext",
    position: { x: outsideX + 40, y: macH - 240 },
    data: { kind: "netz", active: mcpInUse },
    zIndex: 10,
  });
  nodes.push({
    id: "mcpserver",
    type: "ext",
    position: { x: outsideX + 240, y: macH - 240 },
    data: { kind: "mcpserver", active: mcpInUse, mcp: mcpUser?.activeMcp ?? null },
    zIndex: 10,
  });

  // ---- rails ---------------------------------------------------------------
  const E = (
    id: string,
    source: string,
    target: string,
    sh: string,
    th: string,
    active: boolean,
    opt: { net?: boolean; err?: boolean; dim?: boolean } = {},
  ): void => {
    edges.push({
      id,
      source,
      target,
      sourceHandle: sh,
      targetHandle: th,
      type: "rail",
      data: {
        active,
        net: opt.net ?? false,
        err: opt.err ?? false,
        dim: opt.dim ?? false,
        flow: active,
      },
      zIndex: active ? 1001 : 1,
    });
  };

  if (main !== undefined) {
    E("e-user-main", "user", "card-main", "rs", "lt", main.focus === "agent" || main.focus === "gate");
  }
  const mcpErr = mcpUser?.isError === true;
  for (const card of cards) {
    const id = `card-${card.id}`;
    // A local-provider card rails locally; everyone else rails to the remote
    // station — unless it is hidden (pure-local fleet), where the local
    // station is the only one left to ride to.
    const local = (card.provider !== null && isLocalProvider(card.provider)) || !remoteShown;
    const llmTarget = local ? "llm-local" : "llm";
    E(`e-${id}-llm`, id, llmTarget, "rs", "lt", card.focus === "llm", {
      net: llmTarget === "llm",
    });
    if (card.focus === "disk") E(`e-${id}-osdisk`, id, "os-disk", "bs", "tt", true, { err: card.isError });
    if (card.focus === "cmd") E(`e-${id}-osshell`, id, "os-shell", "bs", "tt", true, { err: card.isError });
    if (card.focus === "mcp") E(`e-${id}-osmcp`, id, "os-mcp", "bs", "tt", true, { err: card.isError });
  }
  E("e-osmcp-osnet", "os-mcp", "os-net", "rs", "lt", mcpInUse, { err: mcpErr });
  E("e-osnet-netz", "os-net", "netz", "rs", "lt", mcpInUse, { net: true, err: mcpErr });
  E("e-netz-mcpserver", "netz", "mcpserver", "rs", "lt", mcpInUse, { net: true, err: mcpErr });

  return { nodes, edges };
}
