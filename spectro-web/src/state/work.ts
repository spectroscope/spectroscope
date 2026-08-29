// The work fold (branch chat-v2, prototype): RunEvent[] -> WorkItem[], the
// concurrent work running BESIDE the main agent's line of thought. Pure module,
// no React, no store — a second reading of the same list the chat folds from.
//
// The input type is deliberately NOT "a subagent". It is a work item: an id, an
// optional parent, a lifecycle, a span, counters, and a pointer to the events
// that are its evidence. Three kinds map onto it from data that exists today:
//
//   spawn    — a subagent lane (agent_spawn / a child run_start). CONCURRENT,
//              not detached: SubagentManager.java:346 blocks on future.get(),
//              so every child is finished before its parent's turn ends.
//   trigger  — a run woken by a lingering node (run_start.trigger, card 72).
//              Genuinely detached. No recorded session in this prototype has
//              one, and the panel says so rather than drawing an empty row.
//   launched — a background task started by a tool call that returned a
//              receipt and settled later. Only imported Claude Code
//              transcripts carry these today; see readReceipt below.
//
// The governing rule, from the concept: the panel renders no number it cannot
// take you to. Every counter here therefore carries the event that produced it,
// and the panel hands that same object to App's onFocusEvent seam.

import type { RunEvent } from "../events";

export type WorkKind = "spawn" | "trigger" | "launched";

/** Same vocabulary as AgentInfo.state — a work item is read like a lane. */
export type WorkState = "submitted" | "working" | "completed" | "failed";

/**
 * The events behind an item's numbers. Every field is a real frame from the
 * stream, so a click on a figure opens the trace AT that figure. A null field
 * is a number the panel must not print.
 */
export interface WorkEvidence {
  /** The item's first frame: the way in. */
  start: RunEvent | null;
  /** The last usage frame counted into the token totals. */
  tokens: RunEvent | null;
  /** The first tool_call counted into toolCalls. */
  firstCall: RunEvent | null;
  /** The permission_decision that refused something, when one did. */
  denial: RunEvent | null;
  /** The item's last frame: the far end of the span. */
  end: RunEvent | null;
}

/**
 * Counts a launched task REPORTS about itself, in its own words.
 *
 * A Claude Code workflow settles with a `<usage>` block naming its agent count
 * and tool uses; the per-agent detail lives in sibling files the transcript
 * never references. These numbers are therefore quoted, never folded.
 *
 * They do NOT say where the agents are. This comment did until card 313 — it
 * read "work that is not in this stream", and card 297 had already made that
 * false for an import that merged the run's sidecars, whose agents hang off
 * this very item as children. Where a row may say that is decided in one place
 * and against the agents roster: `components/workLevels.ts` besideReading.
 */
export interface OpaqueCounts {
  agents: number | null;
  agentsDone: number | null;
  agentsError: number | null;
  toolUses: number | null;
  durationMs: number | null;
}

export interface WorkItem {
  id: string;
  /** The agent that started it, or null when nothing in the stream says. */
  parentId: string | null;
  kind: WorkKind;
  /** The readable name: a label, a trigger string, or the launching tool. */
  name: string;
  /** What it was asked to do. Empty when the stream never said. */
  intent: string;
  state: WorkState;
  /** The most recent status line the item reported, or null. */
  lastStatus: string | null;
  firstTs: number | null;
  lastTs: number | null;
  inTokens: number;
  outTokens: number;
  toolCalls: number;
  gatesAsked: number;
  gatesDenied: number;
  /** True while one of this item's calls is still waiting at the gate. */
  gatePending: boolean;
  model: string | null;
  provider: string | null;
  /** Non-null only for launched tasks that reported counts we cannot verify. */
  opaque: OpaqueCounts | null;
  /** The workflow run this item launched, when its receipt named one. What the
   *  panel joins to the agent transcripts beside the session (card 177). */
  runId: string | null;
  evidence: WorkEvidence;
  children: WorkItem[];
}

/** A wave: siblings of one parent whose spans overlap. See {@link groupWaves}. */
export interface Wave {
  /** Stable id — the parent plus the wave's ordinal under it. */
  id: string;
  parentId: string | null;
  items: WorkItem[];
  firstTs: number | null;
  lastTs: number | null;
}

