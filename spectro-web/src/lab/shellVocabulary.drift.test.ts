// Card 301, fix round: ONE shell vocabulary, not two.
//
// fileTree.ts opens with an argument it then breaks three lines later. Its own
// header says the disk tool-name sets are "IMPORTED from labScene rather than
// copied, so the map's disk station and this tree can never disagree about what
// a disk touch is" — and directly under it stood a second, hand-written set of
// the shell verbs, the same two names labScene spells as literals in
// advanceLoop. Two copies of a vocabulary is exactly the shape that header
// forbids, and a divergence between them is silent: the map would light the cmd
// station for a verb the footprint counted as nothing, or the reverse, and no
// test anywhere would go red.
//
// A second copy cannot be observed from outside until it drifts, which is the
// whole problem with it. So this reads the two modules off disk and asserts the
// copy is not there — the same reasoning traceSeam.drift.test.ts and
// scrubStaysDraggable.drift.test.ts give for reading source: there is no DOM in
// this suite, and the property is about the code, not about one run of it.
//
// The behaviour half is below: whatever is IN the shared set is counted by the
// footprint and lights the map's cmd station. That is the assertion that keeps
// holding when the set grows — this file's source checks only make sure it can
// still be one set when it does.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import type { RunEvent } from "../events";
import { SHELL_TOOLS, advanceScene, initialScene } from "./labScene";
import { fileFootprint } from "./fileTree";

const tree = stripComments(read("./fileTree.ts", import.meta.url));
const scene = stripComments(read("./labScene.ts", import.meta.url));

describe("the shell verbs are declared once and read twice", () => {
  it("the file footprint imports the set rather than writing its own", () => {
    expect(tree).toMatch(/import\s*{[^}]*\bSHELL_TOOLS\b[^}]*}\s*from\s*"\.\/labScene"/);
    // The shape that was there: a Set literal of its own, in the very module
    // whose header argues against exactly that.
    expect(tree).not.toMatch(/SHELL_TOOLS\s*=\s*new Set/);
  });

  it("the map reads the same set instead of spelling the verbs out", () => {
    // labScene had the two names as literals in two separate branches of
    // advanceLoop with identical bodies. The set is the declaration; a branch
    // that re-types one of its members is the second copy, one name at a time.
    expect(scene).toContain("SHELL_TOOLS.has(event.name)");
    expect(scene.match(/"run_command"/g) ?? []).toHaveLength(1);
    expect(scene.match(/"Bash"/g) ?? []).toHaveLength(1);
  });

  it("declares both vocabularies' shell verbs, so the set is not half a set", () => {
    // The premise of the two checks above: a set that lost a member would pass
    // them and take the map and the tree quietly down together.
    expect([...SHELL_TOOLS].sort()).toEqual(["Bash", "run_command"]);
  });
});

const call = (name: string): RunEvent => ({
  type: "tool_call",
  agentId: "main",
  callId: "c1",
  name,
  input: { command: "ls" },
  ts: 10,
});

describe("every verb in that one set reaches both readers", () => {
  it("is counted as a shell call by the footprint, and leaves no path on the tree", () => {
    for (const name of SHELL_TOOLS) {
      const fp = fileFootprint([call(name)]);
      expect(fp.shellCalls, `${name} must count as shell work`).toBe(1);
      expect(fp.touches, `${name} names no path`).toEqual([]);
    }
  });

  it("lights the map's cmd station and carries the command it ran", () => {
    for (const name of SHELL_TOOLS) {
      const loop = advanceScene(initialScene(), call(name));
      expect(loop.focus, `${name} must reach the cmd station`).toBe("cmd");
      expect(loop.activeCommand).toBe("ls");
      expect(loop.activeTool, "the recorded name is never rewritten").toBe(name);
    }
  });
});
