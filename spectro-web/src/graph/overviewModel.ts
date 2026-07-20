// The flow-overview model — a pure fold from the FULL RunEvent stream to a
// BPMN-like flow: rounded activities in sequence on the always-present main
// spine, each subagent wave a parallel block (N branch columns that join back).
// Ported from the LLM_Simulator (which extracted spectroscope's System-Map); keep the
// two in sync when either side evolves.
//
// Invariant (the pane's contract): the returned top-level nodes PARTITION the
// event indices [0..events.length) — no gaps, no overlaps — so mapping the
// stepper cursor to "the activity it is inside" is a plain range lookup, and
// clicking an activity can seek to its first event.

import type { RunEvent } from "../events";
import { fileLabel } from "../lab/labScene";

export type ActivityKind = "user" | "think" | "tool" | "say" | "compact" | "end";

export interface Activity {
  id: string;
  kind: ActivityKind;
  label: string;
  agentId: string;
  from: number;
  to: number;
  isError?: boolean;
  gate?: "pending" | "allowed" | "denied";
  /** Accumulated think/say text (capped) — real streams delta token by token,
   *  so the label grows with the stream instead of freezing on token one. */
  text?: string;
}

// Enough accumulated text for a 120-char label plus a useful tooltip.
const TEXT_CAP = 400;
/** Activity labels clip to this width — three sites that must agree. */
const ACTIVITY_LABEL_CHARS = 120;
const COMMAND_PREVIEW_CHARS = 80;
const URL_PREVIEW_CHARS = 60;

/** Open a think/say activity from its first delta. */
function textActivity(id: string, kind: ActivityKind, agentId: string, text: string, i: number): Activity {
  return { id, kind, label: cut(text, ACTIVITY_LABEL_CHARS), agentId, from: i, to: i, text: text.slice(0, TEXT_CAP) };
}

/** Stretch an open think/say activity by one more delta. */
function growText(a: Activity, text: string, i: number): void {
  a.to = i;
  if ((a.text ?? "").length < TEXT_CAP) {
    a.text = ((a.text ?? "") + text).slice(0, TEXT_CAP);
    a.label = cut(a.text, ACTIVITY_LABEL_CHARS);
  }
}

export interface Branch {
  agentId: string;
  label: string | null;
  activities: Activity[];
}

export type OverviewNode =
  | { t: "activity"; a: Activity }
  | { t: "parallel"; id: string; label: string; from: number; to: number; branches: Branch[] };

const cut = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