// ---------------------------------------------------------------------------
// launched tasks: reading a receipt the importer wrote
// ---------------------------------------------------------------------------

/**
 * The task id a tool_result announces, or null.
 *
 * Deliberately the same grammar as `import/claudeCode.ts` `receiptTaskId`:
 * FIRST LINE only, and it must say launched/started, because an output that
 * merely quotes a task id further down is not a launch. Duplicated rather than
 * imported because the importer keeps it private, and a prototype that exports
 * a function out of the importer to reach it has edited the importer.
 */
const RECEIPT = /\b(?:launched|started)\b[^\n]*?\btask(?:\s+id)?[:\s]\s*([A-Za-z0-9_-]{4,})\b/i;
/** The importer's own outcome header: `--- task <id> · <status> ---`. */
const OUTCOME = /^--- task (\S+)(?: · ([^-]+?))? ---$/gm;
/** The flattened `<usage>` line the importer writes under an outcome. */
const USAGE_LINE = /^usage: (.+)$/m;

/** The `Summary: …` line of a launch receipt, which is the task's intent. */
const SUMMARY = /^Summary:\s*(.+)$/m;
/**
 * The `Run ID:` a Workflow receipt prints — the docking point for card 177.
 *
 * A workflow's agents live in `<session>/subagents/workflows/<runId>/`, so this
 * one string joins a row on screen to that folder — to its transcripts while
 * they are only files, and to the agents themselves once an import has read
 * them into the stream (card 297).
 * Unanchored, unlike RECEIPT: the run id arrives several lines down, and the
 * pattern is specific enough (`wf_` plus the id's alphabet) that a line quoting
 * one is a line about this run either way.
 */
const RUN_ID = /\brun\s*id[:\s]\s*(wf_[A-Za-z0-9_-]{4,})\b/i;

export interface LaunchReceipt {
  taskId: string;
  /** The workflow run, when the receipt named one. Null for a Monitor and for
   *  any launch whose receipt does not print a run id. */
  runId: string | null;
  intent: string;
  /** The last status the task reported; null while it never reported one. */
  status: string | null;
  opaque: OpaqueCounts;
}

const num = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read a launch receipt out of a tool_result's output.
 *
 * The text comes from `import/claudeCode.ts`: the receipt line is the tool's
 * own, and everything after it was appended by that importer when the
 * `<task-notification>` arrived. Nothing is inferred — a field the text does
 * not carry stays null, and the panel prints nothing for it.
 *
 * @param output the tool_result output, whole
 * @return the receipt, or null when this output does not announce a task
 */
export function readReceipt(output: string): LaunchReceipt | null {
  const first = output.split("\n", 1)[0] ?? "";
  const m = RECEIPT.exec(first);
  if (m === null) return null;
  const taskId = m[1];
  // Last outcome wins: a monitor reports many times and the newest state is
  // the one the panel should show.
  let status: string | null = null;
  OUTCOME.lastIndex = 0;
  for (let o = OUTCOME.exec(output); o !== null; o = OUTCOME.exec(output)) {
    const said = (o[2] ?? "").trim();
    // "no result by the end of the transcript" is the importer's own marker
    // for a launch that never settled. It is a real state and not a status.
    status = said === "" || said.startsWith("no result") ? null : said;
  }
  const usage = USAGE_LINE.exec(output);
  const fields = new Map<string, string>();
  if (usage !== null)
    for (const pair of usage[1].split(/\s+/)) {
      const at = pair.indexOf("=");
      if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
    }
  return {
    taskId,
    runId: RUN_ID.exec(output)?.[1] ?? null,
    intent: (SUMMARY.exec(output)?.[1] ?? "").trim(),
    status,
    opaque: {
      agents: num(fields.get("agent_count")),
      agentsDone: num(fields.get("agents_done")),
      agentsError: num(fields.get("agents_error")),
      toolUses: num(fields.get("tool_uses")),
      durationMs: num(fields.get("duration_ms")),
    },
  };
}

// ---------------------------------------------------------------------------
// the fold
// ---------------------------------------------------------------------------

const blankEvidence = (): WorkEvidence => ({
  start: null,
  tokens: null,
  firstCall: null,
  denial: null,
  end: null,
});

