// Pins the class the trace table wears for its optional columns. The modifier
// names are the contract with panels.css: each one drops exactly one track from
// the grid that header and rows share, so the two never fall out of step.

import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../state/reducer";
import {
  CATEGORIES,
  categoryOf,
  categoryOfRow,
  inCategories,
  lensRole,
  needsCallIndex,
  ownsSearch,
  summarize,
  toolCategory,
  traceLinkState,
  traceTableClass,
} from "./TraceView";
import { toolCallsById } from "./eventDetail";

// The lens' own three roles. `wearsReasoning` is the branch this pins: since
// the reading moved onto the row that opens an imported line, a turn_start can
// hold the whole thought, and dimming it would grey out the one row the eye
// lands on. A turn that never thought still has to stay dim and silent.
describe("lensRole", () => {
  it("foregrounds a turn_start that carries the thought", () => {
    expect(lensRole("turn_start", true)).toBe("hi");
  });

  it("leaves a turn that never thought dim", () => {
    expect(lensRole("turn_start", false)).toBe("dim");
  });

  it("foregrounds a thinking row whether or not it wears the reading", () => {
    expect(lensRole("thinking_delta", false)).toBe("hi");
    expect(lensRole("thinking_delta", true)).toBe("hi");
  });

  it("anchors the rows a thought is read against", () => {
    for (const type of ["tool_call", "permission_request", "permission_decision", "error"])
      expect(lensRole(type, false)).toBe("anchor");
  });

  it("dims everything the lens has nothing to say about", () => {
    for (const type of ["usage", "tool_result", "user_message", "run_end", "text_delta"])
      expect(lensRole(type, false)).toBe("dim");
  });
});

describe("traceTableClass", () => {
  it("is the plain table while both optional columns show", () => {
    expect(traceTableClass({ host: true, model: true })).toBe("trace-table");
  });

  it("marks a hidden host column", () => {
    expect(traceTableClass({ host: false, model: true })).toBe("trace-table trace-table--no-host");
  });

  it("marks a hidden model column", () => {
    expect(traceTableClass({ host: true, model: false })).toBe("trace-table trace-table--no-model");
  });

  it("composes both modifiers when both columns are off", () => {
    expect(traceTableClass({ host: false, model: false })).toBe(
      "trace-table trace-table--no-host trace-table--no-model",
    );
  });
});

// The session to trace deep link (card 137). Three states, and one of them is
// silence: the trace toolbar is not where anyone learns what Langfuse is.
describe("traceLinkState", () => {
  it("shows nothing before the first export", () => {
    expect(traceLinkState(null, null)).toBe("none");
  });

  it("shows the failure line when nothing has landed", () => {
    expect(traceLinkState(null, "HTTP 401")).toBe("failed");
  });

  it("shows the link once an export landed", () => {
    expect(traceLinkState("http://localhost:3000/trace/abc", null)).toBe("link");
  });

  it("a later failure does not remove a working link", () => {
    expect(traceLinkState("http://localhost:3000/trace/abc", "HTTP 500")).toBe("link");
  });

  it("stays silent for an export that landed on a non-langfuse backend", () => {
    // A successful Jaeger export yields no url, and that is not a failure.
    expect(traceLinkState(null, null)).toBe("none");
  });
});

