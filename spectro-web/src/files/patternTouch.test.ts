// Card 605, task 9, fix round 1: a touch names a pattern because of where it
// came from (a glob tool, a grep's glob filter, an unquoted shell glob word),
// never because its path holds a glob character. A real folder named `[id]`
// is a folder.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { foldFiles, type FileTouch } from "./fold";

const T0 = 1_760_000_000_000;

function touchesOf(name: string, input: unknown): FileTouch[] {
  const events = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/w" },
    { type: "tool_call", agentId: "main", callId: "c1", name, input },
    { type: "tool_result", agentId: "main", callId: "c1", output: "", isError: false, durationMs: 1 },
  ].map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
  return foldFiles(events).calls.flatMap((call) => call.touches);
}

const flags = (name: string, input: unknown) =>
  touchesOf(name, input).map((t) => [t.path, t.folder, t.pattern === true]);

describe("a touch is a pattern by its source (card 605)", () => {
  it("marks a glob tool's touch as a pattern", () => {
    expect(flags("glob", { pattern: "**/*Mock*", path: "/w/src" })).toEqual([
      ["/w/src/**/*Mock*", true, true],
    ]);
    expect(flags("Glob", { pattern: "package.json" })).toEqual([["package.json", true, true]]);
  });

  it("marks a grep narrowed by a glob filter as a pattern, and a grep on a folder as a folder", () => {
    expect(flags("grep", { pattern: "TODO", path: "/w/src", glob: "*.ts" })).toEqual([
      ["/w/src/**/*.ts", true, true],
    ]);
    expect(flags("Grep", { pattern: "TODO", path: "/w/app/[id]" })).toEqual([["/w/app/[id]", true, false]]);
  });

  it("marks an unquoted shell glob word as a pattern, and a quoted bracket as a file", () => {
    expect(flags("Bash", { command: "cat src/*.ts" })).toEqual([["/w/src/*.ts", true, true]]);
    expect(flags("Bash", { command: "cat 'app/[id]/page.tsx'" })).toEqual([
      ["/w/app/[id]/page.tsx", false, false],
    ]);
  });

  it("leaves a listed folder and a read file with a bracket unmarked", () => {
    expect(flags("list_dir", { path: "/w/app/[id]" })).toEqual([["/w/app/[id]", true, false]]);
    expect(flags("view", { path: "/w/app/[id]/page.tsx" })).toEqual([["/w/app/[id]/page.tsx", false, false]]);
  });

  it("keeps the mark when a call names one pattern twice", () => {
    expect(flags("Bash", { command: "cat src/*.ts src/*.ts" })).toEqual([["/w/src/*.ts", true, true]]);
  });
});