function blank(id: string, kind: WorkKind): WorkItem {
  return {
    id,
    parentId: null,
    kind,
    name: id,
    intent: "",
    state: "submitted",
    lastStatus: null,
    firstTs: null,
    lastTs: null,
    inTokens: 0,
    outTokens: 0,
    toolCalls: 0,
    gatesAsked: 0,
    gatesDenied: 0,
    gatePending: false,
    model: null,
    provider: null,
    opaque: null,
    runId: null,
    evidence: blankEvidence(),
    children: [],
  };
}

/** A finished state never reopens: a late status line must not un-finish a lane. */
const settled = (s: WorkState): boolean => s === "completed" || s === "failed";

/**
 * The fold, plus the index a caller needs to join an AGENT to its item.
 *
 * The two are published together because the keys are not one rule. A spawn
 * item is keyed by its agent id, a triggered item by its RUN id — the branch
 * below says so in its own words — and `id` is therefore not a join key for
 * anybody outside this function. Card 301's message lane joined on it, missed
 * every triggered lane, and printed "the run never opened work for this lane"
 * over an item that existed and carried real counters: the exact false claim
 * the null counters were written to prevent.
 */
export interface WorkFold {
  /** Top-level items, children nested under their parent. */
  roots: WorkItem[];
  /**
   * agentId -> the item that agent's events counted towards.
   *
   * Absent for the main agent, which is not a work item, and for an agent the
   * stream only ever named as the sender of a status message. Absent is the
   * absence of a claim; it is not a zeroed item.
   */
  byAgent: Map<string, WorkItem>;
}

/**
 * Fold a stream into the work items running beside the main agent.
 *
 * The MAIN agent is not a work item. It is the left column, and listing it in
 * the panel would render the transcript twice; a session with no concurrent
 * work therefore folds to `[]`, which is the honest reading of a chat where
 * every turn ran on one agent.
 *
 * Unknown event types are ignored, never thrown on — the reducer's contract.
 *
 * @param events the stream, in arrival order
 * @return top-level items, children nested under their parent
 */
export function foldWork(events: readonly RunEvent[]): WorkItem[] {
  return foldWorkIndexed(events).roots;
}

/**
 * {@link foldWork}, keeping the agent index the fold builds on its way.
 *
 * ONE pass: `foldWork` is this function with the index dropped, so a caller
 * that wants both is not asking for a second fold.
 *
 * @param events the stream, in arrival order
 * @return the tree and the agent -> item index
 */