// The chip that brings in what the client recorded (card 141).
//
// The trace groups frames by category and gives each group a chip. The four
// import-only kinds are not run, turn, text, thinking, tool, permission,
// usage, image or context, and dropping them into `other` would scatter them
// among agent_spawn, compaction and error, where a reader cannot put them away
// or bring them back in one click. They get their own.
describe("the client category", () => {
  it("groups the four import-only kinds, and takes nothing that was already placed", () => {
    for (const type of ["task_reminder", "queue_operation", "queued_command", "edited_text_file"]) {
      expect(categoryOf(type), type).toBe("client");
    }
    // The neighbours it must not have swallowed: `other` is still the home of
    // everything unclassified, and every named category still answers.
    expect(categoryOf("agent_spawn")).toBe("other");
    expect(categoryOf("compaction")).toBe("other");
    expect(categoryOf("run_start")).toBe("run");
    expect(categoryOf("tool_call")).toBe("tool");
  });

  it("is one of the chips, so it can be switched off", () => {
    expect(CATEGORIES).toContain("client");
  });

  // Card 195. A pre_tool_use hook does not sit beside the gate, it REPLACES it:
  // a block short-circuits before any permission_request is emitted, so the call
  // is refused and the permission chip has nothing at all to show for it. A
  // reader who presses `permission` to see what was refused would be shown every
  // refusal except the ones nothing was even asked about.
  it("files a hook decision with the gate rather than in other", () => {
    expect(categoryOf("hook_decision")).toBe("permission");
  });

  it("drops exactly those four rows when the chip is off", () => {
    const rows = [
      "run_start",
      "turn_start",
      "task_reminder",
      "text_delta",
      "queue_operation",
      "tool_call",
      "queued_command",
      "agent_spawn",
      "edited_text_file",
      "run_end",
    ];
    // The filter reads a ROW now, not a bare wire type: a tool_call's chip
    // depends on the tool it names and a tool_result's on the call it answers,
    // and neither fact is in the type. These rows carry no payload, which is
    // the point — a type alone still lands where it always did.
    const off = new Set(CATEGORIES.filter((c) => c !== "client"));
    const row = (type: string): { type: string } => ({ type });
    expect(rows.filter((t) => inCategories(row(t), off))).toEqual([
      "run_start",
      "turn_start",
      "text_delta",
      "tool_call",
      "agent_spawn",
      "run_end",
    ]);
    // And with every chip on, nothing is dropped: the filter is the only thing
    // that decides, and an unknown type must not fall out of the trace.
    expect(rows.filter((t) => inCategories(row(t), new Set(CATEGORIES)))).toEqual(rows);
  });
});

// The two chips that ask what the tool WAS (owner: a filter on workflow, "weil
// ich die immer am spannendsten finde", and one on "die mcp computer und
// browser und javascript use").
//
// Measured over the owner's 37 recorded Claude Code transcripts, 16774 tool
// calls: 2609 carry the `mcp__` wire prefix and 172 are the Workflow tool.
// Both were indistinguishable inside `tool` until now, because the chip row
// read the wire type and the tool's name is not in the wire type.
describe("the tool chips", () => {
  it("reads the tool name, and the prefix is the rule for mcp", () => {
    expect(toolCategory("Workflow")).toBe("workflow");
    // Monitor is the other background-task launcher, and the importer has
    // always known both: `receiptTaskId` matches "launched in background" and
    // "started (task …)" alike. Measured over the owner's 39 transcripts, 196
    // launch receipts — 179 Workflow and 17 Monitor. A chip that knew only the
    // first hid those 17 and their joined outcomes from a reader who pressed
    // `workflow` precisely to find them.
    expect(toolCategory("Monitor")).toBe("workflow");
    expect(toolCategory("mcp__Claude_Browser__javascript_tool")).toBe("mcp");
    expect(toolCategory("mcp__ccd_session__mark_chapter")).toBe("mcp");
    // Everything else is still plain tool, including the names that merely
    // read like the new ones. `mcp` is the PREFIX, not a substring.
    expect(toolCategory("Bash")).toBe("tool");
    expect(toolCategory("Read")).toBe("tool");
    expect(toolCategory("WorkflowStatus")).toBe("tool");
    expect(toolCategory("MonitorPanel")).toBe("tool");
    expect(toolCategory("run_mcp__thing")).toBe("tool");
  });

  it("is on the chip row, so both can be switched off", () => {
    expect(CATEGORIES).toContain("workflow");
    expect(CATEGORIES).toContain("mcp");
  });

  it("gives a result the category of the call it answers", () => {
    const stream = [
      { type: "tool_call", callId: "c1", name: "Workflow" },
      { type: "tool_call", callId: "c2", name: "mcp__Claude_Browser__computer" },
      { type: "tool_call", callId: "c3", name: "Bash" },
      { type: "tool_result", callId: "c1", output: "launched" },
      { type: "tool_result", callId: "c2", output: "clicked" },
      { type: "tool_result", callId: "c3", output: "ok" },
    ];
    const calls = toolCallsById(stream);
    const cats = stream.map((p) => categoryOfRow({ type: p.type, payload: p }, calls));
    expect(cats).toEqual(["workflow", "mcp", "tool", "workflow", "mcp", "tool"]);
  });

  it("keeps a result whose call is not in the stream, as plain tool", () => {
    // A truncated import, or a filter that already dropped the call: the result
    // has no name of its own and nothing to inherit from. It must land back in
    // `tool` and stay readable — a row that answered nobody must never vanish.
    const orphan = { type: "tool_result", callId: "gone", output: "x" };
    const calls = toolCallsById([{ type: "tool_call", callId: "c1", name: "Workflow" }]);
    expect(categoryOfRow({ type: "tool_result", payload: orphan }, calls)).toBe("tool");
    // And with no index at all, which is what every caller that does not build
    // one passes.
    expect(categoryOfRow({ type: "tool_result", payload: orphan })).toBe("tool");
    expect(inCategories({ type: "tool_result", payload: orphan }, new Set(["tool"]))).toBe(true);
  });

  it("takes nothing from the chips that were already there", () => {
    // A permission_request is indexed by callId too, and it names a tool. It is
    // still a permission row: the gate is its own group and the tool chips must
    // not reach into it.
    const gate = { type: "permission_request", callId: "g1", name: "mcp__Claude_Browser__computer" };
    expect(categoryOfRow({ type: "permission_request", payload: gate })).toBe("permission");
    // And a tool_call with no name recorded is a tool_call.
    expect(categoryOfRow({ type: "tool_call", payload: { type: "tool_call" } })).toBe("tool");
    expect(categoryOfRow({ type: "run_start", payload: { type: "run_start" } })).toBe("run");
    expect(categoryOfRow({ type: "agent_spawn", payload: { type: "agent_spawn" } })).toBe("other");
  });

  it("drops only the workflow rows when the workflow chip is off", () => {
    const stream = [
      { type: "tool_call", callId: "c1", name: "Workflow" },
      { type: "tool_call", callId: "c2", name: "Bash" },
      { type: "tool_result", callId: "c1", output: "launched" },
      { type: "tool_result", callId: "c2", output: "ok" },
      { type: "agent_spawn", agentId: "a1" },
    ];
    const calls = toolCallsById(stream);
    const off = new Set(CATEGORIES.filter((c) => c !== "workflow"));
    const kept = stream.filter((p) => inCategories({ type: p.type, payload: p }, off, calls));
    // The call AND its result leave together. Half a workflow on the screen is
    // the defect this chip exists to remove.
    expect(kept.map((p) => p.callId ?? p.type)).toEqual(["c2", "c2", "agent_spawn"]);
  });
});

