// The pure mapping layer: a folded Scene (from the REAL labScene reducer) plus a
// little derived Detail (context/tool-input/streamed text, for the expandable
// sections) become React Flow nodes + edges. This is the direct analogue of the
// existing graph/buildGraph.ts — no React, no @xyflow here; SystemFlow.tsx just
// renders whatever this returns. Positions are hand-authored per layout so the
// local/remote flip literally re-places the LLM inside vs. outside "Dein Mac".

import type { Edge, Node } from "@xyflow/react";
import { isMcpTool, prettyMcp, ROOT_AGENT } from "../labScene";
import type { DiskState, Focus, GateState, Scene, SubagentInfo } from "../labScene";
import type { RunEvent } from "../../events";
import type { AgentDirectory } from "../agentDirectory";
import { t, type Lang } from "../../i18n/i18n";
import { imageUrl } from "./imageUrl";
import { outboundHop } from "./addresses";
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
/**
 * The most of ONE MCP answer this fold keeps.
 *
 * A bound, not a taste. Measured over 3 000 `mcp__` results sampled out of
 * ~/.claude/projects (random.seed(328)): p50 209 bytes, p75 934, p90 27 832,
 * p99 78 277, max 246 112 — a 130x spread between the median and the p90, and
 * 14.6 % of the answers are an image block rather than text. Keeping them all
 * whole would put a quarter of a megabyte per call into a structure the map
 * re-derives on every frame; rendering them whole would put it into the DOM.
 * At 2 000 characters roughly four answers in five arrive intact, and the card
 * says how many characters it is not showing rather than pretending it has
 * them all.
 */
export const MCP_ANSWER_CAP = 2000;

/**
 * One MCP call and the answer that came back for it (card 328).
 *
 * The answer was always on the wire — `tool_result` carries `output`,
 * `isError` and `durationMs`, joined to the call by `callId` — and the fold
 * threw it away at the `tool_result` case. This record is what survives it.
 *
 * The JOIN IS SCOPED TO ONE RUN and that is not defensive: measured over 783
 * session files, `callId` is not globally unique — "c1" appears in 31 distinct
 * files, 472 distinct ids over 506 calls. A record kept across a `run_start`
 * would let a later run's call inherit an earlier run's answer with nothing
 * red anywhere, so {@link deriveDetail} empties the table on a new run of the
 * ROOT agent — see the `run_start` case, which says why the root and not the
 * runId alone.
 */
export interface McpExchange {
  callId: string;
  agentId: string;
  /** The wire's tool name. Only the CALL ever said it — `tool_result` has no
   *  name field, which is what makes this a join and not a lookup. */
  name: string;
  /** What the call asked, as the model wrote it. */
  input: unknown;
  /**
   * The answer, cut to {@link MCP_ANSWER_CAP}.
   *
   * `null` while the call is still open, `""` for an answer that was empty.
   * Two different facts: over 3 503 measured results not one was empty, so the
   * empty case is a contract the corpus has never exercised — and collapsing
   * it into "waiting" would tell a reader a finished call is still running.
   */
  output: string | null;
  /** How long the answer was BEFORE the cap; 0 while the call is open. */
  outputChars: number;
  isError: boolean;
  durationMs: number;
  /**
   * What THIS MACHINE's permission gate did with the call, which is not what
   * the server did.
   *
   * A gated call is asked before it is allowed to run, and a refused one never
   * leaves: `labScene.ts`'s `permission_decision` case says it in its own words
   * — "Denied: nothing ran, the packet stays at the gate." The fold had no
   * `permission_decision` case at all, so the refusal that follows arrived as
   * an ordinary `tool_result` and the MCP-Server card printed it as the
   * server's answer. It is not synthetic: the shipped `build_plan` scenario
   * carries `{ mcp: "notes__search_notes", gate: "deny" }` and
   * `scenario/compile.ts` writes "ERROR: the user denied the execution." for
   * it, at 200 ms, with `isError`.
   *
   * `"none"` covers both an ungated call and one the gate let through — once
   * the packet is past the gate the gate has nothing more to say about it.
   */
  gate: "none" | "pending" | "denied";
}

/** Which of the six things the MCP-Server card can be saying. Two of them are
 *  about the LOCAL gate and say so; the card may never draw either as the
 *  external server's doing. */
export type McpAnswerState = "none" | "gated" | "denied" | "waiting" | "answered" | "empty";

/**
 * What one exchange reads as.
 *
 * The gate is read FIRST and that is the whole point: a call standing at the
 * permission gate has `output === null` exactly like a call the server has not
 * answered yet, and "waiting for the answer …" names the wrong wait — nothing
 * has been sent. A refused call has an `output`, and it is this machine's
 * refusal rather than the server's words.
 *
 * @param x the exchange
 * @return the reading the server card renders. Never `"none"` — that is the
 *         card's own reading for a run that has asked nothing, and it has no
 *         exchange to hand this function.
 */
export function mcpAnswerState(x: McpExchange): Exclude<McpAnswerState, "none"> {
  if (x.gate === "denied") return "denied";
  if (x.gate === "pending") return "gated";
  if (x.output === null) return "waiting";
  return x.output === "" ? "empty" : "answered";
}

/** The answering half of one exchange, as the MCP-Server card is handed it. */
export interface McpAnswerView {
  callId: string;
  name: string;
  /** Never `"none"`: this view only exists when there IS an exchange, and
   *  `"none"` is the card's own reading for a run that has asked nothing. */
  state: Exclude<McpAnswerState, "none">;
  /** The answer, already cut at {@link MCP_ANSWER_CAP} by the fold. */
  text: string;
  /** How long the answer really was, so the card can say what it is not showing. */
  chars: number;
  isError: boolean;
  durationMs: number;
}

/** Both halves of the one exchange the MCP chain is showing. */
export interface McpChainView {
  /** The MCP line BOTH cards carry. */
  line: string | null;
  /** The asking half, for the MCP-Client station. */
  call: { callId: string; name: string; input: unknown } | null;
  /** The answering half, for the MCP-Server card. */
  answer: McpAnswerView | null;
  /** Whether the exchange the two cards show came back an error. */
  isError: boolean;
  /**
   * WHICH agent asked the exchange the two cards are showing.
   *
   * The rails need it and the live occupant cannot supply it: `tool_result`
   * spreads `idleActivity()`, so the agent standing on the MCP station is gone
   * at the exact moment the answer — including an error answer — lands. The
   * leg from the agent into the MCP client was therefore clean for every
   * answered error while the chain outward from the client went red.
   */
  askedBy: string | null;
}

/**
 * How many hosts the Net card draws before it starts counting.
 *
 * Measured over 783 session files: 36 reached anything at all, and of those 34
 * reached exactly ONE host and 2 reached two — never three. Four rows is twice
 * the worst case the corpus has ever produced; a design for twelve rows would
 * be a design for data that does not exist. Nothing is dropped silently: what
 * does not fit is counted.
 */
export const NET_HOST_ROWS = 4;

