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

import { emptyQueue, foldQueue, type QueueState } from "./flowmap/queueDepth";
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
  /** Where the packet stood when a permission gate stopped it, so an ALLOWED
   *  decision can put it back (card 295). null whenever no gate is pending —
   *  a denied decision clears it too, because nothing ran. */
  gateFrom: Focus | null;
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
  /** Card 331: what the run has been asked for and has not reached. Import-only
   *  — `queue_operation` never reaches a written spectroscope session. */
  queue: QueueState;
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

/** The session's own agent — the id every top-level event carries and every
 *  spawn hangs under. EXPORTED since card 306 because the map has to ask
 *  whether a workflow's declaration hangs on THIS agent rather than on one of
 *  its children, and a second literal spelling of the same id in a second file
 *  is exactly how the two would come apart. */
export const ROOT_AGENT = "main";
const MAIN = ROOT_AGENT;
/** The native disk verbs. EXPORTED (card 301) so the file footprint folds the
 *  same names this map lights a station for: the map and the tree must never
 *  disagree about what counts as a disk touch, and two copies of a set is
 *  exactly how they would. */
export const DISK_TOOLS = new Set(["read_file", "write_file", "list_dir"]);
// Imported Claude Code transcripts carry Claude Code's tool names. The fold
// routes them to the same stations the native names reach — the recorded name
// itself is NEVER rewritten (the wire is evidence), so activeTool keeps the
// original spelling. AskUserQuestion stays at the agent on purpose: this fold
// uses focus "user" to mean the run is over, and an agent parked at the user
// would read as finished. WebFetch/WebSearch stay dark on purpose: the map has
// no rail from the agent to the network stack, and lighting a station with no
// path to it would claim an MCP chain that never ran.
export const CC_DISK_READ = new Set(["Read", "Glob"]);
export const CC_DISK_WRITE = new Set(["Write", "Edit", "MultiEdit"]);
/** The shell verbs, native and imported — the two that reach the cmd station
 *  and leave a command instead of a path. EXPORTED for the same reason the
 *  disk sets are (card 301): the file footprint counts exactly what the map
 *  lights here, and it can only be exactly that if there is one set. Both
 *  names used to be spelled out as literals in `advanceLoop` below AND copied
 *  into fileTree.ts, which is three declarations of one vocabulary. */
export const SHELL_TOOLS = new Set(["run_command", "Bash"]);
/** The input field a shell call carries its command in — the ONE declaration of
 *  it (card 320). The fold below reads the command out of this key, and the
 *  station that draws it has to ask the classifier about the SAME key or the
 *  two would disagree about what is being coloured. */
export const SHELL_COMMAND_KEY = "command";

/** Middle-ellipsis WITHOUT the basename split — for glob patterns and other
 *  non-path strings the disk pill shows, where the directories are the point. */
export function clipMiddle(s: string, max = 22): string {
  if (s.length <= max) return s;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Last path segment, then Apple-style middle ellipsis so start AND end stay readable. */
export function fileLabel(path: string, max = 22): string {
  const segs = path.split(/[/\\]+/).filter(Boolean);
  const name = segs.length > 0 ? segs[segs.length - 1] : path;
  return clipMiddle(name, max);
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
    gateFrom: null,
    isError: false,
  };
}

