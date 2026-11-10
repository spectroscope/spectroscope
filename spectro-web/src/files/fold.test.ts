// Card 604: the fold of the files tab. One case per rule of section 1 of the
// design (docs/superpowers/specs/2026-11-09-files-tab-design.md) and of the
// calls C11 to C18; every case pins the touches or rows the views read.

import { describe, expect, it } from "vitest";
import { TITLE_AGENT_ID, type RunEvent } from "../events";
import { fileRows, foldFiles, summarize, type FileTouch, type Source } from "./fold";
import { shellTouches, type TouchKind } from "./shell";

const W = "/ws";
const T0 = 1_760_000_000_000;

interface Res {
  fileChange?: string;
  isError?: boolean;
  output?: string;
  none?: boolean; // the call never got a result
}

/** A session written event by event, one second apart, so `t` is the index. */
class Rec {
  readonly events: RunEvent[] = [];
  private ids = 0;

  push(e: object): this {
    this.events.push({ ts: T0 + this.events.length * 1000, ...e } as unknown as RunEvent);
    return this;
  }

  start(workspace?: string, extra: object = {}): this {
    return this.push({
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "go",
      ...(workspace === undefined ? {} : { workspace }),
      ...extra,
    });
  }

  call(name: string, input: unknown, agentId = "main", callId?: string): this {
    return this.push({ type: "tool_call", agentId, callId: callId ?? `c${++this.ids}`, name, input });
  }

  result(callId: string, res: Res = {}, agentId = "main"): this {
    return this.push({
      type: "tool_result",
      agentId,
      callId,
      output: res.output ?? "ok",
      isError: res.isError ?? false,
      durationMs: 5,
      ...(res.fileChange === undefined ? {} : { fileChange: res.fileChange }),
    });
  }

  tool(name: string, input: unknown, res: Res = {}, agentId = "main"): this {
    const id = `c${++this.ids}`;
    this.call(name, input, agentId, id);
    return res.none ? this : this.result(id, res, agentId);
  }
}

const brief = (t: FileTouch) => ({ path: t.path, kind: t.kind, folder: t.folder, sources: t.sources });

