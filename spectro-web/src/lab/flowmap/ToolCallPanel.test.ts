// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The panel's JSX is covered by the TypeScript build; what can drift is its
// judgement — which face a panel shows (pinned through the same labFace calls
// the component makes, composed exactly as it composes them) and what the
// structured face makes of a call in flight. ToolViewBody's structured mode is
// describeTool over the panel's own props (output undefined, isError false —
// sceneToFlow clears the tool on tool_result, so the panel only ever holds a
// pending call), so describeTool with those arguments IS the render path.

import { beforeEach, describe, expect, it } from "vitest";
import { pickPanelFace } from "./ToolCallPanel";
import { describeTool } from "../../components/toolViews";
import { currentLabFace, panelFace, setLabFace } from "../../state/labFace";

// The busy run of sceneToFlow.test.ts — the same run_command payload the map
// feeds the agent card's panel.
const RUN_COMMAND_INPUT = { command: "echo one\necho two" };

describe("the structured face of a call in flight", () => {
  it("reads a run_command as a command block, not JSON", () => {
    const v = describeTool("run_command", RUN_COMMAND_INPUT, undefined, false);
    expect(v.kind).toBe("command");
    if (v.kind !== "command") throw new Error("kind");
    expect(v.command).toBe("echo one\necho two");
    // Pending, honestly: no output yet, and nothing has failed.
    expect(v.output).toBe("");
    expect(v.failed).toBe(false);
  });

  it("reads an edit as its before/after", () => {
    const input = { path: "src/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" };
    const v = describeTool("edit_file", input, undefined, false);
    expect(v.kind).toBe("edit");
    if (v.kind !== "edit") throw new Error("kind");
    expect(v.before).toBe("const x = 1;");
    expect(v.after).toBe("const x = 2;");
  });

  it("falls back to the raw pair for a shape it does not know", () => {
    // The honesty rule of toolViews: never a pretty card over an unread payload.
    expect(describeTool("mystery_tool", { a: 1 }, undefined, false).kind).toBe("generic");
  });

  // The MCP station's panel (nodes.tsx McpBody) is this same component — the
  // master's "the map's tool panels" claim covers it. sceneToFlow only hands
  // the station mcp__-prefixed names, so this IS its structured face.
  it("reads an MCP call as server · tool, not generic JSON", () => {
    const v = describeTool("mcp__notes__search", { query: "spectral" }, undefined, false);
    expect(v.kind).toBe("mcp");
    if (v.kind !== "mcp") throw new Error("kind");
    expect(v.server).toBe("notes");
    expect(v.tool).toBe("search");
    // Pending, honestly: nothing has come back yet.
    expect(v.output).toBe("");
  });
});

describe("the strip and the master on one panel", () => {
  beforeEach(() => {
    setLabFace("insight");
  });

  it("a strip pick re-faces this panel alone", () => {
    const master = currentLabFace();
    expect(panelFace(master, pickPanelFace(master, "structured"))).toBe("structured");
    // An untouched panel next to it stays on the master.
    expect(panelFace(master, null)).toBe("insight");
  });

  // The owner decision (2026-07-30): the master ALSO re-faces already-open
  // panels — a hand-made pick is an exception under ONE master, not a survivor.
  it("the master re-faces a hand-switched panel", () => {
    const pick = pickPanelFace(currentLabFace(), "structured");
    expect(panelFace(currentLabFace(), pick)).toBe("structured");
    setLabFace("structured");
    setLabFace("insight");
    expect(panelFace(currentLabFace(), pick)).toBe("insight");
  });

  it("a pick made after the master moved wins again", () => {
    const stale = pickPanelFace(currentLabFace(), "structured");
    setLabFace("structured");
    setLabFace("insight");
    const fresh = pickPanelFace(currentLabFace(), "structured");
    expect(panelFace(currentLabFace(), stale)).toBe("insight");
    expect(panelFace(currentLabFace(), fresh)).toBe("structured");
  });
});
