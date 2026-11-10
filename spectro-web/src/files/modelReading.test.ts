// Card 604: the model's answer and its merge into the ledger. The answer is
// untrusted text; only the asked-for JSON adds entries, only on shell calls the
// digest named, and a path the heuristic already found on the same call merges
// into that touch instead of adding a second one (C7, C14).

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { fileRows, foldFiles, type FileLedger } from "./fold";
import { mergeModel, readModelAnswer, type ModelEntry } from "./modelReading";

const T0 = 1_760_000_000_000;

function session(calls: { name: string; input: unknown; output?: string }[], workspace = "/ws"): RunEvent[] {
  const events: object[] = [{ type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace }];
  calls.forEach((c, i) => {
    events.push({ type: "tool_call", agentId: "main", callId: `c${i}`, name: c.name, input: c.input });
    events.push({
      type: "tool_result",
      agentId: "main",
      callId: `c${i}`,
      output: c.output ?? "ok",
      isError: false,
      durationMs: 5,
    });
  });
  return events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
}

/** A script run that the heuristic marks `unknown` on out/x.json, then a file tool's write. */
function ledger(workspace = "/ws"): FileLedger {
  return foldFiles(
    session(
      [
        { name: "run_command", input: { command: "python3 gen.py out/x.json" }, output: "wrote out/x.json" },
        { name: "write_file", input: { path: "b.txt", content: "b" } },
      ],
      workspace,
    ),
  );
}

const entry = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  callIndex: 1,
  path: "out/x.json",
  kind: "create",
  reason: "the output says it wrote out/x.json",
  ...over,
});

describe("reading the model's answer", () => {
  it("readsTheJsonContract", () => {
    const text = JSON.stringify({
      files: [
        { callIndex: 1, path: "out/x.json", kind: "create", reason: "the output says so" },
        { callIndex: 1, path: "gen.py", kind: "read", reason: "the script ran" },
      ],
    });
    expect(readModelAnswer(text)).toEqual([
      { callIndex: 1, path: "out/x.json", kind: "create", reason: "the output says so" },
      { callIndex: 1, path: "gen.py", kind: "read", reason: "the script ran" },
    ]);
    // A bare array is the same reading.
    expect(
      readModelAnswer(JSON.stringify([{ callIndex: 3, path: "a", kind: "delete", reason: "rm" }])),
    ).toEqual([{ callIndex: 3, path: "a", kind: "delete", reason: "rm" }]);
    // A malformed entry is dropped, its well-formed neighbour kept.
    expect(
      readModelAnswer(
        JSON.stringify({
          files: [
            { callIndex: "one", path: "a", kind: "create", reason: "" },
            { callIndex: 1, path: "", kind: "create", reason: "" },
            { callIndex: 1, path: "a", kind: "rename", reason: "" },
            { callIndex: 1, path: "a", kind: "append" },
          ],
        }),
      ),
    ).toEqual([{ callIndex: 1, path: "a", kind: "append", reason: "" }]);
    expect(readModelAnswer('{"files":[]}')).toEqual([]);
  });

  it("stripsACodeFence", () => {
    const fenced = '```json\n{"files":[{"callIndex":1,"path":"a","kind":"change","reason":"r"}]}\n```';
    expect(readModelAnswer(fenced)).toEqual([{ callIndex: 1, path: "a", kind: "change", reason: "r" }]);
    const bare = '```\n[{"callIndex":1,"path":"a","kind":"read","reason":"r"}]\n```\n';
    expect(readModelAnswer(bare)).toEqual([{ callIndex: 1, path: "a", kind: "read", reason: "r" }]);
  });

  it("proseIsNotAReading", () => {
    expect(readModelAnswer("The command probably wrote out/x.json.")).toBeNull();
    expect(readModelAnswer('Here you go: {"files":[]}')).toBeNull();
    expect(readModelAnswer('{"summary":"no files"}')).toBeNull();
    expect(readModelAnswer('{"files":"none"}')).toBeNull();
    expect(readModelAnswer("")).toBeNull();
    expect(readModelAnswer("42")).toBeNull();
  });
});