/** What the Net card was handed about this run's outbound traffic. */
export interface NetCardView {
  /** The hosts it draws, first seen first. */
  hosts: string[];
  /** How many more there are below the row cap. */
  more: number;
  /** Whether any recorded address was a redaction marker. */
  redacted: boolean;
  /** Whether anything crossed the boundary at all. */
  crossed: boolean;
}

/**
 * How many lanes the LLM card draws before it scrolls.
 *
 * Owner's choice, 2026-08-30, asked whether the card should hold a fixed three,
 * grow to five, or grow without limit: <em>grow to five, then scroll</em>. The
 * cost he accepted out loud is that the card then has five heights rather than
 * one, and {@code EXPANDED_CARD.llm} is the answer to that cost — the SEAT is
 * fixed at five even when the card is not, so the variation never reaches the
 * neighbours.
 *
 * <p>MEASURED, because "five is plenty" was the card's first assumption and it
 * is wrong: {@code scene.subagents} accumulates every child that emits anything
 * and is emptied only by the ROOT's run_end (labScene.ts:391-403), so the roster
 * on the owner's own 295-agent import reaches 295 and stands above five on
 * 51 732 of 51 858 steps (99.8 %). The overflow line is the NORMAL case on an
 * import, not an edge.
 */
export const LANE_CAP = 5;

/** One agent's two halves, side by side, in the order the card draws them. */
export interface AgentLane {
  /** The engine's own agent id. NOT a handle — see the note on {@link llmLanes}. */
  agent: string;
  /** Its reasoning, as far as the 420-character window keeps it. */
  think: string;
  /** Its answer, same window. */
  answer: string;
  /** Whether this lane is the run's root rather than a child. */
  isRoot: boolean;
}

/** What the LLM card draws, and how much it could not. */
export interface LlmLanesView {
  lanes: AgentLane[];
  /** Agents past {@link LANE_CAP}, which the card reports rather than draws. */
  more: number;
}

/**
 * One lane per agent on screen, thinking and answer together (card 327).
 *
 * <p>THE PIVOT IS A VIEW CHANGE, NOT A FOLD CHANGE. {@code detail.think} and
 * {@code detail.answer} are already {@code Record<agentId, string>}, so the data
 * was always per agent; the old shape asked for two lists over the same roster
 * and let the reader pair them by position. In the owner's own screenshot the
 * Thinking entry was tagged MAIN and the Answer entry directly under it SCOPE —
 * two agents, stacked, reading as one that thought and then spoke.
 *
 * <p>THE ROSTER IS DE-DUPLICATED, and that fixes a shipped defect rather than
 * tidying one. It is built as root-then-scene, and its two halves come from
 * sources that do not agree: {@code deriveDetail} takes the root from the first
 * run_start's agentId (:571) while {@code advanceScene} hardcodes
 * {@code MAIN = "main"} (labScene.ts:72-73). On a transcript whose root is not
 * called "main" the root ALSO sits in {@code scene.subagents}, so the old
 * expression listed it twice — measured on cc-standalone-subagent.jsonl: two
 * think lanes sharing one React key on 10 of 14 steps, and the root wearing the
 * subagent treatment on 11 of 14. 87.5 % of the Claude Code transcripts on this
 * machine have that shape.
 *
 * <p>NO FILTER. The old fold dropped an agent the moment its text was empty,
 * and the card's first draft blamed that for a lane vanishing mid-step. Measured
 * over all 975 steps of all 17 shipped scenarios, the lane count never shrinks
 * mid-run — the only 12 shrink events in the corpus are run_end. What the filter
 * really did was stop a lane ever APPEARING: 4 099 of 5 551 roster slots (73.8 %)
 * suppressed for thinking, 3 443 (62.0 %) for answer. Keeping the lane is the
 * owner's ask, verbatim: "für alle agenten die geladen sind immer das feld
 * behalten dann sieht man immer den letzten stand".
 *
 * <p>THE TEXT IS A 420-CHARACTER WINDOW and real data sits on it — {@code CAP}
 * at :457, and 91.1 % of native thinking_delta events leave the string at
 * exactly 420. "The last state" is satisfied to that depth and no further.
 *
 * <p>THE AGENT ID IS RAW, deliberately. Card 327 criterion 3 asked for card
 * 298's handle colour, and there is no handle at this node: no AgentDirectory
 * reaches it, and {@code agentTagColor} has zero consumers anywhere under
 * lab/flowmap/. Threading the directory here is real work in BOTH producers —
 * fleetToFlow's options are {@code lang, expanded} with no directory at all —
 * so it is a card of its own rather than an unnamed rider on this one.
 *
 * @param scene the agents on screen
 * @param detail the fold
 * @return the lanes to draw, and the count of those below the cap
 */
export function llmLanes(scene: Scene, detail: Detail): LlmLanesView {
  const roster: string[] = [];
  const seen = new Set<string>();
  for (const id of [detail.root, ...scene.subagents.map((c) => c.id)]) {
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    roster.push(id);
  }
  return {
    lanes: roster.slice(0, LANE_CAP).map((id) => ({
      agent: id,
      think: detail.think[id] ?? "",
      answer: detail.answer[id] ?? "",
      isRoot: id === detail.root,
    })),
    more: Math.max(0, roster.length - LANE_CAP),
  };
}

/**
 * CARD 329 — the Net card's whole content, derived from the run.
 *
 * A shared derivation for the same reason as {@link mcpChainView}: both the
 * single-run map and the fleet machine room draw this node.
 *
 * @param detail the fold
 * @return what the card renders
 */
export function netCardView(detail: Detail): NetCardView {
  return {
    hosts: detail.reached.slice(0, NET_HOST_ROWS),
    more: Math.max(0, detail.reached.length - NET_HOST_ROWS),
    redacted: detail.redactedHops > 0,
    crossed: detail.reached.length > 0 || detail.redactedHops > 0,
  };
}

/**
 * CARD 328 — the ONE call both halves of the MCP chain show.
 *
 * One derivation, and that is the card's whole claim: the client card and the
 * server card have to be visibly the same call, and two expressions is exactly
 * how they would come to disagree. It is also why this is a function and not
 * three lines in sceneToFlow — BOTH the single-run map and the fleet machine
 * room draw these two cards, and a fix applied to one of them is half a
 * feature on a live surface.
 *
 * The live occupant's own call wins where there is one, so a station saying
 * "main is on it" cannot be showing a worker's call. With nobody on the
 * station the run's last MCP call stands, which is what lets the answer stay
 * on the card after `tool_result` cleared the station out from under it.
 *
 * @param detail the fold
 * @param occupantId the agent standing on the MCP station, or null
 * @param liveLine the occupant's own `activeMcp` line, or null
 * @return what the two cards render
 */
export function mcpChainView(
  detail: Detail,
  occupantId: string | null,
  liveLine: string | null,
): McpChainView {
  const askedId = (occupantId === null ? undefined : detail.lastAsk[occupantId]) ?? detail.lastMcp;
  const asked = askedId === null || askedId === undefined ? null : (detail.answers[askedId] ?? null);
  return {
    line: liveLine ?? (asked === null ? null : prettyMcp(asked.name)),
    call: asked === null ? null : { callId: asked.callId, name: asked.name, input: asked.input },
    answer:
      asked === null
        ? null
        : {
            callId: asked.callId,
            name: asked.name,
            state: mcpAnswerState(asked),
            text: asked.output ?? "",
            chars: asked.outputChars,
            isError: asked.isError,
            durationMs: asked.durationMs,
          },
    isError: asked?.isError ?? false,
    askedBy: asked?.agentId ?? null,
  };
}