// The collapsed row for a todo list (card 141).
//
// A row whose summary is compactJson(payload) shows `{"items":[{"id":"1",...`
// and then ellipsizes, which is the json blob the card refused. The counts are
// what a reader scanning the trace can use, and they are the same three words
// the plan panel already says in both languages.
describe("the todo row's summary", () => {
  const row = (payload: unknown): TraceEntry => ({
    seq: 1,
    dir: "in",
    ts: 0,
    type: "task_reminder",
    payload,
  });
  const it3 = [
    { id: "1", subject: "a", description: "a1", status: "completed", blocks: [], blockedBy: [] },
    { id: "2", subject: "b", description: "b1", status: "in_progress", blocks: [], blockedBy: [] },
    { id: "3", subject: "c", description: "c1", status: "pending", blocks: [], blockedBy: [] },
  ];

  it("counts the list instead of printing it", () => {
    expect(summarize(row({ items: it3, itemCount: 3 }), "en")).toBe("1 open · 1 running · 1 done");
    expect(summarize(row({ items: it3, itemCount: 3 }), "de")).toBe("1 offen · 1 in Arbeit · 1 fertig");
  });

  it("shows the raw frame when the list is not one it can read", () => {
    const broken = { items: [{ id: "1", status: "pending" }] };
    expect(summarize(row(broken), "en")).toBe('{"items":[{"id":"1","status":"pending"}]}');
  });

  it("leaves the other three import-only kinds as they were", () => {
    const q: TraceEntry = {
      seq: 2,
      dir: "in",
      ts: 0,
      type: "queue_operation",
      payload: { operation: "enqueue" },
    };
    expect(summarize(q, "en")).toBe('{"operation":"enqueue"}');
  });
});

