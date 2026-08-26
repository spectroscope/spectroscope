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
import { imageUrl } from "./imageUrl";
import { stationUsers } from "./stationUsers";
import { SEAT_ROWS_COMPACT, SEAT_ROWS_EXPANDED, SEATS_MAX_COMPACT, SEATS_MAX_EXPANDED, seatGrid, seatOf } from "./workerGrid";

// ---------------------------------------------------------------------------
// Derived detail — the raw bits the scene model deliberately doesn't carry.
// ---------------------------------------------------------------------------
export interface CtxPart {
  label: string;
  chars: number;
  estTokens: number;
}

/** One agent's slice of the shared LLM's reasoning/answer stream. */
export interface AgentStream {
  agent: string;
  text: string;
}
export interface Detail {
  prompt: string;
  ctxParts: CtxPart[] | null;
  ctxTotals: { messages: number; estimatedTokens: number; threshold: number } | null;
  /** in-flight tool per agent (set on tool_call, cleared on tool_result). */
  tool: Record<string, { name: string; input: unknown } | undefined>;
  /** rolling last-N chars of the reasoning / answer streams, per agent. */
  think: Record<string, string>;
  answer: Record<string, string>;
  /** the LAST generated image per agent — its browser URL (a store blob via
   *  GET /api/images/<file>, or a bundled /demo/ asset from a scripted
   *  scenario) plus its prompt; a missing blob falls back to the placeholder
   *  at render time. */
  genImage: Record<string, { src: string; prompt: string } | undefined>;
  /**
   * The pictures an agent was HANDED, in the order they arrived — its own
   * field, because an attachment is not a generated image. Generated is the
   * last one and its caption is the prompt that asked for it; attached is all
   * of them and their caption is what the file was, and the owner's own
   * transcript opens with four at once.
   *
   * Bounded per agent: the map draws cards, and a session that pasted forty
   * screenshots would otherwise draw forty on one.
   */
  attached: Record<string, { src: string; note: string }[] | undefined>;
  /**
   * The agent this stream is rooted at.
   *
   * "main" for a session file, but a standalone subagent transcript roots at
   * its OWN id (claudeCode.ts sets `rootId = subagentRoot`), and the map read
   * the literal "main" everywhere. 66% of the corpus's pictures sit in sidecar
   * files, so on two thirds of them the agent card asked for an agent that is
   * not in the stream and got nothing — not just the pictures: the prompt, the
   * reasoning, the answer and the in-flight tool as well. Card 179's panel
   * inherited that shape rather than causing it.
   */
  root: string;
}

/** How many pictures one card shows. The rest are in the chat and the trace. */
export const MAX_CARD_SHOTS = 6;

const CAP = 420;
const tail = (s: string, add: string) => (s + add).slice(-CAP);

/**
 * An imported picture frame, or null for anything else.
 *
 * The bytes are already in the frame — a data: URI costs no request and works
 * for a file the store never held, which is every imported transcript.
 *
 * @param event any frame the tab folded
 * @return its parts, or null when it is not an attachment_image
 */
function asAttachment(
  event: unknown,
): { agentId: string; mediaType: string; dataBase64: string; note: string } | null {
  const e = event as {
    type?: string;
    agentId?: unknown;
    mediaType?: unknown;
    dataBase64?: unknown;
    note?: unknown;
  };
  if (e?.type !== "attachment_image" || typeof e.dataBase64 !== "string") return null;
  return {
    agentId: typeof e.agentId === "string" ? e.agentId : "main",
    mediaType: typeof e.mediaType === "string" ? e.mediaType : "image/png",
    dataBase64: e.dataBase64,
    note: typeof e.note === "string" ? e.note : "image",
  };
}

