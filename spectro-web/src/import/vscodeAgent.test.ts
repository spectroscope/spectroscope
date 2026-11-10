// The VS Code / GitHub Copilot agent-mode export adapter. The export is JSONL of
// dotted-type records whose payload sits under `data`; the adapter maps it onto
// spectroscope's RunEvent stream so a real recorded session replays through the
// same reducers as a spectroscope run.
//
// Two properties carry the weight here and each has its own test: every tool
// call is announced TWICE in the source (once in assistant.message.toolRequests,
// once as tool.execution_start) and must still produce exactly one card; and a
// completion without a result leaves the output empty rather than filled with
// a sentence of the adapter's own. The GitHub Copilot files record the output
// in `result.content` (card 605, task 10), and that is what a result carries.
import { describe, expect, it } from "vitest";
// Vite-native raw import: the fixture arrives as a plain string, no fs/paths.
import vscodeAgent from "./fixtures/vscode-agent.jsonl?raw";
import copilotCli from "./fixtures/copilot-cli.jsonl?raw";
import copilotIde from "./fixtures/copilot-ide.jsonl?raw";
import { isWireEvent } from "../wire/nonWire";
import { parseVscodeAgentExport, vscodeAgentToRunEvents, vscodeAgentWithOrigin } from "./vscodeAgent";
import { advanceScene, initialScene } from "../lab/labScene";
import { initialState, reduceAll } from "../state/reducer";

const events = parseVscodeAgentExport(vscodeAgent);