/**
 * The most of ONE recorded browser reading this fold keeps (card 330).
 *
 * Same bound as the MCP answer and for the same reason. What a browser tool
 * answers is a `tool_result` like any other: the four real ones on this machine
 * run 123-264 bytes, but `browser_read_page` hands back a whole accessibility
 * tree and `get_page_text` a whole page, and the card is 190px wide.
 */
export const BROWSER_READING_CAP = 2000;

/**
 * The last browser call this run recorded, and what it left behind (card 330).
 *
 * THERE IS NO HTML ON THE WIRE and that is deliberate — `browser_action` is
 * metadata only, "no bytes ride here, ever: a screenshot is a blob in the store
 * and a hash on this line". Two better sources exist and both are on the
 * SESSION wire, so this card fetches nothing:
 *
 *  · the SCREENSHOT. `browser_action.sha256` is the blob's hash, and when the
 *    same call took the picture through `browser_computer` the run also emitted
 *    an `image_generated` carrying the store PATH for that exact hash. Joining
 *    the two gives a real recorded path instead of a guess about the extension.
 *  · the READING. Measured on all four real browser calls in this machine's
 *    store: the `tool_result` for the same callId carries the tool's whole
 *    answer — the page's title line, the accessibility tree, or the refusal.
 *    The sidecar has it too, behind an endpoint; the session file has it here.
 */
export interface BrowserPageRecord {
  /** The sidecar's own id, so a reader can find the two lines over there. */
  cid: string;
  callId: string;
  /** The wire name: browser_navigate, browser_read_page, browser_computer, … */
  tool: string;
  /** The address the call ENDED on. Absent on 3 of the 4 real events — a failed
   *  navigate records no page — and it can be a redaction marker rather than an
   *  address. Absent, redacted and an address are three states of one field. */
  url?: string;
  ok: boolean;
  /** The screenshot blob's hash; absent for a call that took no picture. */
  sha256?: string;
  /** The blob the card can actually load, when an `image_generated` on the same
   *  wire named the path for that hash. A hash with no path is not a picture
   *  this card can show, and it says so rather than guessing a file name. */
  shot: { blobPath: string; sha256: string } | null;
  /** What the tool answered, cut at {@link BROWSER_READING_CAP}. */
  reading: string | null;
  /** How long the answer really was, so the card can say what it is not
   *  showing. `browser_read_page` hands back a whole accessibility tree and
   *  `get_page_text` a whole page; without this the card had no way to say the
   *  text it prints stops mid-token, and it read as the whole recording. */
  readingChars: number;
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
    thresholdSource?: "override" | "window" | "model" | "fallback";
  } | null;
  /**
   * in-flight tool per agent (set on tool_call, cleared on tool_result).
   *
   * Still exactly that, and card 328 deliberately left it alone: the agent hub,
   * the worker cards and the fleet room all read this field to say what is
   * running RIGHT NOW, and a slot that outlived its result would have every one
   * of them claiming a finished call is still in flight. What the MCP answer
   * needed is a record of its own — {@link Detail.answers} — which keeps the
   * whole exchange past the result instead of widening this one.
   */
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
  /**
   * CARD 328 — the MCP conversation of THIS run, keyed by callId.
   *
   * Only `mcp__` calls enter. Two reasons, and both are the card's: the two
   * cards this feeds are the MCP client and the MCP server, and a session that
   * ran 506 tool calls with answers out to 33 KB would otherwise be carrying
   * every one of them on a structure the map re-derives per frame.
   *
   * Emptied on a new run of the ROOT agent — see the `run_start` case in
   * {@link deriveDetail}, and {@link McpExchange} for why the scope exists at
   * all. Not on any new runId: a CHILD's `run_start` carries its own, so that
   * scope would throw the parent's record away the moment it spawned.
   */
  answers: Record<string, McpExchange | undefined>;
  /** The callId of the last MCP call each agent made in this run (card 328). */
  lastAsk: Record<string, string | undefined>;
  /** The callId of the last MCP call ANY agent made in this run (card 328).
   *  What the two cards fall back to once nobody is standing on the station. */
  lastMcp: string | null;
  /**
   * CARD 329 — every host this run REACHED, first seen first.
   *
   * Derived from the two events that carry an outbound address and nothing
   * else: `llm_exchange.url` and `browser_action.url`. A loopback address never
   * enters — 45 of the 137 exchanges in this machine's whole history are
   * loopback, and drawing a backend that never left the machine as outbound is
   * the exact lie the network node exists to prevent.
   *
   * NOT classified. 58 of those 137 went to ONE host in 100.64.0.0/10 — a
   * tailnet address, the largest single group, and neither loopback nor the
   * public internet. The host itself is deliberately not written here: this
   * repository is public and NoOperatorAddressesInTheRepoTest refuses an
   * operator's own node by name. Which shape ships (a third category, or none) is
   * an owner call, so the fold carries the host and the card prints it.
   *
   * A HOST, and deliberately no number beside it. This carried a per-host hit
   * count and the count was not a count of hops: `BrowserTools.java` records
   * `browser.pageUrl()` — the page the browser ENDED on — for EVERY browser
   * tool call, so five read-only verbs on one open page counted five; and 40 of
   * the 137 exchanges carry no `status` at all with 7 more `aborted`, both
   * dropped, so a host that answered nothing counted like one that answered
   * 200. A figure the reader cannot take back to a fact does not get printed.
   */
  reached: string[];
  /** CARD 330: the last browser call this run recorded, or null. */
  page: BrowserPageRecord | null;
  /** How many recorded addresses were a redaction marker (card 329). The run
   *  reached SOMETHING and the record deliberately does not say where; that is
   *  a fact of its own and never a host. */
  redactedHops: number;
  /**
   * CARD 329 — whether the frame the scrubber is SITTING on is a crossing.
   *
   * The boundary nodes' light means "in use right now" on every other station
   * of this map, and `reached.length > 0` never goes back down: after the first
   * remote exchange — the first turn of essentially every real run — `netz` and
   * `os-net` wore the breathing active animation for the rest of the session
   * and past `run_end`. What this run reached stays on the CARD; that is the
   * memory. This is the pulse, and it is the last applied event being one that
   * recorded an address, which is the same "where the packet is now" the focus
   * model is built on.
   */
  crossingNow: boolean;
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

/**
 * Fold one recorded address onto the run's outbound list.
 *
 * The list is DERIVED, never typed: whatever host the events carry appears,
 * and a host nothing recorded cannot. First-seen order, so the reading matches
 * the run rather than an alphabet.
 *
 * @param d the detail being folded
 * @param url the recorded address, in whatever shape it arrived
 * @return whether this event recorded an address at all — what makes the
 *         boundary node's light mean NOW rather than "at some point"
 */
