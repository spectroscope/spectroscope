// The Flow-map scene model — a pure, DOM-free fold over RunEvents. Where the
// Petri marking (petriModel.ts, folded by the stepper as its formal invariant)
// tracks a token count
// per place, the scene tracks exactly WHICH element each agent's packet is on
// right now (`focus`) plus the detail the map paints: disk read/write, gate
// state, the exact tool, and — pulled from the event input — the file, shell
// command and MCP call.
//
// Every agent (the main agent AND each subagent) has its OWN loop state, folded
// with the SAME transition logic (advanceLoop). A child's events carry its
// agentId, so they fold into that child's loop — the map can then draw each
// subagent as its own little agent loop, with its own packet, next to the main.

import type { RunEvent } from "../events";

/** The element an agent's packet currently sits on / that is active. */
export type Focus = "user" | "agent" | "llm" | "gate" | "disk" | "cmd" | "mcp";
export type DiskState = "idle" | "read" | "write";
export type GateState = "none" | "pending" | "allowed" | "denied";
export type LifecycleState = "submitted" | "working" | "completed" | "failed";

/** One agent's loop state — where its packet is and what it is doing. */
export interface Loop {
  focus: Focus;
  disk: DiskState;
  gate: GateState;
  /** Exact tool name, so the matching chip lights (null when no tool runs). */
  activeTool: string | null;
  /** Basename (path stripped, middle-truncated) of the file a disk tool touches. */
  activeFile: string | null;
  /** The shell command for run_command. */
  activeCommand: string | null;
  /** "server · tool" for an mcp__server__tool call. */
  activeMcp: string | null;
  isError: boolean;
}

/** One subagent — its A2A card meta PLUS its own loop (it runs like the main agent). */
export interface SubagentInfo extends Loop {
  id: string;
  /** The dev tool that spawned it ("build_plan", …) or null for plain spawns. */
  label: string | null;
  /** The assignment as the requester phrased it. */
  task: string;
  state: LifecycleState;
  /** The child's latest report_status line. */
  lastStatus: string | null;
}

export interface Scene extends Loop {
  /** true = LLM runs on this machine (Ollama); false = remote; null = unknown. */
  llmLocal: boolean | null;
  /** Subagent loops in spawn order — empty means the map renders like before. */
  subagents: SubagentInfo[];
  /** The child whose event arrived last — lets the owning loop pulse. */
  activeChild: string | null;
  /** runId of the ROOT run, so a CHILD's run_end doesn't clear the subagents. */
  rootRunId: string | null;
  /** callId -> agentId of the agent that raised each pending gate. A
   *  permission_decision carries NO agentId, so this map routes the decision
   *  back to the SAME loop that asked (the main agent or a specific child). */
  gateOwners: Record<string, string>;
}

const MAIN = "main";
const DISK_TOOLS = new Set(["read_file", "write_file", "list_dir"]);

/** Only Ollama runs the model on the user's machine; everything else is remote. */
export function isLocalProvider(provider: string | null | undefined): boolean {
  return typeof provider === "string" && provider.toLowerCase() === "ollama";
}