describe("vscodeAgent adapter", () => {
  it("opens with run_start carrying the first user message", () => {
    expect(events[0]).toMatchObject({ type: "run_start", agentId: "main" });
    expect((events[0] as { prompt: string }).prompt).toMatch(/checkout pods/);
    expect((events[0] as { ts: number }).ts).toBe(Date.parse("2026-07-24T14:43:45.448Z"));
  });

  it("numbers turns by order of appearance, not by the export's turnId", () => {
    // The real export reuses turnIds (a per-request counter that restarts), so
    // the id is worthless as a key — the fixture repeats "2" on purpose.
    const turns = events.filter((e) => e.type === "turn_start").map((e) => e.turn);
    expect(turns).toEqual([1, 2, 3]);
  });

  it("maps reasoningText to thinking and content to text, skipping the empty ones", () => {
    const thinking = events.filter((e) => e.type === "thinking_delta").map((e) => e.text);
    const text = events.filter((e) => e.type === "text_delta").map((e) => e.text);
    expect(thinking).toHaveLength(2); // the third message reasons about nothing
    expect(thinking[0]).toMatch(/restart loop/);
    expect(text).toEqual(["Checking the pod logs first.", "Rolling back now."]);
    expect(text.every((s) => s !== "")).toBe(true);
  });

  it("emits exactly one tool_call per toolCallId although the export announces each twice", () => {
    const calls = events.filter((e) => e.type === "tool_call");
    const ids = calls.map((e) => e.callId);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("takes name and input from tool.execution_start, the richer source", () => {
    const call = events.find((e) => e.type === "tool_call" && e.callId === "call-1");
    expect(call).toMatchObject({ name: "run_in_terminal" });
    expect((call as { input: { command: string } }).input.command).toBe("kubectl logs checkout-7f9");
  });

  it("recovers a call that was announced but never started, so its result is not orphaned", () => {
    // call-3 has a toolRequests entry and a completion but no execution_start —
    // measured in the real export, where four completions arrive that way.
    const call = events.find((e) => e.type === "tool_call" && e.callId === "call-3");
    expect(call).toMatchObject({ name: "kill_terminal" });
    expect(events.some((e) => e.type === "tool_result" && e.callId === "call-3")).toBe(true);
  });

  it("leaves the output of a completion without a result empty, and never invents a placeholder", () => {
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.output === "")).toBe(true);
  });

  it("mirrors success into isError", () => {
    const ok = events.find((e) => e.type === "tool_result" && e.callId === "call-1");
    const failed = events.find((e) => e.type === "tool_result" && e.callId === "call-2");
    expect(ok).toMatchObject({ isError: false });
    expect(failed).toMatchObject({ isError: true });
  });

  it("derives durationMs from the start/complete gap, and stays at 0 when unmatched", () => {
    const byId = (id: string) => events.find((e) => e.type === "tool_result" && e.callId === id);
    expect(byId("call-1")).toMatchObject({ durationMs: 2500 });
    expect(byId("call-2")).toMatchObject({ durationMs: 500 });
    expect(byId("call-3")).toMatchObject({ durationMs: 0 }); // no start to measure from
  });

  it("gives a later user message its own user turn inside the same run", () => {
    const starts = events.filter((e) => e.type === "run_start");
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({ runId: starts[0].runId, agentId: "main" });
    expect(starts[1].prompt).toMatch(/roll the deploy back/);
    expect(starts[1].ts).toBe(Date.parse("2026-07-24T14:44:10.000Z"));
  });

  it("closes with run_end stamped from the last real timestamp", () => {
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "run_end" });
    expect((last as { ts: number }).ts).toBe(Date.parse("2026-07-24T14:44:11.200Z"));
  });

  it("keeps run_end on the file's own clock rather than a constant", () => {
    const shifted = vscodeAgentToRunEvents([
      { type: "user.message", data: { content: "hi" }, id: "a", timestamp: "2031-01-02T03:04:05.000Z" },
      { type: "assistant.turn_start", data: { turnId: "1" }, id: "b", timestamp: "2031-01-02T03:09:09.000Z" },
    ]);
    expect(shifted.at(-1)).toMatchObject({
      type: "run_end",
      ts: Date.parse("2031-01-02T03:09:09.000Z"),
    });
  });

  it("opens a run for an export that begins mid-session, with no prompt invented", () => {
    // The real export starts on a tool record: the opening prompt is simply not
    // in the file. Everything downstream still needs a run to hang from.
    const clipped = vscodeAgentToRunEvents([
      {
        type: "tool.execution_start",
        data: { toolCallId: "c9", toolName: "read_file", arguments: { filePath: "a.ts" } },
        id: "a",
        timestamp: "2026-07-24T10:00:00.000Z",
      },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "c9", success: true },
        id: "b",
        timestamp: "2026-07-24T10:00:01.000Z",
      },
    ]);
    expect(clipped[0]).toMatchObject({ type: "run_start", agentId: "main", prompt: "" });
    expect(clipped.some((e) => e.type === "tool_call" && e.callId === "c9")).toBe(true);
  });

  it("skips records it does not know instead of failing", () => {
    const mixed = vscodeAgentToRunEvents([
      { type: "user.message", data: { content: "go" }, id: "a", timestamp: "2026-07-24T10:00:00.000Z" },
      { type: "workspace.snapshot", data: { files: 3 }, id: "b", timestamp: "2026-07-24T10:00:01.000Z" },
      null,
      "not a record",
    ]);
    expect(mixed[0]).toMatchObject({ type: "run_start" });
    expect(mixed.at(-1)).toMatchObject({ type: "run_end" });
  });

  it("folds to a clean terminal scene", () => {
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

describe("tool arguments announced as a JSON string", () => {
  // The two announcement sites disagree about the type: tool.execution_start
  // carries `arguments` as an object, assistant.message.toolRequests carries
  // the SAME payload as a JSON string. A call that only ever appears in
  // toolRequests therefore reached the card as a quoted blob, and the card
  // rendered escaped JSON instead of the command it describes.
  it("parses a toolRequests argument string into the object it encodes", () => {
    const line = (o: unknown) => JSON.stringify(o);
    const raw = [
      line({
        type: "assistant.message",
        id: "m1",
        timestamp: "2026-07-24T14:00:00.000Z",
        data: {
          messageId: "m1",
          content: "",
          reasoningText: "",
          toolRequests: [
            {
              toolCallId: "only-announced",
              name: "run_in_terminal",
              type: "function",
              arguments: '{"command":"ls -la","explanation":"look around"}',
            },
          ],
        },
      }),
    ].join("\n");

    const events = vscodeAgentToRunEvents(raw.split("\n").map((l) => JSON.parse(l)));
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeDefined();
    expect(call!.input).toEqual({ command: "ls -la", explanation: "look around" });
  });

  it("keeps an unparseable argument string as-is rather than dropping it", () => {
    const raw = JSON.stringify({
      type: "assistant.message",
      id: "m1",
      timestamp: "2026-07-24T14:00:00.000Z",
      data: {
        messageId: "m1",
        content: "",
        reasoningText: "",
        toolRequests: [{ toolCallId: "c1", name: "x", type: "function", arguments: "not json {" }],
      },
    });
    const events = vscodeAgentToRunEvents([JSON.parse(raw)]);
    const call = events.find((e) => e.type === "tool_call");
    expect(call!.input).toBe("not json {");
  });
});

describe("the Copilot CLI's session.start names the folder the session ran in (card 605)", () => {
  // The CLI's own session file opens with `session.start`, whose
  // `data.context.cwd` is the folder the session ran in. The importer hands it
  // on as the import-only `ground_info` frame the Claude Code importer writes,
  // and the files tab reads that frame as the workspace.
  const start = (context: unknown) => ({
    type: "session.start",
    data: { sessionId: "s", context },
    id: "a",
    timestamp: "2026-11-10T09:00:00.000Z",
  });
  const user = {
    type: "user.message",
    data: { content: "go" },
    id: "b",
    timestamp: "2026-11-10T09:00:01.000Z",
  };
  const grounds = (events: readonly { type: string }[]) => events.filter((e) => e.type === "ground_info");

  it("emits one ground_info with the cwd, charged to the session.start line", () => {
    const records = copilotCli
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const { events: cli, origin } = vscodeAgentWithOrigin(records);
    const at = cli.findIndex((e) => (e as { type: string }).type === "ground_info");
    expect(grounds(cli)).toEqual([
      { type: "ground_info", cwd: "/w", ts: Date.parse("2026-11-10T09:00:00.000Z") },
    ]);
    expect(origin[at]).toBe(0);
    // The run still opens on the first user message.
    expect(cli.find((e) => e.type === "run_start")).toMatchObject({
      prompt: expect.stringMatching(/parser test/),
    });
  });

  it("never writes the frame to a session file", () => {
    const events = parseVscodeAgentExport(copilotCli);
    expect(grounds(events)).toHaveLength(1);
    expect(grounds(events.filter(isWireEvent))).toEqual([]);
  });

  it("emits nothing for a cwd that is missing, empty or not absolute, and nothing for a VS Code export", () => {
    for (const context of [undefined, {}, { cwd: "" }, { cwd: "w/src" }, { cwd: 7 }, "/w"]) {
      expect(grounds(vscodeAgentToRunEvents([start(context), user])), JSON.stringify(context)).toEqual([]);
    }
    expect(grounds(events)).toEqual([]);
    // The positive twin: the same records with an absolute cwd carry the frame.
    expect(grounds(vscodeAgentToRunEvents([start({ cwd: "/w/src" }), user]))).toHaveLength(1);
  });

  it("names a later session.start that moved, and not one that stayed", () => {
    const later = (cwd: string) => ({ ...start({ cwd }), id: "c", timestamp: "2026-11-10T10:00:00.000Z" });
    const moved = vscodeAgentToRunEvents([start({ cwd: "/w" }), user, later("/w"), later("/v")]);
    expect(grounds(moved).map((e) => (e as { cwd?: string }).cwd)).toEqual(["/w", "/v"]);
    expect(grounds(moved)[1]).toMatchObject({ from: { cwd: "/w" } });
  });
});

// Final fix wave item 5: an imported session says which provider and model
// the content went to.
describe("the Copilot importer names its provider and model (card 605)", () => {
  const start = (data: object) => ({
    type: "session.start",
    data,
    id: "a",
    timestamp: "2026-11-10T09:00:00.000Z",
  });
  const user = (id: string) => ({
    type: "user.message",
    data: { content: "go" },
    id,
    timestamp: "2026-11-10T09:00:01.000Z",
  });
  const runStarts = (events: readonly unknown[]) =>
    events.filter((e) => (e as { type: string }).type === "run_start") as {
      provider?: string;
      model?: string;
    }[];

  it("takes the model of session.start's selectedModel, with provider copilot", () => {
    const cli = parseVscodeAgentExport(copilotCli);
    const roots = runStarts(cli).filter((e) => (e as { parentId?: string }).parentId === undefined);
    expect(roots.map((e) => [e.provider, e.model])).toEqual([["copilot", "claude-sonnet-4.5"]]);
  });

  it("names the provider without a model when selectedModel is missing or empty", () => {
    for (const data of [
      { sessionId: "s" },
      { sessionId: "s", selectedModel: "" },
      { sessionId: "s", selectedModel: 7 },
    ]) {
      const events = vscodeAgentToRunEvents([start(data), user("b")]);
      expect(
        runStarts(events).map((e) => [e.provider, e.model]),
        JSON.stringify(data),
      ).toEqual([["copilot", undefined]]);
    }
    // The VS Code agent export has no session.start; it is a Copilot session too.
    expect(runStarts(events).every((e) => e.provider === "copilot" && e.model === undefined)).toBe(true);
  });

  it("a later session.start names the model of the runs after it", () => {
    const events = vscodeAgentToRunEvents([
      start({ selectedModel: "gpt-5" }),
      user("b"),
      start({ selectedModel: "claude-sonnet-4.5" }),
      user("c"),
    ]);
    expect(runStarts(events).map((e) => e.model)).toEqual(["gpt-5", "claude-sonnet-4.5"]);
    // A run before any session.start names no model: a later start is no record of it.
    const late = vscodeAgentToRunEvents([user("b"), start({ selectedModel: "gpt-5" }), user("c")]);
    expect(runStarts(late).map((e) => e.model)).toEqual([undefined, "gpt-5"]);
  });
});

// Final fix wave item 6e: a successful Copilot CLI create made the file.
describe("a Copilot CLI create records the file as created (card 605)", () => {
  const call = (name: string, success: boolean) => [
    {
      type: "tool.execution_start",
      data: { toolCallId: "t1", toolName: name, arguments: { path: "/w/a.txt" } },
      id: "a",
    },
    { type: "tool.execution_complete", data: { toolCallId: "t1", success }, id: "b" },
  ];
  const results = (records: unknown[]) =>
    vscodeAgentToRunEvents(records).filter((e) => (e as { type: string }).type === "tool_result") as {
      fileChange?: string;
    }[];

  it("on success, and on success only, and for create only", () => {
    expect(results(call("create", true)).map((r) => r.fileChange)).toEqual(["created"]);
    expect(results(call("create", false)).map((r) => r.fileChange)).toEqual([undefined]);
    expect(results(call("edit", true)).map((r) => r.fileChange)).toEqual([undefined]);
    // The fixture's create.
    const cli = parseVscodeAgentExport(copilotCli).filter(
      (e) => (e as { type: string }).type === "tool_result",
    );
    expect(cli.filter((e) => (e as { fileChange?: string }).fileChange === "created")).toHaveLength(1);
  });
});

// Task 10 item 1: tool.execution_complete records the output in
// data.result.content, and a failure its error.
describe("a Copilot completion carries what the tool returned (card 605)", () => {
  const output = (events: readonly unknown[], callId: string) =>
    (
      events.find(
        (e) =>
          (e as { type: string; callId?: string }).type === "tool_result" &&
          (e as { callId?: string }).callId === callId,
      ) as { output?: string } | undefined
    )?.output;
  const complete = (data: object) => [
    { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "view", arguments: {} }, id: "a" },
    { type: "tool.execution_complete", data: { toolCallId: "t1", ...data }, id: "b" },
  ];

  it("takes the output from result.content in the CLI's file and in the IDE's", () => {
    const cli = parseVscodeAgentExport(copilotCli);
    expect(output(cli, "t1")).toBe("320. TEST(Parser, EmptyLine) {");
    expect(output(cli, "t5")).toBe("Created file /w/src/parser/test/EmptyLineTest.cpp");
    const ide = parseVscodeAgentExport(copilotIde);
    expect(output(ide, "c1")).toBe("1. export function load() {}");
    expect(output(ide, "c2")).toBe("No files matched.");
  });

  it("a failure adds one line code: message, of the parts that are strings", () => {
    const ide = parseVscodeAgentExport(copilotIde);
    expect(output(ide, "c4")).toBe("rejected: The user rejected this tool call.");
    // The CLI fixture's failed view names a message only.
    expect(output(parseVscodeAgentExport(copilotCli), "t8")).toBe("Path does not exist");
    const run = (data: object) => output(vscodeAgentToRunEvents(complete(data)), "t1");
    expect(run({ success: false, error: { code: "denied" } })).toBe("denied");
    expect(run({ success: false, error: { code: 7, message: "gone" } })).toBe("gone");
    expect(run({ success: false, error: { code: 7, message: null } })).toBe("");
    expect(run({ success: false, error: "denied" })).toBe("");
    expect(run({ success: false, error: { code: "x", message: "" } })).toBe("x");
    expect(run({ success: false, result: { content: "" }, error: { code: "x", message: "y" } })).toBe("x: y");
    // The line follows the content when both are there.
    expect(run({ success: false, result: { content: "half" }, error: { code: "x", message: "y" } })).toBe(
      "half\nx: y",
    );
    // A success says nothing about an error it carries.
    expect(run({ success: true, result: { content: "ok" }, error: { code: "x", message: "y" } })).toBe("ok");
  });

  it("a result without a string content stays empty", () => {
    const run = (data: object) => output(vscodeAgentToRunEvents(complete(data)), "t1");
    expect(run({ success: true })).toBe("");
    expect(run({ success: true, result: { content: 7 } })).toBe("");
    expect(run({ success: true, result: "text" })).toBe("");
    // An empty content is what the tool returned.
    expect(run({ success: true, result: { content: "" } })).toBe("");
  });

  it("counts the results whose record held neither a content nor an error, of all results", () => {
    const count = (...data: object[]) =>
      vscodeAgentWithOrigin(
        data.flatMap((d, i) => [
          { type: "tool.execution_start", data: { toolCallId: `t${i}`, toolName: "view", arguments: {} } },
          { type: "tool.execution_complete", data: { toolCallId: `t${i}`, ...d } },
        ]),
      ).toolOutputs;
    expect(count({ success: true }, { success: false }, { success: true, result: { content: 7 } })).toEqual({
      missing: 3,
      total: 3,
    });
    // An empty content and an error line are both something the record held.
    expect(
      count({ success: true, result: { content: "" } }, { success: false, error: { code: "x" } }),
    ).toEqual({ missing: 0, total: 2 });
    // A completion without a call id makes no result and is not counted.
    expect(
      vscodeAgentWithOrigin([{ type: "tool.execution_complete", data: { success: true } }]).toolOutputs,
    ).toEqual({ missing: 0, total: 0 });
  });
});

// Task 10 item 3: a record's top-level agentId names its lane. The CLI store
// writes it on a child's records (1,546 of 2,649 records); the IDE export
// writes none.
describe("a Copilot child works on its own lane (card 605)", () => {
  const records = copilotCli
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; agentId?: string; id: string });
  const { events, origin } = vscodeAgentWithOrigin(records);
  const frames = events as unknown as Record<string, unknown>[];
  const line = (id: string) => records.findIndex((r) => r.id === id);
  const PROMPT = "Read the lexer and report how it handles an empty line.";

  it("every frame of a record carries the record's lane", () => {
    let child = 0;
    frames.forEach((f, i) => {
      if (origin[i] < 0 || typeof f.agentId !== "string") return;
      const lane = records[origin[i]].agentId ?? "main";
      expect(f.agentId, `${String(f.type)} of ${records[origin[i]].id}`).toBe(lane);
      if (lane !== "main") child++;
    });
    // The spawn and the child's run, its turn, its usage, the view and its result, its text.
    expect(child).toBe(7);
  });

  it("subagent.started gives the spawn and the child's own run, named by the parent's task call", () => {
    const at = frames.filter((_, i) => origin[i] === line("e22")).map((f) => f.type);
    // The task message carries the child's readable name (task 11 item 13).
    expect(at).toEqual(["agent_spawn", "agent_message", "run_start"]);
    expect(frames.find((f) => f.type === "agent_spawn")).toEqual({
      type: "agent_spawn",
      agentId: "a-lex",
      parentId: "main",
      task: PROMPT,
      ts: Date.parse("2026-11-10T09:00:21.000Z"),
    });
    expect(frames.find((f) => f.type === "run_start" && f.agentId === "a-lex")).toMatchObject({
      runId: "vscode-a-lex",
      parentId: "main",
      prompt: PROMPT,
      provider: "copilot",
    });
  });

  it("the child's user.message is its task and gives no frame, so the chat shows one prompt", () => {
    expect(frames.filter((_, i) => origin[i] === line("e23"))).toEqual([]);
    expect(frames.filter((f) => f.type === "run_start" && f.parentId === undefined)).toHaveLength(1);
  });

  it("numbers turns per agent", () => {
    const turns = frames.filter((f) => f.type === "turn_start").map((f) => [f.agentId, f.turn]);
    expect(turns).toEqual([
      ["main", 1],
      ["a-lex", 1],
    ]);
  });

  it("subagent.completed ends the child's run, and the file ends the root run", () => {
    const ends = frames.filter((f) => f.type === "run_end");
    expect(ends.map((f) => f.runId)).toEqual(["vscode-a-lex", "vscode-import"]);
    expect(origin[frames.indexOf(ends[0])]).toBe(line("e31"));
    // A child the file never saw complete keeps its run open, as in the Claude Code importer.
    const open = vscodeAgentToRunEvents(records.filter((r) => r.type !== "subagent.completed"));
    expect(open.filter((e) => e.type === "run_end").map((e) => (e as { runId: string }).runId)).toEqual([
      "vscode-import",
    ]);
  });

  it("an agentId that is absent, empty, main or not a string is the main lane", () => {
    for (const agentId of [undefined, "", "main", 7]) {
      const out = vscodeAgentToRunEvents([
        {
          type: "user.message",
          data: { content: "go" },
          id: "a",
          ...(agentId === undefined ? {} : { agentId }),
        },
        { type: "assistant.turn_start", data: {}, id: "b", ...(agentId === undefined ? {} : { agentId }) },
      ]);
      expect(
        out.filter((e) => "agentId" in e).map((e) => (e as { agentId: string }).agentId),
        JSON.stringify(agentId),
      ).toEqual(["main", "main"]);
    }
  });

  it("a child's own task call names the child as the parent of the next child", () => {
    const out = vscodeAgentToRunEvents([
      { type: "user.message", data: { content: "go" }, id: "a" },
      {
        type: "tool.execution_start",
        data: { toolCallId: "p1", toolName: "task", arguments: { prompt: "one" } },
        id: "b",
      },
      { type: "subagent.started", data: { toolCallId: "p1" }, agentId: "c1", id: "c" },
      {
        type: "tool.execution_start",
        data: { toolCallId: "p2", toolName: "task", arguments: { description: "two" } },
        agentId: "c1",
        id: "d",
      },
      { type: "subagent.started", data: { toolCallId: "p2" }, agentId: "c2", id: "e" },
      // A spawn whose call is not in the file hangs off main, with the Claude Code importer's fallback task.
      { type: "subagent.started", data: { toolCallId: "gone" }, agentId: "c3", id: "f" },
      // A replayed start spawns nothing more.
      { type: "subagent.started", data: { toolCallId: "p1" }, agentId: "c1", id: "g" },
      // A start on the main lane names no child.
      { type: "subagent.started", data: { toolCallId: "p1" }, id: "h" },
    ]);
    const spawns = out.filter((e) => e.type === "agent_spawn") as {
      agentId: string;
      parentId: string;
      task: string;
    }[];
    expect(spawns.map((e) => [e.agentId, e.parentId, e.task])).toEqual([
      ["c1", "main", "one"],
      ["c2", "c1", "two"],
      ["c3", "main", "subtask"],
    ]);
  });

  it("the IDE export, which writes no agentId, stays on one lane", () => {
    const ide = parseVscodeAgentExport(copilotIde) as unknown as Record<string, unknown>[];
    expect(new Set(ide.filter((e) => "agentId" in e).map((e) => e.agentId))).toEqual(new Set(["main"]));
  });

  it("the lab holds the child while it works and retires it with the root run", () => {
    const upto = frames.findIndex((f) => f.type === "tool_call" && f.callId === "u1");
    const mid = events.slice(0, upto + 1).reduce(advanceScene, initialScene());
    expect(mid.subagents.map((c) => [c.id, c.focus])).toEqual([["a-lex", "disk"]]);
    expect(mid.focus).not.toBe("disk");
    const end = events.reduce(advanceScene, initialScene());
    expect([end.focus, end.subagents.length]).toEqual(["user", 0]);
  });
});