export function deriveDetail(applied: RunEvent[]): Detail {
  const d: Detail = {
    prompt: "",
    ctxParts: null,
    ctxTotals: null,
    tool: {},
    think: {},
    answer: {},
    genImage: {},
    attached: {},
    root: "main",
  };
  let rootSeen = false;
  for (const e of applied) {
    // Import-only frames are not in the RunEvent union — they never travel the
    // wire, so they are read off the shape rather than switched on. Kept ahead
    // of the switch for exactly that reason: the union below stays the wire's.
    const shot = asAttachment(e);
    if (shot !== null) {
      const had = d.attached[shot.agentId] ?? [];
      if (had.length < MAX_CARD_SHOTS) {
        d.attached[shot.agentId] = [
          ...had,
          { src: `data:${shot.mediaType};base64,${shot.dataBase64}`, note: shot.note },
        ];
      }
      continue;
    }
    switch (e.type) {
      case "image_generated":
        d.genImage[e.agentId] = { src: imageUrl(e.blobPath), prompt: e.prompt };
        break;
      case "run_start":
        // The FIRST run_start names the root. Later ones are children.
        if (!rootSeen) {
          d.root = e.agentId;
          rootSeen = true;
        }
        d.think[e.agentId] = "";
        d.answer[e.agentId] = "";
        if (e.agentId === d.root) d.prompt = e.prompt;
        break;
      case "context_info":
        if (e.agentId === d.root) {
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
  none: "var(--border-strong)",
  pending: "var(--warn)",
  allowed: "var(--ok)",
  denied: "var(--error)",
};
export const lifecycleLabel = (s: SubagentInfo["state"], lang: Lang): string => t(lang, `map.life.${s}`);
export const STATE_COLOR: Record<SubagentInfo["state"], string> = {
  submitted: "var(--text-faint)",
  working: "var(--warn)",
  completed: "var(--ok)",
  failed: "var(--error)",
};

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** One loop's activity line (text + color) — shared with the fleet machine room. */
export function activity(
  f: Focus,
  disk: DiskState,
  file: string | null,
  cmd: string | null,
  mcp: string | null,
  gate: GateState,
  lang: Lang,
  /** The exact tool name, when one is running. The map has a station for six
   *  tools; everything else lands on the agent hub, and the hub used to claim
   *  the agent was PLANNING while a named tool was in flight (card 146). A
   *  `Workflow` call fanning work across a dozen agents read as "plans the next
   *  step", which is not a rounding error — it is the map saying the opposite of
   *  what is happening. Optional so both call sites can adopt it separately. */
  tool?: string | null,
) {
  const file_ = file ?? t(lang, "map.act.file");
  switch (f) {
    case "llm":
      return { text: t(lang, "map.act.thinking"), color: "var(--accent)" };
    case "disk":
      return disk === "write"
        ? { text: t(lang, "map.act.writes", { f: file_ }), color: "var(--accent)" }
        : { text: t(lang, "map.act.reads", { f: file_ }), color: "var(--ok)" };
    case "cmd":
      return { text: `$ ${cut(cmd ?? "run_command", 26)}`, color: "var(--sand)" };
    case "mcp":
      return { text: mcp ?? "mcp-server", color: "var(--sand)" };
    case "gate":
      return { text: gateNote(gate, lang), color: GATE_COLOR[gate] };
    case "agent":
      // A named tool with no station of its own is still a named tool. Saying
      // which one beats claiming the agent is between steps.
      return tool != null && tool !== ""
        ? { text: cut(tool, 26), color: "var(--sand)" }
        : { text: t(lang, "map.act.plans"), color: "var(--text-dim)" };
    default:
      return { text: t(lang, "map.gate.none"), color: "var(--text-faint)" };
  }
}

// ---------------------------------------------------------------------------
// Layout — two hand-authored placements; the flip swaps the whole thing.
// ---------------------------------------------------------------------------
interface XY {
  x: number;
  y: number;
}
interface Zone {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  variant: "mac" | "os" | "outside";
  label: string;
}
interface Layout {
  pos: Record<string, XY>;
  zones: Zone[];
  boundary: { x: number; y: number; h: number } | null;
  subBase: XY;
  subGap: number;
}

/** The OS band's top edge — the seat of the `z-os` zone in BOTH layouts, and the
 *  ceiling every card above it has to stay clear of. */
const OS_BAND_TOP = 668;
/** Height of the `z-os` frame, and how far below its top edge the stations sit. */
const OS_BAND_H = 236;
const OS_STATION_DY = 80;

/**
 * The envelope every expanded card has to fit inside, and the only thing the
 * expanded seats below are derived from.
 *
 * This is a BOUND, not an observation. A height taken off one session is a
 * snapshot: the next session brings a longer order or a fuller context list,
 * the card grows past the number, and the seat under it was already committed.
 * So the heights that can be derived are derived from the caps flowmap.css puts
 * on the parts of a card that grow with content, which is what actually stops a
 * card growing:
 *   · user 24 padding + max(prompt column 16 eyebrow + 4 + .pf-prose 120,
 *     avatar column ~90) ≈ 164, entry 180;
 *   · subagent 24 padding + 20 head + (8 + .pf-sub__task 46) + 24 status +
 *     (20 + 16 + 9 + .pf-disc__body 300) ≈ 467, entry 480.
 * Hand-summed CSS lands a couple of percent under the browser (the user card
 * measured 166 against 164 derived), hence the rounding up.
 *
 * agent and llm keep an observed height plus headroom: their growth regions are
 * capped too (.pf-llm__streams 260, the tool JSON at 150, .pf-prose 120), but
 * the fixed chrome around them can only be read off the DOM, so the sum would
 * be a guess dressed as a derivation. Those two are the entries the runtime
 * check below exists for — see reportOversizeCards.
 */
export const EXPANDED_CARD: Record<string, { w: number; h: number }> = {
  user: { w: 400, h: 180 },
  agent: { w: 680, h: 780 },
  llm: { w: 440, h: 540 },
  subagent: { w: 216, h: 480 },
  // The machine room feeds the SAME card a node's order and its status history,
  // so an open fleet card runs about twice as tall as a worker card here (293
  // measured on a four-phase fleet).
  "fleet-card": { w: 216, h: 300 },
  ext: { w: 150, h: 110 },
  "os-disk": { w: 152, h: 150 },
  "os-shell": { w: 200, h: 210 },
  "os-mcp": { w: 190, h: 210 },
  "os-net": { w: 104, h: 100 },
};

/** Rail room between two expanded cards: enough that the packet on the rail
 *  reads as travelling, not as touching both cards at once. */
export const EXP_GAP = 60;

/** Frame left below the lowest card it holds, so a zone's label and border never
 *  sit on a card. */
const FRAME_PAD = 24;

// ---------------------------------------------------------------------------
// The envelope, checked. A seat is only as good as the number it was derived
// from, and a card that outgrows its number fails silently: it just draws over
// its neighbour. Both checks below turn that into something that says so.
// ---------------------------------------------------------------------------

interface SeatNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
}
const envelopeOf = (id: string, type?: string) => EXPANDED_CARD[id] ?? EXPANDED_CARD[type ?? ""];

/**
 * Pairs of expanded cards whose reserved seats intersect, as `a/b WxH`.
 * Geometry only — it reads the seats the layout emitted against the envelopes
 * those seats were derived from, so an arithmetic slip anywhere between the two
 * (a clamp that squeezes a column, a spread that forgot a card) surfaces here
 * instead of on the screen.
 */
export function seatCollisions(nodes: readonly SeatNode[]): string[] {
  const boxes = nodes
    .map((n) => {
      const env = envelopeOf(n.id, n.type);
      return env === undefined ? null : { id: n.id, x: n.position.x, y: n.position.y, ...env };
    })
    .filter((b): b is { id: string; x: number; y: number; w: number; h: number } => b !== null);
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 0 && h > 0) hits.push(`${a.id}/${b.id} ${w}x${h}`);
    }
  }
  return hits;
}

