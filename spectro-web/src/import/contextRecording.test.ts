// What an imported transcript says about the request that was sent, and what
// it says instead.
//
// The measurement this file is built on, run 2026-08-11 over the 188 session
// transcripts in ~/.claude/projects (210,211 records): ZERO messages with
// `role: "system"`. The assembled request is not in the file. What IS in the
// file is 2,553 attachment records with a body, in 176 of the 188 files,
// holding 12,087,402 characters the client put into the context — and the
// importer builds a frame for three attachment types and passes over the other
// nineteen, so all of it is thrown away today.
//
// The rule inherited from sourceNotes.ts and recordMeta.ts, and the reason both
// halves of this module are pinned on their absent case first: what the file
// does not carry produces NOTHING. An injection that carries nothing but its
// own type name is not an injection, and a format that never recorded the
// system prompt must not be handed one.

import { describe, expect, it } from "vitest";
import { contextInjections, readContextInjection, recordsSystemPrompt } from "./contextRecording";

/** A record in the shape the corpus writes: the body under `attachment`, the
 *  record it hung under in `parentUuid`. Measured: 2,398 of the corpus's 2,553
 *  injections carry a string `parentUuid`, and the 155 that do not are all
 *  `hook_success`. */
const attachment = (body: unknown, parentUuid = "p-1"): string =>
  JSON.stringify({ parentUuid, isSidechain: false, type: "attachment", attachment: body, uuid: "u-1" });

describe("whether the format recorded the request at all", () => {
  // The measurement above, and the reason the panel may not stay silent: an
  // import that shows no system prompt is showing the truth about the FILE,
  // and a reader with nothing on screen concludes it about the SESSION.
  it("says a Claude Code transcript did not record one", () => {
    expect(recordsSystemPrompt("claude-code")).toBe(false);
  });

  // The VS Code agent-mode export has a closed six-type vocabulary
  // (detect.ts, VSCODE_AGENT_TYPES): user.message, assistant.turn_start,
  // assistant.turn_end, assistant.message, tool.execution_start,
  // tool.execution_complete. None of them is a place a system prompt could
  // sit. This is read off the vocabulary, not off a corpus — there is no real
  // VS Code export on this machine to count, and saying so is the point.
  it("says a VS Code agent export did not record one either", () => {
    expect(recordsSystemPrompt("vscode-agent")).toBe(false);
  });

  // Ours does: a spectroscope session emits context_info with a `parts` entry
  // labelled "system prompt" (events.ts). The panel is full for our runs, and
  // that difference is the whole subject of the card.
  it("says a spectroscope session did record one", () => {
    expect(recordsSystemPrompt("spectroscope")).toBe(true);
  });
});