/** Last path segment, then Apple-style middle ellipsis so start AND end stay readable. */
export function fileLabel(path: string, max = 22): string {
  const segs = path.split(/[/\\]+/).filter(Boolean);
  const name = segs.length > 0 ? segs[segs.length - 1] : path;
  if (name.length <= max) return name;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/** A fresh loop — a spawned/running agent starts "at the agent". */
export function initialLoop(): Loop {
  return {
    focus: "agent",
    disk: "idle",
    gate: "none",
    activeTool: null,
    activeFile: null,
    activeCommand: null,
    activeMcp: null,
    isError: false,
  };
}

export function initialScene(): Scene {
  return {
    ...initialLoop(),
    focus: "user", // the main agent idles at the user before a run
    llmLocal: null,
    subagents: [],
    activeChild: null,
    rootRunId: null,
    gateOwners: {},
  };
}

function agentOf(event: RunEvent): string | null {
  return "agentId" in event && typeof event.agentId === "string" ? event.agentId : null;
}

/** Read a string field out of an event's (untrusted) tool input. */
function inputStr(input: unknown, key: string): string | null {
  if (input !== null && typeof input === "object" && key in (input as object)) {
    const v = (input as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** "mcp__notes__search_notes" -> "notes · search_notes". */
function prettyMcp(name: string): string {
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return rest;
  return `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
}

/** The clean-slate activity fields, reused by run_start / tool_result / run_end. */
function idleActivity(): Pick<Loop, "disk" | "gate" | "activeTool" | "activeFile" | "activeCommand" | "activeMcp"> {
  return { disk: "idle", gate: "none", activeTool: null, activeFile: null, activeCommand: null, activeMcp: null };
}

/**
 * Fold one event onto ONE agent's loop — the shared transition logic used for the
 * main agent and each subagent alike. Events that don't move the loop (usage,
 * context_info, …) return it unchanged.
 */
export function advanceLoop(loop: Loop, event: RunEvent): Loop {
  switch (event.type) {
    case "run_start":
      return { ...loop, ...idleActivity(), focus: "agent", isError: false };
    case "turn_start":
    case "text_delta":
    case "thinking_delta":
      return { ...loop, focus: "llm", isError: false };
    case "tool_call": {
      const base = { ...loop, ...idleActivity(), activeTool: event.name, isError: false };
      if (event.name.startsWith("mcp__")) {
        return { ...base, focus: "mcp", activeMcp: prettyMcp(event.name) };
      }
      if (event.name === "run_command") {
        return { ...base, focus: "cmd", activeCommand: inputStr(event.input, "command") };
      }
      if (DISK_TOOLS.has(event.name)) {
        const path = inputStr(event.input, "path");
        return {
          ...base,
          focus: "disk",
          disk: event.name === "write_file" ? "write" : "read",
          activeFile: path !== null ? fileLabel(path) : null,
        };
      }
      return { ...base, focus: "agent" }; // unknown tool: no dedicated station
    }
    case "permission_request":
      return { ...loop, focus: "gate", gate: "pending" };
    case "permission_decision":
      return { ...loop, gate: event.allowed ? "allowed" : "denied", isError: !event.allowed };
    case "tool_result":
      return { ...loop, ...idleActivity(), focus: "agent", isError: event.isError };
    case "run_end":
      return { ...loop, ...idleActivity(), focus: "user", isError: false };
    case "error":
      return { ...loop, ...idleActivity(), focus: "user", isError: true };
    default:
      return loop; // usage / compaction / context_info / unknown: no move
  }
}

/** Upsert a subagent by id (spawn and task message may arrive either way). */
function upsertCard(cards: SubagentInfo[], id: string, patch: Partial<SubagentInfo>): SubagentInfo[] {
  const at = cards.findIndex((c) => c.id === id);
  if (at < 0) {
    return [...cards, { id, label: null, task: "", state: "submitted", lastStatus: null, ...initialLoop(), ...patch }];
  }
  const next = [...cards];
  next[at] = { ...next[at], ...patch };
  return next;
}

/** Fold a child event into that child's own loop (creating its card if unseen). */
function foldChild(cards: SubagentInfo[], id: string, event: RunEvent): SubagentInfo[] {
  const at = cards.findIndex((c) => c.id === id);
  if (at < 0) {
    const fresh: SubagentInfo = {
      id, label: null, task: "", state: "submitted", lastStatus: null,
      ...advanceLoop(initialLoop(), event),
    };
    return [...cards, fresh];
  }
  const next = [...cards];
  next[at] = { ...next[at], ...advanceLoop(next[at], event) };
  return next;
}

/** Fold one event onto the whole scene (the main loop + the subagents). Never mutates. */
export function advanceScene(scene: Scene, event: RunEvent): Scene {
  // Parent-level A2A card meta — handled before the child guard even though the
  // ids name children; they never move a loop.
  if (event.type === "agent_spawn") {
    return { ...scene, subagents: upsertCard(scene.subagents, event.agentId, { task: event.task }) };
  }
  if (event.type === "agent_message") {
    switch (event.role) {
      case "task":
        return {
          ...scene,
          subagents: upsertCard(scene.subagents, event.to,
            { task: event.text, label: event.label ?? null, state: "submitted" }),
        };
      case "status":
        return {
          ...scene,
          subagents: upsertCard(scene.subagents, event.from, { state: "working", lastStatus: event.text }),
          activeChild: event.from,
        };
      case "result":
        return {
          ...scene,
          subagents: upsertCard(scene.subagents, event.from,
            { state: event.state === "completed" ? "completed" : "failed" }),
          activeChild: event.from,
        };
      default:
        return scene;
    }
  }

  // The permission gate spans two events: the request carries the asking
  // agentId (route to that loop, remember the callId's owner); the decision
  // carries NONE, so resolve the owner by callId and fold the decision back
  // into the SAME loop — otherwise a child's decision would move the main gate
  // and strand the child at "pending" (and a child denial would redden the
  // whole main map).
  if (event.type === "permission_request") {
    const owner = agentOf(event) ?? MAIN;
    const gateOwners = { ...scene.gateOwners, [event.callId]: owner };
    return owner === MAIN
      ? { ...scene, gateOwners, ...advanceLoop(scene, event) }
      : { ...scene, gateOwners, subagents: foldChild(scene.subagents, owner, event), activeChild: owner };
  }
  if (event.type === "permission_decision") {
    const owner = scene.gateOwners[event.callId] ?? MAIN;
    const { [event.callId]: _resolved, ...gateOwners } = scene.gateOwners;
    return owner === MAIN
      ? { ...scene, gateOwners, ...advanceLoop(scene, event) }
      : { ...scene, gateOwners, subagents: foldChild(scene.subagents, owner, event), activeChild: owner };
  }

  const agent = agentOf(event);
  if (agent !== null && agent !== MAIN) {
    // A CHILD event → fold into that child's OWN loop; the main packet stays put.
    return { ...scene, subagents: foldChild(scene.subagents, agent, event), activeChild: agent };
  }

  // Main / scene-level events.
  switch (event.type) {
    case "run_start": {
      // Only the ROOT run_start reaches here — a child's carries agentId ≠ main.
      const provider = "provider" in event ? event.provider : undefined;
      return {
        ...initialScene(),
        llmLocal: provider !== undefined ? isLocalProvider(provider) : scene.llmLocal,
        focus: "agent",
        rootRunId: event.runId,
      };
    }
    case "run_end":
      // A CHILD's own run_end (a different runId, no agentId) must NOT clear the
      // subagents — only the root run ending retires them.
      if (scene.rootRunId !== null && event.runId !== scene.rootRunId) return scene;
      return { ...scene, ...idleActivity(), focus: "user", isError: false, subagents: [], activeChild: null, rootRunId: null, gateOwners: {} };
    default:
      // Every other main event moves the main loop.
      return { ...scene, ...advanceLoop(scene, event) };
  }
}
