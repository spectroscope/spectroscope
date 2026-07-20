// A scripted RunEvent stream for the prototype: a compressed but faithful replay
// of a real recorded session (build_plan -> worker-1), spliced with an approved
// run_command gate and a DENIED mcp call so the demo exercises every station:
// thinking, a subagent A2A lifecycle (spawn -> task -> status -> result), disk
// read, an approved permission gate, a denied MCP call (red), and the final
// answer. The wire shapes match events.ts exactly. English edition.

import type { RunEvent } from "../events";

const MAIN_RUN = "run-main-01";
const CHILD_RUN = "run-worker-1";
const C = {
  plan: "call-build-plan",
  skill: "call-use-skill",
  status1: "call-status-1",
  read: "call-read",
  cmd: "call-run-cmd",
  mcp: "call-mcp-search",
};

const CHILD_TASK =
  "You are a senior PLANNER. Produce a concrete step-by-step plan for the task " +
  "below. If a use_skill tool is available, load the 'writing-plans' skill first " +
  "and follow it. Report progress via report_status.";

/** The user prompt of the demo run, also handy to copy and use live. */
export const DEMO_PROMPT =
  'Add a --version flag to the Java CLI "spectroscope". Plan it first with the build_plan ' +
  "tool (max 5 steps, do not write files), then show me the plan.";

/** A representative spectroscope system prompt, shown in the Agent's System context panel. */
export const DEMO_SYSTEM_PROMPT = `You are spectroscope, a coding agent. You work in a loop: think, call a tool, read the result, repeat, until the task is done, then you answer the user.

Tools: read_file, write_file, list_dir, run_command plus the subagent tools build_plan / develop / test, use_skill and report_status.

Rules:
- You construct tool inputs yourself; treat every input as model output (untrusted).
- Paths are sandboxed to the project (no ".." escape).
- run_command and MCP calls need the user's approval.
- Plan before large changes. Be concise and precise.`;

