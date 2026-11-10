// The VS Code / GitHub Copilot agent-mode export adapter. The export is JSONL of
// dotted-type records whose payload sits under `data`; the adapter maps it onto
// spectroscope's RunEvent stream so a real recorded session replays through the
// same reducers as a spectroscope run.
//
// Two properties carry the weight here and each has its own test: every tool
// call is announced TWICE in the source (once in assistant.message.toolRequests,
// once as tool.execution_start) and must still produce exactly one card; and the
// format carries no tool output at all, which the adapter must leave empty
// rather than fill with a sentence of its own.
import { describe, expect, it } from "vitest";
// Vite-native raw import: the fixture arrives as a plain string, no fs/paths.
import vscodeAgent from "./fixtures/vscode-agent.jsonl?raw";
import copilotCli from "./fixtures/copilot-cli.jsonl?raw";
import { isWireEvent } from "../wire/nonWire";
import { parseVscodeAgentExport, vscodeAgentToRunEvents, vscodeAgentWithOrigin } from "./vscodeAgent";
import { advanceScene, initialScene } from "../lab/labScene";

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

  it("leaves tool output empty because the format carries none, and never invents a placeholder", () => {
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
    expect(runStarts(cli).map((e) => [e.provider, e.model])).toEqual([["copilot", "claude-sonnet-4.5"]]);
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