function reach(d: Detail, url: unknown): boolean {
  const hop = outboundHop(url);
  if (hop.kind === "redacted") {
    d.redactedHops += 1;
    return true;
  }
  if (hop.kind !== "host") return false;
  if (!d.reached.includes(hop.host)) d.reached.push(hop.host);
  return true;
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
    answers: {},
    lastAsk: {},
    lastMcp: null,
    reached: [],
    redactedHops: 0,
    crossingNow: false,
    page: null,
  };
  /** CARD 330: store paths by content hash, so a browser_action's hash can find
   *  the path the `image_generated` for the same shot already announced. */
  const blobs = new Map<string, string>();
  let rootSeen = false;
  /** The run the MCP table belongs to (card 328). A `callId` is unique inside
   *  ONE run and nowhere else, so the table cannot outlive its run. */
  let runId: string | null = null;
  for (const e of applied) {
    // CARD 329: the pulse is about THIS frame, so it is cleared before the
    // frame is read and set only by an event that recorded an address. Left to
    // accumulate it would be the same monotone latch it replaces.
    d.crossingNow = false;
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
        // CARD 330: the store is content-addressed, so this line is the only
        // place the run says which PATH a given hash lives at. A browser
        // screenshot announces itself here and references itself by hash on the
        // browser_action beside it.
        blobs.set(e.sha256, e.blobPath);
        break;
      case "run_start":
        // The FIRST run_start names the root. Later ones are children.
        if (!rootSeen) {
          d.root = e.agentId;
          rootSeen = true;
        }
        // CARD 328/329/330: a new run of the ROOT empties what the last run
        // recorded — its MCP conversation, the hosts it reached and the page it
        // opened. Measured: "c1" is the callId of a first call in 31 different
        // session files, so a table that survived a run boundary would hand run
        // two the answer run one got, silently and with the right id on it.
        //
        // ONLY the root's, and that is measured too. A CHILD's run_start
        // carries its OWN runId, never its parent's — 25 of 25 child run_starts
        // across this machine's 783 session files, not one of them shared. So a
        // scope keyed on the runId alone would have thrown the parent's whole
        // record away the moment it spawned a subagent, which is the ordinary
        // case on this map and not a corner of it.
        if (e.agentId === d.root && e.runId !== runId) {
          runId = e.runId;
          d.answers = {};
          d.lastAsk = {};
          d.lastMcp = null;
          d.reached = [];
          d.redactedHops = 0;
          d.page = null;
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
      // CARD 329 — the two events that name an address, folded the same way.
      // The map read NEITHER of them before this: `grep -rn
      // "llm_exchange\|browser_action" src/lab/` returned zero matches, tests
      // included, so the Net node drew a router glyph and measured nothing.
      case "llm_exchange":
        d.crossingNow = reach(d, e.url);
        break;
      case "browser_action": {
        // `url` is ABSENT on 3 of the 4 real browser_action events on this
        // machine — a failed navigate records no page — and `outboundHop`
        // reads that as `none`, which is what it is.
        d.crossingNow = reach(d, (e as { url?: unknown }).url);
        // CARD 330: the run's latest browser call. Its reading arrives later,
        // on the tool_result for the same callId.
        const path = e.sha256 === undefined ? undefined : blobs.get(e.sha256);
        d.page = {
          cid: e.cid,
          callId: e.callId ?? "",
          tool: e.tool,
          ...(e.url === undefined ? {} : { url: e.url }),
          ok: e.ok,
          ...(e.sha256 === undefined ? {} : { sha256: e.sha256 }),
          shot: e.sha256 !== undefined && path !== undefined ? { blobPath: path, sha256: e.sha256 } : null,
          reading: null,
          readingChars: 0,
        };
        break;
      }
      case "tool_call":
      case "permission_request":
        d.tool[e.agentId] = { name: e.name, input: e.input };
        // CARD 328: an MCP call opens its own exchange, which outlives the
        // in-flight slot above. `permission_request` opens it too — a gated
        // call is asked before it is allowed to run, and the client card has to
        // be able to say WHICH call is standing at the gate. It also RECORDS
        // that it is standing there: until the decision lands nothing has been
        // sent, and a server card reading "waiting for the answer …" would be
        // naming the wrong wait.
        if (isMcpTool(e.name)) {
          d.answers[e.callId] = {
            callId: e.callId,
            agentId: e.agentId,
            name: e.name,
            input: e.input,
            output: null,
            outputChars: 0,
            isError: false,
            durationMs: 0,
            gate: e.type === "permission_request" ? "pending" : "none",
          };
          d.lastAsk[e.agentId] = e.callId;
          d.lastMcp = e.callId;
        }
        break;
      case "permission_decision": {
        // CARD 328, round 2. `permission_decision` carries no agentId — the
        // callId is the whole join, and it is the same one the request opened.
        // An ALLOWED call goes back to being an ordinary call: the gate is done
        // with it and the answer that follows is the server's. A DENIED one
        // never leaves this machine, so nothing that follows it is.
        const gated = d.answers[e.callId];
        if (gated !== undefined) {
          d.answers[e.callId] = { ...gated, gate: e.allowed ? "none" : "denied" };
        }
        break;
      }
      case "tool_result": {
        d.tool[e.agentId] = undefined;
        // CARD 328: and the answer lands on the exchange the call opened. Only
        // on one this run opened — a result whose call belongs to an earlier
        // run finds nothing, which is the run scope doing its job rather than a
        // guard bolted on top of it.
        // CARD 330: a browser tool's answer is a tool_result like any other,
        // and it is where the recorded READING actually lives — the
        // accessibility tree, the page text, or the refusal and its rule.
        // An EMPTY id joins nothing. `browser_action.callId` is documented
        // optional ("absent where no turn produced one"), and a page folded
        // without one would otherwise adopt the next result that also had
        // none — an unrelated tool's output printed as the page's recording.
        if (
          d.page !== null &&
          d.page.callId !== "" &&
          d.page.callId === e.callId &&
          d.page.reading === null
        ) {
          d.page = {
            ...d.page,
            reading: e.output.slice(0, BROWSER_READING_CAP),
            readingChars: e.output.length,
          };
        }
        const open = d.answers[e.callId];
        // A REFUSED call still gets a tool_result — the harness writes one so
        // the model's turn can continue — and it carries this machine's own
        // words, not the server's. Measured on the shipped `build_plan`
        // scenario: "ERROR: the user denied the execution." at 200 ms with
        // isError. Taking it would put a local refusal on the card that says
        // what the external server answered.
        if (open !== undefined && open.gate !== "denied") {
          d.answers[e.callId] = {
            ...open,
            output: e.output.slice(0, MCP_ANSWER_CAP),
            outputChars: e.output.length,
            isError: e.isError,
            durationMs: e.durationMs,
          };
        }
        break;
      }
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

/**
 * CARD 330: the browser station's COMPACT width — `.pf-os--browser` in
 * flowmap.css, and the number the compact band's own width grows by.
 *
 * Two copies of one number, and `stationSeats.test.ts` holds them together by
 * reading the declaration out of the stylesheet: the band derives from this
 * one and the card paints from that one, so nothing would go red if they came
 * apart.
 */
export const COMPACT_BROWSER_W = 190;

/**
 * CARD 330: the browser station's COMPACT height, MEASURED.
 *
 * The `z-os` frame is {@link OS_BAND_H} tall and seats its stations
 * {@link OS_STATION_DY} below its top edge, so a compact station has 156px
 * before it draws through the floor. This card did not fit: rendering the page
 * itself measured 202.44 there, and 165 before the verb row and the cut chip
 * were added — a card hanging out of the OPERATING SYSTEM box it is supposed
 * to be inside. Compact now names the state instead of drawing the artefact
 * (see BrowserBody), which puts it in line with its neighbours.
 *
 * 2026-08-30, Chrome, devicePixelRatio 2, both variable fonts
 * `document.fonts.load`ed before the read (fonts.ready alone came out short on
 * card 296's pass), real markup inside `.pf-root > .pf-flow`, read through
 * getBoundingClientRect. Worst compact case: one occupant, a failed verb, a
 * 71-character address and a reading recorded:
 *
 *   os-browser  127.22      os-mcp    125.09      os-shell  125.09
 *
 * INHERITED, recorded and not fixed here: a SECOND occupant adds ~40px to any
 * of these — os-mcp measures 166.09 and os-disk 159.27 with a single occupant
 * and an ordinary path — so the band is short for its existing stations too.
 * `OS_BAND_H` is card 319's geometry and this card does not move it.
 */
export const COMPACT_BROWSER_H = 128;

/** The OS band's top edge — the seat of the `z-os` zone in BOTH layouts, and the
 *  ceiling every card above it has to stay clear of. */
/**
 * The compact widths of the OS band's five stations, left to right — the
 * `.pf-os--*` declarations in flowmap.css, in the band's own order.
 *
 * The band's width and the fifth station's seat both derive from this, so the
 * frame cannot come apart from the row it holds: `osBandWidth` over these five
 * is 1008, and `792 + STATION_GAP + COMPACT_BROWSER_W` was the same number
 * written a second way.
 */
const COMPACT_STATION_W = [152, 200, 190, 104, COMPACT_BROWSER_W];

const OS_BAND_TOP = 668;
/** Height of the `z-os` frame, and how far below its top edge the stations sit. */
export const OS_BAND_H = 236;
export const OS_STATION_DY = 80;

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
 * The line that stood here read:
 * "agent and llm keep an observed height plus headroom", and it justified that
 * with the caps on the regions inside them — ".pf-llm__streams 260, the tool
 * JSON at 150, .pf-prose 120". Card 319 measured it, and it was wrong twice.
 *
 * THE 150 NEVER EXISTED. ToolCallPanel.tsx has read `maxHeight: 240` since card
 * 287 and says so in its own comment; there is no 150 cap anywhere in
 * flowmap.css. That is not a slip in prose — it was the sentence the agent's
 * 780 rested on, and it was stale about exactly the region that caused 929 of
 * the 931 height changes the owner's own 3328 steps produced.
 *
 * AND "OBSERVED PLUS HEADROOM" WAS WRONG IN BOTH DIRECTIONS AT ONCE, the same
 * double error cardGeometry.ts records for the worker card's old 560. Measured
 * over his run: 363.97 on 6.5 % of steps — 416px of air, 53 % of the seat —
 * against 932.98 on his tallest, which is 153px OVER it, on 828 steps (24.9 %).
 * With every region present the same card measured 1188.29, 393px over.
 *
 * So that sentence now holds for the LLM alone, on the two caps flowmap.css
 * really sets (.pf-llm__streams 260, .pf-prose 120). The AGENT's entry is no
 * longer an observation: every region inside that card states a fixed box
 * (`.pf-toolbody` at the 240 above, `.pf-ctx`, `.pf-agent__shelf`, `.pf-prose`)
 * and the card renders every one of them on every step, so the card has ONE
 * height and this entry is that height, measured in a browser, plus rounding.
 * The LLM is now the only entry the runtime check below exists for — see
 * reportOversizeCards.
 *
 * `.pf-prose` is in that list because of a second pass and not a first: it
 * stated only a `max-height`, so the card measured 1075.09 until `/api/context`
 * answered and 1178.59 after — 103.50px, on a step, with the runtime arm saying
 * so. A cap is not a reserve, and the sentence above was true of every region
 * but the one nobody had looked at.
 */
export const EXPANDED_CARD: Record<string, { w: number; h: number }> = {
  user: { w: 400, h: 180 },
  // CARD 319. MEASURED, not observed: the budgeted card renders every region at
  // its reserved size on every step, so it has one height and this is it plus
  // rounding. Chrome, both variable fonts loaded before the read, the owner's
  // own recording stepped through the real Step forward control at a 1600x900
  // window (.pf-flow 1272x579, zoom 0.351332), through getBoundingClientRect on
  // `.pf-root > .pf-flow > .react-flow__node-agent` divided by that zoom:
  //
  //   1178.60 world px, ONE value over the run, worst single-step change 0.00
  //
  // The 21px on top is for a machine whose font stack is not this one — the
  // fixed regions hold there too, the chrome around them does not have to.
  agent: { w: 680, h: 1200 },
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
  /*
   * The type fallback for anything drawn as an "ext" card.
   *
   * Its HEIGHT no longer sizes anything: `envelopeOf` is
   * `n.env ?? EXPANDED_CARD[n.id] ?? EXPANDED_CARD[n.type]`, and both cards
   * emitted as type "ext" — `netz` and `mcpserver` — now carry a key of their
   * own id, which wins. It is kept as the fallback for an ext card that has
   * not been measured yet, and it is NOT dead: `EXT_W` reads its width, and
   * `EXT_ROW_W` and `MCPSERVER_X` derive from that.
   */
  ext: { w: 150, h: 110 },
  /*
   * CARD 328 — the MCP-Server card's OWN seat.
   *
   * A key of the card's own id wins over the type lookup and moves nothing
   * else — which is what makes cards 328, 329 and 330 a resolvable merge in
   * one table. The WIDTH stays at ext's 150 on purpose: `EXT_W` ->
   * `EXT_ROW_W` -> `MCPSERVER_X` and the outside frame all derive from it,
   * and that arithmetic belongs to card 319.
   *
   * MEASURED, not summed, and at the card's WORST case rather than its
   * typical one. 2026-08-30, Chrome, devicePixelRatio 2, both variable fonts
   * `document.fonts.load`ed before the read (fonts.ready alone came out short
   * on card 296's pass); the real markup rendered inside
   * `.pf-root > .pf-flow > .react-flow__node-ext` and read through
   * getBoundingClientRect. These cards carry no zoom, so the numbers are world
   * px as they stand:
   *
   *   nothing asked yet                                      102.87
   *   waiting for the answer (en and de alike)               152.41
   *   answered with nothing                                  152.41
   *   the gate is still deciding, en 168.69 · de             168.69
   *   the gate refused it, en 169.69 · de                    185.96
   *   answered, 2 000 chars shown of 246 112, en and de      222.09
   *   an error answer at 3 598 164 ms with its cut chip,
   *     en and de alike                                      230.59  <- the bound
   *
   * The last one is the WORST case this card can reach, not its typical one:
   * the answer region is capped at 64px by flowmap.css and scrolls, so no
   * answer can grow it, and the two lines that CAN wrap are the meta and the
   * cut chip. It was 238.59 in round one, when the German meta wrapped to two
   * lines around a raw `3598164 ms`; the duration reads as `59 m 58 s` now
   * (`formatDuration`, the app's own), which is both readable and shorter.
   * The two gate readings — round two, and about the LOCAL permission gate
   * rather than the server — sit well under it. 250 leaves 19px over the bound
   * and seats the card 14px clear of the outside frame's floor.
   */
  mcpserver: { w: 150, h: 250 },
  /*
   * CARD 329 — the Net card's own seat, for the same reason as the one above:
   * `ext` sizes BOTH, so growing it would silently resize the MCP-Server card.
   * The width stays ext's 150; NETZ_X and EXT_ROW_W derive from `ext.w` and
   * that arithmetic is card 319's.
   *
   * MEASURED at the card's WORST case in the same browser pass as the entry
   * above (Chrome, devicePixelRatio 2, both variable fonts document.fonts.
   * load-ed before the read, real markup inside `.pf-root > .pf-flow`, no zoom
   * on this card):
   *
   *   nothing left this machine (en and de alike)          114.59
   *   one host, the ordinary case                          102.09
   *   four hosts + a redaction row + a "+8 more" remainder  193.81  <- the bound
   *
   * The last one is the WORST case, not the typical one, and it is well past
   * what the corpus can produce: 34 of the 36 sessions that reached anything
   * reached exactly ONE host, 2 reached two, never three, and zero redaction
   * markers exist anywhere in the store. It is also the reason a host row is
   * one line with the address on its title — a 47-character host wrapped over
   * four rows measured 271.31 and put the card through the floor of the frame
   * it stands in. 210 leaves 16px over the bound.
   */
  netz: { w: 150, h: 210 },
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
  /*
   * CARD 330 — the browser station, a NEW node and therefore a NEW key: it
   * collides with nothing this table already holds. Wider than the other
   * stations because what it shows is a picture of a page.
   *
   * MEASURED in the same pass as the two external cards above (2026-08-30,
   * Chrome, devicePixelRatio 2, both variable fonts document.fonts.load-ed
   * before the read, the real markup inside `.pf-root > .pf-flow >
   * .react-flow__node-os`, no zoom on this card). This entry bounds the WIDE
   * shell, which is the only one the seats and the runtime check ever judge:
   *
   *   no browser was driven                                    64.55
   *   an address, and neither a picture nor a reading          101.72
   *   a screenshot recorded whose blob is gone                 115.72
   *   a 2 000-character reading with its cut chip              266.44
   *   a screenshot at its 180px cap, with a long address       267.72  <- bound
   *
   * The last is the WORST case and it is a cap, not an observation: a page
   * screenshot is 1200x800 (the pass above used a real 1200x6000 PNG through
   * the image endpoint) and would otherwise set this card's height out of the
   * image store. Both growth regions are capped in flowmap.css — the shot 180,
   * the reading 160 — which is what makes 280 a bound. The shot's cap came
   * down from 200 in round two: the verb row that tells a refusal from a
   * success costs 20px, and at 200 the card measured 287.72 against this same
   * 280. The seat did not move; the picture gave up the row's height. 280
   * leaves 12px over the bound and does not move `tallestStation`, which the
   * two 340px stations already own.
   *
   * The COMPACT shell is a different card and a different bound — see
   * {@link COMPACT_BROWSER_H}, which is what the `z-os` frame has to hold.
   */
  "os-browser": { w: 300, h: 280 },
};

/**
 * The OS band's stations, left to right — ONE list.
 *
 * It used to be typed out three times inside sceneToFlow (the expanded seating,
 * the tallest-station sum, and the vertical-shift loop), and card 330 adding a
 * fifth station is exactly the change where two of three copies get updated and
 * the third quietly seats the new card on top of its neighbour. The order is
 * the drawing order and the seats derive from it.
 */
export const OS_STATION_IDS = ["os-disk", "os-shell", "os-mcp", "os-net", "os-browser"] as const;

/** Rail room between two expanded cards — one source with the row derivation
 *  (cardGeometry.RAIL_GAP), re-exported under the name the layout uses. */
export const EXP_GAP = RAIL_GAP;

/** Frame left below the lowest card it holds, so a zone's label and border never
 *  sit on a card. */
const FRAME_PAD = 24;

/** The mac frame's own top edge — where the machine every inside card lives in
 *  starts. Read off the zone table below, which is the only place it is set. */
const MAC_FRAME_Y = 24;

/**
 * Where the agent hub sits in the EXPANDED world (card 319).
 *
 * The owner's second ask: "maybe place the main agent a bit higher so it does
 * not keep popping around at the bottom." It is a DERIVATION rather than a
 * taste — the same FRAME_PAD the frame already leaves BELOW its lowest card,
 * left above its first one, so the hub sits exactly one pad inside the machine
 * it belongs to. Measured at a 1600x900 window it puts the card's top 45.8px
 * below the top of `.lab-flowmap`, against 84.27 before and a proposed ceiling
 * of 64 (cardStillness.AGENT_TOP_CEILING_PX, still an owner call) — see below
 * for what that reading is and is not.
 *
 * Expanded only. COMMON's 150 still seats the compact world, which was measured
 * still and is not this card's business.
 *
 * AND THE 45.8 IS A READING OF THAT PANE, not a property of the seat. `fitView`
 * scales the world into whatever pane it is given, and most of that 45.8 is the
 * fit's own padding rather than the card's 24 world px of air — at a much
 * larger window the same seat reads considerably more. So 64 is a threshold a
 * bigger screen can cross with nothing here having changed, and the gate holds
 * the SHAPE instead: the hub is nearer the frame above it than the band below
 * it, and the air above it is under a third of the air below
 * (agentCardSeat.test.ts). Both are ratios and survive the zoom.
 */
const EXPANDED_AGENT_Y = MAC_FRAME_Y + FRAME_PAD;

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

/**
 * Cards that rendered taller than their envelope, worst first.
 *
 * CARD 306: `env` is the seat this ONE card was given where its type does not
 * say — a member of a workflow box thrown minimal. `seatCollisions` was given
 * that field and this arm was not, so a boxed member was judged against
 * EXPANDED_CARD.subagent: it could grow to 479px inside a 128px band and the
 * arm whose whole job is to say a card is drawing on its neighbour would have
 * had nothing to say.
 */
export function oversizeCards(
  measured: Iterable<{ id: string; type?: string; h: number; env?: { w: number; h: number } }>,
): { id: string; h: number; bound: number }[] {
  const out: { id: string; h: number; bound: number }[] = [];
  for (const m of measured) {
    const env = envelopeOf({ id: m.id, type: m.type, position: { x: 0, y: 0 }, env: m.env });
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
 *
 * CARD 319 IS THAT CARD FOR THE AGENT HUB, and it brings the measurement: the
 * seat was 780 against a card that rendered 363.97 on 6.5 % of the owner's
 * steps — the 364 named two paragraphs up, found by this very arm and left
 * standing because nobody had corrected the envelope yet. The hub's card is now
 * budgeted to one measured height and the seat is that height, so the arm has
 * nothing to say about it; the point of letting it watch is that it WOULD, the
 * moment someone raises the seat past twice the card again. Four envelopes are
 * still waiting for a card of their own: llm 540 for 378.74, os-mcp and
 * os-shell 340 for 64.55 bare, os-disk 240 for 103.50.
 */
export const UNDER_WATCHED_TYPES: ReadonlySet<string> = new Set(["agent", "subagent"]);

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
  measured: Iterable<{ id: string; type?: string; h: number; env?: { w: number; h: number } }>,
  now: number = Date.now(),
): { envelope: string; peak: number; bound: number }[] {
  for (const m of measured) {
    const type = m.type ?? "";
    // h <= 0 is "not laid out yet", not "a card of no height".
    if (!UNDER_WATCHED_TYPES.has(type) || m.h <= 0 || EXPANDED_CARD[type] === undefined) continue;
    // CARD 306: a card carrying its own seat is not in the shape this arm
    // judges. A boxed member at 96px fills three quarters of the 128px band it
    // stands in, and measured against the 480 its TYPE reserves it would read
    // as a seat holding air — reporting the subagent envelope on the strength
    // of a card that never sat in one.
    if (m.env !== undefined) continue;
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
  nodes: readonly {
    id: string;
    type?: string;
    data?: { boxSeat?: { w: number; h: number } };
    measured?: { height?: number };
  }[],
  expanded: boolean,
): { id: string; type?: string; h: number; env?: { w: number; h: number } }[] {
  if (!expanded) return [];
  const out: { id: string; type?: string; h: number; env?: { w: number; h: number } }[] = [];
  for (const n of nodes) {
    if (n.type === "zone") continue;
    const h = n.measured?.height ?? 0;
    if (h <= 0) continue;
    // CARD 306: a boxed member's seat comes off the node, because its type
    // does not say. This is the only road it has — FlowMap hands this function
    // the rendered nodes and nothing else.
    const seat = n.data?.boxSeat;
    out.push(seat === undefined ? { id: n.id, type: n.type, h } : { id: n.id, type: n.type, h, env: seat });
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
  // CARD 330: the browser station, the FIFTH seat, and the one seat here that
  // is derived rather than transcribed. It is the LAST on purpose: the four
  // before it keep the exact x they have always had, so this card moves no
  // station card 319 is standing on. `stationSeats` over the compact widths
  // reproduces all five, which stationSeats.test.ts proves — this takes the
  // fifth from that derivation instead of writing 808 down beside it.
  "os-browser": { x: stationSeats(COMPACT_STATION_W)[4], y: 748 },
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
    // MAC_FRAME_Y, not a literal: EXPANDED_AGENT_Y is derived from this edge,
    // and two 24s with nothing between them is how a derivation quietly stops
    // being one.
    {
      id: "z-mac",
      x: 0,
      y: MAC_FRAME_Y,
      w: MAC_W,
      h: 900,
      variant: "mac",
      label: "AGENTENSYSTEM · DEIN MAC",
    },
    // CARD 330: 792 held the four-station row. The frame that has to HOLD five
    // is derived from the five widths rather than added to by hand — a frame
    // that does not grow with its row is a frame with a card sticking through
    // its side, and a frame never complains about what is drawn over it.
    {
      id: "z-os",
      x: 24,
      y: OS_BAND_TOP,
      w: osBandWidth(COMPACT_STATION_W),
      h: OS_BAND_H,
      variant: "os",
      label: "BETRIEBSSYSTEM",
    },
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
    const stationIds = OS_STATION_IDS;
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
      EXPANDED_AGENT_Y + EXPANDED_CARD.agent.h + EXP_GAP - OS_BAND_TOP,
      L.pos.llm.y + EXPANDED_CARD.llm.h + EXP_GAP - L.pos.netz.y,
    );
    // An open station (the shell with a running command, the MCP client with its
    // call) is taller than the band was drawn for, so the band grows to hold it.
    const tallestStation = Math.max(...OS_STATION_IDS.map((id) => EXPANDED_CARD[id].h));
    bandGrow = Math.max(0, OS_STATION_DY + tallestStation + 20 - OS_BAND_H);
    posL.agent = { x: agentX, y: EXPANDED_AGENT_Y };
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
    for (const id of ["netz", "mcpserver", ...OS_STATION_IDS]) {
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
  // CARD 328: both halves of the one exchange the chain is showing.
  const chain = mcpChainView(detail, mcpUser?.agentId ?? null, mcpUser?.loop.activeMcp ?? null);
  // CARD 329: what this run actually put across the network boundary. The two
  // boundary nodes used to light for `mcpInUse` and nothing else, so every one
  // of the 137 llm_exchanges in this machine's history left them dark — the
  // node whose job is to say what left the machine was dark for almost
  // everything that left it.
  const netView = netCardView(detail);
  // CARD 330: the browser station reads its occupant off the SAME derivation
  // as the other three (stationOccupants, card 295). It used to be a local
  // `activeTool.startsWith("browser_")` over the scene and its children at
  // once, which is a boolean and not an occupancy: it could not say who, so
  // the station never named its occupant and a worker on the browser lit
  // MAIN's rail while having none of its own.
  const atBrowser = on("browser")[0];
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
    // The CALL, not only its command string (card 320): the station asks the
    // classifier what language it is drawing, and it has nothing to ask about
    // otherwise. Read off the OCCUPANT, the way os-mcp reads its own, and that
    // is what the guard is for — not staleness. `deriveDetail` already drops a
    // call on its tool_result, so a finished command cannot linger here. What
    // it does not do is say WHICH station a call belongs to: wired as the
    // agent's current call outright, this station carries a `Read` while the
    // disk beside it is the one spinning (measured 2026-08-30), and it carries
    // main's call while a worker is the one standing here.
    tool: atCmd === undefined ? null : (detail.tool[atCmd.agentId] ?? null),
    by: usersOf("cmd"),
    byTag: atCmd?.tag ?? null,
  });
  N("os-mcp", "os", {
    kind: "mcp",
    active: mcpInUse,
    mcp: chain.line,
    // CARD 328: the client card holds what was ASKED, and holds it past the
    // answer. It used to read `detail.tool[occupant]`, which is the in-flight
    // slot and is empty the instant `tool_result` lands — so the half of the
    // map that shows the question went blank at the exact moment the other
    // half could finally show the reply.
    call: chain.call,
    by: usersOf("mcp"),
    byTag: mcpUser?.tag ?? null,
  });
  N("os-net", "os", {
    kind: "net",
    // NOW, like every other station on this map: an MCP call in flight, or the
    // frame the scrubber sits on being one that recorded an address. `crossed`
    // is the run's MEMORY and never goes back down — it stays on the Netz card
    // as rows, which is where a fact that outlives its moment belongs.
    active: mcpInUse || detail.crossingNow,
    byTag: mcpUser?.tag ?? null,
  });
  // CARD 330 — the browser station, the owner's "counterpart in the OS, namely
  // the headless browser / demo browser". It is drawn on EVERY map, empty when
  // the run drove no browser: a station that appears and disappears is a card
  // whose absence a reader has to interpret.
  //
  // Busy is the ONE thing the scene can honestly say about it. A browser tool
  // has no station in `advanceLoop` — it lands on "agent" like any unknown tool
  // — so occupancy is read off the tool NAME in flight, which is the same fact
  // the agent card is showing.
  N("os-browser", "os", {
    kind: "browser",
    active: atBrowser !== undefined,
    page: detail.page,
    by: usersOf("browser"),
    byTag: atBrowser?.tag ?? null,
  });

  // ----- LLM ----- (the SHARED model — it works for main and every subagent,
  // so it animates and streams for whichever agent is at it right now)
  const llmBusy = scene.focus === "llm" || scene.subagents.some((c) => c.focus === "llm");
  const llmView = llmLanes(scene, detail);
  N("llm", "llm", {
    active: llmBusy,
    provider: opts.provider,
    model: opts.model,
    lanes: llmView.lanes,
    more: llmView.more,
  });

  // ----- external services ----- (edu declutter drops the whole "outside")
  if (!declutter) {
    N("netz", "ext", { kind: "netz", active: mcpInUse || detail.crossingNow, net: netView });
    N("mcpserver", "ext", { kind: "mcpserver", active: mcpInUse, mcp: chain.line, answer: chain.answer });
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
          // `boxed` is what puts `.pf-sub--boxed` on the compact card, and
          // that class is where the band's reserve becomes a BOUND: the card
          // is capped at exactly what its band gave it, every growing region
          // inside it is capped and clipped, and the one control that could
          // still push past all of them — the card's own disclosure — is not
          // drawn on a boxed member at all (nodes.tsx).
          //
          // React Flow is not that bound and never was. Measured in Chrome:
          // `extent: "parent"` clamps a child's POSITION, never its SIZE, and
          // it clamps to the BOX rather than to the band — so a member that
          // grows inside the box stands on the row below it with nothing
          // said, and the one place the clamp fires, the box's own floor, it
          // walks the card up onto the row above. That is how a box thrown
          // minimal on an expanded map came to draw 227-244px cards into the
          // 132 its bands reserved, with the last row 88px above its band.
          //
          // It is set for a member in either view: the expanded card ignores
          // it, so one flag says one thing.
          // And the SEAT its band gave it, because its type does not say: on
          // an expanded map `EXPANDED_CARD.subagent` is 408x480 while a box
          // thrown minimal seats 216x128, and every check that reads a card's
          // envelope off its type would be judging these thirteen against a
          // seat they are not in. Taken off the seat itself, never re-derived
          // from the switch — a second expression for one number can disagree,
          // and the direction it disagrees in here is the invisible one: an
          // envelope smaller than the seat reports nothing.
          data: { ...subCardData(c, b.expandedBox), boxed: true, boxSeat: { w: m.w, h: m.h } },
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
  // CARD 330: the browser station's rail home. STRUCTURAL, like the disk and
  // shell rails — drawn always, lit while a browser tool is in flight. Card 295
  // is why: a station with no rail reads as a card floating beside the map.
  E("e-agent-osbrowser", "agent", "os-browser", "bs", "tt", isHot("main", "browser"), {
    lane: stationLane(null),
  });
  // The MCP call rides the whole chain and lights it end to end while in use:
  //   <caller> → MCP-client → network stack →⟂ Netz → MCP-server
  // The first leg belongs to the CALLING agent (main's rail or the child's
  // own rail below); the chain from the client outward is shared.
  // CARD 328 — and the error mark is REACHABLE now, which it was not.
  //
  // `mcpUser?.loop.isError` alone could never be true for an ANSWERED error, by
  // construction: `advanceLoop`'s tool_result case spreads `idleActivity()`,
  // which sets `activeMcp: null`; MCP occupancy IS `activeMcp !== null`
  // (stationUsers.ts); so the very event that sets `isError` also empties
  // `on("mcp")` and left `mcpUser` undefined. The only chain that could ever go
  // red was a DENIED permission_decision — and all three MCP calls in the whole
  // store were allowed, so it had never once fired. The answer the card now
  // keeps is what makes the mark reachable.
  const mcpErr = (mcpUser?.loop.isError ?? false) || chain.isError;
  const mcpByWorker = mcpUser !== undefined && mcpUser.agentId !== "main";
  // WHO the red belongs to. `mcpUser` is undefined exactly when an ANSWERED
  // error landed — `tool_result` spreads `idleActivity()` and empties the
  // station — so keying the mark on the live occupant left the leg INTO the
  // client clean while the chain outward from it went red: half a red chain,
  // which reads as a failure that started at the network. The exchange knows
  // who asked it and outlives the station.
  const mcpErrAgent = mcpUser?.agentId ?? chain.askedBy;
  E("e-agent-osmcp", "agent", "os-mcp", "bs", "tt", isHot("main", "mcp"), {
    err: mcpErr && mcpErrAgent === "main",
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
        err: (c.isError && isHot(c.id, st)) || (st === "mcp" && mcpErr && mcpErrAgent === c.id),
        dim: !isHot(c.id, st),
        worker: true,
        lane: stationLane(seat),
      });
    stationRail("osdisk", "os-disk", "disk");
    stationRail("osshell", "os-shell", "cmd");
    stationRail("osmcp", "os-mcp", "mcp");
    // CARD 330, round 2: the browser gets a child rail like the other three.
    // Without it a worker driving the browser had its work drawn on the main
    // agent's leg — the misattribution card 287 removed everywhere else.
    stationRail("osbrowser", "os-browser", "browser");
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
    // holds 216x128 cards at the minimal pitch, and the expanded envelope
    // would read those five as five cards lying on top of each other.
    //
    // Read off the node, where the seating put it, rather than re-derived from
    // the switch — and read there by BOTH arms of the check, so there is one
    // expression for the number instead of two that can disagree. The
    // direction they can disagree in is the invisible one: an envelope smaller
    // than the seat reports nothing and hides the collisions that ARE there.
    reportSeatCollisions(
      nodes.map((n) => {
        const seat = (n.data as { boxSeat?: { w: number; h: number } } | undefined)?.boxSeat;
        return {
          id: n.id,
          type: n.type,
          position: world.get(n.id) ?? n.position,
          ...(seat === undefined ? {} : { env: seat }),
        };
      }),
    );
  }
  // CARD 306: React Flow REQUIRES a parent to appear before its children, and
  // until now the push order satisfied that by accident. An accident is not a
  // guarantee — the next card that moves a push moves it silently — so the
  // order is produced. Everything else keeps the order it was pushed in.
  return { nodes: orderParentsFirst(nodes), edges };
}