const raw: RunEvent[] = [
  { type: "run_start", runId: MAIN_RUN, agentId: "main", prompt: DEMO_PROMPT, provider: "ollama", ts: 0 },
  { type: "turn_start", agentId: "main", turn: 1, ts: 0 },
  { type: "context_info", agentId: "main", turn: 1, messages: 1, estimatedTokens: 1361, threshold: 100000, parts: [
      { label: "system prompt", chars: 1027, estTokens: 256 },
      { label: "tool schemas", chars: 4224, estTokens: 1056 },
      { label: "conversation", chars: 198, estTokens: 49 },
    ], ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "The user wants a plan. I delegate it to a planner subagent via build_plan.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: C.plan, name: "build_plan", input: { task: "Plan how to add a --version flag to the Java CLI \"spectroscope\". Maximum 5 steps. Do not write files, just the plan as text." }, ts: 0 },
  { type: "usage", agentId: "main", inputTokens: 1153, outputTokens: 127, ts: 0 },
  { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: CHILD_TASK, ts: 0 },
  { type: "agent_message", from: "main", to: "worker-1", role: "task", state: "submitted", text: "Plan how to add a --version flag to the Java CLI \"spectroscope\". Maximum 5 steps.", label: "build_plan", ts: 0 },

  // ---- child worker-1 runs in parallel ----
  { type: "run_start", runId: CHILD_RUN, agentId: "worker-1", parentId: "main", prompt: CHILD_TASK, provider: "ollama", ts: 0 },
  { type: "turn_start", agentId: "worker-1", turn: 1, ts: 0 },
  { type: "thinking_delta", agentId: "worker-1", text: "First I load the 'writing-plans' skill to follow the format.", ts: 0 },
  { type: "tool_call", agentId: "worker-1", callId: C.skill, name: "use_skill", input: { name: "writing-plans" }, ts: 0 },
  { type: "tool_result", agentId: "worker-1", callId: C.skill, output: "# Writing plans\n\nUse this skill when a design exists and the next artifact is a PLAN. Keep steps small, verifiable, ordered …", isError: false, durationMs: 2, ts: 0 },
  { type: "tool_call", agentId: "worker-1", callId: C.status1, name: "report_status", input: { message: "Reading task and existing files" }, ts: 0 },
  { type: "agent_message", from: "worker-1", to: "main", role: "status", state: "working", text: "Reading task and existing files", ts: 0 },
  { type: "tool_result", agentId: "worker-1", callId: C.status1, output: "ok", isError: false, durationMs: 0, ts: 0 },
  { type: "thinking_delta", agentId: "worker-1", text: "Now I draft the 5 steps: picocli @Option, VersionProvider, Manifest, test, docs.", ts: 0 },
  { type: "agent_message", from: "worker-1", to: "main", role: "status", state: "working", text: "Drafting the plan", ts: 0 },
  { type: "text_delta", agentId: "worker-1", text: "# Plan: --version flag for the spectroscope CLI\n\n1. picocli @Option(names=\"--version\", versionHelp=true) …", ts: 0 },
  { type: "run_end", runId: CHILD_RUN, stopReason: "end_turn", ts: 0 },
  { type: "agent_message", from: "worker-1", to: "main", role: "result", state: "completed", text: "[worker-1] result (tokens: 4433 in / 1447 out):\n# Plan: --version flag for the spectroscope CLI\n\n1. picocli @Option …", ts: 0 },

  // ---- main receives the plan, resumes ----
  { type: "tool_result", agentId: "main", callId: C.plan, output: "[worker-1] result (tokens: 4433 in / 1447 out):\n# Plan: --version flag …", isError: false, durationMs: 29467, ts: 0 },
  { type: "turn_start", agentId: "main", turn: 2, ts: 0 },
  // Turn 2: the plan result is now in the conversation, so the context grows noticeably.
  { type: "context_info", agentId: "main", turn: 2, messages: 5, estimatedTokens: 3720, threshold: 100000, parts: [
      { label: "system prompt", chars: 1027, estTokens: 256 },
      { label: "tool schemas", chars: 4224, estTokens: 1056 },
      { label: "conversation", chars: 9612, estTokens: 2408 },
    ], ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "The plan is solid. I quickly verify the current Main class before presenting it.", ts: 0 },

  // ---- disk read (permission-free) ----
  { type: "tool_call", agentId: "main", callId: C.read, name: "read_file", input: { path: "spectro-cli/src/main/java/dev/spectroscope/cli/Main.java" }, ts: 0 },
  { type: "tool_result", agentId: "main", callId: C.read, output: "public final class Main { public static void main(String[] a) { … } }", isError: false, durationMs: 3, ts: 0 },

  // ---- approved run_command gate ----
  { type: "tool_call", agentId: "main", callId: C.cmd, name: "run_command", input: { command: "./gradlew test --quiet" }, ts: 0 },
  { type: "permission_request", agentId: "main", callId: C.cmd, name: "run_command", input: { command: "./gradlew test --quiet" }, ts: 0 },
  { type: "permission_decision", callId: C.cmd, allowed: true, ts: 0 },
  { type: "tool_result", agentId: "main", callId: C.cmd, output: "BUILD SUCCESSFUL in 12s\n42 tests, 0 failures", isError: false, durationMs: 12040, ts: 0 },

  // ---- denied MCP gate (red) ----
  { type: "tool_call", agentId: "main", callId: C.mcp, name: "mcp__notes__search_notes", input: { query: "version flag conventions", limit: 5 }, ts: 0 },
  { type: "permission_request", agentId: "main", callId: C.mcp, name: "mcp__notes__search_notes", input: { query: "version flag conventions", limit: 5 }, ts: 0 },
  { type: "permission_decision", callId: C.mcp, allowed: false, ts: 0 },
  { type: "tool_result", agentId: "main", callId: C.mcp, output: "ERROR: the user denied the execution.", isError: true, durationMs: 334, ts: 0 },

  // ---- final answer ----
  { type: "thinking_delta", agentId: "main", text: "Even without the notes the plan is enough. I present it to the user.", ts: 0 },
  { type: "text_delta", agentId: "main", text: "Here is the finished 5-step plan for the --version flag in the spectroscope CLI …", ts: 0 },
  { type: "usage", agentId: "main", inputTokens: 5002, outputTokens: 1604, ts: 0 },
  { type: "run_end", runId: MAIN_RUN, stopReason: "end_turn", ts: 0 },
];

