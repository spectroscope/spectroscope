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
import {
  SEAT_ROWS_COMPACT,
  SEATS_MAX_COMPACT,
  SEATS_MAX_EXPANDED,
  rowsFor,
  type RowsPref,
  seatGrid,
  seatOf,
  type SeatPool,
} from "./workerGrid";
import { osBandWidth, stationSeats } from "./stationSeats";
import { RAIL_GAP, SUB_CARD_H, SUB_CARD_W } from "./cardGeometry";

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
  /** Each agent's own launch brief — its run_start.prompt (card 287). */
  briefs: Record<string, string>;
  /** Each agent's own model, ONLY when its run_start named one. An agent with
   *  no model on the wire stays absent — never inherited (card 287). */
  models: Record<string, string>;
  /**
   * Per-agent context spend off the usage events (card 287). The context size
   * of one turn is inputTokens + cacheReadTokens + cacheCreationTokens — the
   * wire's own contract says inputTokens is the RAW uncached remainder and the
   * true context is the sum. `peak` keeps the MAXIMUM, not the last value,
   * because a window can be compacted downward mid-run and the reader is being
   * shown how big it got. `turns` counts the usage events.
   */
  spend: Record<string, { peak: number; turns: number }>;
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
    briefs: {},
    models: {},
    spend: {},
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
        d.briefs[e.agentId] = e.prompt;
        if (e.model !== undefined) d.models[e.agentId] = e.model;
        if (e.agentId === d.root) d.prompt = e.prompt;
        break;
      case "usage": {
        const size = e.inputTokens + (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0);
        const had = d.spend[e.agentId] ?? { peak: 0, turns: 0 };
        d.spend[e.agentId] = { peak: Math.max(had.peak, size), turns: had.turns + 1 };
        break;
      }
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
  // The full worker card (card 287): the 680-wide agent instrument under the
  // fixed 0.6 zoom paints 408 wide. Card 296 took the height out of this table
  // and into cardGeometry.ts, MEASURED in a browser and shared with the row
  // derivation in workerGrid — the two used to be the same number written
  // twice with nothing holding them together.
  subagent: { w: SUB_CARD_W, h: SUB_CARD_H },
  // The machine room feeds the SAME card a node's order and its status history,
  // so an open fleet card runs about twice as tall as a worker card here (293
  // measured on a four-phase fleet).
  "fleet-card": { w: 216, h: 300 },
  ext: { w: 150, h: 110 },
  // The stations grew (card 287): sized so an ACTIVE station's content is
  // legible without opening a disclosure — the command line whole, the MCP
  // call readable. Starting values from a downstream measurement (shell fully
  // visible went 10.5% → 75.4% of open steps there); the card's browser pass
  // re-measures them here and replaces the numbers. Expanded seats derive
  // from these via stationSeats, so widening moves neighbours, never overlaps.
  "os-disk": { w: 260, h: 240 },
  "os-shell": { w: 460, h: 340 },
  "os-mcp": { w: 500, h: 340 },
  "os-net": { w: 104, h: 100 },
};

/** Rail room between two expanded cards — one source with the row derivation
 *  (cardGeometry.RAIL_GAP), re-exported under the name the layout uses. */
export const EXP_GAP = RAIL_GAP;

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

/**
 * The tallest each card has ever been measured at, for the under-fill arm.
 *
 * The peak, not the last reading: a run whose first worker is bare and whose
 * second carries four pictures would otherwise be reported as over-reserved on
 * the strength of the bare one, and the seat has to hold the second.
 */
const tallest = new Map<string, number>();

/**
 * Cards whose SEAT reserves at least twice the tallest card that ever stood in
 * it — the arm oversizeCards is blind to by construction.
 *
 * A seat is derived from an envelope, and an envelope that is far too GENEROUS
 * fails as quietly as one that is too small: nothing overlaps, so nothing
 * shows, and the map simply spreads into room no card ever needed. That is the
 * defect the owner reported on card 296 — a 620px row for a card measured at
 * 304 — and the check that existed could not have seen it.
 *
 * Twice is not a taste: at twice the card, the air under it is the card again.
 */
export function underfilledCards(
  measured: Iterable<{ id: string; type?: string; h: number }>,
): { id: string; h: number; bound: number }[] {
  const out: { id: string; h: number; bound: number }[] = [];
  for (const m of measured) {
    const env = envelopeOf(m.id, m.type);
    // h <= 0 is "not laid out yet", not "a card of no height".
    if (env === undefined || m.h <= 0) continue;
    const peak = Math.max(tallest.get(m.id) ?? 0, m.h);
    tallest.set(m.id, peak);
    if (peak * 2 <= env.h) out.push({ id: m.id, h: peak, bound: env.h });
  }
  return out.sort((a, b) => b.bound - b.h - (a.bound - a.h));
}