// Where the run stood, and when it moved (card 167, finding 8). The frame is
// import-only and it belongs beside the other four: the busiest transcript in
// the corpus stood in 16 different directories and carries 273 of these rows
// (measured 2026-08-04, `3e010de0…`), and a reader who
// wants the conversation must be able to put them away in one click.
describe("the ground row", () => {
  const ground = (payload: unknown): TraceEntry => ({
    seq: 1,
    dir: "in",
    ts: 0,
    type: "ground_info",
    payload,
  });

  it("sits in the client chip with the rest of what the file recorded", () => {
    expect(categoryOf("ground_info")).toBe("client");
  });

  it("reads the opening announcement as the ground itself", () => {
    expect(summarize(ground({ cwd: "/Users/x/repo", gitBranch: "main", version: "2.1.181" }), "en")).toBe(
      "cwd /Users/x/repo · gitBranch main · version 2.1.181",
    );
  });

  it("reads a move as what it left and what it landed on", () => {
    expect(summarize(ground({ cwd: "/Users/x/repo/wt", from: { cwd: "/Users/x/repo" } }), "en")).toBe(
      "cwd /Users/x/repo → /Users/x/repo/wt",
    );
  });

  it("names only the fields the frame carries", () => {
    expect(summarize(ground({ gitBranch: "feature", from: { gitBranch: "main" } }), "en")).toBe(
      "gitBranch main → feature",
    );
  });

  // The field names are the file's own words, so they are not translated: the
  // same rule recordMeta.ts labels its groups by.
  it("spells the fields the way the file spells them, in either language", () => {
    expect(summarize(ground({ cwd: "/a" }), "de")).toBe("cwd /a");
  });

  it("falls back to the raw frame when the payload says none of it", () => {
    expect(summarize(ground({ note: "x" }), "en")).toBe('{"note":"x"}');
  });
});

// What the callId index costs, and when it is worth paying.
//
// Building it is one walk of the whole stream. On a LIVE session the stream
// grows under it, so an eager index pays that walk again on every frame batch
// — for a trace nobody has filtered. The index only ever changes an answer
// while the three tool chips disagree with each other, and that is the rule
// the view gates on.
describe("what the callId index is worth", () => {
  const stream = [
    { type: "tool_call", callId: "c1", name: "Workflow" },
    { type: "tool_call", callId: "c2", name: "mcp__Claude_Browser__computer" },
    { type: "tool_call", callId: "c3", name: "Bash" },
    { type: "tool_result", callId: "c1", output: "launched" },
    { type: "tool_result", callId: "c2", output: "clicked" },
    { type: "tool_result", callId: "c3", output: "ok" },
    { type: "text_delta", text: "hi" },
  ];
  const calls = toolCallsById(stream);
  const keep = (active: Set<string>, index?: ReturnType<typeof toolCallsById>): string[] =>
    stream.filter((p) => inCategories({ type: p.type, payload: p }, active, index)).map((p) => p.type);

  it("changes no answer while the three tool chips agree", () => {
    // All three pressed — the state a trace opens in — and all three released.
    // In both, a result lands on the same side of the filter whether it
    // inherited its call's chip or fell back to plain `tool`.
    const allOn = new Set(CATEGORIES);
    expect(keep(allOn)).toEqual(keep(allOn, calls));
    const allToolChipsOff = new Set(
      CATEGORIES.filter((c) => c !== "tool" && c !== "workflow" && c !== "mcp"),
    );
    expect(keep(allToolChipsOff)).toEqual(keep(allToolChipsOff, calls));
    expect(keep(allToolChipsOff, calls)).toEqual(["text_delta"]);
  });

  it("is the only thing that tells the three apart once they disagree", () => {
    const noWorkflow = new Set(CATEGORIES.filter((c) => c !== "workflow"));
    // With the index, the Workflow call AND the result it owns both go.
    expect(keep(noWorkflow, calls)).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "text_delta",
    ]);
    // Without it, the result has nothing to inherit and stays as plain `tool`:
    // the reader loses the launch and keeps the answer, which is exactly the
    // half-row the index exists to prevent.
    expect(keep(noWorkflow)).toEqual([
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "tool_result",
      "text_delta",
    ]);
  });

  it("names the chip states that need it, and no others", () => {
    expect(needsCallIndex(new Set(CATEGORIES))).toBe(false);
    expect(needsCallIndex(new Set())).toBe(false);
    expect(needsCallIndex(new Set(["tool", "workflow", "mcp"]))).toBe(false);
    expect(needsCallIndex(new Set(CATEGORIES.filter((c) => c !== "workflow")))).toBe(true);
    expect(needsCallIndex(new Set(CATEGORIES.filter((c) => c !== "mcp")))).toBe(true);
    expect(needsCallIndex(new Set(CATEGORIES.filter((c) => c !== "tool")))).toBe(true);
    expect(needsCallIndex(new Set(["workflow"]))).toBe(true);
    // Chips outside the tool group never make the index worth building.
    expect(needsCallIndex(new Set(["text", "thinking", "permission"]))).toBe(false);
  });
});