/** The demo events, with a synthetic monotonically increasing timestamp. */
export const DEMO_EVENTS: RunEvent[] = raw.map((e, i) => ({ ...e, ts: 1783423157000 + i * 1200 }));

/** Short human labels for the progress readout, per event index. */
export function eventLabel(e: RunEvent): string {
  switch (e.type) {
    case "run_start": return `run_start · ${e.agentId}`;
    case "turn_start": return `turn_start · ${e.agentId} #${e.turn}`;
    case "context_info": return `context_info · ${e.estimatedTokens} tok`;
    case "thinking_delta": return `thinking · ${e.agentId}`;
    case "text_delta": return `text · ${e.agentId}`;
    case "tool_call": return `tool_call · ${e.name}`;
    case "permission_request": return `permission_request · ${e.name}`;
    case "permission_decision": return `permission_decision · ${e.allowed ? "allow" : "deny"}`;
    case "tool_result": return `tool_result${e.isError ? " · error" : ""}`;
    case "agent_spawn": return `agent_spawn · ${e.agentId}`;
    case "agent_message": return `agent_message · ${e.role}`;
    case "usage": return `usage · ${e.agentId}`;
    case "run_end": return `run_end · ${e.stopReason}`;
    case "error": return `error`;
    default: return (e as RunEvent).type;
  }
}

// ---------------------------------------------------------------------------
// A second scenario: a fan-out into THREE parallel review subagents. The scene
// model + sceneToFlow already render up to three subagent loops, each with its
// own packet, this scenario just feeds them so all three "think" at the LLM at
// once. Ids bugs/perf/security, label "review".
// ---------------------------------------------------------------------------
const MAIN_RUN_F = "run-main-fan";
const CTX_PARTS = [
  { label: "system prompt", chars: 1027, estTokens: 256 },
  { label: "tool schemas", chars: 4224, estTokens: 1056 },
  { label: "conversation", chars: 320, estTokens: 80 },
];

