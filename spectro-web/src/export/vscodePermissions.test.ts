// The VS Code agent shape has no gate record either.
//
// Found by exporting a real 266-event session three ways and reading the bytes:
// the produced .vscode.jsonl carried none of the stream's 9 permission
// decisions, and the sheet said nothing. The Claude Code row warns about
// exactly this loss, so the two rows of one table disagreed about the same
// missing field — and the row that stayed quiet is the one whose writer never
// mentions permissions at all.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { formatLosses, streamFacts } from "./options";
import { toVscodeAgentJsonl } from "./vscodeAgent";

const ts = 1_783_500_000_000;

/** Two gate decisions around one tool call, which is all this needs. */
function gatedStream(): RunEvent[] {
  return [
    { type: "run_start", runId: "r", agentId: "main", prompt: "go", ts },
    { type: "turn_start", agentId: "main", turn: 1, ts },
    { type: "tool_call", agentId: "main", callId: "c1", name: "write_file", input: { path: "a" }, ts },
    { type: "permission_decision", callId: "c1", allowed: true, ts },
    { type: "tool_result", agentId: "main", callId: "c1", output: "ok", isError: false, durationMs: 3, ts },
    { type: "tool_call", agentId: "main", callId: "c2", name: "run_command", input: { cmd: "rm" }, ts },
    { type: "permission_decision", callId: "c2", allowed: false, ts },
    { type: "run_end", runId: "r", stopReason: "end_turn", ts },
  ];
}

describe("the VS Code export owns up to the gate record it drops", () => {
  it("really does drop the decisions", () => {
    const written = toVscodeAgentJsonl(gatedStream());
    expect(written).not.toContain("permission");
  });

  it("counts them off the stream in the sheet", () => {
    const facts = streamFacts(gatedStream());
    expect(facts.permissionDecisions).toBe(2);

    const codes = formatLosses("vscode", facts).map((loss) => loss.code);
    expect(codes).toContain("permissions");
  });

  it("says nothing about a gate when the stream never hit one", () => {
    const ungated = gatedStream().filter((e) => e.type !== "permission_decision");
    const codes = formatLosses("vscode", streamFacts(ungated)).map((loss) => loss.code);
    expect(codes).not.toContain("permissions");
  });
});