describe("foldFiles", () => {
  it("everyNativeAndImportedNameFolds", () => {
    const P: Source[] = ["probable"];
    const R: Source[] = ["recorded"];
    const cases: [string, unknown, Res, TouchKind, string, boolean, Source[]][] = [
      ["read_file", { path: "a.ts" }, {}, "read", "/ws/a.ts", false, R],
      [
        "write_file",
        { path: "a.ts", content: "x" },
        { fileChange: "created" },
        "create",
        "/ws/a.ts",
        false,
        R,
      ],
      ["edit_file", { path: "a.ts", old_string: "x", new_string: "y" }, {}, "change", "/ws/a.ts", false, R],
      ["list_dir", { path: "src" }, {}, "read", "/ws/src", true, R],
      ["grep", { pattern: "TODO", path: "src" }, {}, "read", "/ws/src", false, R],
      ["glob", { pattern: "**/*.ts" }, {}, "read", "**/*.ts", true, R],
      ["view_file", { path: "a.ts" }, {}, "read", "/ws/a.ts", false, R],
      ["view_image", { path: "shot.png" }, {}, "read", "/ws/shot.png", false, R],
      ["Read", { file_path: "/ws/b.ts" }, {}, "read", "/ws/b.ts", false, R],
      ["Write", { file_path: "/ws/b.ts", content: "x" }, {}, "write", "/ws/b.ts", false, R],
      [
        "Edit",
        { file_path: "/ws/b.ts", old_string: "x", new_string: "y" },
        {},
        "change",
        "/ws/b.ts",
        false,
        R,
      ],
      [
        "MultiEdit",
        { file_path: "/ws/b.ts", edits: [{ old_string: "x", new_string: "y" }] },
        {},
        "change",
        "/ws/b.ts",
        false,
        R,
      ],
      [
        "NotebookEdit",
        { notebook_path: "/ws/n.ipynb", new_source: "x" },
        {},
        "change",
        "/ws/n.ipynb",
        false,
        R,
      ],
      ["Glob", { pattern: "*.md" }, {}, "read", "*.md", true, R],
      ["Grep", { pattern: "needle" }, {}, "read", "/ws", true, R],
      ["create_file", { filePath: "/ws/c.ts", content: "x" }, {}, "write", "/ws/c.ts", false, R],
      [
        "replace_string_in_file",
        { filePath: "/ws/c.ts", oldString: "x", newString: "y" },
        {},
        "change",
        "/ws/c.ts",
        false,
        R,
      ],
      ["run_command", { command: "rm old.txt" }, {}, "delete", "/ws/old.txt", false, P],
      ["Bash", { command: "cat notes.md" }, {}, "read", "/ws/notes.md", false, P],
      ["run_in_terminal", { command: "touch new.txt" }, {}, "create", "/ws/new.txt", false, P],
    ];
    for (const [name, input, res, kind, path, folder, sources] of cases) {
      const ledger = foldFiles(new Rec().start(W).tool(name, input, res).events);
      expect(
        ledger.calls.map((c) => [c.tool, c.status, c.shell]),
        name,
      ).toEqual([[name, "ok", sources === P]]);
      expect(ledger.calls[0].touches.map(brief), name).toEqual([{ path, kind, folder, sources }]);
    }
  });

  it("writeFileReadsFileChange", () => {
    const rec = new Rec()
      .start(W)
      .tool("write_file", { path: "a.txt", content: "A" }, { fileChange: "created" })
      .tool("write_file", { path: "b.txt", content: "B" }, { fileChange: "changed" })
      .tool("write_file", { path: "c.txt", content: "C" })
      .tool("write_file", { path: "d.txt", content: "D" }, { fileChange: "unchanged" });
    const calls = foldFiles(rec.events).calls;
    const one = (k: number) =>
      calls[k].touches.map((t) => ({ kind: t.kind, content: t.content, reason: t.reason }));
    expect(one(0)).toEqual([{ kind: "create", content: "A", reason: "recorded as created" }]);
    expect(one(1)).toEqual([{ kind: "overwrite", content: "B", reason: "recorded as changed" }]);
    expect(one(2)).toEqual([{ kind: "write", content: "C", reason: "existence not recorded" }]);
    expect(calls[3]).toMatchObject({ status: "ok", line: "d.txt", note: "no change", touches: [] });
    expect(calls.slice(0, 3).map((c) => c.note)).toEqual([null, null, null]);
  });

  it("aShellCallWithoutFilesSaysSo", () => {
    const rec = new Rec().start(W).tool("Bash", { command: "git status" }, { output: "On branch main" });
    const [call] = foldFiles(rec.events).calls;
    expect(call).toMatchObject({
      tool: "Bash",
      shell: true,
      line: "git status",
      output: "On branch main",
      note: "no file named",
      touches: [],
      script: null,
      inline: false,
      base: W,
    });
    const file = foldFiles(new Rec().start(W).tool("read_file", { path: "a" }).events).calls[0];
    expect(file).toMatchObject({ shell: false, output: null, note: null });
  });

  it("multiEditKeepsEveryPair", () => {
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
      { old_string: "e", new_string: "f" },
    ];
    const rec = new Rec().start(W).tool("MultiEdit", { file_path: "/ws/m.ts", edits });
    const [touch] = foldFiles(rec.events).calls[0].touches;
    expect(touch.kind).toBe("change");
    expect(touch.replaced).toEqual([
      { old: "a", new: "b" },
      { old: "c", new: "d" },
      { old: "e", new: "f" },
    ]);
    const single = new Rec().start(W).tool("edit_file", { path: "m.ts", old_string: "x", new_string: "y" });
    expect(foldFiles(single.events).calls[0].touches[0].replaced).toEqual([{ old: "x", new: "y" }]);
  });

  it("aFailedCallListsWithoutTouches", () => {
    const rec = new Rec()
      .start(W)
      .tool(
        "edit_file",
        { path: "a.ts", old_string: "x", new_string: "y" },
        { isError: true, output: "ERROR: not found" },
      )
      .tool("Bash", { command: "touch b.txt" }, { isError: true, output: "denied" })
      .tool("edit_file", { path: "a.ts", old_string: "x", new_string: "y" });
    const calls = foldFiles(rec.events).calls;
    expect(calls.map((c) => [c.status, c.touches.length])).toEqual([
      ["failed", 0],
      ["failed", 0],
      ["ok", 1],
    ]);
    expect(calls[0].line).toBe("a.ts");
  });

  it("aCallWithoutAResultIsPending", () => {
    const rec = new Rec().start(W).tool("write_file", { path: "a.txt", content: "x" }, { none: true });
    const [call] = foldFiles(rec.events).calls;
    expect(call.status).toBe("pending");
    expect(call.touches.map((t) => [t.kind, t.reason])).toEqual([
      ["write", "existence not recorded (no result yet)"],
    ]);
  });

  it("subagentCallsKeepTheirAgent", () => {
    const rec = new Rec()
      .start(W)
      .push({ type: "run_start", runId: "r2", agentId: "child-1", parentId: "main", prompt: "look" })
      .tool("read_file", { path: "b.ts" }, {}, "child-1")
      .tool("Bash", { command: "rm c.txt" }, {}, "child-1");
    const calls = foldFiles(rec.events).calls;
    expect(calls.map((c) => c.agentId)).toEqual(["child-1", "child-1"]);
    expect(calls.flatMap((c) => c.touches.map((t) => t.agentId))).toEqual(["child-1", "child-1"]);
    expect(calls[0].touches[0].callIndex).toBe(2);
  });

  it("mergesRelativeAndAbsoluteSpellings", () => {
    const rec = new Rec()
      .start(W)
      .tool("edit_file", { path: "src/a.ts", old_string: "x", new_string: "y" })
      .tool("read_file", { path: "/ws/src/a.ts" });
    const ledger = foldFiles(rec.events);
    expect(ledger.workspace).toBe(W);
    const rows = fileRows(ledger, null);
    expect(rows.map((r) => [r.path, r.label, r.touches.length])).toEqual([["/ws/src/a.ts", "src/a.ts", 2]]);
    expect(rows[0].touches.map((t) => t.written)).toEqual(["src/a.ts", "/ws/src/a.ts"]);
  });

  it("importCwdMovesTheShellBase", () => {
    const rec = new Rec()
      .push({ type: "ground_info", cwd: "/a" })
      .start()
      .tool("Bash", { command: "touch x" })
      .push({ type: "ground_info", gitBranch: "feature" })
      .tool("Write", { file_path: "w.txt", content: "w" })
      .push({ type: "ground_info", cwd: "/b", from: { cwd: "/a" } })
      .tool("Bash", { command: "touch y" });
    const ledger = foldFiles(rec.events);
    expect(ledger.calls.map((c) => [c.base, c.touches.map((t) => t.path)])).toEqual([
      ["/a", ["/a/x"]],
      ["/a", ["/a/w.txt"]],
      ["/b", ["/b/y"]],
    ]);
    expect(ledger.workspace).toBe("/a");
    const native = foldFiles(
      new Rec().tool("read_file", { path: "early" }).start(W).tool("read_file", { path: "late" }).events,
    );
    expect(native.calls.map((c) => [c.base, c.touches[0].path])).toEqual([
      [null, "early"],
      [W, "/ws/late"],
    ]);
  });

  it("promptsAreMarkers", () => {
    const rec = new Rec()
      .start(W, { prompt: "first" })
      .tool("read_file", { path: "a" })
      .push({ type: "user_message", text: "second" })
      .push({ type: "run_start", runId: "r2", agentId: "child-1", parentId: "main", prompt: "child task" })
      .push({ type: "run_start", runId: "r3", agentId: TITLE_AGENT_ID, prompt: "name this" })
      .start(W, { prompt: "third" });
    expect(foldFiles(rec.events).prompts).toEqual([
      { eventIndex: 0, t: 0, n: 1, text: "first" },
      { eventIndex: 3, t: 3, n: 2, text: "second" },
      { eventIndex: 6, t: 6, n: 3, text: "third" },
    ]);
  });

  it("oneRecordIsOneMark", () => {
    const at = T0 + 5000;
    const rec = new Rec()
      .start(undefined, { prompt: "first" })
      .push({ type: "user_message", text: "look at this", ts: at })
      .push({ type: "user_message", text: "and this", ts: at })
      .push({ type: "user_message", text: "[Image: shot.png]", ts: at })
      .tool("read_file", { path: "a" });
    expect(foldFiles(rec.events).prompts).toEqual([
      { eventIndex: 0, t: 0, n: 1, text: "first" },
      { eventIndex: 1, t: 5, n: 2, text: "look at this\nand this\n[Image: shot.png]" },
    ]);
  });

  it("twoRecordsAreTwoMarks", () => {
    const at = T0 + 5000;
    const rec = new Rec()
      .start(undefined, { prompt: "first" })
      .push({ type: "user_message", text: "second" })
      .push({ type: "user_message", text: "third" })
      .push({ type: "user_message", text: "fourth", ts: at })
      .push({ type: "text_delta", agentId: "main", text: "ok", ts: at })
      .push({ type: "user_message", text: "fifth", ts: at });
    expect(foldFiles(rec.events).prompts.map((p) => [p.n, p.text])).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"],
      [4, "fourth"],
      [5, "fifth"],
    ]);
  });

  it("aStamplessStreamHasNoSeconds", () => {
    const rec = new Rec().start(W).tool("read_file", { path: "a" }).tool("Bash", { command: "touch b" });
    const stamped = foldFiles(rec.events);
    expect(stamped.timed).toBe(true);
    expect(stamped.calls.map((c) => [c.t, c.touches[0].t])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    const bare = rec.events.map((e) => {
      const { ts: _ts, ...rest } = e as { ts: number };
      return rest as unknown as RunEvent;
    });
    const ledger = foldFiles(bare);
    expect(ledger.timed).toBe(false);
    expect(ledger.calls.map((c) => [c.t, ...c.touches.map((t) => t.t)])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(ledger.prompts.map((p) => p.t)).toEqual([null]);
  });

  it("aRepeatedCallIdPairsWithTheLatestOpenCall", () => {
    const rec = new Rec()
      .start(W)
      .call("write_file", { path: "a.txt", content: "a" }, "main", "c1")
      .call("write_file", { path: "o.txt", content: "o" }, "other", "c1")
      .call("write_file", { path: "b.txt", content: "b" }, "main", "c1")
      .result("c1", { fileChange: "changed" }, "other")
      .result("c1", { fileChange: "created" }, "main")
      .result("c1", {}, "main");
    // Three different answers, so pairing by call id alone (b overwrite, o
    // create) or with the earliest open call (a create, b write) reads differently.
    const got = foldFiles(rec.events).calls.map((c) => [c.line, c.touches[0].kind]);
    expect(got).toEqual([
      ["a.txt", "write"],
      ["o.txt", "overwrite"],
      ["b.txt", "create"],
    ]);
  });

  it("monitorIsNotFolded", () => {
    const rec = new Rec()
      .start(W)
      .tool("Monitor", { command: "touch m.txt" })
      .tool("Bash", { command: "touch m.txt" });
    expect(foldFiles(rec.events).calls.map((c) => c.tool)).toEqual(["Bash"]);
  });

  it("aGeneratedImageIsNotARead", () => {
    const rec = new Rec()
      .start(W)
      .tool("generate_image", { prompt: "a cat" }, { output: "saved /ws/out/cat.png" })
      .tool("view_image", { path: "out/cat.png" });
    expect(foldFiles(rec.events).calls.map((c) => c.tool)).toEqual(["view_image"]);
  });

  it("anUnchangedEditHasNoTouch", () => {
    const input = { path: "a.ts", old_string: "x", new_string: "x" };
    const rec = new Rec()
      .start(W)
      .tool("edit_file", input, { fileChange: "unchanged" })
      .tool("edit_file", input, { fileChange: "changed" })
      .tool(
        "MultiEdit",
        { file_path: "a.ts", edits: [{ old_string: "x", new_string: "x" }] },
        { fileChange: "unchanged" },
      );
    const calls = foldFiles(rec.events).calls;
    expect(calls.map((c) => [c.status, c.note, c.touches.length])).toEqual([
      ["ok", "no change", 0],
      ["ok", null, 1],
      ["ok", "no change", 0],
    ]);
  });

  it("patternsStayPatterns", () => {
    const rec = new Rec()
      .start(W)
      .tool("glob", { pattern: "*.ts", path: "src" })
      .tool("Glob", { pattern: "**/*.md", path: "/ws/docs/" })
      .tool("Glob", { pattern: "*.json", path: "" })
      .tool("grep", { pattern: "TODO", path: "src" })
      .tool("Grep", { pattern: "needle" });
    const got = foldFiles(rec.events).calls.map((c) => c.touches.map((t) => [t.written, t.path, t.folder]));
    expect(got).toEqual([
      [["src/*.ts", "src/*.ts", true]],
      [["/ws/docs/**/*.md", "/ws/docs/**/*.md", true]],
      [["*.json", "*.json", true]],
      [["src", "/ws/src", false]],
      [[".", "/ws", true]],
    ]);
  });

  it("aGrepWithoutAPathReadsItsFolder", () => {
    const touched = (rec: Rec) =>
      foldFiles(rec.events).calls.map((c) => [
        c.line,
        c.touches.map((t) => [t.written, t.path, t.folder, t.reason]),
      ]);
    const rec = new Rec()
      .start(W)
      .tool("grep", { pattern: "needle" })
      .tool("Grep", { pattern: "needle", path: "" })
      .tool("grep_search", { query: "TODO" });
    // The folder the call ran in, never the pattern; the call's line still names the pattern.
    expect(touched(rec)).toEqual([
      ["needle", [[".", "/ws", true, 'grep "needle"']]],
      ["needle", [[".", "/ws", true, 'Grep "needle"']]],
      ["TODO", [[".", "/ws", true, 'grep_search "TODO"']]],
    ]);
    // With no folder known, the folder is `.`.
    expect(touched(new Rec().start().tool("Grep", { pattern: "needle" }))).toEqual([
      ["needle", [[".", ".", true, 'Grep "needle"']]],
    ]);
    // A glob without a path is still its pattern.
    expect(touched(new Rec().start(W).tool("Glob", { pattern: "*.md" }))).toEqual([
      ["*.md", [["*.md", "*.md", true, "files matching *.md"]]],
    ]);
  });

  it("aFileSearchedByGrepIsNotAFolder", () => {
    const rec = new Rec()
      .start(W)
      .tool("grep", { pattern: "TODO", path: "NEXT-SESSION.md" })
      .tool("Grep", { pattern: "TODO", path: "/ws/NEXT-SESSION.md" })
      .tool("grep", { pattern: "TODO", path: "src/" })
      .tool("grep_search", { query: "TODO", includePattern: "src/**/*.ts" })
      .tool("list_dir", { path: "src" });
    const got = foldFiles(rec.events).calls.map((c) => c.touches.map((t) => [t.path, t.folder]));
    expect(got).toEqual([
      [["/ws/NEXT-SESSION.md", false]],
      [["/ws/NEXT-SESSION.md", false]],
      // Where the call says folder or pattern, it stays one.
      [["/ws/src", true]],
      [["/ws/src/**/*.ts", true]],
      [["/ws/src", true]],
    ]);
  });

  it("aCommandLineIsOneLine", () => {
    const command = "cat > a.md <<'EOF'\n# Title\nEOF\n";
    const rec = new Rec().start(W).tool("Bash", { command });
    const [call] = foldFiles(rec.events).calls;
    expect(call.line).not.toContain("\n");
    expect(call.line).toBe("cat > a.md <<'EOF' ⏎ # Title ⏎ EOF");
    expect(call.touches.map((t) => [t.path, t.content])).toEqual([["/ws/a.md", "# Title\n"]]);
  });
});