/**
 * The rendered nodes, as the envelope check reads them: zones dropped (a frame
 * has no envelope) and anything the browser has not measured yet dropped too.
 *
 * Its own function so the wiring in FlowMap is one line and these rules are
 * under the gate. Two of them are traps:
 *
 *  · a hidden pane delivers no frames, so `measured` stays undefined there —
 *    a zero must read as "not laid out", never as a card of no height;
 *  · COMPACT is not this table's world. Only the expanded seating derives from
 *    EXPANDED_CARD; compact seats are hand-authored and its cards are a third
 *    the size, so running the check there would report every worker as
 *    over-reserved and be wrong about all of them.
 *
 * @param nodes what the canvas rendered, with whatever it has measured
 * @param expanded the seating these nodes came from
 */
export function measuredCards(
  nodes: readonly { id: string; type?: string; measured?: { height?: number } }[],
  expanded: boolean,
): { id: string; type?: string; h: number }[] {
  if (!expanded) return [];
  const out: { id: string; type?: string; h: number }[] = [];
  for (const n of nodes) {
    if (n.type === "zone") continue;
    const h = n.measured?.height ?? 0;
    if (h > 0) out.push({ id: n.id, type: n.type, h });
  }
  return out;
}

const spoken = new Set<string>();

/**
 * The runtime half: hand it the heights the browser actually laid out and it
 * names every card that no longer fits the envelope its neighbours were seated
 * around — and, since card 296, every seat that reserves more than twice the
 * card it holds. Once per card — a layout that runs per frame would otherwise
 * shout per frame, and a report nobody can read is the silence it was meant to
 * break.
 */