export function foldWorkIndexed(events: readonly RunEvent[]): WorkFold {
  const items = new Map<string, WorkItem>();
  /** agentId -> the item it acts for (spawn and trigger items only). */
  const byAgent = new Map<string, string>();
  /** callId -> the agent that asked for permission. */
  const gateAgent = new Map<string, string>();
  /** Launch candidates: every tool_call, keyed by callId. */
  const calls = new Map<string, { name: string; event: RunEvent; ts: number; agentId: string }>();
  /** callId -> the newest tool_result seen for it. */
  const settleOf = new Map<string, { event: RunEvent; ts: number; output: string }>();

  const ensure = (id: string, kind: WorkKind): WorkItem => {
    let item = items.get(id);
    if (item === undefined) {
      item = blank(id, kind);
      items.set(id, item);
    }
    return item;
  };

  /** Stamp an item's span and its first/last evidence frame. */
  const stamp = (item: WorkItem, ts: number, event: RunEvent): void => {
    if (item.firstTs === null || ts < item.firstTs) {
      item.firstTs = ts;
      item.evidence.start = event;
    }
    if (item.lastTs === null || ts >= item.lastTs) {
      item.lastTs = ts;
      item.evidence.end = event;
    }
  };

  /** The item an agent's events count towards, or undefined for main. */
  const itemOf = (agentId: unknown): WorkItem | undefined => {
    if (typeof agentId !== "string") return undefined;
    const id = byAgent.get(agentId);
    return id === undefined ? undefined : items.get(id);
  };

  for (const event of events) {
    switch (event.type) {
      case "run_start": {
        if (typeof event.trigger === "string" && event.trigger !== "") {
          // A triggered node's run: the work item is the RUN, and its name is
          // what woke it. This is the only genuinely detached source we can
          // read today, and no recorded session in the prototype has one.
          const item = ensure(event.runId, "trigger");
          item.parentId = event.parentId ?? null;
          item.name = event.trigger;
          item.intent = event.prompt;
          item.state = "working";
          item.model = event.model ?? item.model;
          item.provider = event.provider ?? item.provider;
          byAgent.set(event.agentId, item.id);
          stamp(item, event.ts, event);
          break;
        }
        if (event.parentId == null) break; // the main run is the left column
        const item = ensure(event.agentId, "spawn");
        item.parentId = event.parentId;
        if (!settled(item.state)) item.state = "working";
        item.model = event.model ?? item.model;
        item.provider = event.provider ?? item.provider;
        byAgent.set(event.agentId, item.id);
        stamp(item, event.ts, event);
        break;
      }

      case "agent_spawn": {
        const item = ensure(event.agentId, "spawn");
        item.parentId = event.parentId;
        item.intent = event.task;
        byAgent.set(event.agentId, item.id);
        stamp(item, event.ts, event);
        break;
      }

      case "agent_message": {
        if (event.role === "task") {
          const item = ensure(event.to, "spawn");
          item.intent = event.text;
          // The agent type is the only readable name a subagent has; its id is
          // a raw tool-use id in an import.
          if (event.label !== undefined && event.label !== "") item.name = event.label;
          byAgent.set(event.to, item.id);
          break;
        }
        const item = itemOf(event.from);
        if (item === undefined) break;
        stamp(item, event.ts, event);
        if (event.role === "status") {
          if (!settled(item.state)) item.state = "working";
          item.lastStatus = event.text;
        } else if (event.role === "result") {
          item.state = event.state === "completed" ? "completed" : "failed";
        }
        break;
      }

      case "usage": {
        const item = itemOf(event.agentId);
        if (item === undefined) break;
        item.inTokens += event.inputTokens;
        item.outTokens += event.outputTokens;
        item.evidence.tokens = event;
        stamp(item, event.ts, event);
        break;
      }

      case "tool_call": {
        calls.set(event.callId, {
          name: event.name,
          event,
          ts: event.ts,
          agentId: event.agentId,
        });
        const item = itemOf(event.agentId);
        if (item === undefined) break;
        item.toolCalls += 1;
        if (item.evidence.firstCall === null) item.evidence.firstCall = event;
        stamp(item, event.ts, event);
        break;
      }

      case "tool_result": {
        // Newest wins: a background task settles by patching the SAME card, so
        // the last result for a callId is the one that carries the outcome.
        settleOf.set(event.callId, { event, ts: event.ts, output: event.output });
        const item = itemOf(event.agentId);
        if (item !== undefined) stamp(item, event.ts, event);
        break;
      }

      case "permission_request": {
        gateAgent.set(event.callId, event.agentId);
        const item = itemOf(event.agentId);
        if (item === undefined) break;
        item.gatesAsked += 1;
        item.gatePending = true;
        stamp(item, event.ts, event);
        break;
      }

      case "permission_decision": {
        // A decision names no agent — it is joined back through the request
        // that does. A decision without a matching request counts nowhere and
        // is not an error.
        const item = itemOf(gateAgent.get(event.callId));
        if (item === undefined) break;
        item.gatePending = false;
        if (!event.allowed) {
          item.gatesDenied += 1;
          item.evidence.denial = event;
        }
        break;
      }

      case "run_end": {
        // Only a triggered item is closed by a run_end of its own; a subagent
        // lane is closed by its result message.
        for (const item of items.values()) {
          if (item.kind === "trigger" && item.id === event.runId && !settled(item.state)) {
            item.state = event.stopReason === "error" ? "failed" : "completed";
            stamp(item, event.ts, event);
          }
        }
        break;
      }

      default:
        break; // forward compatibility, exactly like the reducer
    }
  }

  // Launched background tasks, read from the receipts their calls returned.
  for (const [callId, call] of calls) {
    const settle = settleOf.get(callId);
    if (settle === undefined) continue;
    const receipt = readReceipt(settle.output);
    if (receipt === null) continue;
    // Card 297. An IMPORTED workflow run is already a node in this stream,
    // spawned under the very tool_use that returned this receipt, with the
    // run's own agents hanging off it. That node IS this launch, so the
    // receipt fills it in rather than opening a second card: keyed apart, one
    // run stood on screen twice — once completed off the receipt, once
    // submitted forever off the node. Its kind stays "spawn", which is what it
    // now is: a run whose agents are in the stream, not a launch known only by
    // the number in its receipt.
    const node = items.get(callId);
    const item = node ?? ensure(receipt.taskId, "launched");
    item.parentId = call.agentId;
    item.name = call.name;
    // A node's intent came from the run's own state file, which names the run
    // better than the receipt's one-line Summary.
    if (node === undefined || item.intent === "") item.intent = receipt.intent;
    item.opaque = receipt.opaque;
    item.runId = receipt.runId;
    // Launch to settlement, for a node exactly as for a bare launch: the
    // node's own three frames are the tool_use stamp and the ending this same
    // result carries, so the two spans are the same span.
    item.evidence.start = call.event;
    item.evidence.end = settle.event;
    item.firstTs = call.ts;
    item.lastTs = settle.ts;
    // No status yet means it never reported back: the transcript ended with
    // the task still out there. That is "working", not "completed". A node the
    // stream already closed keeps its ending — a finished state never reopens.
    if (!settled(item.state))
      item.state =
        receipt.status === null
          ? "working"
          : receipt.status === "completed"
            ? "completed"
            : receipt.status === "failed"
              ? "failed"
              : "working";
  }

  // Nest: an item whose parent is another item hangs under it; everything else
  // is top level (the main agent is not an item, so its children are roots).
  const roots: WorkItem[] = [];
  for (const item of items.values()) {
    const parent = item.parentId === null ? undefined : items.get(item.parentId);
    if (parent !== undefined && parent !== item) parent.children.push(item);
    else roots.push(item);
  }
  const byStart = (a: WorkItem, b: WorkItem): number => (a.firstTs ?? 0) - (b.firstTs ?? 0);
  const sortDeep = (list: WorkItem[]): void => {
    list.sort(byStart);
    for (const item of list) sortDeep(item.children);
  };
  sortDeep(roots);
  // The index resolved to the items themselves. Built here, from the very map
  // whose two keying rules made it necessary, so no caller has to re-derive
  // which rule applied to which item.
  const index = new Map<string, WorkItem>();
  for (const [agentId, itemId] of byAgent) {
    const item = items.get(itemId);
    if (item !== undefined) index.set(agentId, item);
  }
  return { roots, byAgent: index };
}

