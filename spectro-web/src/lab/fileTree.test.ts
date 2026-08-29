// Card 301B. The file footprint is a claim about THREE things, and every test
// below bites exactly one of them:
//
//   1. the ALIASING — two tool vocabularies (native read_file/write_file/
//      list_dir, imported Read/Write/Edit/MultiEdit/Glob) and three spellings
//      of the path key (path / file_path / filePath) land on ONE entry;
//   2. the DIRECTION — a write is a write and a read is a read, per agent, so
//      two agents touching one file are both named;
//   3. the SILENCE — shell work is invisible to this fold, and the fold says
//      how much of it there was rather than letting a thin tree read as truth.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { agentDirectory } from "./agentDirectory";
import { fileFootprint, shortenPath } from "./fileTree";

const call = (agentId: string, name: string, input: unknown, ts: number): RunEvent => ({
  type: "tool_call",
  agentId,
  callId: `c-${ts}`,
  name,
  input,
  ts,
});

const delta = (agentId: string, ts: number): RunEvent => ({
  type: "text_delta",
  agentId,
  text: "…",
  ts,
});

describe("fileFootprint — the native vocabulary", () => {
  it("folds read_file / write_file / list_dir onto readers and writers", () => {
    const fp = fileFootprint([
      call("main", "read_file", { path: "a/one.ts" }, 10),
      call("main", "write_file", { path: "a/two.ts" }, 20),
      call("main", "list_dir", { path: "a" }, 30),
    ]);
    expect(fp.touches.map((t) => t.path)).toEqual(["a/one.ts", "a/two.ts", "a"]);
    expect([...fp.touches[0].readers]).toEqual(["main"]);
    expect(fp.touches[0].writers.size).toBe(0);
    expect([...fp.touches[1].writers]).toEqual(["main"]);
    expect(fp.touches[1].readers.size).toBe(0);
    // A directory listing is a READ of that path, not a write.
    expect([...fp.touches[2].readers]).toEqual(["main"]);
  });
});

describe("fileFootprint — the imported Claude Code vocabulary", () => {
  it("folds Read and Glob as reads, Write / Edit / MultiEdit as writes", () => {
    const fp = fileFootprint([
      call("main", "Read", { file_path: "r.ts" }, 10),
      call("main", "Write", { file_path: "w.ts" }, 20),
      call("main", "Edit", { file_path: "e.ts" }, 30),
      call("main", "MultiEdit", { file_path: "m.ts" }, 40),
    ]);
    expect(fp.touches.map((t) => t.path)).toEqual(["r.ts", "w.ts", "e.ts", "m.ts"]);
    expect(fp.touches[0].readers.size).toBe(1);
    expect(fp.touches[0].writers.size).toBe(0);
    for (const i of [1, 2, 3]) {
      expect(fp.touches[i].writers.size, `${fp.touches[i].path} must be a write`).toBe(1);
      expect(fp.touches[i].readers.size).toBe(0);
    }
  });

  it("records a Glob by its PATTERN and marks it as one, because it names no file", () => {
    const fp = fileFootprint([call("main", "Glob", { pattern: "src/**/*.ts" }, 10)]);
    expect(fp.touches.map((t) => t.path)).toEqual(["src/**/*.ts"]);
    expect(fp.touches[0].pattern).toBe(true);
    expect(fp.touches[0].readers.size).toBe(1);
  });

  it("marks an ordinary path as not a pattern", () => {
    const fp = fileFootprint([call("main", "Read", { file_path: "r.ts" }, 10)]);
    expect(fp.touches[0].pattern).toBe(false);
  });
});

describe("fileFootprint — the three spellings of the path key", () => {
  it("reads path, file_path and filePath onto the same entry", () => {
    const fp = fileFootprint([
      call("main", "Read", { path: "same.ts" }, 10),
      call("w1", "Read", { file_path: "same.ts" }, 20),
      call("w2", "Read", { filePath: "same.ts" }, 30),
    ]);
    expect(fp.touches).toHaveLength(1);
    expect([...fp.touches[0].readers]).toEqual(["main", "w1", "w2"]);
  });
});