describe("merging the model's entries", () => {
  it("mergesIntoTheProbableTouch", () => {
    const before = ledger();
    const shell = before.calls[0];
    expect(shell.touches.map((t) => [t.path, t.kind, t.sources])).toContainEqual([
      "/ws/out/x.json",
      "unknown",
      ["probable"],
    ]);
    const after = mergeModel(before, [entry()]);
    const touches = after.calls[0].touches.filter((t) => t.path === "/ws/out/x.json");
    expect(touches).toHaveLength(1);
    expect(touches[0].kind).toBe("create");
    expect(touches[0].sources).toEqual(["probable", "model"]);
    expect(touches[0].reason).toContain("the output says it wrote out/x.json");
    expect(touches[0].reason).toContain(shell.touches.find((t) => t.path === "/ws/out/x.json")!.reason);
    // The input ledger is left as it was.
    expect(before.calls[0].touches.find((t) => t.path === "/ws/out/x.json")!.kind).toBe("unknown");
    // A path the heuristic did not name adds a touch of the model's own.
    const added = mergeModel(before, [entry({ path: "logs/run.txt", kind: "append", reason: "tee" })]);
    const fresh = added.calls[0].touches.find((t) => t.path === "/ws/logs/run.txt");
    expect(fresh).toMatchObject({
      kind: "append",
      sources: ["model"],
      written: "logs/run.txt",
      callIndex: shell.callIndex,
      agentId: shell.agentId,
      t: shell.t,
    });
    // The less specific kind never wins: a model read does not demote a create.
    const merged = mergeModel(after, [entry({ kind: "read", reason: "read back" })]);
    expect(merged.calls[0].touches.find((t) => t.path === "/ws/out/x.json")!.kind).toBe("create");
  });

  it("mergesAModelPathSpelledDifferently", () => {
    for (const path of ["./out/x.json", "/ws/out/x.json", "out//x.json", "src/../out/x.json"]) {
      const after = mergeModel(ledger(), [entry({ path })]);
      const named = after.calls[0].touches.filter((t) => t.path === "/ws/out/x.json");
      expect(named, path).toHaveLength(1);
      expect(named[0].sources, path).toEqual(["probable", "model"]);
    }
    // Without a workspace the heuristic keeps the path as written, and the spellings still meet.
    const bare = mergeModel(ledger(""), [entry({ path: "./out/x.json" })]);
    const shell = bare.calls[0].touches.filter((t) => t.kind === "create");
    expect(shell).toHaveLength(1);
    expect(shell[0].sources).toEqual(["probable", "model"]);
  });

  it("dropsEntriesOnFileToolCalls", () => {
    const before = ledger();
    const write = before.calls[1];
    expect(write.shell).toBe(false);
    const after = mergeModel(before, [entry({ callIndex: write.callIndex, path: "b.txt", kind: "delete" })]);
    expect(after.calls[1].touches).toEqual(write.touches);
    expect(after.calls[1].touches.every((t) => t.sources.includes("recorded"))).toBe(true);
  });

  it("dropsUnknownCallIndexes", () => {
    const before = ledger();
    const after = mergeModel(before, [
      entry({ callIndex: 99 }),
      entry({ callIndex: 2 }), // the shell call's result, not a call
      entry({ kind: "rename" as ModelEntry["kind"] }),
    ]);
    expect(after.calls.map((c) => c.touches)).toEqual(before.calls.map((c) => c.touches));
    // The positive twin: the same entry with a real index lands.
    expect(mergeModel(before, [entry()]).calls[0].touches.some((t) => t.sources.includes("model"))).toBe(
      true,
    );
  });

  it("aMergeDoesNotChangeFileCounts", () => {
    const before = ledger();
    const after = mergeModel(before, [entry(), entry({ path: "./out/x.json", kind: "change" })]);
    const paths = (l: FileLedger) => fileRows(l, null).map((r) => r.path);
    expect(paths(after)).toEqual(paths(before));
    expect(after.calls.flatMap((c) => c.touches)).toHaveLength(before.calls.flatMap((c) => c.touches).length);
    // The row the merge reached now carries the model's source.
    const row = fileRows(after, null).find((r) => r.path === "/ws/out/x.json");
    expect(row?.sources).toEqual(["probable", "model"]);
    expect(row?.letter).toBe("A");
  });

  it("dropsEntriesOnFailedCalls", () => {
    const events = session([{ name: "run_command", input: { command: "make out/x.json" }, output: "ERROR" }]);
    const failed = events.map((e) => (e.type === "tool_result" ? ({ ...e, isError: true } as RunEvent) : e));
    const before = foldFiles(failed);
    expect(before.calls[0].status).toBe("failed");
    const after = mergeModel(before, [entry()]);
    expect(after.calls[0].touches).toEqual([]);
  });
});