/** Cards that rendered taller than their envelope, worst first. */
export function oversizeCards(
  measured: Iterable<{ id: string; type?: string; h: number }>,
): { id: string; h: number; bound: number }[] {
  const out: { id: string; h: number; bound: number }[] = [];
  for (const m of measured) {
    const env = envelopeOf(m.id, m.type);
    if (env !== undefined && m.h > env.h) out.push({ id: m.id, h: m.h, bound: env.h });
  }
  return out.sort((a, b) => b.h - b.bound - (a.h - a.bound));
}

const spoken = new Set<string>();

/**
 * The runtime half: hand it the heights the browser actually laid out and it
 * names every card that no longer fits the envelope its neighbours were seated
 * around. Once per card — a layout that runs per frame would otherwise shout
 * per frame, and a report nobody can read is the silence it was meant to break.
 */
export function reportOversizeCards(
  measured: Iterable<{ id: string; type?: string; h: number }>,
  sink: (message: string) => void = (m) => console.error(m),
): { id: string; h: number; bound: number }[] {
  const over = oversizeCards(measured);
  for (const c of over) {
    if (spoken.has(`size:${c.id}`)) continue;
    spoken.add(`size:${c.id}`);
    sink(
      `flow map: the ${c.id} card rendered ${c.h}px tall against an envelope of ${c.bound}px — ` +
        `every seat derived from it is ${c.h - c.bound}px short, so cards will overlap.`,
    );
  }
  return over;
}