describe("one entry per call and file (C7)", () => {
  const touchesOf = (command: string): FileTouch[] =>
    foldFiles(new Rec().start(W).tool("Bash", { command }).events).calls[0].touches;

  it("aPathNamedTwiceByOneCommandIsOneTouch", () => {
    const touches = touchesOf("cat a.md | grep x a.md");
    expect(touches.map(brief)).toEqual([
      { path: "/ws/a.md", kind: "read", folder: false, sources: ["probable"] },
    ]);
    // Both reasons stay, joined, each once.
    const raw = shellTouches("cat a.md | grep x a.md", W).touches.map((t) => t.reason);
    expect(raw).toHaveLength(2);
    expect(touches[0].reason).toBe([...new Set(raw)].join("; "));
    // An identical reason is not repeated.
    const twice = touchesOf("cat a.md && cat a.md");
    expect(twice).toHaveLength(1);
    expect(twice[0].reason).toBe(shellTouches("cat a.md", W).touches[0].reason);
  });

  it("theMoreSpecificKindWins", () => {
    // cp writes b, cat reads it: one touch on b, kind write.
    expect(touchesOf("cp a b && cat b").map(brief)).toEqual([
      { path: "/ws/a", kind: "read", folder: false, sources: ["probable"] },
      { path: "/ws/b", kind: "write", folder: false, sources: ["probable"] },
    ]);
    // In the other order too: the read comes first, the write still wins.
    expect(touchesOf("cat b && cp a b").map(brief)).toEqual([
      { path: "/ws/b", kind: "write", folder: false, sources: ["probable"] },
      { path: "/ws/a", kind: "read", folder: false, sources: ["probable"] },
    ]);
    // The row of b holds that one touch.
    const ledger = foldFiles(new Rec().start(W).tool("Bash", { command: "cp a b && cat b" }).events);
    expect(fileRows(ledger, null).find((row) => row.path === "/ws/b")?.touches).toHaveLength(1);
  });

  it("aDeleteCountsOnlyAfterTheLastWrite", () => {
    const one = (command: string) => {
      const ledger = foldFiles(new Rec().start(W).tool("Bash", { command }).events);
      const rows = fileRows(ledger, null);
      return {
        kinds: ledger.calls[0].touches.map((t) => t.kind),
        letter: rows.find((row) => row.path === "/ws/f")?.letter,
      };
    };
    // Written again after its delete, the file exists when the call ends.
    expect(one("rm f && echo x > f")).toEqual({ kinds: ["overwrite"], letter: "M" });
    // Deleted after its last write, or after a read, it is gone.
    expect(one("echo x > f && rm f")).toEqual({ kinds: ["delete"], letter: "D" });
    expect(one("cat f && rm f")).toEqual({ kinds: ["delete"], letter: "D" });
  });

  it("doublePairsOnOnePathStayOneTouchWithBothPairs", () => {
    const sed = touchesOf("sed -i 's/a/b/' f.txt && sed -i 's/c/d/' f.txt");
    expect(sed.map(brief)).toEqual([
      { path: "/ws/f.txt", kind: "change", folder: false, sources: ["probable"] },
    ]);
    expect(sed[0].replaced).toEqual([
      { old: "a", new: "b" },
      { old: "c", new: "d" },
    ]);
    // A MultiEdit is one touch with every pair, as before.
    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ];
    const multi = foldFiles(new Rec().start(W).tool("MultiEdit", { file_path: "/ws/m.ts", edits }).events);
    expect(multi.calls[0].touches).toHaveLength(1);
    expect(multi.calls[0].touches[0].replaced).toHaveLength(2);
  });

  it("contentAndAppendedKeepTheFirstOnes", () => {
    const command = "cat > n.md <<'EOF'\nfirst\nEOF\ncat >> n.md <<'EOF'\nmore\nEOF";
    const raw = shellTouches(command, W).touches;
    expect(raw.map((t) => t.kind)).toEqual(["overwrite", "append"]);
    const touches = touchesOf(command);
    expect(touches.map(brief)).toEqual([
      { path: "/ws/n.md", kind: "overwrite", folder: false, sources: ["probable"] },
    ]);
    expect(touches[0].content).toBe(raw[0].content);
    expect(touches[0].appended).toBe(raw[1].appended);
  });

  it("aLedgerWithoutRepeatsKeepsItsTouchesAndCounts", () => {
    const commands = ["echo x > p.txt", "cp a.txt b.txt", "python3 s.py"];
    let rec = new Rec().start(W).tool("edit_file", { path: "a.ts", old_string: "x", new_string: "y" });
    for (const command of commands) rec = rec.tool("Bash", { command });
    rec = rec.tool("read_file", { path: "r.txt" });
    const ledger = foldFiles(rec.events);
    // No call names one path twice, so nothing merges: every heuristic touch is there.
    for (const call of ledger.calls) {
      expect(new Set(call.touches.map((t) => t.path)).size).toBe(call.touches.length);
    }
    expect(ledger.calls.filter((c) => c.shell).map((c) => c.touches.length)).toEqual(
      commands.map((command) => shellTouches(command, W).touches.length),
    );
    // Read only: r.txt, the copy's source a.txt and the script s.py.
    expect(summarize(ledger, fileRows(ledger, null), null)).toEqual({
      recordedChanged: 1,
      snapshotChanged: 0,
      probableChanged: 2,
      onlyRead: 3,
      shellCalls: 3,
      unknownScripts: 1,
    });
  });
});

