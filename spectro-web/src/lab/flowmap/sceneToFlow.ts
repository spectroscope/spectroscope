// The pure mapping layer: a folded Scene (from the REAL labScene reducer) plus a
// little derived Detail (context/tool-input/streamed text, for the expandable
// sections) become React Flow nodes + edges. This is the direct analogue of the
// existing graph/buildGraph.ts — no React, no @xyflow here; SystemFlow.tsx just
// renders whatever this returns. Positions are hand-authored per layout so the
// local/remote flip literally re-places the LLM inside vs. outside "Dein Mac".

import type { Edge, Node } from "@xyflow/react";
import { ROOT_AGENT } from "../labScene";
import type { DiskState, Focus, GateState, Scene, SubagentInfo } from "../labScene";
import type { RunEvent } from "../../events";
import type { AgentDirectory } from "../agentDirectory";
import { t, type Lang } from "../../i18n/i18n";
import { imageUrl } from "./imageUrl";
import { stationOccupants, type Station, type StationOccupant } from "./stationUsers";
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
import { workflowBoxLayout, type BoxLayout } from "./workflowBox";
import { orderParentsFirst, worldBoxes } from "./worldBox";
import type { WorkflowDeclaration } from "../workflowGraph";
import { RAIL_GAP, SUB_CARD_H, SUB_CARD_W } from "./cardGeometry";
import { stationLane } from "./railRoute";

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
  ctxTotals: {
    messages: number;
    estimatedTokens: number;
    threshold: number;
    /** Which fact produced `threshold` (card 300). Absent when the frame said
     *  nothing — which is not the same as "fallback", and the difference is
     *  exactly what a percentage may honestly be built on. */
    thresholdSource?: "override" | "window" | "fallback";
  } | null;
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
          d.ctxTotals = {
            messages: e.messages,
            estimatedTokens: e.estimatedTokens,
            threshold: e.threshold,
            ...(e.thresholdSource === undefined ? {} : { thresholdSource: e.thresholdSource }),
          };
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
  boundary: { x: number; y: number; h: number };
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
  /** CARD 306: the seat this ONE node was actually given, where its type does
   *  not say. A workflow box carries its own switch, so a member of a box
   *  thrown minimal is a 216x132 card at the minimal pitch while every other
   *  subagent on the same expanded map is 408x480 — and judged by the type
   *  alone it reads as five cards lying on top of each other. Measured in the
   *  running app: twenty such reports on the shipped scenario, none of them
   *  true, which costs more than the check is worth because the next real one
   *  is now one line among twenty. */
  env?: { w: number; h: number };
}
const envelopeOf = (n: SeatNode) => n.env ?? EXPANDED_CARD[n.id] ?? EXPANDED_CARD[n.type ?? ""];

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
      const env = envelopeOf(n);
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
    const env = envelopeOf({ id: m.id, type: m.type, position: { x: 0, y: 0 } });
    if (env !== undefined && m.h > env.h) out.push({ id: m.id, h: m.h, bound: env.h });
  }
  return out.sort((a, b) => b.h - b.bound - (a.h - a.bound));
}

/**
 * The envelopes the under-fill arm watches.
 *
 * Card 296 corrected exactly ONE — the worker seat — and the arm that found it
 * names five more the moment it is let loose: the agent hub reserves 780 for a
 * card that measured 364, llm 540 for 168, os-shell and os-mcp 340 for 65,
 * os-disk 240 for 104. Every one of those readings is TRUE and none of them is
 * broken, so widening the arm to all of them would ship it already shouting —
 * six standing warnings out of the box, burying the first real finding exactly
 * the way this check's missing caller buried it for two cards.
 *
 * So the arm watches what this card measured. Widening it belongs to whichever
 * card corrects the next envelope, one at a time, with its own measurement.
 */
export const UNDER_WATCHED_TYPES: ReadonlySet<string> = new Set(["subagent"]);

/**
 * How long a watched envelope's tallest card has to stand still before the
 * under-fill arm believes it.
 *
 * The re-review's find: judging a card the frame it appears cannot work, and
 * no peak map can rescue it. A bare worker card measures 237.59 world px, so
 * 237.59 * 2 <= 480 the instant a worker is laid out — the FIRST reading is
 * the peak, and the card only grows afterwards (304 typical, 423 with four
 * pictures). Peak-per-id protects tall-then-short, which is the one order a
 * real run cannot produce first.
 *
 * A settled reading can. The caller reports twice: once now, for the oversize
 * arm, which is a defect and must be loud immediately — and once more after
 * the layout has not moved for this long, which is the only call the under
 * arm can ever speak on.
 */
export const UNDER_SETTLE_MS = 3000;

/**
 * The tallest card ever measured in each WATCHED envelope, and since when.
 *
 * Per envelope, not per card id — the docstring this replaces promised "a run
 * whose first worker is bare and whose second carries four pictures must not
 * be reported on the strength of the bare one", and that sentence is about two
 * DIFFERENT ids, which a per-id map can say nothing about. One seat shape, one
 * peak.
 *
 * `since` is the clock the settle window runs on: it restarts whenever the
 * peak grows, so a card that is still filling up never reports.
 */
const peaks = new Map<string, { envelope: string; peak: number; since: number }>();

/** What either arm has already said, keyed `size:<id>` / `slack:<envelope>`
 *  — a layout runs per frame and a report nobody can read is the silence
 *  this check was built to break. */