// Card 179, adversarial pass. A picture frame carries its BYTES, and the
// collapsed row is the one place that must never print them.
describe("an imported picture in the trace", () => {
  const big = "A".repeat(60_000);
  const shot: TraceEntry = {
    seq: 5,
    dir: "in",
    ts: 0,
    type: "attachment_image",
    payload: { agentId: "main", mediaType: "image/png", note: "[image/png · 31.0 KB]", dataBase64: big },
  };

  it("says the file's own note, not 600 KB of base64", () => {
    const line = summarize(shot, "en");
    expect(line).toBe("[image/png · 31.0 KB]");
    expect(line).not.toContain(big);
  });

  it("falls back to the media type when the file gave no note", () => {
    expect(summarize({ ...shot, payload: { mediaType: "image/webp", dataBase64: big } }, "en")).toBe(
      "[image/webp]",
    );
  });

  // Measured before this was written: on a 140-picture file the summaries
  // totalled 19.87 MB and Cmd+F for "deny" matched 15 picture rows, none of
  // them because the frame said so.
  it("keeps the base64 out of the row's search text", () => {
    expect(summarize(shot, "en").length).toBeLessThan(200);
  });

  it("answers to the chip a reader presses to find pictures", () => {
    expect(categoryOf("attachment_image")).toBe("image");
  });
});

// Card 195, review finding 5. The collapsed row is the line a reader SCANS, and
// this frame had no case at all: it fell through to compactJson and read
// `{"type":"hook_decisi…` — truncated before the verdict, which is the only
// thing on the row anyone is standing there for. The reason was findable with
// Cmd+F and the open row was fine; the scannable line was a wall of braces. The
// CLI got a proper line the day the event was added (EventRenderer's ⛨ line);
// the web trace, the surface this product is named after, did not.
describe("a hook decision in the trace", () => {
  /** @param over the payload fields this case is about
   *  @return the row as the socket delivered it */
  const row = (over: Record<string, unknown>): TraceEntry => ({
    seq: 9,
    dir: "in",
    ts: 0,
    type: "hook_decision",
    payload: {
      agentId: "main",
      callId: "c1",
      toolName: "run_command",
      event: "pre_tool_use",
      matcher: "run_command",
      command: "/h/deny.sh",
      timeoutSeconds: 10,
      verdict: "blocked",
      ...over,
    },
  });

  it("leads with the verdict and the hook's own words", () => {
    expect(summarize(row({ reason: "verifier says no shell" }), "en")).toBe(
      "⛨ pre_tool_use blocked · /h/deny.sh · verifier says no shell",
    );
  });

  it("says a timeout let the call through, in both languages", () => {
    // The case that matters most and shows least: fail-open means the call ran
    // with part of the fence down, and a row reading only "timed-out" leaves the
    // reader to guess whether anything happened after it.
    const slow = row({ verdict: "timed-out", command: "/h/slow.sh", timeoutSeconds: 1, reason: undefined });
    expect(summarize(slow, "en")).toBe(
      "⛨ pre_tool_use timed-out · /h/slow.sh · killed after 1s — the call ran anyway",
    );
    expect(summarize(slow, "de")).toContain("der Aufruf lief trotzdem");
  });

  it("says the verdict even when the hook stated no reason", () => {
    expect(summarize(row({}), "en")).toBe("⛨ pre_tool_use blocked · /h/deny.sh");
  });

  it("never falls back to the raw frame for this type", () => {
    // compactJson of this payload leads with the plumbing — agentId, callId,
    // toolName — and ellipsizes long before the verdict.
    expect(summarize(row({ reason: "x" }), "en")).not.toContain("callId");
  });
});

// Card 175 left the trace MOUNTED while another tab shows, and chat, text and
// trace all report their hit count into one store (`state/search.ts`). Whoever
// reports last wins, and the trace's effect runs after the chat's — so a reader
// searching in the chat was reading, and stepping through, the hidden trace's
// hits. The view nobody is looking at does not speak for the search.
describe("ownsSearch", () => {
  it("speaks for the search while the trace is the surface on screen", () => {
    expect(ownsSearch(true, true, "deny")).toBe(true);
  });

  it("stays silent while it is mounted behind another tab", () => {
    expect(ownsSearch(false, true, "deny")).toBe(false);
  });

  it("stays silent with the box closed, or with nothing typed in it", () => {
    expect(ownsSearch(true, false, "deny")).toBe(false);
    expect(ownsSearch(true, true, "   ")).toBe(false);
  });
});
