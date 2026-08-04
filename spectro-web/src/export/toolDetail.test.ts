// What a saved export says about a tool call, when the transcript recorded what
// the tool RETURNED beside the flattened text (card 167).
//
// The importer reads `toolUseResult`, the reducer patches it onto the card, and
// describeTool has read it since the frame existed. What nothing did was HAND it
// over: the export built its view from four arguments and dropped the fifth, so
// a file saved out of an imported session showed the gutter, ran the two streams
// together and drew a task update with no from-state — while the PR said it did
// not. These run the whole path, events in and markup out, because that is the
// only place the disagreement was visible.
//
// The no-detail cases are here for the same reason and carry more weight: a
// record that carried nothing must render EXACTLY as it did, and that is the
// majority of every corpus.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { chatBody } from "./html";

const ts = Date.UTC(2026, 7, 4, 9, 0, 0);

/** The card markup alone. The whole document carries a stylesheet that mentions
 *  every status class by name, so an assertion that something is ABSENT has to
 *  read the body and not the file around it. */
const body = (events: readonly RunEvent[]): string => chatBody(events).body;

/** The frame the importer emits beside a tool_result. Not in the wire union by
 *  construction (wire/nonWire.ts), so a test builds it the way the importer
 *  does: as a shape the reducer's default branch reads. */
function detailFrame(callId: string, detail: unknown): RunEvent {
  return { type: "tool_result_detail", callId, detail, ts } as unknown as RunEvent;
}

/** One call and its result, with the detail frame appended when there is one. */
function session(
  name: string,
  input: unknown,
  output: string,
  detail?: unknown,
  isError = false,
): RunEvent[] {
  const events: RunEvent[] = [
    { type: "run_start", runId: "r", agentId: "main", prompt: "go", ts },
    { type: "tool_call", agentId: "main", callId: "c1", name, input, ts },
    { type: "tool_result", agentId: "main", callId: "c1", output, isError, durationMs: 12, ts },
  ];
  if (detail !== undefined) events.push(detailFrame("c1", detail));
  events.push({ type: "run_end", runId: "r", stopReason: "end_turn", ts });
  return events;
}

// The block a Read hands the model: every line welded to its own number and a
// tab. The highlighter colours that gutter as program text, and the markdown
// face renders over a heading it destroyed.
const GUTTERED = "     1\t# Heading\n     2\t\n     3\t- one item";
const UNGUTTERED = "# Heading\n\n- one item";

describe("a read whose record kept the file body", () => {
  const withDetail = body(
    session("Read", { file_path: "/tmp/notes.md" }, GUTTERED, {
      fileContent: UNGUTTERED,
      startLine: 1,
      numLines: 3,
      totalLines: 611,
    }),
  );

  it("shows the body the file has, not the one with the numbers welded on", () => {
    expect(withDetail).toContain("# Heading");
    expect(withDetail).not.toContain("1\t# Heading");
  });

  it("states the page the record returned", () => {
    expect(withDetail).toContain("lines 1–3 of 611");
  });

  it("says the read stopped at the cap, when it did", () => {
    const cut = body(session("Read", { file_path: "/a" }, "body", { fileContent: "body", truncated: true }));
    expect(cut).toContain("cut off at the token cap");
    expect(body(session("Read", { file_path: "/a" }, "body"))).not.toContain("token cap");
  });

  it("leaves a read with no detail exactly as it was: the block, gutter and all", () => {
    const plain = body(session("Read", { file_path: "/tmp/notes.md" }, GUTTERED));
    expect(plain).toContain("1\t# Heading");
    expect(plain).not.toContain("lines 1–3 of 611");
  });
});

describe("a command whose record kept the two streams apart", () => {
  const withDetail = body(
    session("Bash", { command: "du -sh app" }, " 66M\tapp\n\nShell cwd was reset\n", {
      stdout: " 66M\tapp\n",
      stderr: "Shell cwd was reset\n",
    }),
  );

  it("names the second stream as stderr rather than running it into the first", () => {
    expect(withDetail).toContain("stderr");
    expect(withDetail).toContain("Shell cwd was reset");
  });

  it("gives back the body of a command whose block was only a sentence about it", () => {
    const backgrounded = body(
      session("Bash", { command: "npm run gate" }, "Command running in background (id: 7)", {
        stdout: "vitest 2557 passed\n",
      }),
    );
    expect(backgrounded).toContain("vitest 2557 passed");
  });

  it("leaves a command with no detail exactly as it was: one stream, no label", () => {
    const plain = body(session("Bash", { command: "ls" }, "a\nb\n"));
    expect(plain).not.toContain("stderr");
    expect(plain).toContain("a\nb");
  });
});

describe("a task update whose record named the state it moved out of", () => {
  const input = { taskId: "9", status: "completed" };
  const output = "Updated task #9 (status)";

  it("draws the arrow with both ends", () => {
    const withDetail = body(
      session("TaskUpdate", input, output, { statusFrom: "in_progress", statusTo: "completed" }),
    );
    expect(withDetail).toContain("x-tv-status--from");
    expect(withDetail).toContain("in_progress");
  });

  it("leaves an update with no detail as the one state it knows", () => {
    const plain = body(session("TaskUpdate", input, output));
    expect(plain).not.toContain("x-tv-status--from");
    expect(plain).not.toContain("in_progress");
  });
});

describe("an edit whose record said where the change landed", () => {
  const input = { file_path: "/src/a.ts", old_string: "a", new_string: "b" };

  it("names the lines, in the file's new numbering", () => {
    const withDetail = body(
      session("Edit", input, "The file has been updated.", {
        patch: [{ oldStart: 51, oldLines: 4, newStart: 51, newLines: 6 }],
      }),
    );
    expect(withDetail).toContain("changed at lines 51–56");
  });

  it("leaves an edit with no detail saying nothing about where", () => {
    expect(body(session("Edit", input, "The file has been updated."))).not.toContain("changed at");
  });
});