// Task 10 item 4: selectedModel is "auto" in the CLI store; the model in force
// is in session.auto_mode_resolved.chosenModel or session.model_change.newModel.
describe("a Copilot run names the model in force for it (card 605)", () => {
  let n = 0;
  const rec = (type: string, data: object = {}) => ({ type, data, id: `r${++n}` });
  const start = (selectedModel?: string) =>
    rec("session.start", selectedModel === undefined ? {} : { selectedModel });
  const resolved = (chosenModel: string) => rec("session.auto_mode_resolved", { chosenModel });
  const changed = (newModel: string) => rec("session.model_change", { newModel });
  const user = () => rec("user.message", { content: "go" });
  const turn = () => rec("assistant.turn_start", { turnId: "0" });
  const models = (records: unknown[]) =>
    vscodeAgentToRunEvents(records)
      .filter((e) => e.type === "run_start" && e.parentId === undefined)
      .map((e) => (e as { model?: string }).model);

  it("takes the chosen model of auto mode in the IDE's file", () => {
    const ide = parseVscodeAgentExport(copilotIde).filter((e) => e.type === "run_start");
    expect(ide.map((e) => [(e as { provider?: string }).provider, (e as { model?: string }).model])).toEqual([
      ["copilot", "gpt-5-mini"],
    ]);
  });

  it("auto alone names no model", () => {
    expect(models([start("auto"), user(), turn()])).toEqual([undefined]);
    expect(models([start("auto"), changed("auto"), user(), turn()])).toEqual([undefined]);
  });

  it("the latest choice at or before the run's first assistant turn wins over a later one", () => {
    expect(models([start("auto"), user(), changed("gpt-5"), resolved("claude-sonnet-4.5"), turn()])).toEqual([
      "claude-sonnet-4.5",
    ]);
    expect(models([start("auto"), user(), resolved("gpt-5"), turn(), changed("claude-sonnet-4.5")])).toEqual([
      "gpt-5",
    ]);
    // A choice made in an earlier run is still in force.
    expect(models([start("auto"), resolved("gpt-5"), user(), turn(), user(), turn()])).toEqual([
      "gpt-5",
      "gpt-5",
    ]);
    // A choice beats selectedModel.
    expect(models([start("gpt-4.1"), resolved("gpt-5"), user(), turn()])).toEqual(["gpt-5"]);
  });

  it("else the first choice after that turn within the run, and none from the next run", () => {
    expect(models([start("auto"), user(), turn(), resolved("gpt-5"), resolved("gpt-4.1")])).toEqual([
      "gpt-5",
    ]);
    expect(models([start("auto"), user(), turn(), user(), resolved("gpt-5"), turn()])).toEqual([
      undefined,
      "gpt-5",
    ]);
    // A switch back to auto before the turn ends what was in force; auto mode then resolves within the run.
    expect(
      models([start("auto"), changed("gpt-5"), changed("auto"), user(), turn(), resolved("gpt-4.1")]),
    ).toEqual(["gpt-4.1"]);
    expect(models([start("gpt-4.1"), changed("auto"), user(), turn()])).toEqual([undefined]);
  });

  it("else selectedModel when it is not auto", () => {
    expect(models([start("gpt-4.1"), user(), turn()])).toEqual(["gpt-4.1"]);
    expect(models([start("gpt-4.1"), user()])).toEqual(["gpt-4.1"]);
    // A run with no turn still takes a choice made before its end.
    expect(models([start("auto"), user(), resolved("gpt-5")])).toEqual(["gpt-5"]);
  });

  it("a child's run names the model its subagent.started gives", () => {
    const child = parseVscodeAgentExport(copilotCli).find(
      (e) => e.type === "run_start" && e.parentId !== undefined,
    );
    expect((child as { model?: string }).model).toBe("claude-haiku-4.5");
    const spawn = (model: unknown) =>
      vscodeAgentToRunEvents([
        user(),
        { type: "subagent.started", data: { toolCallId: "x", model }, agentId: "c1", id: "s" },
      ]).find((e) => e.type === "run_start" && e.parentId !== undefined) as { model?: string };
    expect(spawn("auto").model).toBeUndefined();
    expect(spawn("").model).toBeUndefined();
    expect(spawn(7).model).toBeUndefined();
  });
});