describe("fileFootprint — who touched it", () => {
  it("names every agent that read and every agent that wrote one path", () => {
    const fp = fileFootprint([
      call("main", "Read", { file_path: "shared.ts" }, 10),
      call("w1", "Write", { file_path: "shared.ts" }, 20),
      call("w1", "Read", { file_path: "shared.ts" }, 30),
    ]);
    expect(fp.touches).toHaveLength(1);
    expect([...fp.touches[0].readers].sort()).toEqual(["main", "w1"]);
    expect([...fp.touches[0].writers]).toEqual(["w1"]);
  });

  it("keeps the FIRST touch as the way in, not the last", () => {
    const first = call("main", "Read", { file_path: "f.ts" }, 10);
    const later = call("w1", "Write", { file_path: "f.ts" }, 99);
    const fp = fileFootprint([delta("main", 1), first, delta("main", 50), later]);
    expect(fp.touches[0].firstEvent).toBe(first);
    // The index is into the prefix the fold was given — the scrub cursor's own
    // coordinate system, so a caller can seek to it without a second search.
    expect(fp.touches[0].firstIndex).toBe(1);
  });

  it("orders entries by first touch, not alphabetically", () => {
    const fp = fileFootprint([
      call("main", "Read", { file_path: "zebra.ts" }, 10),
      call("main", "Read", { file_path: "alpha.ts" }, 20),
    ]);
    expect(fp.touches.map((t) => t.path)).toEqual(["zebra.ts", "alpha.ts"]);
  });
});

describe("fileFootprint — shell work is invisible and says so", () => {
  it("counts run_command and Bash rather than folding what they touched", () => {
    const fp = fileFootprint([
      call("main", "run_command", { command: "rm -rf build" }, 10),
      call("main", "Bash", { command: "sed -i s/a/b/ x.ts" }, 20),
      call("main", "Read", { file_path: "seen.ts" }, 30),
    ]);
    expect(fp.shellCalls).toBe(2);
    // Neither shell call may invent a path: only the Read is on the tree.
    expect(fp.touches.map((t) => t.path)).toEqual(["seen.ts"]);
  });

  it("reports zero shell calls for a run that used none", () => {
    const fp = fileFootprint([call("main", "Read", { file_path: "a.ts" }, 10)]);
    expect(fp.shellCalls).toBe(0);
  });
});

describe("fileFootprint — what it refuses to record", () => {
  it("ignores a tool that is not a disk tool", () => {
    const fp = fileFootprint([call("main", "WebFetch", { path: "https://example.invalid" }, 10)]);
    expect(fp.touches).toEqual([]);
    expect(fp.shellCalls).toBe(0);
  });

  it("trims a path, so one file with stray whitespace is not two entries", () => {
    const fp = fileFootprint([
      call("main", "Read", { file_path: "  a.ts  " }, 10),
      call("w1", "Read", { file_path: "a.ts" }, 20),
    ]);
    expect(fp.touches).toHaveLength(1);
    expect(fp.touches[0].path).toBe("a.ts");
    expect([...fp.touches[0].readers]).toEqual(["main", "w1"]);
  });

  it("ignores a Glob whose pattern is blank or missing", () => {
    const fp = fileFootprint([call("main", "Glob", { pattern: "   " }, 10), call("main", "Glob", {}, 20)]);
    expect(fp.touches).toEqual([]);
  });

  it("ignores a disk call whose input carries no usable path", () => {
    const fp = fileFootprint([
      call("main", "Read", {}, 10),
      call("main", "Read", { file_path: 7 }, 20),
      call("main", "Read", null, 30),
      call("main", "Read", { file_path: "   " }, 40),
    ]);
    expect(fp.touches).toEqual([]);
  });
});