describe("fileRows", () => {
  it("fileRowsFiltersByAgent", () => {
    const rec = new Rec()
      .start(W)
      .tool("edit_file", { path: "a.ts", old_string: "x", new_string: "y" })
      .tool("read_file", { path: "b.ts" }, {}, "child-1");
    const ledger = foldFiles(rec.events);
    const paths = (agents: ReadonlySet<string> | null) => fileRows(ledger, agents).map((r) => r.label);
    expect(paths(null)).toEqual(["a.ts", "b.ts"]);
    expect(paths(new Set(["child-1"]))).toEqual(["b.ts"]);
    expect(paths(new Set(["main"]))).toEqual(["a.ts"]);
    expect(paths(new Set())).toEqual([]);
  });

  it("lettersAndGroups", () => {
    const rec = new Rec()
      .start(W)
      .tool("write_file", { path: "a.txt", content: "a" }, { fileChange: "created" })
      .tool("edit_file", { path: "a.txt", old_string: "a", new_string: "b" })
      .tool("edit_file", { path: "b.txt", old_string: "a", new_string: "b" })
      .tool("Bash", { command: "rm b.txt" })
      .tool("Bash", { command: "python3 run.py data/in.csv" })
      .tool("read_file", { path: "r.txt" });
    const rows = fileRows(foldFiles(rec.events), null);
    expect(rows.map((r) => [r.label, r.letter, r.group, r.sources])).toEqual([
      ["a.txt", "A", "changed", ["recorded"]],
      ["b.txt", "D", "changed", ["recorded", "probable"]],
      ["run.py", "R", "read", ["probable"]],
      ["data/in.csv", "?", "changed", ["probable"]],
      ["r.txt", "R", "read", ["recorded"]],
    ]);
    expect(rows.map((r) => [r.firstCall, r.firstT])).toEqual([
      [1, 1],
      [5, 5],
      [9, 9],
      [9, 9],
      [11, 11],
    ]);
  });
});