// Task 10 item 5: the CLI store writes session.usage_record per call. Its
// inputTokens counts the cache reads and writes inside it (232 of 232 records
// hold inputTokens >= cacheReadTokens + cacheWriteTokens); the wire's
// inputTokens is the uncached remainder.
describe("a Copilot usage record gives a usage frame on its lane (card 605)", () => {
  const usage = (events: readonly unknown[]) =>
    (events as Record<string, unknown>[]).filter((e) => e.type === "usage");
  const one = (u: unknown) =>
    usage(vscodeAgentToRunEvents([{ type: "session.usage_record", data: { usage: u } }]));

  it("takes the four counts out of the CLI's records, the cache taken out of the input", () => {
    expect(usage(parseVscodeAgentExport(copilotCli))).toEqual([
      {
        type: "usage",
        agentId: "main",
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 9000,
        cacheCreationTokens: 2500,
        ts: Date.parse("2026-11-10T09:00:03.500Z"),
      },
      {
        type: "usage",
        agentId: "a-lex",
        inputTokens: 400,
        outputTokens: 120,
        cacheReadTokens: 0,
        cacheCreationTokens: 3600,
        ts: Date.parse("2026-11-10T09:00:25.500Z"),
      },
    ]);
  });

  it("names a cache count only when the record does, and never goes below zero", () => {
    expect(one({ inputTokens: 70, outputTokens: 5 })).toMatchObject([{ inputTokens: 70, outputTokens: 5 }]);
    expect(Object.keys(one({ inputTokens: 70, outputTokens: 5 })[0])).not.toContain("cacheReadTokens");
    expect(one({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 8, cacheWriteTokens: 9 })).toMatchObject([
      { inputTokens: 0, cacheReadTokens: 8, cacheCreationTokens: 9 },
    ]);
    expect(one({ outputTokens: 4 })).toMatchObject([{ inputTokens: 0, outputTokens: 4 }]);
  });

  it("gives no frame for a record without token counts, and never an aiCredits", () => {
    for (const u of [
      undefined,
      {},
      { inputTokens: "12" },
      "usage",
      { inputTokens: -1, outputTokens: Number.NaN },
    ]) {
      expect(one(u), JSON.stringify(u)).toEqual([]);
    }
    expect(usage(parseVscodeAgentExport(copilotCli)).some((e) => "aiCredits" in e)).toBe(false);
  });
});