export function reportOversizeCards(
  measured: Iterable<{ id: string; type?: string; h: number }>,
  /**
   * Where a finding goes. The two arms are not the same severity and the
   * default says so: a card OVER its seat draws on top of its neighbour and is
   * a defect; a seat holding air is a design smell that costs spread and
   * nothing else. Live on the "scaling fan-out" scenario the under-fill arm
   * named five seats in its first run — all of them true, none of them broken
   * — and five console errors would have read as breakage.
   */
  sink: (message: string, kind: "over" | "under") => void = (m, kind) =>
    kind === "over" ? console.error(m) : console.warn(m),
): { over: { id: string; h: number; bound: number }[]; under: { id: string; h: number; bound: number }[] } {
  const seen = [...measured];
  const over = oversizeCards(seen);
  for (const c of over) {
    if (spoken.has(`size:${c.id}`)) continue;
    spoken.add(`size:${c.id}`);
    sink(
      `flow map: the ${c.id} card rendered ${c.h}px tall against an envelope of ${c.bound}px — ` +
        `every seat derived from it is ${c.h - c.bound}px short, so cards will overlap.`,
      "over",
    );
  }
  const under = underfilledCards(seen);
  for (const c of under) {
    if (spoken.has(`slack:${c.id}`)) continue;
    spoken.add(`slack:${c.id}`);
    sink(
      `flow map: the tallest ${c.id} card measured ${c.h}px against an envelope of ${c.bound}px — ` +
        `every seat derived from it reserves more than twice the card, so the map spreads into ` +
        `${c.bound - c.h}px per seat that nothing ever fills.`,
      "under",
    );
  }
  return { over, under };
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
 *  - the preferred top-to-top spacing (subGap) is used as-is — the caller
 *    always hands a band it fits (see below);
 *  - the whole group centered in its band.
 * Result: one agent lands centered, two as a centered pair, three fill the band
 * evenly, and the spacing is identical whether one arrives before the others.
 *
 * There used to be a clamp here ("if span > band, shrink the step") and it was
 * measured dead in both modes (card 292): expanded derives subBandBottom as
 * subBase.y + (rows-1)*subGapL + subCardH, so band == span exactly; compact
 * caps rows at three, so span <= 2*180 + 132 = 492 against a band of
 * 630 - 110 = 520. A guard that pretends to protect and cannot fire is worse
 * than none — a real overflow belongs to the seat-collision report, which says
 * so out loud instead of silently squeezing cards into each other.
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
  const span = (count - 1) * preferredGap + cardH;
  const start = bandTop + Math.max(0, (band - span) / 2);
  return Array.from({ length: count }, (_, i) => Math.round(start + i * preferredGap));
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
    /** The seat pool folded over the SAME applied prefix as the scene (card
     *  292): seats say what was concurrent, each seat shows its last assignee,
     *  and an ended child yields its seat to a later one. Without it the
     *  legacy lifetime seating stands — the edu sim has no event prefix. */
    pool?: SeatPool;
    /** The pane's width/height, measured by FlowMap (card 292): expanded rows
     *  derive from it so the grid fills the space it has. A hidden pane never
     *  measures — absent, the constant row count stands and nothing breaks
     *  headless or in tests. */
    paneAspect?: number | null;
    /** The reader's row choice (card 296). `auto` — the default — derives the
     *  rows from the seats and the measured pane exactly as before; a number
     *  holds the grid at that depth. */
    rowsPref?: RowsPref;
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
  const seatCeiling = isExpanded ? SEATS_MAX_EXPANDED : SEATS_MAX_COMPACT;
  // With a pool (card 292) the map draws each seat's CURRENT occupant: an
  // ended child keeps its seat only until a later child takes it, and the grid
  // is sized by the peak concurrency, not the lifetime count. Without a pool
  // (the edu sim has no event prefix) the lifetime seating stands unchanged.
  const pool = opts.pool;
  const subsOnMap =
    pool !== undefined
      ? scene.subagents.filter((c) => {
          const s = pool.seat[c.id];
          return s !== undefined && s < seatCeiling && pool.occupant[s] === c.id;
        })
      : scene.subagents.slice(0, seatCeiling);
  const seatsInUse = pool !== undefined ? Math.min(pool.occupant.length, seatCeiling) : subsOnMap.length;
  const slotCount = Math.min(seatCeiling, Math.max(seatsInUse, opts.subSlots ?? seatsInUse));
  // Expanded rows follow the seats in use and the measured pane (card 292);
  // with no measurement the constant stands. Compact keeps its three rows.
  const seatRows = isExpanded
    ? rowsFor(slotCount, opts.paneAspect, opts.rowsPref ?? "auto")
    : SEAT_ROWS_COMPACT;
  const grid = seatGrid(slotCount, seatRows);
  let subColPitch = COMPACT_SUB_W + SUB_MIN_GAP;
  /** Expanded only: the band width derived from the widened stations. */
  let osBandW: number | null = null;
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
    // The widened stations re-seat left-to-right from their own envelopes, and
    // the band width follows them (stationSeats — the derivation that replaced
    // the hand-written seats).
    const stationIds = ["os-disk", "os-shell", "os-mcp", "os-net"] as const;
    const stationWs = stationIds.map((sid) => EXPANDED_CARD[sid].w);
    const stationXs = stationSeats(stationWs);
    stationIds.forEach((sid, i) => {
      posL[sid] = { ...posL[sid], x: stationXs[i] };
    });
    osBandW = osBandWidth(stationWs);
    const osZone = L.zones.find((z) => z.variant === "os")!;
    // The worker column starts clear of BOTH the wide agent card and the
    // band's right edge — the band sits below user+agent and now runs wider
    // than the agent, so a column keyed to the agent alone would stand on the
    // stations (the seat guards caught exactly that).
    const subX = Math.max(agentX + EXPANDED_CARD.agent.w + EXP_GAP, osZone.x + osBandW + EXP_GAP);
    // The leftmost thing in the right-hand world sets the shift for all of it:
    // remote that is the boundary wall, local it is the LLM inside the machine.
    const rightWorld = Math.min(
      L.boundary?.x ?? Number.POSITIVE_INFINITY,
      L.pos.llm.x,
      L.pos.netz.x,
      L.pos.mcpserver.x,
    );
    // The grid's right edge plus rail room: subX + cols * (card + gap). With
    // one column this is exactly the single-column shift it replaces. The mac
    // frame must hold the band even with no worker column (zero workers), so
    // the spread takes whichever need is larger.
    subColPitch = EXPANDED_CARD.subagent.w + EXP_GAP;
    const macFrameW = L.zones.find((z) => z.variant === "mac")?.w ?? 0;
    const bandNeed = osZone.x + osBandW + FRAME_PAD - macFrameW;
    spread = Math.max(0, subX + grid.cols * subColPitch - rightWorld, bandNeed);
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
    spread === 0 && frameGrow === 0 && osBandW === null
      ? z
      : z.variant === "mac"
        ? { ...z, w: z.w + spread, h: z.h + frameGrow }
        : z.variant === "outside"
          ? { ...z, x: z.x + spread, h: z.h + frameGrow }
          : { ...z, y: z.y + vSpread, h: z.h + bandGrow, ...(osBandW !== null ? { w: osBandW } : {}) },
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
    // The pool's seat index survives the churn around a child; the lifetime
    // index is the poolless fallback.
    const seat = seatOf(pool?.seat[c.id] ?? i, seatRows);
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
      // Expanded, a worker is the agent's own card with the child's data
      // (card 287). Compact data stays byte-identical to what shipped.
      ...(isExpanded
        ? {
            full: {
              error: c.isError,
              gate: c.gate,
              gateNote: gateNote(c.gate, lang),
              gateColor: GATE_COLOR[c.gate],
              activeTool: c.activeTool,
              tool: detail.tool[c.id] ?? null,
              genImage: detail.genImage[c.id] ?? null,
              attached: detail.attached[c.id] ?? null,
              brief: detail.briefs[c.id] ?? null,
              model: detail.models[c.id] ?? null,
              spend: detail.spend[c.id] ?? null,
            },
          }
        : {}),
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