function reportSeatCollisions(nodes: readonly SeatNode[]): void {
  for (const hit of seatCollisions(nodes)) {
    if (spoken.has(`seat:${hit}`)) continue;
    spoken.add(`seat:${hit}`);
    console.error(`flow map: two expanded cards were seated on top of each other — ${hit}`);
  }
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
      { id: "z-os", x: 24, y: OS_BAND_TOP, w: 792, h: OS_BAND_H, variant: "os", label: "BETRIEBSSYSTEM" },
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
      { id: "z-os", x: 24, y: OS_BAND_TOP, w: 792, h: OS_BAND_H, variant: "os", label: "BETRIEBSSYSTEM" },
      { id: "z-outside", x: 1372, y: 24, w: 380, h: 900, variant: "outside", label: "AUSSERHALB" },
    ],
    boundary: null,
    subBase: { x: 610, y: 110 }, // centered between the agent hub and the inside LLM, started higher so the 3rd clears the OS band
    subGap: 180,
  },
};

// focus → the node the packet rests on (gate stays at the agent).
const FOCUS_NODE: Record<Focus, string> = {
  user: "user",
  agent: "agent",
  gate: "agent",
  llm: "llm",
  disk: "os-disk",
  cmd: "os-shell",
  mcp: "os-mcp",
};

const SUB_H = 132; // compact subagent card height, used to vertically center the group
/** Compact subagent card width — mirrors `.pf-sub { width }` in flowmap.css;
 *  the compact column pitch derives from it. */
const COMPACT_SUB_W = 216;
const SUB_MIN_GAP = 44; // hard minimum visual gap between subagent cards
const SUB_BAND_BOTTOM = 630; // subagents stay above the OS band (OS_BAND_TOP)

/**
 * Deterministic vertical layout for the subagent column. Rules:
 *  - a preferred top-to-top spacing (subGap), kept when it fits the band;
 *  - a hard minimum spacing (card height + SUB_MIN_GAP) so cards never clump;
 *  - the whole group centered in its band;
 *  - clamped so the column never overflows into the OS band.
 * Result: one agent lands centered, two as a centered pair, three fill the band
 * evenly, and the spacing is identical whether one arrives before the others.
 *
 * cardH is what one card occupies — compact by default, the expanded envelope
 * when the shell opens every panel. It has to travel with the spacing: the band
 * clamp below shrinks the step to fit, and a clamp that shrinks against the
 * WRONG height happily seats card n+1 inside card n.
 */