describe("an injection the importer builds no frame for", () => {
  it("reads a hook's injected context, with what hung it and how much of it there was", () => {
    const line = attachment({
      type: "hook_additional_context",
      content: ["remember the house rules"],
      hookName: "superpowers",
      hookEvent: "SessionStart",
      toolUseID: "t-9",
    });
    const injection = readContextInjection(line);
    expect(injection).not.toBeNull();
    expect(injection!.kind).toBe("hook_additional_context");
    expect(injection!.parentUuid).toBe("p-1");
    // How much text the body carries, its own type name aside — the number the
    // reader came for: 862 of these records in the corpus, one of them 562,975
    // characters long. Identifiers are counted too, because telling a hook's
    // name from a hook's output takes a vocabulary of attachment types, and
    // this module deliberately has none. The corpus total is counted the same
    // way, so the two numbers mean the same thing.
    expect(injection!.chars).toBe(24 + 11 + 12 + 3);
    expect(injection!.fields).toEqual([
      { key: "content", value: '["remember the house rules"]' },
      { key: "hookName", value: "superpowers" },
      { key: "hookEvent", value: "SessionStart" },
      { key: "toolUseID", value: "t-9" },
    ]);
  });

  it("carries what a delta added and what it withdrew, both", () => {
    // A delta with only its additions read would say a server arrived and never
    // that it left. Both lists travel, under the file's own key names.
    const line = attachment({
      type: "mcp_instructions_delta",
      addedNames: ["chrome"],
      addedBlocks: ["## chrome\nuse the batch call"],
      removedNames: ["blender"],
    });
    const injection = readContextInjection(line)!;
    expect(injection.fields).toEqual([
      { key: "addedNames", value: '["chrome"]' },
      { key: "addedBlocks", value: '["## chrome\\nuse the batch call"]' },
      { key: "removedNames", value: '["blender"]' },
    ]);
  });

  // No vocabulary anywhere in this module. Claude Code extends the attachment
  // list without asking us — nineteen kinds are in this corpus and the twentieth
  // is not ours to predict — so an unknown body is read exactly like a known
  // one rather than dropped by a lookup that never heard of it.
  // 155 of the corpus's 2,553 injections have no parent — every one of them a
  // `hook_success`. The field is then absent rather than empty or guessed at
  // from the neighbouring line: the same rule sourceNotes.ts draws, one level
  // down. An injection nailed to the wrong turn reads worse than one that says
  // only where it sat in the file.
  it("leaves the attribution off a record that carries none", () => {
    // The record's OWN uuid is there, as it is on every record in the corpus,
    // and it is not a stand-in: it names this attachment, not the turn the
    // attachment landed on.
    const line = JSON.stringify({
      type: "attachment",
      parentUuid: null,
      uuid: "u-itself",
      attachment: { type: "hook_success", hookName: "format" },
    });
    const injection = readContextInjection(line)!;
    expect(injection.kind).toBe("hook_success");
    expect("parentUuid" in injection).toBe(false);
  });

  it("reads a kind nobody here has ever seen", () => {
    const injection = readContextInjection(attachment({ type: "weather_delta", forecast: "rain" }))!;
    expect(injection.kind).toBe("weather_delta");
    expect(injection.fields).toEqual([{ key: "forecast", value: "rain" }]);
  });
});

describe("what produces nothing", () => {
  // 319 of the corpus's 2,872 unframed attachment records carry nothing but
  // their own type name: 279 command_permissions with an empty allowedTools,
  // 21 workflow_keyword_request and 19 ultra_effort_exit with no body at all.
  // A row saying "command_permissions" and nothing else is a line of interface
  // that reports the client's bookkeeping as an event in the session.
  it("drops an injection whose body says nothing", () => {
    expect(readContextInjection(attachment({ type: "command_permissions", allowedTools: [] }))).toBeNull();
    expect(readContextInjection(attachment({ type: "ultra_effort_exit" }))).toBeNull();
  });

  // The importer already builds a frame for these three (claudeCode.ts,
  // emitNoConversation). A reading here as well would put the same todo list on
  // screen twice and let the two copies disagree.
  it("says nothing about the three kinds that already become frames", () => {
    for (const type of ["task_reminder", "queued_command", "edited_text_file"]) {
      expect(
        readContextInjection(attachment({ type, content: [{ id: "1" }], prompt: "hi", filename: "a.ts" })),
        type,
      ).toBeNull();
    }
  });

  it("says nothing about a line that is not an attachment record", () => {
    expect(readContextInjection('{"type":"user","message":{"role":"user","content":"hi"}}')).toBeNull();
    expect(readContextInjection('{"type":"attachment"}')).toBeNull();
    expect(readContextInjection('{"type":"attachment","attachment":"hook_additional_context"}')).toBeNull();
  });

  // The record's OWN type decides, not the presence of the field. Measured: all
  // 11,650 records in the corpus that carry a top-level `attachment` field are
  // of type "attachment", so this shape does not occur today — which is exactly
  // why the gate is pinned rather than assumed. claudeCode.ts reads the field
  // behind the same gate (emitNoConversation), and a conversation record that
  // grew one would otherwise have the client's bookkeeping read off a turn.
  it("goes by the record's type, not by the field being there", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hi" },
      attachment: { type: "hook_additional_context", content: ["injected"] },
    });
    expect(readContextInjection(line)).toBeNull();
  });

  // A line we cannot read is a line we know nothing about. The source pane
  // still shows it verbatim; an injection would be a claim.
  it("says nothing about a line that is not JSON", () => {
    expect(readContextInjection("{not json")).toBeNull();
    expect(readContextInjection("")).toBeNull();
  });
});