const rawFanout: RunEvent[] = [
  { type: "run_start", runId: MAIN_RUN_F, agentId: "main", prompt: "Review the open PR thoroughly: bugs, performance and security. Check them in parallel, then summarize by priority.", provider: "ollama", ts: 0 },
  { type: "turn_start", agentId: "main", turn: 1, ts: 0 },
  { type: "context_info", agentId: "main", turn: 1, messages: 1, estimatedTokens: 1392, threshold: 100000, parts: CTX_PARTS, ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "I fan out into three parallel reviewers: bugs, performance, security.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: "call-review-fanout", name: "review", input: { areas: ["bugs", "performance", "security"] }, ts: 0 },
  { type: "usage", agentId: "main", inputTokens: 1240, outputTokens: 96, ts: 0 },

  { type: "agent_spawn", agentId: "bugs", parentId: "main", task: "Check the diff for bugs: null checks, off-by-one, error paths.", ts: 0 },
  { type: "agent_message", from: "main", to: "bugs", role: "task", state: "submitted", text: "Find bugs in the diff", label: "review", ts: 0 },
  { type: "agent_spawn", agentId: "perf", parentId: "main", task: "Check the diff for performance issues: N+1 queries, unnecessary allocations.", ts: 0 },
  { type: "agent_message", from: "main", to: "perf", role: "task", state: "submitted", text: "Check performance", label: "review", ts: 0 },
  { type: "agent_spawn", agentId: "security", parentId: "main", task: "Check the diff for security: injection, secrets, path traversal.", ts: 0 },
  { type: "agent_message", from: "main", to: "security", role: "task", state: "submitted", text: "Check security", label: "review", ts: 0 },

  // three children spin up and think at the LLM in parallel
  { type: "run_start", runId: "run-bugs", agentId: "bugs", parentId: "main", prompt: "Find bugs in the diff", provider: "ollama", ts: 0 },
  { type: "run_start", runId: "run-perf", agentId: "perf", parentId: "main", prompt: "Check performance", provider: "ollama", ts: 0 },
  { type: "run_start", runId: "run-security", agentId: "security", parentId: "main", prompt: "Check security", provider: "ollama", ts: 0 },
  { type: "thinking_delta", agentId: "bugs", text: "I check null checks and bounds.", ts: 0 },
  { type: "thinking_delta", agentId: "perf", text: "I look for N+1 queries.", ts: 0 },
  { type: "thinking_delta", agentId: "security", text: "I check injection and secrets.", ts: 0 },

  { type: "tool_call", agentId: "security", callId: "call-sec-read", name: "read_file", input: { path: "src/main/java/app/Db.java" }, ts: 0 },
  { type: "agent_message", from: "bugs", to: "main", role: "status", state: "working", text: "checking null checks", ts: 0 },
  { type: "agent_message", from: "perf", to: "main", role: "status", state: "working", text: "checking queries", ts: 0 },
  { type: "tool_result", agentId: "security", callId: "call-sec-read", output: "String sql = \"SELECT * FROM u WHERE id=\" + id;", isError: false, durationMs: 3, ts: 0 },
  { type: "agent_message", from: "security", to: "main", role: "status", state: "working", text: "checking injection", ts: 0 },

  { type: "text_delta", agentId: "bugs", text: "## Bugs\n- Off-by-one in the pager (last page missing).", ts: 0 },
  { type: "text_delta", agentId: "perf", text: "## Performance\n- N+1 query in ListRepo.findAll().", ts: 0 },
  { type: "text_delta", agentId: "security", text: "## Security\n- SQL concat in Db.java → injection.", ts: 0 },

  { type: "run_end", runId: "run-bugs", stopReason: "end_turn", ts: 0 },
  { type: "agent_message", from: "bugs", to: "main", role: "result", state: "completed", text: "[bugs] 1 bug: off-by-one in the pager.", ts: 0 },
  { type: "run_end", runId: "run-perf", stopReason: "end_turn", ts: 0 },
  { type: "agent_message", from: "perf", to: "main", role: "result", state: "completed", text: "[perf] 1 N+1 query in ListRepo.", ts: 0 },
  { type: "run_end", runId: "run-security", stopReason: "end_turn", ts: 0 },
  { type: "agent_message", from: "security", to: "main", role: "result", state: "completed", text: "[security] SQL concat → injection risk in Db.java.", ts: 0 },

  { type: "tool_result", agentId: "main", callId: "call-review-fanout", output: "3 reviews back: 1 bug, 1 perf, 1 security.", isError: false, durationMs: 21400, ts: 0 },
  { type: "turn_start", agentId: "main", turn: 2, ts: 0 },
  { type: "context_info", agentId: "main", turn: 2, messages: 8, estimatedTokens: 4980, threshold: 100000, parts: [
      { label: "system prompt", chars: 1027, estTokens: 256 },
      { label: "tool schemas", chars: 4224, estTokens: 1056 },
      { label: "conversation", chars: 14672, estTokens: 3668 },
    ], ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "All three reviews are back. I prioritize the security finding.", ts: 0 },
  { type: "text_delta", agentId: "main", text: "Summary: 1 critical security finding (SQL injection), 1 bug, 1 performance issue …", ts: 0 },
  { type: "usage", agentId: "main", inputTokens: 6100, outputTokens: 1420, ts: 0 },
  { type: "run_end", runId: MAIN_RUN_F, stopReason: "end_turn", ts: 0 },
];

/** The fan-out demo (three parallel review subagents), with synthetic timestamps. */
export const DEMO_EVENTS_FANOUT: RunEvent[] = rawFanout.map((e, i) => ({ ...e, ts: 1783430000000 + i * 1200 }));

// ---------------------------------------------------------------------------
// A permission scenario: a denied gate (red) then an approved one (green).
// ---------------------------------------------------------------------------
const rawPermission: RunEvent[] = [
  { type: "run_start", runId: "run-perm", agentId: "main", prompt: "Clean up the data/tmp directory, then show me the git status.", provider: "ollama", ts: 0 },
  { type: "turn_start", agentId: "main", turn: 1, ts: 0 },
  { type: "context_info", agentId: "main", turn: 1, messages: 1, estimatedTokens: 1300, threshold: 100000, parts: CTX_PARTS, ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "Deleting is risky, that needs your approval.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: "c-rm", name: "run_command", input: { command: "rm -rf data/tmp" }, ts: 0 },
  { type: "permission_request", agentId: "main", callId: "c-rm", name: "run_command", input: { command: "rm -rf data/tmp" }, ts: 0 },
  { type: "permission_decision", callId: "c-rm", allowed: false, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "c-rm", output: "ERROR: the user denied the execution.", isError: true, durationMs: 210, ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "Denied. I delete nothing and only take a look.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: "c-ls", name: "list_dir", input: { path: "data/tmp" }, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "c-ls", output: "cache.bin\nsession.log", isError: false, durationMs: 2, ts: 0 },
  { type: "tool_call", agentId: "main", callId: "c-git", name: "run_command", input: { command: "git status --short" }, ts: 0 },
  { type: "permission_request", agentId: "main", callId: "c-git", name: "run_command", input: { command: "git status --short" }, ts: 0 },
  { type: "permission_decision", callId: "c-git", allowed: true, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "c-git", output: " M src/app.ts", isError: false, durationMs: 120, ts: 0 },
  { type: "text_delta", agentId: "main", text: "I deleted nothing (the deletion was denied). Git shows one changed file.", ts: 0 },
  { type: "usage", agentId: "main", inputTokens: 1500, outputTokens: 220, ts: 0 },
  { type: "run_end", runId: "run-perm", stopReason: "end_turn", ts: 0 },
];

// ---------------------------------------------------------------------------
// A disk + shell scenario: read (green), write (coral), list, and shell calls.
// ---------------------------------------------------------------------------
const rawDisk: RunEvent[] = [
  { type: "run_start", runId: "run-disk", agentId: "main", prompt: "Read src/config.json, write the updated version, list src/ and run the tests.", provider: "ollama", ts: 0 },
  { type: "turn_start", agentId: "main", turn: 1, ts: 0 },
  { type: "context_info", agentId: "main", turn: 1, messages: 1, estimatedTokens: 1320, threshold: 100000, parts: CTX_PARTS, ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "First read the config.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: "d-read", name: "read_file", input: { path: "src/config.json" }, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "d-read", output: "{ \"retries\": 3 }", isError: false, durationMs: 2, ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "Now write the new version.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: "d-write", name: "write_file", input: { path: "src/config.json" }, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "d-write", output: "ok, wrote 1 file", isError: false, durationMs: 4, ts: 0 },
  { type: "tool_call", agentId: "main", callId: "d-ls", name: "list_dir", input: { path: "src" }, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "d-ls", output: "app.ts\nconfig.json\nindex.ts", isError: false, durationMs: 1, ts: 0 },
  { type: "thinking_delta", agentId: "main", text: "And run the tests.", ts: 0 },
  { type: "tool_call", agentId: "main", callId: "d-test", name: "run_command", input: { command: "npm test" }, ts: 0 },
  { type: "permission_request", agentId: "main", callId: "d-test", name: "run_command", input: { command: "npm test" }, ts: 0 },
  { type: "permission_decision", callId: "d-test", allowed: true, ts: 0 },
  { type: "tool_result", agentId: "main", callId: "d-test", output: "12 passed, 0 failed", isError: false, durationMs: 9300, ts: 0 },
  { type: "text_delta", agentId: "main", text: "Config updated (retries 3→5), src/ listed, tests green.", ts: 0 },
  { type: "usage", agentId: "main", inputTokens: 2100, outputTokens: 340, ts: 0 },
  { type: "run_end", runId: "run-disk", stopReason: "end_turn", ts: 0 },
];

/** The extra scenarios, with synthetic timestamps. */
export const DEMO_EVENTS_PERMISSION: RunEvent[] = rawPermission.map((e, i) => ({ ...e, ts: 1783440000000 + i * 1200 }));
export const DEMO_EVENTS_DISK: RunEvent[] = rawDisk.map((e, i) => ({ ...e, ts: 1783450000000 + i * 1200 }));

/** Selectable demo scenarios for the prototype toolbar. */
export const SCENARIOS: { id: string; name: string; events: RunEvent[] }[] = [
  { id: "buildplan", name: "build_plan · 1 subagent", events: DEMO_EVENTS },
  { id: "fanout", name: "Review fan-out · 3 subagents", events: DEMO_EVENTS_FANOUT },
  { id: "permission", name: "Permission gate · blocked & allowed", events: DEMO_EVENTS_PERMISSION },
  { id: "diskshell", name: "Disk & shell · read / write", events: DEMO_EVENTS_DISK },
];