// Task 10 item 7: tool.execution_start may carry its arguments as a string.
describe("tool.execution_start arguments given as a string (card 605)", () => {
  const input = (args: unknown) =>
    (
      vscodeAgentToRunEvents([
        { type: "tool.execution_start", data: { toolCallId: "t1", toolName: "x", arguments: args } },
      ]).find((e) => e.type === "tool_call") as { input: unknown }
    ).input;

  it("parses a JSON string into the object it encodes, and keeps any other string as written", () => {
    expect(input('{"path":"/w/a.ts"}')).toEqual({ path: "/w/a.ts" });
    expect(input("not json {")).toBe("not json {");
    expect(input('"quoted"')).toBe('"quoted"');
    expect(input({ path: "/w/a.ts" })).toEqual({ path: "/w/a.ts" });
  });

  it("keeps the IDE's patch text as the input of its apply_patch call", () => {
    const call = parseVscodeAgentExport(copilotIde).find(
      (e) => e.type === "tool_call" && e.name === "apply_patch",
    ) as { input: unknown };
    expect(typeof call.input).toBe("string");
    expect((call.input as string).startsWith("*** Begin Patch")).toBe(true);
  });
});

// Task 10 item 8: errors. The wire's `abort` is a client command (ClientMessage
// in events.ts), not a recorded event, so a recorded abort reads as an error.
describe("a Copilot error, abort or warning (card 605)", () => {
  const errors = (records: unknown[]) =>
    vscodeAgentToRunEvents(records)
      .filter((e) => e.type === "error")
      .map((e) => [(e as { agentId?: string }).agentId, (e as { message: string }).message]);

  it("gives session.error and abort an error frame each, in the file's order", () => {
    const records = copilotCli
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(errors(records)).toEqual([
      ["main", "Request failed"],
      ["main", "aborted: user initiated"],
    ]);
    // session.warning gives no frame: the wire has no warning event.
    const { origin } = vscodeAgentWithOrigin(records);
    const warning = records.findIndex((r: { type: string }) => r.type === "session.warning");
    expect(warning).toBeGreaterThan(-1);
    expect([...origin]).not.toContain(warning);
  });

  it("names an abort's reason only when it is a string, and an error by its message, else its type", () => {
    expect(errors([{ type: "abort", data: {} }])).toEqual([["main", "aborted"]]);
    expect(errors([{ type: "abort", data: { reason: 7 } }])).toEqual([["main", "aborted"]]);
    expect(errors([{ type: "abort" }])).toEqual([["main", "aborted"]]);
    expect(errors([{ type: "session.error", data: { errorType: "quota" } }])).toEqual([["main", "quota"]]);
    expect(errors([{ type: "session.error", data: { errorType: "", message: "" } }])).toEqual([]);
    expect(errors([{ type: "session.error", data: { message: "boom" }, agentId: "c1" }])).toEqual([
      ["c1", "boom"],
    ]);
  });

  it("an error before the first person's turn opens no run (task 11 item 7)", () => {
    const frames = vscodeAgentToRunEvents([
      { type: "session.start", data: { selectedModel: "auto", producer: "copilot-agent" } },
      { type: "session.error", data: { message: "boom" } },
      { type: "user.message", data: { content: "go" } },
      { type: "assistant.turn_start", data: {} },
      { type: "assistant.message", data: { content: "hi" } },
    ]).map((e) => [e.type, (e as { prompt?: string }).prompt ?? (e as { message?: string }).message ?? null]);
    expect(frames.slice(0, 3)).toEqual([
      ["error", "boom"],
      ["run_start", "go"],
      ["turn_start", null],
    ]);
    // An error alone stands without a run.
    expect(
      vscodeAgentToRunEvents([{ type: "session.error", data: { message: "boom" } }]).map((e) => e.type),
    ).toEqual(["error"]);
  });
});