describe("a body too big to print", () => {
  // The median injection in the corpus carries 2,364 characters and the largest
  // 562,975, so past the inline ceiling is the common case here, not the edge.
  // A long run of language stays WHOLE and is marked `text`, the same marking
  // recordMeta.ts puts on an unnamed long string: the ceiling belongs to the
  // pane that paints, never to the reading.
  it("hands a long run of language over whole, marked for the pane to cap", () => {
    const body = { type: "skill_listing", content: "x".repeat(500), skillCount: 3, names: ["a", "b"] };
    const injection = readContextInjection(attachment(body))!;
    expect(injection.chars).toBe(502); // the listing, plus the two names
    expect(injection.fields).toEqual([
      { key: "content", value: "x".repeat(500), block: "text" },
      { key: "skillCount", value: "3" },
      { key: "names", value: '["a","b"]' },
    ]);
  });

  // A list too long to print compactly is OPENED, not named by its shape. A
  // deferred_tools_delta carrying sixty tool names would come back as
  // "[60 items]" from a shape reading, and which tools were loaded is the whole
  // reason a reader opened the record. 303 of these in the corpus.
  it("opens a list too long to print, on the file's own paths", () => {
    const names = Array.from({ length: 12 }, (_, i) => `mcp__server__tool_number_${i}`);
    const injection = readContextInjection(attachment({ type: "deferred_tools_delta", addedNames: names }))!;
    expect(injection.fields).toHaveLength(12);
    expect(injection.fields[0]).toEqual({ key: "addedNames[0]", value: "mcp__server__tool_number_0" });
    expect(injection.fields[11]).toEqual({ key: "addedNames[11]", value: "mcp__server__tool_number_11" });
  });

  // The nested CLAUDE.md files a session read in are recorded WITH their text —
  // 64 records in 28 files. This is the card's on-disk source, except that it
  // does not need the disk: the file says what was injected at the time, which
  // is a stronger statement than what the path holds today.
  it("reaches the text inside a nested body, down the file's own path", () => {
    const injection = readContextInjection(
      attachment({
        type: "nested_memory",
        path: "/repo/sub/CLAUDE.md",
        displayPath: "sub",
        content: { path: "/repo/sub/CLAUDE.md", type: "Project", content: "y".repeat(300) },
      }),
    )!;
    expect(injection.fields.map((f) => f.key)).toEqual([
      "path",
      "displayPath",
      "content.path",
      "content.type",
      "content.content",
    ]);
    expect(injection.fields[4]).toEqual({ key: "content.content", value: "y".repeat(300), block: "text" });
  });
});

describe("the injections of a whole file", () => {
  const lines = [
    '{"type":"user","message":{"role":"user","content":"go"},"uuid":"u-a"}',
    attachment({ type: "skill_listing", content: "one skill", names: ["humanizer"] }, "u-a"),
    "",
    attachment({ type: "command_permissions", allowedTools: [] }, "u-a"),
    '{"type":"assistant","message":{"role":"assistant","content":[]},"uuid":"u-b"}',
    attachment({ type: "hook_additional_context", content: ["after"], hookName: "gate" }, "u-b"),
  ];

  // "In the order they arrived" is the file's own order, and the line number is
  // what lets a reader open the record the claim came from. ImportSource counts
  // lines from zero with the blanks left in place (detect.ts), so this counts
  // the same way or the two numbers name different lines.
  it("comes back in the file's order, each one on its own line", () => {
    expect(contextInjections(lines).map((i) => [i.line, i.injection.kind])).toEqual([
      [1, "skill_listing"],
      [5, "hook_additional_context"],
    ]);
  });

  // Attribution is the file's word, not ours: parentUuid is on all 2,401
  // injection records measured, and it names the record this injection hung
  // under. Nothing here infers a turn from position.
  it("attributes each one to the record the file hung it under", () => {
    expect(contextInjections(lines).map((i) => i.injection.parentUuid)).toEqual(["u-a", "u-b"]);
  });

  it("is empty for a session that was produced here and has no file", () => {
    expect(contextInjections(null)).toEqual([]);
    expect(contextInjections(undefined)).toEqual([]);
  });
});