const spoken = new Set<string>();

/** Envelopes the under arm has already spoken about, so it speaks once. */
const warnedUnder = new Set<string>();

/**
 * A watched envelope whose tallest settled card fills at most half of it.
 *
 * A seat is derived from an envelope, and an envelope that is far too GENEROUS
 * fails as quietly as one that is too small: nothing overlaps, so nothing
 * shows, and the map simply spreads into room no card ever needed. That is the
 * defect the owner reported on card 296 — a 620px row for a card measured at
 * 304 — and the check that existed could not have seen it.
 *
 * Twice is not a taste: at twice the card, the air under it is the card again.
 *
 * The envelope is read by TYPE, never by id: this arm judges a seat SHAPE that
 * many cards share, and envelopeOf's id-first lookup would tie the verdict to
 * whichever card happens to share a name with an envelope.
 *
 * @param measured what the browser laid out this pass
 * @param now the clock the settle window runs on; injected so the gate can
 *            move it instead of sleeping
 */
export function underfilledCards(
  measured: Iterable<{ id: string; type?: string; h: number }>,
  now: number = Date.now(),
): { envelope: string; peak: number; bound: number }[] {
  for (const m of measured) {
    const type = m.type ?? "";
    // h <= 0 is "not laid out yet", not "a card of no height".
    if (!UNDER_WATCHED_TYPES.has(type) || m.h <= 0 || EXPANDED_CARD[type] === undefined) continue;
    // The key is the ENVELOPE, not the card. Keyed by id, the second worker's
    // four pictures could never clear the first worker's bare reading.
    const key = type;
    const seen = peaks.get(key);
    if (seen === undefined || m.h > seen.peak) peaks.set(key, { envelope: type, peak: m.h, since: now });
  }
  const out: { envelope: string; peak: number; bound: number }[] = [];
  for (const seen of peaks.values()) {
    const env = EXPANDED_CARD[seen.envelope];
    if (env === undefined || now - seen.since < UNDER_SETTLE_MS) continue;
    if (seen.peak * 2 <= env.h) out.push({ envelope: seen.envelope, peak: seen.peak, bound: env.h });
  }
  return out.sort((a, b) => b.bound - b.peak - (a.bound - a.peak));
}

/**
 * Envelopes the arm reported and the run has since disproved — a card taller
 * than half the seat finally stood in one.
 *
 * The re-review's other half: a report that can never be withdrawn is worse
 * than no report, because the reader learns to ignore the channel. A worker
 * that sits bare past the settle window and only then picks up a tool is an
 * ordinary run, not a corner case.
 */
function withdrawnUnder(): { envelope: string; peak: number; bound: number }[] {
  const out: { envelope: string; peak: number; bound: number }[] = [];
  for (const envelope of warnedUnder) {
    const seen = peaks.get(envelope);
    const env = EXPANDED_CARD[envelope];
    if (seen === undefined || env === undefined) continue;
    if (seen.peak * 2 > env.h) out.push({ envelope, peak: seen.peak, bound: env.h });
  }
  return out;
}

/**
 * Forget everything both arms have measured and said.
 *
 * A test seam, and it has to be one: the memory is per module, so a suite that
 * shares this module shares the peaks and the once-only locks, and one test's
 * peak would silently decide the next one's verdict.
 */