// Task 11 item 9 (review I1): before the first person's turn no record opens
// a run. An error or an abort stands alone; a usage record or a spawn waits
// for the run the person's message opens.
describe("records before the first person's turn (task 11 item 9)", () => {
  const START = { type: "session.start", data: { selectedModel: "auto", producer: "copilot-agent" } };
  const TURN = [
    { type: "user.message", data: { content: "go" } },
    { type: "assistant.turn_start", data: {} },
    { type: "assistant.message", data: { content: "hi" } },
  ];
  const LEAD: Record<string, object> = {
    "session.error": { type: "session.error", data: { message: "boom" } },
    abort: { type: "abort", data: { reason: "user initiated" } },
    "session.usage_record": {
      type: "session.usage_record",
      data: { usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 40 } },
    },
    "subagent.started": {
      type: "subagent.started",
      agentId: "c1",
      data: { toolCallId: "t0", agentName: "explore", model: "auto" },
    },
  };
  const turns = (records: object[]) =>
    reduceAll(initialState, vscodeAgentToRunEvents(records)).turns.map((t) => [
      t.kind,
      (t as { text?: string }).text ?? null,
    ]);

  it("the review's input: the first user turn is the person's message", () => {
    expect(turns([START, LEAD["session.error"], ...TURN])).toEqual([
      ["error", "boom"],
      ["user", "go"],
      ["assistant", "hi"],
    ]);
  });

  for (const [name, lead] of Object.entries(LEAD)) {
    it(`a ${name} first opens no run of its own`, () => {
      const events = vscodeAgentToRunEvents([START, lead, ...TURN]);
      const roots = events.filter(
        (e) => e.type === "run_start" && (e as { agentId: string }).agentId === "main",
      );
      expect(roots.map((e) => (e as { prompt: string }).prompt)).toEqual(["go"]);
      expect(turns([START, lead, ...TURN]).find((t) => t[0] === "user")).toEqual(["user", "go"]);
    });
  }

  it("a held usage counts toward the run, charged to its own record", () => {
    const records = [START, LEAD["session.usage_record"], ...TURN];
    const state = reduceAll(initialState, vscodeAgentToRunEvents(records));
    expect(state.runUsage).toEqual({ inputTokens: 60, outputTokens: 5 });
    const { events, origin } = vscodeAgentWithOrigin(records);
    expect(origin[events.findIndex((e) => e.type === "usage")]).toBe(1);
  });

  it("a held frame follows the run's start, before the run's first turn", () => {
    for (const name of ["session.usage_record", "subagent.started"]) {
      const types = vscodeAgentToRunEvents([START, LEAD[name], ...TURN]).map((e) => e.type);
      expect(types.slice(0, 5), name).toEqual(
        name === "subagent.started"
          ? ["run_start", "agent_spawn", "agent_message", "run_start", "turn_start"]
          : ["run_start", "usage", "turn_start", "text_delta", "run_end"],
      );
    }
  });

  it("a usage record with no run after it still gives its frame", () => {
    expect(vscodeAgentToRunEvents([START, LEAD["session.usage_record"]]).map((e) => e.type)).toEqual([
      "usage",
    ]);
  });
});