function subagentYs(
  count: number,
  bandTop: number,
  bandBottom: number,
  preferredGap: number,
  cardH: number = SUB_H,
): number[] {
  if (count <= 0) return [];
  const band = bandBottom - bandTop;
  const minStep = cardH + SUB_MIN_GAP;
  const span = (step: number) => (count - 1) * step + cardH;
  let step = preferredGap;
  if (span(step) > band) step = Math.max(minStep, (band - cardH) / (count - 1 || 1));
  const start = bandTop + Math.max(0, (band - span(step)) / 2);
  return Array.from({ length: count }, (_, i) => Math.round(start + i * step));
}

export interface FlowResult {
  nodes: Node[];
  edges: Edge[];
}

export function sceneToFlow(
  scene: Scene,
  detail: Detail,
  opts: {
    local: boolean;
    provider: string;
    model: string;
    systemPrompt?: string;
    lang?: Lang;
    /** edu: drop the "your mac" + "outside" frames + boundary + external services
     *  (a scenario lesson never crosses the boundary), keeping only the OS band —
     *  the map is tighter, so the camera zooms the actual cards in bigger. */
    declutter?: boolean;
    /** edu: reserve this many subagent slots (the lesson's max), so a worker never
     *  slides down as its siblings spawn — its slot is fixed from the first frame. */
    subSlots?: number;
    /** ExpandAll shells: every card renders WIDE and tall, so the seats spread
     *  by what EXPANDED_CARD says those cards occupy — sideways for the agent,
     *  the worker column and the right-hand world, downwards for the OS band and
     *  the outside stations. Compact keeps the hand-authored seats untouched. */
    expanded?: boolean;
  },
): FlowResult {
  const L = opts.local ? LAYOUTS.local : LAYOUTS.remote;
  const lang: Lang = opts.lang ?? "en";
  const declutter = opts.declutter ?? false;
  // Expanded seating (never combined with the edu declutter camera, which has
  // its own, shell-sized seats): every seat is derived from EXPANDED_CARD, so
  // the map spreads by exactly what the OPEN cards need —
  //   · the agent starts right of the wide user card, so the prompt rail is a
  //     forward hop instead of a line running back across the agent;
  //   · the worker column starts right of the wide agent card;
  //   · the whole right-hand world (boundary · LLM · outside) starts right of
  //     the worker column;
  //   · the OS band and the outside stations drop below the tall agent and LLM
  //     cards, and the frames grow by the same amount.
  const posL: Record<string, XY> = { ...L.pos };
  // The grid's slot count is needed before the frames are sized: expanded, the
  // workers stack deeper than anything else on the map, so the frames follow
  // them. Seats are a grid since card 287 — rows first, columns as needed, the
  // seat of worker i fixed by i alone so a card never moves once it is drawn.
  const isExpanded = !declutter && opts.expanded === true;
  const seatRows = isExpanded ? SEAT_ROWS_EXPANDED : SEAT_ROWS_COMPACT;
  const seatCeiling = isExpanded ? SEATS_MAX_EXPANDED : SEATS_MAX_COMPACT;
  const subsOnMap = scene.subagents.slice(0, seatCeiling);
  const slotCount = Math.min(seatCeiling, Math.max(subsOnMap.length, opts.subSlots ?? subsOnMap.length));
  const grid = seatGrid(slotCount, seatRows);
  let subColPitch = COMPACT_SUB_W + SUB_MIN_GAP;
  let spread = 0;
  let vSpread = 0;
  let bandGrow = 0;
  let colGrow = 0;
  let subBaseL: XY = L.subBase;
  let subGapL = L.subGap;
  let subCardH = SUB_H;
  let subBandBottom = SUB_BAND_BOTTOM;
  if (isExpanded) {
    const agentX = L.pos.user.x + EXPANDED_CARD.user.w + EXP_GAP;
    const subX = agentX + EXPANDED_CARD.agent.w + EXP_GAP;
    // The leftmost thing in the right-hand world sets the shift for all of it:
    // remote that is the boundary wall, local it is the LLM inside the machine.
    const rightWorld = Math.min(
      L.boundary?.x ?? Number.POSITIVE_INFINITY,
      L.pos.llm.x,
      L.pos.netz.x,
      L.pos.mcpserver.x,
    );
    // The grid's right edge plus rail room: subX + cols * (card + gap). With
    // one column this is exactly the single-column shift it replaces.
    subColPitch = EXPANDED_CARD.subagent.w + EXP_GAP;
    spread = Math.max(0, subX + grid.cols * subColPitch - rightWorld);
    vSpread = Math.max(
      0,
      L.pos.agent.y + EXPANDED_CARD.agent.h + EXP_GAP - OS_BAND_TOP,
      L.pos.llm.y + EXPANDED_CARD.llm.h + EXP_GAP - L.pos.netz.y,
    );
    // An open station (the shell with a running command, the MCP client with its
    // call) is taller than the band was drawn for, so the band grows to hold it.
    const tallestStation = Math.max(
      ...["os-disk", "os-shell", "os-mcp", "os-net"].map((id) => EXPANDED_CARD[id].h),
    );
    bandGrow = Math.max(0, OS_STATION_DY + tallestStation + 20 - OS_BAND_H);
    posL.agent = { x: agentX, y: L.pos.agent.y };
    for (const id of ["llm", "netz", "mcpserver"]) posL[id] = { ...posL[id], x: posL[id].x + spread };
    for (const id of ["netz", "mcpserver", "os-disk", "os-shell", "os-mcp", "os-net"]) {
      posL[id] = { ...posL[id], y: posL[id].y + vSpread };
    }
    subBaseL = { x: subX, y: L.subBase.y };
    // The worker column is the only place two cards of the SAME kind sit above
    // each other, so its pitch is the one seat that has to come from the card's
    // own envelope rather than from a neighbour's: envelope plus the same rail
    // room every other expanded seat leaves. Anything shorter seats the next
    // worker's header on the previous worker's order.
    subCardH = EXPANDED_CARD.subagent.h;
    subGapL = subCardH + EXP_GAP;
    // The column at that pitch is deeper than the OS band it used to dodge, and
    // it no longer shares a column with the band anyway (it sits right of the
    // wide agent). So it gets the room it needs instead of being clamped into
    // room it does not have — a clamp here is how the cards ended up stacked.
    // Depth follows the grid's ROWS — a second column adds width, not depth.
    subBandBottom = subBaseL.y + Math.max(0, grid.rows - 1) * subGapL + subCardH;
    const macFrame = L.zones.find((z) => z.variant === "mac");
    colGrow = macFrame ? Math.max(0, subBandBottom + FRAME_PAD - (macFrame.y + macFrame.h)) : 0;
  } else if (!declutter && grid.cols > 1) {
    // Compact grows sideways too: a second worker column would otherwise run
    // into the boundary (remote) or the in-machine LLM (local). Same shift
    // rule as expanded — the right-hand world clears the grid's right edge.
    const rightWorld = Math.min(
      L.boundary?.x ?? Number.POSITIVE_INFINITY,
      L.pos.llm.x,
      L.pos.netz.x,
      L.pos.mcpserver.x,
    );
    spread = Math.max(0, L.subBase.x + grid.cols * subColPitch - rightWorld);
    for (const id of ["llm", "netz", "mcpserver"]) posL[id] = { ...posL[id], x: posL[id].x + spread };
  }
  // Frames hold whichever runs deeper: the drop below the tall agent/llm cards,
  // or the worker column.
  const frameGrow = Math.max(vSpread + bandGrow, colGrow);
  const zonesL: Zone[] = L.zones.map((z) =>
    spread === 0 && frameGrow === 0
      ? z
      : z.variant === "mac"
        ? { ...z, w: z.w + spread, h: z.h + frameGrow }
        : z.variant === "outside"
          ? { ...z, x: z.x + spread, h: z.h + frameGrow }
          : { ...z, y: z.y + vSpread, h: z.h + bandGrow },
  );
  const boundaryL =
    L.boundary && (spread > 0 || frameGrow > 0)
      ? { ...L.boundary, x: L.boundary.x + spread, h: L.boundary.h + frameGrow }
      : L.boundary;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // ----- zones (non-interactive background) -----
  const ZONE_LABEL: Record<Zone["variant"], string> = {
    mac: t(lang, "map.zone.mac"),
    os: t(lang, "map.zone.os"),
    outside: t(lang, "map.zone.outside"),
  };
  for (const z of zonesL) {
    // edu declutter: keep only the OS band; the "your mac" + "outside" frames go.
    if (declutter && z.variant !== "os") continue;
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
  if (boundaryL && !declutter) {
    nodes.push({
      id: "z-boundary",
      type: "zone",
      position: { x: boundaryL.x, y: boundaryL.y },
      data: { variant: "boundary", label: t(lang, "map.zone.boundary") },
      draggable: false,
      selectable: false,
      zIndex: 1,
      style: { width: 20, height: boundaryL.h },
    });
  }

  // edu: every card is EXPANDED (wide + tall), so the sim's tight diagonal layout
  // is re-seated to a clean LEFT-TO-RIGHT reading, so the user->agent rail is a
  // short horizontal hop and never crosses the map:
  //  - the user sits in its OWN left column, its right edge clear of the wide
  //    agent's x-range (so the rail reads left-to-right, not back across);
  //  - the agent is the centre;
  //  - the llm is on the right, pushed further out only when the lesson fans out
  //    to workers, which then occupy the middle-right column between the two.
  // A local override, never a mutation of the shared (sim-facing) layout.
  const hasWorkers = (opts.subSlots ?? 0) > 0;
  const EDU_POS: Record<string, XY> = {
    user: { x: 20, y: 180 },
    agent: { x: 440, y: 40 },
    llm: hasWorkers ? { x: 1420, y: 120 } : { x: 1040, y: 120 },
  };
  const subBaseX = 1020; // the worker column sits right of the wide agent (ends ~980)
  const posOf = (id: string): XY => (declutter && EDU_POS[id]) || posL[id];
  const N = (id: string, type: string, data: Record<string, unknown>, z = 10) =>
    nodes.push({ id, type, position: posOf(id), data, zIndex: z });

  // ----- user -----
  N("user", "user", { active: scene.focus === "user", prompt: detail.prompt });

  // ----- agent hub -----
  const mainAct = activity(
    scene.focus,
    scene.disk,
    scene.activeFile,
    scene.activeCommand,
    scene.activeMcp,
    scene.gate,
    lang,
    scene.activeTool,
  );
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
    tool: detail.tool[detail.root] ?? null,
    genImage: detail.genImage[detail.root] ?? null,
    attached: detail.attached[detail.root] ?? null,
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
  N("os-disk", "os", {
    kind: "disk",
    active: atDisk !== undefined,
    disk: atDisk?.loop.disk ?? "idle",
    file: atDisk?.loop.activeFile ?? null,
    by: stationUsers(scene, "disk"),
  });
  N("os-shell", "os", {
    kind: "shell",
    active: atCmd !== undefined,
    command: atCmd?.loop.activeCommand ?? null,
    by: stationUsers(scene, "cmd"),
  });
  N("os-mcp", "os", {
    kind: "mcp",
    active: mcpInUse,
    mcp: mcpUser?.loop.activeMcp ?? null,
    tool: mcpTool?.name?.startsWith("mcp__") ? mcpTool : null,
    by: stationUsers(scene, "mcp"),
  });
  N("os-net", "os", { kind: "net", active: mcpInUse });

  // ----- LLM ----- (the SHARED model — it works for main and every subagent,
  // so it animates and streams for whichever agent is at it right now)
  const llmBusy = scene.focus === "llm" || scene.subagents.some((c) => c.focus === "llm");
  const streamsOf = (rec: Record<string, string>): AgentStream[] =>
    [detail.root, ...scene.subagents.map((c) => c.id)]
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

  // ----- external services ----- (edu declutter drops the whole "outside")
  if (!declutter) {
    N("netz", "ext", { kind: "netz", active: mcpInUse });
    N("mcpserver", "ext", { kind: "mcpserver", active: mcpInUse, mcp: mcpUser?.loop.activeMcp ?? null });
  }

  // ----- subagents (each its own loop) -----
  // slotCount reserves a fixed slot per subagent (edu passes the lesson's max) so
  // a worker never slides as siblings spawn; it falls back to the live count for
  // the sim, and the frames above are already sized for it.
  const subs = subsOnMap;
  // One shared row ladder for every column: the y of seat (row, col) is the y
  // of that row — a sibling in a second column never re-centres the first.
  const subYs = subagentYs(grid.rows, subBaseL.y, subBandBottom, subGapL, subCardH);
  subs.forEach((c, i) => {
    const id = `sub-${c.id}`;
    const seat = seatOf(i, seatRows);
    posL[id] = {
      x: (declutter ? subBaseX : subBaseL.x) + seat.col * subColPitch,
      y: subYs[seat.row] ?? subBaseL.y,
    };
    const act = activity(
      c.focus,
      c.disk,
      c.activeFile,
      c.activeCommand,
      c.activeMcp,
      c.gate,
      lang,
      c.activeTool,
    );
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
    id: string,
    source: string,
    target: string,
    sh: string,
    th: string,
    active: boolean,
    opt: { net?: boolean; err?: boolean; dim?: boolean; flow?: boolean } = {},
  ) => {
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
        flow: opt.flow ?? active,
      },
      zIndex: active ? 1001 : 1,
    });
  };

  const mainLit = FOCUS_NODE[scene.focus];
  const litUserAgent = scene.focus === "agent" || scene.focus === "gate" || scene.focus === "user";
  E("e-user-agent", "user", "agent", "rs", "lt", litUserAgent, {
    err: scene.isError && scene.focus === "user",
  });
  E("e-agent-llm", "agent", "llm", "rs", "lt", mainLit === "llm", { net });
  E("e-agent-osdisk", "agent", "os-disk", "bs", "tt", mainLit === "os-disk");
  E("e-agent-osshell", "agent", "os-shell", "bs", "tt", mainLit === "os-shell");
  // The MCP call rides the whole chain and lights it end to end while in use:
  //   <caller> → MCP-client → network stack →⟂ Netz → MCP-server
  // The first leg belongs to the CALLING agent (main's rail or the child's
  // own rail below); the chain from the client outward is shared.
  const mcpErr = !!mcpUser?.loop.isError;
  const mainOnMcp = scene.activeMcp !== null;
  E("e-agent-osmcp", "agent", "os-mcp", "bs", "tt", mainLit === "os-mcp" || mainOnMcp, {
    err: mcpErr && mcpUser?.id === "main",
  });
  E("e-osmcp-osnet", "os-mcp", "os-net", "rs", "lt", mcpInUse, { err: mcpErr });
  if (!declutter) {
    // the legs out to Netz + MCP-Server only exist when the "outside" is drawn.
    E("e-osnet-netz", "os-net", "netz", "rs", "lt", mcpInUse, { net: true, err: mcpErr });
    E("e-netz-mcpserver", "netz", "mcpserver", "rs", "lt", mcpInUse, { net: true, err: mcpErr });
  }

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

  // Only the expanded map has envelopes to check against; compact cards are the
  // small ones these numbers do not describe.
  if (!declutter && opts.expanded === true) reportSeatCollisions(nodes as SeatNode[]);
  return { nodes, edges };
}
