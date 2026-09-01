// The fleet machine room's layout fold (card 59): one FleetLabScene in, React
// Flow nodes/edges out — REUSING the single-run map's pieces (SubagentNode as
// the per-node card, the OS band stations, the LLM node, the zones, the rail
// edges), never forking them. Where the single-run layout is hand-authored for
// one agent + up to three children, this one is COMPUTED from the node count:
// the card grid wraps into columns, and the zones, OS band, boundary and LLM
// stations move outward so nothing ever overlaps.
//
// Honesty notes baked into the geometry:
//   - ONE model station, beyond the boundary, whoever serves the tokens (card
//     304). The fleet used to split its cards into a local set and a remote set
//     and draw a box for each, so a pure-ollama fleet showed no boundary
//     traffic at all and a mixed fleet showed two models. With the internal
//     model behind the agents and ollama serving cloud models, "local" no
//     longer named a fact worth a second station;
//   - the user station only exists when a "main" node exists (a process fleet
//     without main has no user-facing entry, so none is drawn).

import type { Edge, Node } from "@xyflow/react";
import type { Lang } from "../../i18n/i18n";
import { t } from "../../i18n/i18n";
import type { FleetLabNode, FleetLabScene } from "../fleetLabScene";
import { modelLocation } from "./addresses";
import {
  EXPANDED_CARD,
  LANE_CAP,
  STATE_COLOR,
  activity,
  lifecycleLabel,
  mcpChainView,
  netCardView,
  type AgentLane,
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
// CARD 330: the band holds five stations now (disk/shell/mcp/net/browser) —
// 792 was the four-station row, plus the same 26px gap and the browser's 190.
const OS_W = 1008;
const MAC_PAD = 24;
const USER_X = 40; // the user station's own column, left of the card grid

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
  // Expanded cards open task & history inline and grow tall/wide, so every
  // reserve below switches to what EXPANDED_CARD says they occupy: the pitch
  // (so open cards never overlap), the card height the frame reserves under the
  // last row, the LLM height the frame has to contain, and the grid's own start
  // — the wide user card holds a whole column of its own.
  const expanded = opts.expanded === true;
  const stepY = expanded ? 330 : FLEET_CARD_STEP_Y;
  const cardH = expanded ? EXPANDED_CARD["fleet-card"].h : CARD_H;
  const gridX = expanded ? USER_X + EXPANDED_CARD.user.w + 60 : GRID_X;
  const cols = columnsFor(cards.length);
  const rows = Math.max(1, Math.ceil(cards.length / cols));

  // ---- computed frame ------------------------------------------------------
  const gridBottom = GRID_Y + (rows - 1) * stepY + cardH;
  const osTop = Math.max(668, gridBottom + OS_GAP);
  const gridRight = gridX + (cols - 1) * CARD_STEP_X + CARD_W;
  // The mac zone must hold the card grid and the OS band. It used to have to
  // hold a local model station beside the band as well; that station is gone
  // (card 304), so the frame is back to the two things that live in it.
  const macW = Math.max(1000, gridRight + 120);
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
      position: { x: USER_X, y: GRID_Y + 40 },
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
      position: { x: gridX + col * CARD_STEP_X, y: GRID_Y + row * stepY },
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
  /** CARD 330: the card inside a browser verb, if any. Named rather than
   *  counted, so the rail below can be drawn for it like the other three. */
  const onBrowser = cards.find((c) => c.activeTool !== null && c.activeTool.startsWith("browser_"));
  // CARD 328: the fleet room draws the SAME two cards as the single-run map, so
  // it takes the same derivation rather than a second one beside it. Without
  // this line the answer would be visible on one surface and missing on the
  // other, which is half a feature shipped.
  const chain = mcpChainView(detail, mcpUser?.id ?? null, mcpUser?.activeMcp ?? null);
  // CARD 329, same reason: the fleet room draws the same boundary nodes.
  const netView = netCardView(detail);
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
      data: {
        kind: "shell",
        active: atCmd !== undefined,
        command: atCmd?.activeCommand ?? null,
        // The CALL, not only its command string (card 320). The station asks
        // the classifier what language it is drawing and has nothing to ask
        // about otherwise: handed no call it renders the chain in plain text,
        // which is this card half-built on a shipped surface. Read off the
        // OCCUPANT, the way os-mcp two entries down reads its own — the agent's
        // current call outright would stand a `Read` on the shell station.
        tool: atCmd === undefined ? null : (detail.tool[atCmd.id] ?? null),
      },
    },
    {
      id: "os-mcp",
      x: MAC_PAD + 438,
      data: { kind: "mcp", active: mcpInUse, mcp: chain.line, call: chain.call },
    },
    {
      id: "os-net",
      x: MAC_PAD + 654,
      // NOW, not ever — same repair as the single-run map. `crossed` is the
      // run's memory and never goes back down; it stays on the Netz card.
      data: { kind: "net", active: mcpInUse || detail.crossingNow },
    },
    // CARD 330: the fleet room's OS band draws the same stations as the
    // single-run map's, so the browser station is here too — one producer left
    // behind is half a feature on a live surface. `browserBusy` is read off the
    // tool in flight, the same fact the single-run map reads.
    {
      id: "os-browser",
      x: MAC_PAD + 784,
      data: {
        kind: "browser",
        active: onBrowser !== undefined,
        page: detail.page,
      },
    },
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

  // ---- the LLM station -----------------------------------------------------
  // One station for the whole fleet, and every card's provider on its label.
  const withProvider = cards.filter((c) => c.provider !== null);
  // CARD 327, criterion 10: BOTH producers write the lane shape. The defect
  // card 320 found at the shell station was exactly one producer left behind,
  // and this one has no AgentDirectory to reach for — so it builds the same
  // lanes from its own roster rather than calling llmLanes, which takes a Scene
  // this side does not have. The SHAPE is what a test holds them to, not the
  // call.
  const lanesOf = (of: FleetLabNode[]): { lanes: AgentLane[]; more: number } => ({
    lanes: of.slice(0, LANE_CAP).map((c, i) => ({
      agent: c.id,
      think: detail.think[c.id] ?? "",
      answer: detail.answer[c.id] ?? "",
      isRoot: i === 0,
    })),
    more: Math.max(0, of.length - LANE_CAP),
  });
  nodes.push({
    id: "llm",
    type: "llm",
    position: { x: llmX, y: llmY },
    data: {
      active: cards.some((c) => c.focus === "llm"),
      // CARD 333, criterion 6: the SAME decision the single-run map draws, off
      // the same fold. A card wired into one producer ships half a feature —
      // card 320's shell station and card 327's lanes were both exactly that.
      loc: modelLocation(detail.llmUrl),
      provider: providerLabel(withProvider),
      model: "",
      ...lanesOf(cards),
    },
    zIndex: 10,
  });

  // ---- external services (the MCP chain's far side) ------------------------
  nodes.push({
    id: "netz",
    type: "ext",
    position: { x: outsideX + 40, y: macH - 240 },
    data: { kind: "netz", active: mcpInUse || detail.crossingNow, net: netView },
    zIndex: 10,
  });
  nodes.push({
    id: "mcpserver",
    type: "ext",
    position: { x: outsideX + 240, y: macH - 240 },
    data: { kind: "mcpserver", active: mcpInUse, mcp: chain.line, answer: chain.answer },
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
  // CARD 328, same repair as the single-run map: the live occupant is gone the
  // instant `tool_result` clears `activeMcp`, so this alone could never be true
  // for an ANSWERED error. The exchange the two cards are showing can.
  const mcpErr = mcpUser?.isError === true || chain.isError;
  for (const card of cards) {
    const id = `card-${card.id}`;
    // Every card rails to the one station, and every one of those legs crosses
    // the boundary (card 304).
    E(`e-${id}-llm`, id, "llm", "rs", "lt", card.focus === "llm", { net: true });
    if (card.focus === "disk") E(`e-${id}-osdisk`, id, "os-disk", "bs", "tt", true, { err: card.isError });
    if (card.focus === "cmd") E(`e-${id}-osshell`, id, "os-shell", "bs", "tt", true, { err: card.isError });
    if (card.focus === "mcp") E(`e-${id}-osmcp`, id, "os-mcp", "bs", "tt", true, { err: card.isError });
    // CARD 330, round 2: the browser station had a card and no rail on this
    // surface, so its work was drawn beside the map instead of on it. Same
    // condition as the station's own occupancy — the tool in flight, because a
    // browser verb has no focus of its own.
    if (card.activeTool !== null && card.activeTool.startsWith("browser_"))
      E(`e-${id}-osbrowser`, id, "os-browser", "bs", "tt", true, { err: card.isError });
  }
  E("e-osmcp-osnet", "os-mcp", "os-net", "rs", "lt", mcpInUse, { err: mcpErr });
  E("e-osnet-netz", "os-net", "netz", "rs", "lt", mcpInUse, { net: true, err: mcpErr });
  E("e-netz-mcpserver", "netz", "mcpserver", "rs", "lt", mcpInUse, { net: true, err: mcpErr });

  return { nodes, edges };
}