describe("summarize", () => {
  it("summaryCounts", () => {
    const rec = new Rec()
      .start(W)
      .tool("edit_file", { path: "a.ts", old_string: "x", new_string: "y" })
      .tool("Bash", { command: "echo x > p.txt" })
      .tool("read_file", { path: "r.txt" })
      .tool("Bash", { command: "python3 s.py" });
    const ledger = foldFiles(rec.events);
    expect(summarize(ledger, fileRows(ledger, null), null)).toEqual({
      recordedChanged: 1,
      snapshotChanged: 0,
      probableChanged: 1,
      onlyRead: 2,
      shellCalls: 2,
      unknownScripts: 1,
    });
    expect(ledger.calls[3].script).toBe("/ws/s.py");
  });

  it("summaryFollowsTheAgentFilter", () => {
    const rec = new Rec()
      .start(W)
      .tool("Bash", { command: "touch m.txt" })
      .push({ type: "run_start", runId: "r2", agentId: "child-1", parentId: "main", prompt: "sub" })
      .tool("Bash", { command: "python3 job.py" }, {}, "child-1");
    const ledger = foldFiles(rec.events);
    const count = (agents: ReadonlySet<string> | null) => {
      const s = summarize(ledger, fileRows(ledger, agents), agents);
      return [s.shellCalls, s.unknownScripts];
    };
    expect(count(null)).toEqual([2, 1]);
    expect(count(new Set(["child-1"]))).toEqual([1, 1]);
    expect(count(new Set(["main"]))).toEqual([1, 0]);
  });

  it("aFailedScriptHasNoUnknownEffect", () => {
    const run = (res: Res) => {
      const ledger = foldFiles(new Rec().start(W).tool("Bash", { command: "python3 s.py" }, res).events);
      const s = summarize(ledger, fileRows(ledger, null), null);
      return [s.shellCalls, s.unknownScripts];
    };
    expect(run({ isError: true, output: "Traceback" })).toEqual([1, 0]);
    expect(run({})).toEqual([1, 1]);
  });
});