// Task 11 item 13 (review M7): a Copilot child gets a readable name, the way
// the Claude Code importer gives one: a task message with a label.
describe("a Copilot child's readable name (task 11 item 13)", () => {
  const records = copilotCli
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; agentId?: string; data?: Record<string, unknown> });
  const child = records.find((r) => r.type === "subagent.started")?.agentId ?? "";
  const roster = (rs: object[]) => reduceAll(initialState, vscodeAgentToRunEvents(rs)).agents;
  const named = (data: Record<string, unknown>) =>
    roster(
      records.map((r) => (r.type === "subagent.started" ? { ...r, data: { ...r.data, ...data } } : r)),
    ).find((a) => a.id === child)?.label;

  it("takes agentDisplayName, else agentName, else task", () => {
    expect(child).not.toBe("");
    expect(roster(records).find((a) => a.id === child)?.label).toBe("lexer");
    expect(named({ agentDisplayName: undefined })).toBe("explore");
    expect(named({ agentDisplayName: "", agentName: 7 })).toBe("task");
  });

  it("sends it as the task message to the child, after the spawn", () => {
    const events = vscodeAgentToRunEvents(records);
    const spawn = events.findIndex((e) => e.type === "agent_spawn");
    expect(events[spawn + 1]).toMatchObject({
      type: "agent_message",
      from: "main",
      to: child,
      role: "task",
      label: "lexer",
    });
  });
});

// Fix round 2 item 5 (Task 11 review M6): a child's completion before the first run waits for it too.
describe("a completion before the first run (fix round 2 item 5)", () => {
  it("follows its spawn and the child's run_start, and the child ends", () => {
    const records = [
      { type: "session.start", data: { selectedModel: "auto", producer: "copilot-agent" } },
      { type: "subagent.started", agentId: "c1", data: { toolCallId: "t0", agentName: "explore" } },
      { type: "subagent.completed", agentId: "c1", data: { toolCallId: "t0" } },
      { type: "user.message", data: { content: "go" } },
      { type: "assistant.turn_start", data: {} },
    ];
    const events = vscodeAgentToRunEvents(records);
    const types = events.map((e) => [e.type, (e as { runId?: string }).runId ?? null]);
    expect(types.slice(0, 5)).toEqual([
      ["run_start", "vscode-import"],
      ["agent_spawn", null],
      ["agent_message", null],
      ["run_start", "vscode-c1"],
      ["run_end", "vscode-c1"],
    ]);
    const child = reduceAll(initialState, events).agents.find((a) => a.id === "c1");
    expect(child?.state).not.toBe("working");
  });
});