const inputStr = (input: unknown, key: string): string | null => {
  if (input !== null && typeof input === "object" && key in (input as object)) {
    const v = (input as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
};

function toolLabel(name: string, input: unknown): string {
  if (name === "read_file") return `read ${fileLabel(inputStr(input, "path") ?? "file")}`;
  if (name === "write_file") return `write ${fileLabel(inputStr(input, "path") ?? "file")}`;
  if (name === "edit_file") return `edit ${fileLabel(inputStr(input, "path") ?? "file")}`;
  if (name === "list_dir") return `ls ${inputStr(input, "path") ?? ""}`.trim();
  if (name === "run_command") return `$ ${cut(inputStr(input, "command") ?? "command", COMMAND_PREVIEW_CHARS)}`;
  if (name === "web_fetch") return `fetch ${cut(inputStr(input, "url") ?? "url", URL_PREVIEW_CHARS)}`;
  if (name === "web_search") return `search "${cut(inputStr(input, "query") ?? "query", URL_PREVIEW_CHARS)}"`;
  if (name === "browse_page") return `browse ${cut(inputStr(input, "url") ?? "url", URL_PREVIEW_CHARS)}`;
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const sep = rest.indexOf("__");
    return sep < 0 ? rest : `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
  }
  return name;
}

export function buildOverview(events: RunEvent[]): OverviewNode[] {
  const nodes: OverviewNode[] = [];
  let seq = 0;
  const nextId = () => `ov${++seq}`;

  // --- main spine state ---
  let cur: Activity | null = null; // open main activity (owned by the last pushed node)
  // --- parallel block state ---
  let block: Extract<OverviewNode, { t: "parallel" }> | null = null;
  let wrapperCallId: string | null = null;
  const branchOpen = new Map<string, Activity | null>(); // agentId -> open branch activity
  // tool activities looked up by callId (main and branch alike) for gate/result routing
  const byCall = new Map<string, Activity>();

  const pushMain = (a: Activity) => {
    nodes.push({ t: "activity", a });
    cur = a;
  };
  const closeMain = () => {
    cur = null;
  };
  const extend = (i: number) => {
    // book-keeping events stretch whatever is open; inside a block, the block.
    if (block) block.to = i;
    else if (cur) cur.to = i;
    else if (nodes.length > 0) {
      const last = nodes[nodes.length - 1];
      if (last.t === "activity") last.a.to = i;
      else last.to = i;
    }
  };

  /** Does this main tool_call wrap a subagent wave? (an agent_spawn arrives before its result) */
  const wrapsSpawn = (i: number, callId: string): boolean => {
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j];
      if (e.type === "agent_spawn") return true;
      if (e.type === "tool_result" && e.callId === callId) return false;
    }
    return false;
  };

  const openBlock = (i: number, label: string, callId: string | null) => {
    closeMain();
    block = { t: "parallel", id: nextId(), label, from: i, to: i, branches: [] };
    wrapperCallId = callId;
    nodes.push(block);
  };
  const closeBlock = (i: number) => {
    if (!block) return;
    block.to = i;
    for (const b of block.branches) branchOpen.set(b.agentId, null);
    block = null;
    wrapperCallId = null;
  };
  const branchOf = (agentId: string): Branch | null => block?.branches.find((b) => b.agentId === agentId) ?? null;

  const foldChildContent = (i: number, agentId: string, e: RunEvent) => {
    const br = branchOf(agentId);
    if (!br || !block) return extend(i);
    block.to = i;
    const open = branchOpen.get(agentId) ?? null;
    if (e.type === "thinking_delta" || e.type === "text_delta") {
      const kind: ActivityKind = e.type === "thinking_delta" ? "think" : "say";
      if (open && open.kind === kind) { growText(open, e.text, i); return; }
      const a = textActivity(nextId(), kind, agentId, e.text, i);
      br.activities.push(a);
      branchOpen.set(agentId, a);
      return;
    }
    if (e.type === "tool_call") {
      if (e.name === "report_status") { if (open) open.to = i; return; }
      const a: Activity = { id: nextId(), kind: "tool", label: toolLabel(e.name, e.input), agentId, from: i, to: i };
      br.activities.push(a);
      branchOpen.set(agentId, a);
      byCall.set(e.callId, a);
      return;
    }
    if (e.type === "tool_result") {
      const a = byCall.get(e.callId);
      if (a && a.agentId === agentId) { a.to = i; a.isError = e.isError || a.gate === "denied"; branchOpen.set(agentId, null); }
      else if (open) open.to = i;
      return;
    }
    if (open) open.to = i;
  };

  events.forEach((e, i) => {
    // ---- gate events route by callId, wherever the tool lives ----
    if (e.type === "permission_request") {
      const a = byCall.get(e.callId);
      if (a) { a.gate = "pending"; a.to = Math.max(a.to, i); }
      extend(i);
      return;
    }
    if (e.type === "permission_decision") {
      const a = byCall.get(e.callId);
      if (a) { a.gate = e.allowed ? "allowed" : "denied"; a.to = Math.max(a.to, i); }
      extend(i);
      return;
    }

    // ---- inside a parallel block ----
    if (block) {
      if (e.type === "agent_spawn") {
        block.branches.push({ agentId: e.agentId, label: null, activities: [] });
        block.to = i;
        return;
      }
      if (e.type === "agent_message") {
        if (e.role === "task") {
          const br = branchOf(e.to);
          if (br && br.label === null) br.label = e.label ?? null;
        }
        block.to = i;
        return;
      }
      const agent = "agentId" in e && typeof e.agentId === "string" ? e.agentId : null;
      if (agent && agent !== "main" && branchOf(agent)) {
        if (e.type === "run_start" || e.type === "turn_start") { block.to = i; return; }
        foldChildContent(i, agent, e);
        return;
      }
      if (e.type === "run_end" && branchOf("") === null) {
        // a CHILD's run_end carries no agentId — it can only belong to the block
        block.to = i;
        return;
      }
      if (e.type === "tool_result" && agent === "main") {
        const closes = (wrapperCallId !== null && e.callId === wrapperCallId) ||
          (wrapperCallId === null && branchOf(e.callId) !== null);
        block.to = i;
        if (closes) closeBlock(i);
        return;
      }
      block.to = i; // any other event inside the wave stretches the block
      return;
    }

    // ---- main spine ----
    switch (e.type) {
      case "run_start":
        closeMain();
        pushMain({ id: nextId(), kind: "user", label: cut(e.prompt, ACTIVITY_LABEL_CHARS), agentId: "main", from: i, to: i });
        return;
      case "thinking_delta":
      case "text_delta": {
        const kind: ActivityKind = e.type === "thinking_delta" ? "think" : "say";
        if (cur && cur.kind === kind) { growText(cur, e.text, i); return; }
        closeMain();
        pushMain(textActivity(nextId(), kind, "main", e.text, i));
        return;
      }
      case "tool_call": {
        if (wrapsSpawn(i, e.callId)) {
          openBlock(i, e.name, e.callId);
          return;
        }
        closeMain();
        const a: Activity = { id: nextId(), kind: "tool", label: toolLabel(e.name, e.input), agentId: "main", from: i, to: i };
        byCall.set(e.callId, a);
        pushMain(a);
        return;
      }
      case "agent_spawn":
        // spawn without a wrapper call (defensive: foreign/imported streams)
        openBlock(i, "subagents", null);
        block!.branches.push({ agentId: e.agentId, label: null, activities: [] });
        return;
      case "tool_result": {
        const a = byCall.get(e.callId);
        if (a) { a.to = i; a.isError = e.isError || a.gate === "denied"; if (cur === a) closeMain(); }
        else extend(i);
        return;
      }
      case "compaction":
        closeMain();
        pushMain({ id: nextId(), kind: "compact", label: "compaction", agentId: "main", from: i, to: i });
        closeMain();
        return;
      case "run_end":
        closeMain();
        pushMain({ id: nextId(), kind: "end", label: "end", agentId: "main", from: i, to: i });
        closeMain();
        return;
      default:
        extend(i); // turn_start / context_info / usage / agent_message / plan / error
        return;
    }
  });

  return nodes;
}

/** The id of the node/branch-activity the cursor (events[0..n)) is inside. */
export function activityAt(nodes: OverviewNode[], n: number): string | null {
  if (n <= 0) return null;
  const idx = n - 1;
  for (const nd of nodes) {
    if (nd.t === "activity") {
      if (idx >= nd.a.from && idx <= nd.a.to) return nd.a.id;
    } else if (idx >= nd.from && idx <= nd.to) {
      for (const b of nd.branches) {
        for (const a of b.activities) if (idx >= a.from && idx <= a.to) return a.id;
      }
      return nd.id;
    }
  }
  return null;
}