// Card 605, task 10 item 7: one apply_patch names several files, each recorded.
describe("an apply_patch call (card 605)", () => {
  const PATCH = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-x",
    "+y",
    "*** Update File: src/b.ts",
    "*** Move to: src/c.ts",
    "*** Add File: src/d.ts",
    "+d",
    "*** Delete File: src/e.ts",
    "*** End Patch",
  ].join("\n");
  const session = (result: { output: string; isError: boolean } | null): RunEvent[] => [
    { type: "run_start", runId: "r", agentId: "main", prompt: "go", workspace: "/w", ts: 1000 },
    { type: "tool_call", agentId: "main", callId: "p1", name: "apply_patch", input: PATCH, ts: 2000 },
    ...(result === null
      ? []
      : [
          { type: "tool_result" as const, agentId: "main", callId: "p1", durationMs: 0, ts: 3000, ...result },
        ]),
  ];

  it("gives one recorded touch per named file, of the kind its header says", () => {
    const [call] = foldFiles(session({ output: "Success.", isError: false })).calls;
    expect([call.tool, call.line, call.shell, call.status]).toEqual(["apply_patch", "src/a.ts", false, "ok"]);
    expect(call.touches.map((t) => [t.path, t.kind, t.sources, t.reason])).toEqual([
      ["/w/src/a.ts", "change", ["recorded"], "patched"],
      // An Update with a Move leaves no file at the old path (task 11 item 14).
      ["/w/src/b.ts", "delete", ["recorded"], "moved away by a patch"],
      ["/w/src/c.ts", "change", ["recorded"], "patched and moved here"],
      ["/w/src/d.ts", "create", ["recorded"], "added by a patch"],
      ["/w/src/e.ts", "delete", ["recorded"], "deleted by a patch"],
    ]);
    const letters = fileRows(foldFiles(session({ output: "", isError: false })), null).map((r) => r.letter);
    expect(letters).toEqual(["M", "D", "M", "A", "D"]);
  });

  it("touches nothing when the patch failed, and marks its touches pending without a result", () => {
    expect(foldFiles(session({ output: "conflict", isError: true })).calls[0].touches).toEqual([]);
    const pending = foldFiles(session(null)).calls[0].touches;
    expect(pending.every((t) => t.reason.endsWith(" (no result yet)"))).toBe(true);
    expect(pending).toHaveLength(5);
  });
});