export function resetEnvelopeMemory(): void {
  spoken.clear();
  peaks.clear();
  warnedUnder.clear();
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
 * It passes every non-zone card through on purpose: the OVERSIZE arm has to
 * see all of them, because any card that outgrows its seat draws over its
 * neighbour. Which envelopes the under-fill arm judges is that arm's own
 * business — UNDER_WATCHED_TYPES — not a filter here.
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

/**
 * The runtime half: hand it the heights the browser actually laid out and it
 * names every card that no longer fits the envelope its neighbours were seated
 * around — and, since card 296, every watched seat that reserves more than
 * twice the card it holds.
 *
 * The two arms speak on different clocks, and the re-review is why. A card
 * OVER its seat is a defect drawing on top of its neighbour: it is said the
 * moment it is seen. A seat holding air is a judgement about a run, and a run
 * that has been going for one frame has nothing to judge — so the under arm
 * speaks only once the tallest card in a watched envelope has stood still for
 * UNDER_SETTLE_MS, and takes it back if the run goes on to disprove it.
 *
 * Once per finding either way.
 *
 * @param measured the heights the browser laid out
 * @param sink where a finding goes
 * @param now the clock the under arm's settle window runs on
 */
export function reportOversizeCards(
  measured: Iterable<{ id: string; type?: string; h: number }>,
  /**
   * The two arms are not the same severity and the default says so: a card
   * OVER its seat draws on top of its neighbour and is a defect; a seat
   * holding air costs spread and nothing else.
   */
  sink: (message: string, kind: "over" | "under") => void = (m, kind) =>
    kind === "over" ? console.error(m) : console.warn(m),
  now: number = Date.now(),
): {
  over: { id: string; h: number; bound: number }[];
  under: { envelope: string; peak: number; bound: number }[];
} {
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
  const under = underfilledCards(seen, now);
  for (const c of under) {
    if (spoken.has(`slack:${c.envelope}`)) continue;
    spoken.add(`slack:${c.envelope}`);
    warnedUnder.add(c.envelope);
    sink(
      `flow map: the tallest ${c.envelope} card measured ${c.peak}px against an envelope of ` +
        `${c.bound}px — every seat derived from it reserves more than twice the card, so the map ` +
        `spreads into ${c.bound - c.peak}px per seat that nothing ever fills.`,
      "under",
    );
  }
  for (const c of withdrawnUnder()) {
    warnedUnder.delete(c.envelope);
    spoken.delete(`slack:${c.envelope}`);
    sink(
      `flow map: withdrawing the under-fill report on the ${c.envelope} envelope — a ${c.peak}px ` +
        `card has since stood in its ${c.bound}px seat.`,
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

// ---------------------------------------------------------------------------
// The layout. ONE geometry (card 304), where there used to be two picked by the
// provider: the LLM inside "your mac" for ollama, outside it for everyone else,
// and — in the local one — no network boundary drawn at all. That branch made
// the map draw a different MACHINE depending on who served the tokens, and the
// fact it was drawing has stopped being one: the internal model now hangs
// behind the agents, and ollama itself serves cloud models, so "local" no
// longer states anything worth a second layout. The LLM is always outside, the
// boundary is always drawn, and the mac zone keeps the full width the workers
// live in.
//
// Everything right of the machine derives from the card sizes rather than from
// pasted seats, so widening a card moves its neighbours instead of landing on
// top of them.
// ---------------------------------------------------------------------------

/**
 * The mac zone's width — the owner's decision, and the one number here that is
 * a decision rather than a derivation. The WORKERS live in this width: card 287
 * gave them a grid up to twelve seats and card 296 tied the seating to the room
 * available, so narrowing it undoes both. Pinned in sceneToFlow.test.ts on the
 * literal, so an edit that shrinks it fails loudly instead of quietly costing
 * seats.
 */
const MAC_W = 1340;
/** The boundary wall as it is drawn — matches the `style.width` its zone gets. */
const BOUNDARY_W = 20;
/** Air either side of the wall, so neither frame touches it. */
const BOUNDARY_GAP = 16;
/** The outside frame's inset around the widest thing it holds. */
const OUTSIDE_PAD = 40;
/** Rail room between Netz and the MCP server, the two that share a row. */
const EXT_GAP = 50;

/** The LLM card's width — flowmap.css pins `.pf-llm` flat at this in BOTH
 *  shells, so the seat can be derived from it either way. */
const LLM_W = EXPANDED_CARD.llm.w;
/** Ditto `.pf-ext` for Netz and the MCP server. */
const EXT_W = EXPANDED_CARD.ext.w;
/** The two external stations side by side. */
const EXT_ROW_W = 2 * EXT_W + EXT_GAP;

const BOUNDARY_X = MAC_W + BOUNDARY_GAP;
const OUTSIDE_X = BOUNDARY_X + BOUNDARY_W + BOUNDARY_GAP;
/** Wide enough for whichever of its two rows is wider — the 440px LLM card, or
 *  the Netz + MCP-Server pair. The local variant's 380 was sized for the pair
 *  alone and would have cut 60px off the model card. */
const OUTSIDE_W = Math.max(LLM_W, EXT_ROW_W) + 2 * OUTSIDE_PAD;

/** The LLM's own row, centred in the frame. */
const LLM_X = OUTSIDE_X + (OUTSIDE_W - LLM_W) / 2;
/** The station row below it, centred as a pair. */
const NETZ_X = OUTSIDE_X + (OUTSIDE_W - EXT_ROW_W) / 2;
const MCPSERVER_X = NETZ_X + EXT_W + EXT_GAP;

// Generous vertical room so an expanded node (context / JSON) never collides with
// the OS band below it, and a tall aspect so wide screens get side margins that
// keep the floating panels off the nodes.
const LAYOUT: Layout = {
  pos: {
    ...COMMON,
    // y240 leaves the expanded card (540 tall) clear of the station row at y660
    // once the expanded vertical spread has run.
    llm: { x: LLM_X, y: 240 },
    netz: { x: NETZ_X, y: 660 },
    mcpserver: { x: MCPSERVER_X, y: 660 },
  },
  zones: [
    { id: "z-mac", x: 0, y: 24, w: MAC_W, h: 900, variant: "mac", label: "AGENTENSYSTEM · DEIN MAC" },
    { id: "z-os", x: 24, y: OS_BAND_TOP, w: 792, h: OS_BAND_H, variant: "os", label: "BETRIEBSSYSTEM" },
    { id: "z-outside", x: OUTSIDE_X, y: 24, w: OUTSIDE_W, h: 900, variant: "outside", label: "AUSSERHALB" },
  ],
  boundary: { x: BOUNDARY_X, y: 24, h: 900 },
  // Centred in the free space right of the agent hub, started higher so the
  // third card clears the OS band.
  subBase: { x: 610, y: 110 },
  subGap: 180,
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
 * CARD 306: the node id of one workflow run's box.
 *
 * Namespaced away from `sub-<agentId>` on purpose — the run itself is a card
 * in the scene (the importer spawns the `Workflow` tool_use as an agent), and
 * the box takes that card's place. Two ids for one run would put it on the map
 * twice.
 */
export function boxNodeId(parentId: string): string {
  return `wfbox-${parentId}`;
}

/** Air between two workflow boxes stacked in the box column. */
const BOX_STACK_GAP = 40;

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
    /** The agent handles folded over the SAME applied prefix as the scene (card
     *  298): the OS stations name their occupant by its stable tag instead of
     *  by its position in the live scene array. Absent — the edu sim has no
     *  event prefix — the local derivation stands. */
    dir?: AgentDirectory;
    /** The reader's row choice (card 296). `auto` — the default — derives the
     *  rows from the seats and the measured pane exactly as before; a number
     *  holds the grid at that depth. */
    rowsPref?: RowsPref;
    /**
     * CARD 306: what each workflow run declared about itself, keyed by the
     * node that run hangs on — the same map card 302 built for the lens.
     *
     * It never reached this file before: the lens got it and the map did not,
     * so the map drew a run's thirteen agents as thirteen loose cards in the
     * concurrency pool with nothing saying which phase any of them ran in.
     * Absent — the live run, the edu sim, an import that carried no state
     * file — and the map is exactly what it always was.
     */
    declared?: WorkflowDeclaration;
    /**
     * CARD 306: the boxes whose switch the reader has thrown, by box node id.
     *
     * Per BOX, which the global ExpandAllContext cannot be: the owner asked
     * for a switch on the box, and a session can hold five of them. A box not
     * named here follows the global switch, so the global one keeps working
     * unchanged.
     */
    boxExpanded?: ReadonlySet<string>;
    /** What a box's own switch calls. Absent = the switch is not offered. */
    onToggleBox?: (boxId: string) => void;
  },
): FlowResult {
  const L = LAYOUT;
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
  // CARD 306 — THE BOXES, laid out before anything is seated.
  //
  // Their interiors are pure geometry (workflowBox.ts) and depend on nothing
  // the seating decides, so they can be known first — which is what lets the
  // worker column, the frames and the OS band be sized around them instead of
  // on top of them.
  //
  // A declaration about a run the scene has not drawn is skipped: the box
  // stands where the run's own card stands, and a box for a card the reader
  // has not reached would be a claim about a run that is not on screen.
  //
  // ON SCREEN IS TWO CARDS, NOT ONE, and asking only about the first is why no
  // scenario ever drew a box. A declaration hangs on the node its agents were
  // spawned under. For an imported run that node is the `Workflow` tool_use's
  // own child card, so it is in `scene.subagents`. For everything compiled
  // from the DSL it is the SESSION's agent — `expandSpawn` and `expandFanout`
  // both write `parentId: "main"` — and a session's agent is never one of its
  // own children, so `sceneIds` alone answered "not on screen" about the one
  // card this map always draws. One rule, both readers: the run's node is on
  // screen when it is a child card the scene folded, or the root agent card.
  const sceneIds = new Set(scene.subagents.map((c) => c.id));
  const onMap = (runId: string): boolean => runId === ROOT_AGENT || sceneIds.has(runId);
  const unplacedTitle = t(lang, "map.wf.unplaced");
  const boxes: { runId: string; boxId: string; layout: BoxLayout; expandedBox: boolean }[] = [];
  if (opts.declared !== undefined && !declutter) {
    for (const [runId, run] of opts.declared) {
      if (!onMap(runId)) continue;
      const boxId = boxNodeId(runId);
      // The per-box switch. The set names the boxes the reader has thrown AWAY
      // from the global one, so both stay true: a box nobody touched follows
      // the map, and a thrown box is the map's opposite — minimal on an
      // expanded map, expanded on a compact one.
      //
      // It used to read `opts.boxExpanded?.has(boxId) ?? isExpanded`, which
      // looks like the same sentence and is not: `??` falls back on undefined,
      // and FlowMap holds a Set and passes it on every render. An empty Set is
      // not undefined and `.has` answers false, so the global switch stopped
      // reaching any box the moment the option was wired up. Measured in the
      // running app: an expanded map, every box drawing minimal cards, and the
      // box's own switch offering to expand what the map had already expanded.
      const expandedBox = opts.boxExpanded?.has(boxId) === true ? !isExpanded : isExpanded;
      boxes.push({
        runId,
        boxId,
        expandedBox,
        layout: workflowBoxLayout(run, { expanded: expandedBox, present: sceneIds, unplacedTitle }),
      });
    }
  }
  /** Every agent a box seated — and the runs themselves, whose cards the boxes
   *  ARE. Both come out of the concurrency pool: a member drawn twice would be
   *  two agents, and a run drawn beside its own box would be one run twice.
   *
   *  A run hanging on the ROOT agent adds "main" to this set and nothing to
   *  the map: "main" is never in `scene.subagents`, so the pool it filters had
   *  no such card to lose. The session's agent card stays exactly where it is
   *  — it is the hub every rail on the map runs through, and it is not the
   *  run's card in the sense the sentence above means. */
  const boxed = new Set<string>();
  for (const b of boxes) {
    boxed.add(b.runId);
    for (const id of b.layout.placed) boxed.add(id);
  }
  const boxColW = boxes.reduce((w, b) => Math.max(w, b.layout.w), 0);
  const boxColH =
    boxes.length === 0 ? 0 : boxes.reduce((h, b) => h + b.layout.h, 0) + (boxes.length - 1) * BOX_STACK_GAP;
  /** What the worker column has to step aside by to clear the box column. */
  const boxColStep = boxes.length === 0 ? 0 : boxColW + EXP_GAP;
  const inPool = (c: SubagentInfo): boolean => !boxed.has(c.id);
  // CARD 306's SECOND SEATING RULE, and the only change to this expression:
  // a worker that belongs to a workflow is seated by its BOX, so it is not in
  // the pool the grid is built from. Everything else keeps the concurrency
  // seating untouched, and with no boxes `inPool` is true for everyone — the
  // expression is the one that shipped.
  //
  // The boxed ones come out FIRST, before the ceiling is applied. The other
  // order looks equivalent and is not: `slice(0, ceiling)` would spend the
  // ceiling on cards the boxes are already drawing, and a loose worker behind
  // twelve boxed ones would silently never be drawn at all. Measured — the
  // "keeps the workers clear of the box column" pin caught exactly that. With
  // no boxes `inPool` is true for everyone and the expression is unchanged.
  const pooled = scene.subagents.filter(inPool);
  const subsOnMap =
    pool !== undefined
      ? pooled.filter((c) => {
          const s = pool.seat[c.id];
          return s !== undefined && s < seatCeiling && pool.occupant[s] === c.id;
        })
      : pooled.slice(0, seatCeiling);
  const pooledSeats = pool !== undefined ? Math.min(pool.occupant.length, seatCeiling) : subsOnMap.length;
  // The pool counts every concurrent child, boxed ones included; the grid only
  // has to hold the ones still standing in it.
  const seatsInUse = boxes.length === 0 ? pooledSeats : subsOnMap.length;
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
  /** CARD 306: where the box column starts. The boxes take the head of the
   *  worker area and the grid steps aside past them, so the workflow reads as
   *  one block and the loose workers keep their own seating beside it. */
  let boxBaseL: XY = L.subBase;
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
    // The leftmost thing in the right-hand world sets the shift for all of it —
    // the boundary wall, since card 304 put the LLM beyond it for everyone.
    const rightWorld = Math.min(L.boundary.x, L.pos.llm.x, L.pos.netz.x, L.pos.mcpserver.x);
    // The grid's right edge plus rail room: subX + cols * (card + gap). With
    // one column this is exactly the single-column shift it replaces. The mac
    // frame must hold the band even with no worker column (zero workers), so
    // the spread takes whichever need is larger.
    subColPitch = EXPANDED_CARD.subagent.w + EXP_GAP;
    const macFrameW = L.zones.find((z) => z.variant === "mac")?.w ?? 0;
    const bandNeed = osZone.x + osBandW + FRAME_PAD - macFrameW;
    spread = Math.max(0, subX + boxColStep + grid.cols * subColPitch - rightWorld, bandNeed);
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
    boxBaseL = { x: subX, y: L.subBase.y };
    subBaseL = { x: subX + boxColStep, y: L.subBase.y };
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
  } else if (!declutter && (grid.cols > 1 || boxes.length > 0)) {
    // Compact grows sideways too: a second worker column would otherwise run
    // into the boundary wall. Same shift rule as expanded — the right-hand
    // world clears the grid's right edge. Since card 306 the box column is
    // part of that edge: with no boxes `boxColStep` is 0 and the expression is
    // the one that shipped.
    const rightWorld = Math.min(L.boundary.x, L.pos.llm.x, L.pos.netz.x, L.pos.mcpserver.x);
    spread = Math.max(0, L.subBase.x + boxColStep + grid.cols * subColPitch - rightWorld);
    subBaseL = { x: L.subBase.x + boxColStep, y: L.subBase.y };
  }

  // CARD 306 — THE VERTICAL GROWTH, and the defect it repairs.
  //
  // `vSpread`, `bandGrow` and `colGrow` were assigned ONLY inside the expanded
  // branch, so nothing on this map ever grew downward in compact. Compact had
  // no way to need it: its worker column is capped at three rows and clears
  // the OS band by arithmetic. A workflow box has no such cap — the owner's
  // own ask is that it "may grow very large and that is allowed" — so a tall
  // box in compact would have run straight through the band and the frame
  // below it, silently, because a frame does not complain about what is drawn
  // over it.
  //
  // So the box column's depth is a growth need like any other, in BOTH
  // seatings: the band drops below it and the mac frame stretches to hold it.
  //
  // ONE growth need, not two. The obvious second line — stretch the mac frame
  // to `boxColBottom + FRAME_PAD` the way the worker column does — was written
  // and then MEASURED dead: the band ceiling sits at 668 and the mac frame
  // ends at 924, so the box's claim on `vSpread` (bottom + 60 - 668) always
  // exceeds its claim on `colGrow` (bottom + 24 - 924) by 292, and
  // `frameGrow` takes the larger. Biting it out changed nothing, which is the
  // definition of a guard that cannot fire. The frame still grows — through
  // vSpread, which is the number that is actually doing it.
  const boxColBottom = boxBaseL.y + boxColH;
  if (boxes.length > 0) vSpread = Math.max(vSpread, boxColBottom + EXP_GAP - OS_BAND_TOP);

  // The shifts run ONCE, here, now that both branches have had their say.
  // They used to live inside the expanded branch, which is why compact could
  // not move the band at all. With no boxes the numbers are unchanged: compact
  // still has vSpread 0, so the y-loop is the no-op it always was.
  if (spread !== 0) {
    for (const id of ["llm", "netz", "mcpserver"]) posL[id] = { ...posL[id], x: posL[id].x + spread };
  }
  if (vSpread !== 0) {
    for (const id of ["netz", "mcpserver", "os-disk", "os-shell", "os-mcp", "os-net"]) {
      posL[id] = { ...posL[id], y: posL[id].y + vSpread };
    }
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
    spread > 0 || frameGrow > 0
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
  if (!declutter) {
    nodes.push({
      id: "z-boundary",
      type: "zone",
      position: { x: boundaryL.x, y: boundaryL.y },
      data: { variant: "boundary", label: t(lang, "map.zone.boundary") },
      draggable: false,
      selectable: false,
      zIndex: 1,
      style: { width: BOUNDARY_W, height: boundaryL.h },
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
  // Occupancy is derived ONCE (stationOccupants, card 295) and then read three
  // ways: the node's active state, the "who is on it" chip, and — below — which
  // rail is hot. It used to be worked out here a second time with a per-station
  // `loops.find`, free to disagree with the chip beside it.
  const occupants = stationOccupants(scene, opts.dir);
  const on = (st: Station): StationOccupant[] => occupants.filter((o) => o.station === st);
  const usersOf = (st: Station) => on(st).map(({ tag, name, agentId }) => ({ tag, name, agentId }));
  // First match wins, main first: with main AND a worker at the disk the station
  // shows MAIN. The demoted occupants are not dropped — the chip names them.
  const atDisk = on("disk")[0];
  const atCmd = on("cmd")[0];
  const mcpUser = on("mcp")[0];
  const mcpInUse = mcpUser !== undefined;
  const mcpTool = mcpUser ? detail.tool[mcpUser.agentId] : undefined;
  /** The rails that are hot right now, keyed agent+station. */
  const hot = new Set(occupants.map((o) => `${o.agentId}\u0000${o.station}`));
  const isHot = (agentId: string, st: Station) => hot.has(`${agentId}\u0000${st}`);
  N("os-disk", "os", {
    kind: "disk",
    active: atDisk !== undefined,
    disk: atDisk?.loop.disk ?? "idle",
    file: atDisk?.loop.activeFile ?? null,
    by: usersOf("disk"),
    byTag: atDisk?.tag ?? null,
  });
  N("os-shell", "os", {
    kind: "shell",
    active: atCmd !== undefined,
    command: atCmd?.loop.activeCommand ?? null,
    by: usersOf("cmd"),
    byTag: atCmd?.tag ?? null,
  });
  N("os-mcp", "os", {
    kind: "mcp",
    active: mcpInUse,
    mcp: mcpUser?.loop.activeMcp ?? null,
    tool: mcpTool?.name?.startsWith("mcp__") ? mcpTool : null,
    by: usersOf("mcp"),
    byTag: mcpUser?.tag ?? null,
  });
  N("os-net", "os", { kind: "net", active: mcpInUse, byTag: mcpUser?.tag ?? null });

  // ----- LLM ----- (the SHARED model — it works for main and every subagent,
  // so it animates and streams for whichever agent is at it right now)
  const llmBusy = scene.focus === "llm" || scene.subagents.some((c) => c.focus === "llm");
  const streamsOf = (rec: Record<string, string>): AgentStream[] =>
    [detail.root, ...scene.subagents.map((c) => c.id)]
      .map((id) => ({ agent: id, text: rec[id] ?? "" }))
      .filter((s) => s.text.length > 0);
  N("llm", "llm", {
    active: llmBusy,
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
  /**
   * One worker card's data, in ONE place.
   *
   * The flat seating and the workflow box draw the SAME card — that is the
   * owner's ask in its own words, "the agents stay the cards they already
   * are". Two copies of this object is exactly how the two would drift, and a
   * boxed worker quietly losing its brief or its spend is the kind of gap
   * nothing renders as an error.
   *
   * @param c the child as the scene folded it
   * @param full whether this card is the full instrument (card 287) — for a
   *             boxed member that is its OWN box's switch, not the map's
   */
  const subCardData = (c: SubagentInfo, full: boolean): Record<string, unknown> => ({
    id: c.id,
    label: c.label,
    task: c.task,
    state: c.state,
    stateLabel: lifecycleLabel(c.state, lang),
    stateColor: STATE_COLOR[c.state],
    lastStatus: c.lastStatus,
    activity: activity(
      c.focus,
      c.disk,
      c.activeFile,
      c.activeCommand,
      c.activeMcp,
      c.gate,
      lang,
      c.activeTool,
    ),
    focus: c.focus,
    active: scene.activeChild === c.id,
    think: detail.think[c.id] ?? "",
    // Expanded, a worker is the agent's own card with the child's data
    // (card 287). Compact data stays byte-identical to what shipped.
    ...(full
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
    N(id, "subagent", subCardData(c, isExpanded));
  });

  // ----- CARD 306: the workflow boxes, and the agents standing in them -----
  //
  // The box is a React Flow PARENT and its members are its children —
  // `parentId` plus `extent: "parent"`, the mechanism the owner picked, used
  // only where containment IS the meaning. The zones stay absolutely
  // positioned exactly as they were: a zone contains nothing, it is a drawn
  // frame, and converting it would make every card's position relative for no
  // gain and every silent-failure risk.
  //
  // A member's position is therefore RELATIVE to its box, straight out of the
  // pure geometry. Nothing downstream may read it as a world number without
  // going through `worldBoxes`.
  const childOf = new Map(scene.subagents.map((c) => [c.id, c]));
  let boxY = boxBaseL.y;
  for (const b of boxes) {
    const run = opts.declared!.get(b.runId)!;
    const runCard = childOf.get(b.runId);
    nodes.push({
      id: b.boxId,
      type: "wfbox",
      position: { x: boxBaseL.x, y: boxY },
      data: {
        boxId: b.boxId,
        // What the box NAMES: the run, how far through its phases it is, how
        // many agents stand in it, and how it is doing. The run's own card is
        // gone from the pool, so everything that card said has to be here.
        //
        // No card at all is the root-hung run: the session IS the run, and its
        // agent card is a hub rather than a name for one. It gets the
        // translated word instead of the fold's internal id — "main" on a box
        // in front of a reader is this file talking to itself.
        title: runCard?.task ?? t(lang, "map.wf.run"),
        phasesTotal: run.phases.length,
        // Counted off the BANDS this box actually drew, not off the
        // declaration's `startedAt`. A band holds exactly the agents the scene
        // has reached, so this number and the picture around it cannot
        // disagree — and disagreeing is what it did: measured on the shipped
        // scenario, the header read "0/5 phases" with all five bands full and
        // thirteen cards standing in them. `declarationOf` leaves `startedAt`
        // null on purpose, because for a compiled run it is the stream and not
        // the DSL that says when an agent began.
        //
        // The unplaced band is left out: it is where agents whose run named no
        // phase are put, so counting it would make a phase out of the absence
        // of one, and `phasesTotal` does not count it either.
        phasesEntered: b.layout.bands.filter((band) => !band.unplaced && band.members.length > 0).length,
        agents: b.layout.placed.length,
        state: runCard?.state ?? null,
        stateLabel: runCard === undefined ? null : lifecycleLabel(runCard.state, lang),
        stateColor: runCard === undefined ? null : STATE_COLOR[runCard.state],
        expanded: b.expandedBox,
        bands: b.layout.bands.map((band) => ({
          title: band.title,
          detail: band.detail,
          unplaced: band.unplaced,
          y: band.y,
          h: band.h,
          count: band.members.length,
        })),
        onToggle: opts.onToggleBox,
        w: b.layout.w,
        h: b.layout.h,
      },
      draggable: false,
      selectable: false,
      zIndex: 5,
      style: { width: b.layout.w, height: b.layout.h },
    });
    for (const band of b.layout.bands) {
      for (const m of band.members) {
        const c = childOf.get(m.agentId);
        if (c === undefined) continue;
        nodes.push({
          id: `sub-${m.agentId}`,
          type: "subagent",
          parentId: b.boxId,
          extent: "parent",
          position: { x: m.x, y: m.y },
          // The box's own switch travels WITH the card. A minimal card opens
          // its disclosure off the MAP's switch, and a box thrown minimal on
          // an expanded map then rendered 227-244px tall into the 132 its band
          // reserved — measured — and `extent: "parent"` does not let a child
          // stick out, it clamps: the last band's row came to rest 88px above
          // its own band, on top of the row before it. Two switches
          // disagreeing, the geometry following one and the markup the other.
          data: { ...subCardData(c, b.expandedBox), boxExpanded: b.expandedBox },
          zIndex: 10,
        });
      }
    }
    boxY += b.layout.h + BOX_STACK_GAP;
  }

  // ----- edges (the rails) -----
  const E = (
    id: string,
    source: string,
    target: string,
    sh: string,
    th: string,
    active: boolean,
    opt: {
      net?: boolean;
      err?: boolean;
      dim?: boolean;
      flow?: boolean;
      worker?: boolean;
      lane?: number;
    } = {},
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
        // A worker's leg is tinted with the worker accent, so a lit station
        // says at a glance WHO is on it even before the chip is read.
        worker: opt.worker ?? false,
        // Where two rails would otherwise draw one line. Only the rails into
        // the OS band converge, and they say so here rather than leaving the
        // renderer to guess from a hash of the id — main and every seated
        // worker arrive at the SAME handle.
        lane: opt.lane ?? null,
      },
      zIndex: active ? 1001 : 1,
    });
  };

  const mainLit = FOCUS_NODE[scene.focus];
  const litUserAgent = scene.focus === "agent" || scene.focus === "gate" || scene.focus === "user";
  E("e-user-agent", "user", "agent", "rs", "lt", litUserAgent, {
    err: scene.isError && scene.focus === "user",
  });
  // Every LLM leg crosses the boundary now (card 304) — the model card sits
  // beyond the wall whoever serves the tokens.
  E("e-agent-llm", "agent", "llm", "rs", "lt", mainLit === "llm", { net: true });
  E("e-agent-osdisk", "agent", "os-disk", "bs", "tt", isHot("main", "disk"), { lane: stationLane(null) });
  E("e-agent-osshell", "agent", "os-shell", "bs", "tt", isHot("main", "cmd"), { lane: stationLane(null) });
  // The MCP call rides the whole chain and lights it end to end while in use:
  //   <caller> → MCP-client → network stack →⟂ Netz → MCP-server
  // The first leg belongs to the CALLING agent (main's rail or the child's
  // own rail below); the chain from the client outward is shared.
  const mcpErr = !!mcpUser?.loop.isError;
  const mcpByWorker = mcpUser !== undefined && mcpUser.agentId !== "main";
  E("e-agent-osmcp", "agent", "os-mcp", "bs", "tt", isHot("main", "mcp"), {
    err: mcpErr && mcpUser?.agentId === "main",
    lane: stationLane(null),
  });
  E("e-osmcp-osnet", "os-mcp", "os-net", "rs", "lt", mcpInUse, { err: mcpErr, worker: mcpByWorker });
  if (!declutter) {
    // the legs out to Netz + MCP-Server only exist when the "outside" is drawn.
    E("e-osnet-netz", "os-net", "netz", "rs", "lt", mcpInUse, {
      net: true,
      err: mcpErr,
      worker: mcpByWorker,
    });
    E("e-netz-mcpserver", "netz", "mcpserver", "rs", "lt", mcpInUse, {
      net: true,
      err: mcpErr,
      worker: mcpByWorker,
    });
  }

  // CARD 306: the boxed members ride the SAME rail rules as the flat ones, and
  // that is not a nicety. Card 295 already fixed this once — a child whose
  // rails only existed while it stood on a station had no line into the OS
  // band between two tool calls, and the owner saw floating cards. Taking the
  // workflow members out of `subs` would have brought that back for every
  // workflow agent, permanently, with the rails simply absent instead of
  // intermittent.
  //
  // One difference, and it is the truth rather than a shortcut: a member's leg
  // home goes to its BOX, because the run is what launched it. The session's
  // hub did not.
  const railed: { c: SubagentInfo; seat: number; home: string }[] = subs.map((c, i) => ({
    c,
    // The same seat the card is drawn on: it is what keeps this worker's rail
    // off its siblings' at the station handle they all arrive on.
    seat: pool?.seat[c.id] ?? i,
    home: "agent",
  }));
  // The boxed ones continue the lane numbering past the seated ones, so two
  // rails never land on one another at the station handle they share.
  let lane = subs.length;
  for (const b of boxes) {
    for (const band of b.layout.bands) {
      for (const m of band.members) {
        const c = childOf.get(m.agentId);
        if (c === undefined) continue;
        railed.push({ c, seat: lane++, home: b.boxId });
      }
    }
  }
  railed.forEach(({ c, seat, home }) => {
    const id = `sub-${c.id}`;
    E(`e-${id}-agent`, id, home, "ls", "rt", false, { dim: true });
    E(`e-${id}-llm`, id, "llm", "rs", "lt", c.focus === "llm", { net: true });
    // A child's OWN rails to the three shared stations. They are STRUCTURAL
    // (card 295): drawn always, dimmed until used — mirroring what main has
    // had all along. They used to exist only while the child stood on the
    // station, so between two tool calls a worker card had no line into the OS
    // band at all, and the owner saw floating cards. Keeping them alive off
    // the child's lifecycle state was the other candidate and was rejected:
    // only a report_status message ever sets state "working", so a child that
    // never reports would float again — the very defect.
    const stationRail = (suffix: string, target: string, st: Station) =>
      E(`e-${id}-${suffix}`, id, target, "bs", "tt", isHot(c.id, st), {
        err: c.isError && isHot(c.id, st),
        dim: !isHot(c.id, st),
        worker: true,
        lane: stationLane(seat),
      });
    stationRail("osdisk", "os-disk", "disk");
    stationRail("osshell", "os-shell", "cmd");
    stationRail("osmcp", "os-mcp", "mcp");
  });

  // Only the expanded map has envelopes to check against; compact cards are the
  // small ones these numbers do not describe.
  //
  // CARD 306: through `worldBoxes` now, and that is not cosmetic. This check
  // compares RECTANGLES, and a boxed member's position is measured from its
  // box. Fed raw, a member seated 14px into a box at x=1400 would be compared
  // as a card at x=14 — sitting on the user card — and the report would name a
  // collision that is not there while missing the ones that are. Nothing would
  // have thrown: 14 is a perfectly good number.
  if (!declutter && opts.expanded === true) {
    const world = worldBoxes(nodes as { id: string; position: XY; parentId?: string }[]);
    // A boxed member is judged against the seat its OWN box gave it, because
    // its box carries its own switch: on an expanded map a box thrown minimal
    // holds 216x132 cards at the minimal pitch, and the expanded envelope
    // would read those five as five cards lying on top of each other.
    //
    // Taken off the SEAT rather than re-derived from the switch. Re-deriving
    // would be a second expression for one number, and the failure it can have
    // is the invisible direction: an envelope smaller than the seat reports
    // nothing and hides the collisions that ARE there. There is no second
    // number to disagree now.
    const boxedSeat = new Map<string, { w: number; h: number }>();
    for (const b of boxes) {
      for (const band of b.layout.bands) {
        for (const m of band.members) boxedSeat.set(`sub-${m.agentId}`, { w: m.w, h: m.h });
      }
    }
    reportSeatCollisions(
      nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: world.get(n.id) ?? n.position,
        ...(boxedSeat.has(n.id) ? { env: boxedSeat.get(n.id) } : {}),
      })),
    );
  }
  // CARD 306: React Flow REQUIRES a parent to appear before its children, and
  // until now the push order satisfied that by accident. An accident is not a
  // guarantee — the next card that moves a push moves it silently — so the
  // order is produced. Everything else keeps the order it was pushed in.
  return { nodes: orderParentsFirst(nodes), edges };
}