/**
 * Group siblings into waves by OVERLAP IN TIME.
 *
 * The reference tool's phases are declared by the launching script. We have no
 * declaration and must not invent one, so a phase here is observed: a run of
 * siblings whose spans touch. Items with no span at all (nothing of theirs was
 * ever stamped) join the wave they were listed next to rather than forming a
 * wave of their own, because "unknown when" is not "at a different time".
 *
 * Evaluated and NOT reused for this: `spectrum/fleetLegibility.ts`
 * collapseFleetGraph groups by (parent, role) with no time component, takes a
 * FleetGraph rather than work items, and folds a bucket into ONE aggregate node
 * that hides its members — the opposite of a phase row, which exists to list
 * them.
 *
 * @param items siblings, in any order
 * @return waves in start order; one wave when everything overlaps
 */
export function groupWaves(items: readonly WorkItem[]): Wave[] {
  const sorted = [...items].sort((a, b) => (a.firstTs ?? 0) - (b.firstTs ?? 0));
  const waves: Wave[] = [];
  for (const item of sorted) {
    const open = waves[waves.length - 1];
    const overlaps =
      open !== undefined && (item.firstTs === null || open.lastTs === null || item.firstTs <= open.lastTs);
    if (open !== undefined && overlaps) {
      open.items.push(item);
      if (item.firstTs !== null && (open.firstTs === null || item.firstTs < open.firstTs))
        open.firstTs = item.firstTs;
      if (item.lastTs !== null && (open.lastTs === null || item.lastTs > open.lastTs))
        open.lastTs = item.lastTs;
      continue;
    }
    waves.push({
      id: `${item.parentId ?? ""}#${waves.length}`,
      parentId: item.parentId,
      items: [item],
      firstTs: item.firstTs,
      lastTs: item.lastTs,
    });
  }
  return waves;
}

/** Every item in the tree, parents before children — the panel's flat count. */
export function countWork(items: readonly WorkItem[]): number {
  return items.reduce((n, item) => n + 1 + countWork(item.children), 0);
}