export function initialScene(): Scene {
  return {
    ...initialLoop(),
    focus: "user", // the main agent idles at the user before a run
    subagents: [],
    activeChild: null,
    rootRunId: null,
    gateOwners: {},
    queue: emptyQueue(),
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

/**
 * Whether a tool name is an MCP call.
 *
 * ONE rule, three readers. The station switch below, the map's MCP client card
 * and — since card 328 — the fold that keeps the server's answer each spelled
 * `name.startsWith("mcp__")` for themselves, which is three places for the
 * prefix to drift apart and nothing to notice.
 *
 * @param name the wire's tool name
 * @return true for an MCP tool
 */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/** "mcp__notes__search_notes" -> "notes · search_notes". */
export function prettyMcp(name: string): string {
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return rest;
  return `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}`;
}

/** The clean-slate activity fields, reused by run_start / tool_result / run_end. */
function idleActivity(): Pick<
  Loop,
  "disk" | "gate" | "activeTool" | "activeFile" | "activeCommand" | "activeMcp" | "gateFrom"
> {
  return {
    disk: "idle",
    gate: "none",
    activeTool: null,
    activeFile: null,
    activeCommand: null,
    activeMcp: null,
    gateFrom: null,
  };
}

/** The three places a gated tool actually runs — the only origins a decision
 *  can hand the packet back to. */
function isStation(f: Focus | null): f is "disk" | "cmd" | "mcp" {
  return f === "disk" || f === "cmd" || f === "mcp";
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
      if (isMcpTool(event.name)) {
        return { ...base, focus: "mcp", activeMcp: prettyMcp(event.name) };
      }
      // Both shell verbs, from the one set: they were two branches with
      // identical bodies, and each retyped a name the set already declares.
      if (SHELL_TOOLS.has(event.name)) {
        return { ...base, focus: "cmd", activeCommand: inputStr(event.input, SHELL_COMMAND_KEY) };
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
      if (CC_DISK_READ.has(event.name) || CC_DISK_WRITE.has(event.name)) {
        const path = inputStr(event.input, "path") ?? inputStr(event.input, "file_path");
        const pattern = event.name === "Glob" ? inputStr(event.input, "pattern") : null;
        return {
          ...base,
          focus: "disk",
          disk: CC_DISK_WRITE.has(event.name) ? "write" : "read",
          activeFile: pattern !== null ? clipMiddle(pattern, 28) : path !== null ? fileLabel(path) : null,
        };
      }
      return { ...base, focus: "agent" }; // unknown tool: no dedicated station
    }
    case "permission_request":
      // Remember the station the packet was pulled off. A repeated request (or
      // one with no preceding tool_call) must not record the gate as its own
      // origin, or the decision would "return" the packet to where it stands.
      return {
        ...loop,
        gateFrom: loop.focus === "gate" ? loop.gateFrom : loop.focus,
        focus: "gate",
        gate: "pending",
      };
    case "permission_decision":
      // Allowed: the tool NOW runs, so the packet goes back to its station and
      // the station lights for the whole call. Denied: nothing ran, the packet
      // stays at the gate. Either way the memory is spent.
      //
      // Only a STATION is a place to return to. Not every gate stands behind a
      // tool_call: Agent.java asks for the goal check under its own
      // GOAL_CHECK_GATE with no call in front of it, so the remembered origin
      // there is the LLM the turn just ended on. Returning the packet to it
      // would light the model — and say "the model is thinking" — for the whole
      // duration of the check command. The packet waits at the gate instead.
      return {
        ...loop,
        focus: event.allowed && isStation(loop.gateFrom) ? loop.gateFrom : loop.focus,
        gateFrom: null,
        gate: event.allowed ? "allowed" : "denied",
        isError: !event.allowed,
      };
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
    return [
      ...cards,
      { id, label: null, task: "", state: "submitted", lastStatus: null, ...initialLoop(), ...patch },
    ];
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
      id,
      label: null,
      task: "",
      state: "submitted",
      lastStatus: null,
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
  // Card 331: the queue is folded FIRST and returns early, because a queue
  // operation is not a loop event — it carries no agentId, moves no focus, and
  // must not fall through to the child guard below and be attributed to whoever
  // happens to be active.
  const queued = foldQueue(scene.queue, event);
  if (queued !== scene.queue) {
    return { ...scene, queue: queued };
  }

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
          subagents: upsertCard(scene.subagents, event.to, {
            task: event.text,
            label: event.label ?? null,
            state: "submitted",
          }),
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
          subagents: upsertCard(scene.subagents, event.from, {
            state: event.state === "completed" ? "completed" : "failed",
          }),
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
      // The provider used to be folded in here as a locality bit the map drew a
      // second layout from; card 304 dropped that distinction, so the fold has
      // no opinion about the backend left and a run_start is a plain reset.
      return { ...initialScene(), focus: "agent", rootRunId: event.runId };
    }
    case "run_end":
      // A CHILD's own run_end (a different runId, no agentId) must NOT clear the
      // subagents — only the root run ending retires them.
      if (scene.rootRunId !== null && event.runId !== scene.rootRunId) return scene;
      return {
        ...scene,
        ...idleActivity(),
        focus: "user",
        isError: false,
        subagents: [],
        activeChild: null,
        rootRunId: null,
        gateOwners: {},
      };
    default:
      // Every other main event moves the main loop.
      return { ...scene, ...advanceLoop(scene, event) };
  }
}