describe("fileFootprint — the scrub cursor", () => {
  it("reads exactly the prefix, so upto is slice(0, upto)", () => {
    const events = [
      call("main", "Read", { file_path: "a.ts" }, 10),
      call("main", "Write", { file_path: "b.ts" }, 20),
      call("main", "run_command", { command: "ls" }, 30),
    ];
    expect(fileFootprint(events, 1).touches.map((t) => t.path)).toEqual(["a.ts"]);
    expect(fileFootprint(events, 1).shellCalls).toBe(0);
    expect(fileFootprint(events, 2).touches.map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
    expect(fileFootprint(events, 3).shellCalls).toBe(1);
    // A negative cursor is an empty prefix, never a slice from the end.
    expect(fileFootprint(events, -2).touches).toEqual([]);
  });
});

describe("shortenPath — the workspace root the canon knows", () => {
  it("drops the root prefix and leaves the rest untouched", () => {
    expect(shortenPath("/w/proj/src/a.ts", "/w/proj")).toBe("src/a.ts");
  });

  it("shows the root itself by its basename", () => {
    expect(shortenPath("/w/proj", "/w/proj")).toBe("proj");
  });

  it("tolerates a trailing slash on the root", () => {
    expect(shortenPath("/w/proj/src/a.ts", "/w/proj/")).toBe("src/a.ts");
  });

  it("leaves a path outside the root alone — shortening must never mislead", () => {
    expect(shortenPath("/elsewhere/a.ts", "/w/proj")).toBe("/elsewhere/a.ts");
    // A sibling folder whose name merely STARTS with the root is not inside it.
    expect(shortenPath("/w/project2/a.ts", "/w/proj")).toBe("/w/project2/a.ts");
  });

  it("passes the path through when no root is known", () => {
    expect(shortenPath("src/a.ts", null)).toBe("src/a.ts");
    expect(shortenPath("src/a.ts", undefined)).toBe("src/a.ts");
    expect(shortenPath("src/a.ts", "")).toBe("src/a.ts");
    // A root of nothing but separators is no root either.
    expect(shortenPath("/src/a.ts", "/")).toBe("/src/a.ts");
  });
});

// The premise FileFootprint's badge list now rests on. It dropped the fallback
// that printed an unnamed id as itself — the one place in that panel that could
// have put a raw `toolu_…` on screen — on the grounds that the fallback cannot
// fire: both folds read the same prefix, and a tool_call names its agent, so
// the directory has a handle for every toucher. That is an argument about two
// modules, so it is measured rather than argued. If the directory's creation
// rule ever narrows, this goes red where the panel would have gone silent.
describe("every agent the footprint names, the directory can name too", () => {
  it("holds a handle for each toucher, over both tool vocabularies", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 },
      { type: "agent_spawn", agentId: "toolu_01opaque", parentId: "main", task: "read", ts: 2 },
      call("main", "read_file", { path: "a.ts" }, 10),
      call("main", "write_file", { path: "a.ts" }, 11),
      call("toolu_01opaque", "Read", { file_path: "b.ts" }, 12),
      call("toolu_01opaque", "Edit", { file_path: "a.ts" }, 13),
      call("never-spawned", "Glob", { pattern: "src/**" }, 14),
      call("never-spawned", "MultiEdit", { file_path: "c.ts" }, 15),
    ];
    const fp = fileFootprint(events);
    const dir = agentDirectory(events);
    let checked = 0;
    for (const touch of fp.touches) {
      for (const id of [...touch.readers, ...touch.writers]) {
        checked += 1;
        expect(dir.has(id), `the directory must hold a handle for ${id}`).toBe(true);
        expect(dir.get(id)?.tag, `${id} must have a handle to print`).toBeTruthy();
      }
    }
    // The witness: a loop over an empty list proves nothing at all. Six, not
    // eight: a.ts is one entry that main both read and wrote, so main is
    // checked on both of its sides, and two of the calls share it.
    expect(checked).toBe(6);
  });
});
