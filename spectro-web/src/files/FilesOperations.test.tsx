// Card 604: the operations of the files tab. The operations view is a table of
// every call with its time, prompt, agent, operation, call line, files and
// tool; the detail sits below it. In the view `all`, a compact list of the same
// rows stands beside the detail and narrows to the selected file. The suite has
// no DOM: the tab renders on the server renderer and the drive kit presses its
// controls (testkit/driveComponent.tsx), so nothing a case needs may wait for
// an effect.

import { isValidElement, type ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { blockOf, read, rules } from "../testkit/source";
import { FilesCreated } from "./FilesCreated";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { FilesOperations, FilesOpList } from "./FilesOperations";
import { FilesTimeline } from "./FilesTimeline";
import { FilesView, type FilesViewProps } from "./FilesView";
import { foldFiles } from "./fold";
import { mergeModel } from "./modelReading";

const T0 = 1_760_000_000_000;

/** One event per second from T0, so a call's `t` is its index. */
function stamp(events: object[]): RunEvent[] {
  return events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
}

const call = (callId: string, name: string, input: unknown, agentId = "main") => ({
  type: "tool_call",
  agentId,
  callId,
  name,
  input,
});
const result = (callId: string, extra: object = {}, agentId = "main") => ({
  type: "tool_result",
  agentId,
  callId,
  output: "ok",
  isError: false,
  durationMs: 5,
  ...extra,
});

/** Two prompts: a read and an edit under the first, two shell commands under the second. */
const TWO_PROMPTS = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "first", workspace: "/ws" },
  call("c1", "read_file", { path: "README.md" }),
  result("c1"),
  call("c2", "edit_file", { path: "src/a.ts", old_string: "1", new_string: "2" }),
  result("c2", { fileChange: "changed" }),
  { type: "run_start", runId: "r2", agentId: "main", prompt: "second", workspace: "/ws" },
  call("c3", "run_command", { command: "git status --short" }),
  result("c3"),
  call("c4", "run_command", { command: "echo hi > out.txt" }),
  result("c4"),
]);

const EXPAND = [
  FilesView,
  FilesExplorer,
  FilesDetail,
  FilesTimeline,
  FilesCreated,
  FilesOperations,
  FilesOpList,
];

function props(over: Partial<FilesViewProps> = {}): FilesViewProps {
  return {
    viewKey: "s-1",
    events: TWO_PROMPTS,
    startAt: null,
    onStartHandled: () => {},
    onFocusEvent: () => {},
    onOpenPath: () => {},
    title: null,
    ...over,
  };
}

const run = (p: FilesViewProps, steps: Step[] = []): El[] => drive(<FilesView {...p} />, EXPAND, steps);

/** The host elements below `el`, outermost first. */
function inside(el: El): El[] {
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c as ReactNode);
      return;
    }
    if (!isValidElement(n)) return;
    const child = n as El;
    out.push(child);
    walk(child.props.children);
  };
  walk(el.props.children);
  return out;
}

function textOf(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map((c) => textOf(c as ReactNode)).join("");
  if (isValidElement(n)) return textOf((n as El).props.children);
  return "";
}

const classOf = (el: El): string => (typeof el.props.className === "string" ? el.props.className : "");
const hasClass = (el: El, name: string): boolean => classOf(el).split(/\s+/).includes(name);

function only<T>(list: T[], what: string): T {
  if (list.length !== 1) throw new Error(`expected one ${what}, found ${list.length}`);
  return list[0];
}

const press =
  (name: string): Step =>
  (tree) =>
    only(
      tree.filter((el) => el.type === "button" && el.props["data-action"] === name),
      `button ${name}`,
    ).props.onClick?.();

const pressRow =
  (path: string): Step =>
  (tree) =>
    only(
      tree.filter(
        (el) => el.type === "button" && hasClass(el, "files-row") && el.props["data-path"] === path,
      ),
      `explorer row ${path}`,
    ).props.onClick?.();

const pressChip =
  (agent: string): Step =>
  (tree) =>
    only(
      tree.filter((el) => el.type === "button" && el.props["data-agent"] === agent),
      `chip ${agent}`,
    ).props.onClick?.();

const byClassName = (tree: El[], name: string): El[] => tree.filter((el) => hasClass(el, name));

/** The rows of the operations table. */
const tableRows = (tree: El[]): El[] =>
  tree.filter((el) => el.type === "tr" && hasClass(el, "files-ops__row"));

/** The text of each row's cell with the given class. */
const column = (rows: El[], cls: string): string[] =>
  rows.map((row) =>
    textOf(
      only(
        inside(row).filter((el) => el.type === "td" && hasClass(el, cls)),
        `${cls} cell`,
      ).props.children,
    ),
  );

const pressOp =
  (callIndex: number): Step =>
  (tree) =>
    only(
      tree.filter((el) => el.props["data-op"] === callIndex),
      `operation ${callIndex}`,
    ).props.onClick?.();

/** The rows of the compact list in the view `all`. */
const listRows = (tree: El[]): El[] => tree.filter((el) => el.type === "button" && hasClass(el, "files-op"));

/** Three calls on src/a.ts (a read and two edits) around one created b.ts. */
const A_THREE_TIMES = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "read_file", { path: "src/a.ts" }),
  result("c1"),
  call("c2", "edit_file", { path: "src/a.ts", old_string: "1", new_string: "2" }),
  result("c2", { fileChange: "changed" }),
  call("c3", "write_file", { path: "b.ts", content: "b\n" }),
  result("c3", { fileChange: "created" }),
  call("c4", "edit_file", { path: "src/a.ts", old_string: "2", new_string: "3" }),
  result("c4", { fileChange: "changed" }),
]);

/** The list's ids, the "all calls" buttons, the explorer row of src/a.ts and the selected list row. */
function listState(tree: El[]): {
  ops: unknown[];
  allCalls: number;
  rowPressed: unknown;
  selected: unknown[];
} {
  return {
    ops: listRows(tree).map((el) => el.props["data-op"]),
    allCalls: tree.filter((el) => el.type === "button" && el.props["data-action"] === "all-calls").length,
    rowPressed: tree.find(
      (el) => el.type === "button" && hasClass(el, "files-row") && el.props["data-path"] === "/ws/src/a.ts",
    )?.props["aria-pressed"],
    selected: listRows(tree)
      .filter((el) => hasClass(el, "files-op--sel"))
      .map((el) => el.props["data-op"]),
  };
}

beforeAll(() => setLang("en"));

describe("the operations view", () => {
  it("operationsListsEveryCallWithItsPrompt", () => {
    const tree = run(props(), [press("view-operations")]);
    const rows = tableRows(tree);
    // Every call, in event order.
    expect(rows.map((row) => row.props["data-op"])).toEqual([1, 3, 6, 8]);
    expect(column(rows, "files-ops__p")).toEqual(["1", "1", "2", "2"]);
    expect(column(rows, "files-ops__t")).toEqual(["+1.0 s", "+3.0 s", "+6.0 s", "+8.0 s"]);
    expect(column(rows, "files-ops__op")).toEqual(["read", "changed", "no file named", "overwritten"]);
    expect(column(rows, "files-ops__line")).toEqual([
      "README.md",
      "src/a.ts",
      "$ git status --short",
      "$ echo hi > out.txt",
    ]);
    expect(column(rows, "files-ops__tool")).toEqual(["read_file", "edit_file", "run_command", "run_command"]);
    // The files cell names each file with its source tag and what happened to it.
    const echo = only(
      inside(rows[3]).filter((el) => hasClass(el, "files-ops__files")),
      "files cell",
    );
    expect(inside(echo).some((el) => hasClass(el, "files-src--probable"))).toBe(true);
    expect(textOf(echo.props.children)).toContain("out.txt");
    expect(textOf(echo.props.children)).toContain("overwritten");
    // One agent: no agent column.
    expect(tree.some((el) => hasClass(el, "files-ops__agent"))).toBe(false);
    // The head says what the time column counts from, and the detail sits below the table.
    expect(dict["filesTab.ops.fromStart"]).toEqual({
      de: "Zeit seit dem Start des Laufs",
      en: "time from the start of the run",
    });
    const head = textOf(only(byClassName(tree, "files-panel__meta"), "operations head").props.children);
    expect(head).toBe("time from the start of the run");
    // The key that said seconds over cells in clock form is gone.
    expect(dict["filesTab.ops.seconds"]).toBeUndefined();
    expect(tree.some((el) => hasClass(el, "files-detail"))).toBe(true);
    expect(tree.some((el) => hasClass(el, "files-explorer"))).toBe(false);
  });

  it("operationsShowsFailedCalls", () => {
    const events = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("e1", "edit_file", { path: "a.ts", old_string: "x", new_string: "y" }),
      result("e1", { output: "ERROR: old_string not found", isError: true }),
      call("e2", "edit_file", { path: "b.ts", old_string: "x", new_string: "y" }),
      result("e2", { fileChange: "changed" }),
    ]);
    const tree = run(props({ events }), [press("view-operations")]);
    const [failed, ok] = tableRows(tree);
    expect(hasClass(failed, "files-ops__row--failed")).toBe(true);
    expect(column([failed], "files-ops__op")).toEqual(["failed"]);
    expect(column([failed], "files-ops__files")).toEqual([""]);
    expect(inside(failed).some((el) => hasClass(el, "files-src"))).toBe(false);
    // The call line still names what the call tried.
    expect(column([failed], "files-ops__line")).toEqual(["a.ts"]);
    // The positive twin: a call that worked carries its file and no failed class.
    expect(hasClass(ok, "files-ops__row--failed")).toBe(false);
    expect(inside(ok).some((el) => hasClass(el, "files-src--recorded"))).toBe(true);
    expect(column([ok], "files-ops__files")[0]).toContain("b.ts");
  });

  it("operationsFollowTheChipsAndTheCursor", () => {
    const two = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("m1", "edit_file", { path: "a.ts", old_string: "1", new_string: "2" }),
      result("m1", { fileChange: "changed" }),
      call("w1", "write_file", { path: "b.ts", content: "b\n" }, "worker-1"),
      result("w1", { fileChange: "created" }, "worker-1"),
      call("m2", "read_file", { path: "b.ts" }),
      result("m2"),
    ]);
    const both = run(props({ events: two }), [press("view-operations")]);
    expect(column(tableRows(both), "files-ops__agent")).toEqual(["main", "worker-1", "main"]);
    // Switching worker-1 off takes its row away.
    const mainOnly = run(props({ events: two }), [press("view-operations"), pressChip("worker-1")]);
    expect(tableRows(mainOnly).map((row) => row.props["data-op"])).toEqual([1, 5]);
    // A press selects the call: the row is marked, the detail below shows it, and
    // the cursor stands on it, so the rows after it are dimmed.
    const picked = run(props({ events: two }), [press("view-operations"), pressOp(3)]);
    const rows = tableRows(picked);
    expect(rows.map((row) => hasClass(row, "files-ops__row--sel"))).toEqual([false, true, false]);
    expect(rows.map((row) => hasClass(row, "files-ops__row--after"))).toEqual([false, false, true]);
    const detail = only(
      picked.filter((el) => hasClass(el, "files-detail")),
      "detail",
    );
    expect(
      inside(detail)
        .filter((el) => el.type === "tr" && hasClass(el, "files-diff__add"))
        .map((tr) => textOf(tr.props.children)),
    ).toEqual(["+b"]);
  });

  it("allListsTheSelectedFilesCalls", () => {
    const events = A_THREE_TIMES;
    const allFiles = dict["filesTab.ops.allFiles"]?.en;
    expect(allFiles).toBeTruthy();
    const head = (tree: El[]): string =>
      textOf(
        only(
          tree.filter((el) => hasClass(el, "files-oplist")),
          "operations list",
        ).props.children,
      );
    // Nothing selected: every call.
    const fresh = run(props({ events }));
    expect(listRows(fresh).map((el) => el.props["data-op"])).toEqual([1, 3, 5, 7]);
    expect(head(fresh)).toContain(`${allFiles} · 4`);
    // A file selected: its calls only, and the head names it.
    const picked = run(props({ events }), [pressRow("/ws/src/a.ts")]);
    expect(listRows(picked).map((el) => el.props["data-op"])).toEqual([1, 3, 7]);
    expect(head(picked)).toContain("src/a.ts · 3");
    expect(listRows(picked).map((el) => hasClass(el, "files-op--sel"))).toEqual([false, false, true]);
    // A press on a call of that file selects it and keeps the file.
    const read = run(props({ events }), [pressRow("/ws/src/a.ts"), pressOp(1)]);
    expect(listRows(read).map((el) => el.props["data-op"])).toEqual([1, 3, 7]);
    expect(listRows(read).map((el) => hasClass(el, "files-op--sel"))).toEqual([true, false, false]);
    // The view diff has no list.
    const diff = run(props({ events }), [press("view-diff")]);
    expect(listRows(diff)).toEqual([]);
    expect(diff.some((el) => hasClass(el, "files-explorer"))).toBe(true);
  });

  it("aSecondPressOnTheSelectedFileShowsEveryCallAgain", () => {
    const p = props({ events: A_THREE_TIMES });
    // Nothing selected yet: every call, and no button to ask for them.
    expect(listState(run(p))).toEqual({ ops: [1, 3, 5, 7], allCalls: 0, rowPressed: false, selected: [] });
    // One press: the file's calls, its latest change selected, and the button to widen again.
    expect(listState(run(p, [pressRow("/ws/src/a.ts")]))).toEqual({
      ops: [1, 3, 7],
      allCalls: 1,
      rowPressed: true,
      selected: [7],
    });
    // A second press on the same row lets the file go: every call again, the
    // call stays selected, and the button is gone.
    const again = run(p, [pressRow("/ws/src/a.ts"), pressRow("/ws/src/a.ts")]);
    expect(listState(again)).toEqual({ ops: [1, 3, 5, 7], allCalls: 0, rowPressed: false, selected: [7] });
    expect(
      only(
        again.filter((el) => hasClass(el, "files-detail")),
        "detail",
      ).props.className,
    ).not.toContain("files-detail--after");
    expect(again.some((el) => hasClass(el, "files-placeholder"))).toBe(false);
  });

  it("theTableFixesItsColumnsAndKeepsEachCellOnOneLine", () => {
    const css = read("./files.css", import.meta.url);
    // A fixed layout takes the column widths from the col elements, so a long
    // path or command cannot squeeze the call column (D6: 63 px against 1,041 px).
    expect(blockOf(css, ".files-ops__table")).toMatch(/table-layout:\s*fixed/);
    // Below its min-width the table scrolls sideways rather than closing the files column.
    expect(blockOf(css, ".files-ops__table")).toMatch(/min-width:\s*75em/);
    for (const cell of [".files-ops__line", ".files-ops__fx"]) {
      expect(blockOf(css, cell), cell).toMatch(/white-space:\s*nowrap/);
      expect(blockOf(css, cell), cell).toMatch(/overflow:\s*hidden/);
      expect(blockOf(css, cell), cell).toMatch(/text-overflow:\s*ellipsis/);
    }
    expect(blockOf(css, ".files-ops__line")).not.toMatch(/word-break/);
    // One col per column, in the head's order, with and without the agent column.
    const two = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("m1", "read_file", { path: "a.ts" }),
      result("m1"),
      call("w1", "read_file", { path: "b.ts" }, "worker-1"),
      result("w1", {}, "worker-1"),
    ]);
    const colsOf = (tree: El[]): string[] =>
      tree
        .filter((el) => el.type === "col")
        .map((el) => /files-ops__col--(\w+)/.exec(String(el.props.className))?.[1] ?? "?");
    const one = run(props(), [press("view-operations")]);
    expect(colsOf(one)).toEqual(["when", "prompt", "op", "call", "files", "tool"]);
    expect(one.filter((el) => el.type === "th")).toHaveLength(6);
    const both = run(props({ events: two }), [press("view-operations")]);
    expect(colsOf(both)).toEqual(["when", "prompt", "agent", "op", "call", "files", "tool"]);
    expect(both.filter((el) => el.type === "th")).toHaveLength(7);
    // The tool column leaves at narrow widths with its cells.
    const tool = one.find((el) => el.type === "col" && String(el.props.className).includes("--tool"));
    expect(String(tool?.props.className)).toContain("files-hide-narrow");
    // Every column has a width except call and files, which share what is left equally.
    for (const name of ["when", "prompt", "agent", "op", "tool"]) {
      expect(blockOf(css, `.files-ops__col--${name}`), name).toMatch(/width:/);
    }
    for (const name of ["call", "files"]) {
      expect(
        rules("files.css", css).some((r) => r.subject === `.files-ops__col--${name}`),
        name,
      ).toBe(false);
    }
    // The operation column holds its longest German word, "keine Datei genannt" (130 px measured).
    expect(blockOf(css, ".files-ops__col--op")).toMatch(/width:\s*12em/);
  });

  it("theFilesCellNamesTheFileWithTheWholePathInItsTitle", () => {
    const far =
      "/home/example/projects/spectro/spectro-server/src/main/java/dev/example/server/session/SessionConnection.java";
    const events = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("e1", "edit_file", { path: far, old_string: "1", new_string: "2" }),
      result("e1", { fileChange: "changed" }),
      call("r1", "read_file", { path: "src/a.ts" }),
      result("r1"),
      call("d1", "run_command", { command: "rm -r build" }),
      result("d1"),
      call("g1", "run_command", { command: "rm -f *.log" }),
      result("g1"),
    ]);
    const tree = run(props({ events }), [press("view-operations")]);
    const lines = tableRows(tree).map((row) =>
      only(
        inside(row).filter((el) => hasClass(el, "files-ops__fx")),
        "line in the files cell",
      ),
    );
    const names = lines.map(
      (line) =>
        only(
          inside(line).filter((el) => hasClass(el, "files-ops__path")),
          "name in the line",
        ).props,
    );
    // The file name only: a folder keeps its slash, a pattern stays as written.
    expect(names.map((p) => textOf(p.children as ReactNode))).toEqual([
      "SessionConnection.java",
      "a.ts",
      "build/",
      "*.log",
    ]);
    // The title holds the whole path and the source.
    expect(names.map((p) => p.title)).toEqual([
      `${far} · recorded`,
      "/ws/src/a.ts · recorded",
      "/ws/build/ · probable",
      "/ws/*.log · probable",
    ]);
    // The source tag stays beside the name, after it, so a narrow column cuts the tag before the name.
    const order = (line: El): string[] =>
      inside(line)
        .filter((el) => hasClass(el, "files-ops__path") || hasClass(el, "files-src"))
        .map((el) => (hasClass(el, "files-ops__path") ? "name" : "tag"));
    expect(lines.map(order)).toEqual([
      ["name", "tag"],
      ["name", "tag"],
      ["name", "tag"],
      ["name", "tag"],
    ]);
    // The explorer keeps showing the path.
    const all = run(props({ events }));
    const explorer = only(
      all.filter((el) => hasClass(el, "files-explorer")),
      "explorer",
    );
    expect(textOf(explorer.props.children)).toContain("src/a.ts");
  });

  it("aNameCarriesItsSourceWhenTheColumnCutsItsTag", () => {
    // 48 characters: past the 27 a line holds at 1024 px, so the tag after it is cut off.
    const long = "GeneratedQuarterlyReportForTheWholeTeam_final.md";
    const events = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("p1", "run_command", { command: `echo hi > ${long}` }),
      result("p1"),
      call("w1", "write_file", { path: `docs/${long}`, content: "x\n" }),
      result("w1", { fileChange: "created" }),
    ]);
    const nameSpans = (tree: El[]): El[] => tree.filter((el) => hasClass(el, "files-ops__path"));
    const marks = (tree: El[]): string[] =>
      nameSpans(tree).map((el) =>
        hasClass(el, "files-ops__path--model")
          ? "model"
          : hasClass(el, "files-ops__path--probable")
            ? "probable"
            : "none",
      );
    // The probable name carries its source; the recorded twin carries none.
    const tree = run(props({ events }), [press("view-operations")]);
    expect(marks(tree)).toEqual(["probable", "none"]);
    expect(nameSpans(tree).map((el) => el.props.title)).toEqual([
      `/ws/${long} · probable`,
      `/ws/docs/${long} · recorded`,
    ]);
    // The title speaks the tab's language.
    setLang("de");
    try {
      const de = run(props({ events }), [press("view-operations")]);
      expect(nameSpans(de).map((el) => el.props.title)).toEqual([
        `/ws/${long} · wahrscheinlich`,
        `/ws/docs/${long} · aufgezeichnet`,
      ]);
    } finally {
      setLang("en");
    }
    // A model's reading: alone, or merged with the heuristic's guess, the name says model.
    const ledger = mergeModel(foldFiles(events), [
      { callIndex: 1, path: long, kind: "overwrite", reason: "" },
      { callIndex: 1, path: "summary.txt", kind: "create", reason: "" },
    ]);
    const merged = drive(
      <FilesOperations
        lang="en"
        ledger={ledger}
        calls={ledger.calls}
        ordinals={new Map(ledger.calls.map((c, i) => [c.callIndex, i + 1]))}
        limit={99}
        selection={{ call: null, path: null }}
        agents={false}
        onPick={() => {}}
      />,
      [FilesOperations],
      [],
    );
    expect(marks(merged)).toEqual(["model", "model", "none"]);
    expect(nameSpans(merged).map((el) => el.props.title)).toEqual([
      `/ws/${long} · probable · model`,
      "/ws/summary.txt · model",
      `/ws/docs/${long} · recorded`,
    ]);
    // The stylesheet draws the two guesses apart, in the files aliases, and leaves recorded plain.
    const css = read("./files.css", import.meta.url);
    expect(blockOf(css, ".files-ops__path--probable")).toMatch(/dashed/);
    expect(blockOf(css, ".files-ops__path--probable")).toMatch(/var\(--files-shell\)/);
    expect(blockOf(css, ".files-ops__path--model")).toMatch(/dotted/);
    expect(blockOf(css, ".files-ops__path--model")).toMatch(/var\(--files-model\)/);
    expect(rules("files.css", css).some((r) => r.subject === ".files-ops__path--recorded")).toBe(false);
  });

  it("aLongCommandStaysOneLineWithTheWholeCommandInItsTitle", () => {
    // A heredoc of 5,000 characters, then a short command.
    const command = `cat > big.txt <<'EOF'\n${"x".repeat(5_000)}\nEOF`;
    const events = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("h1", "run_command", { command }),
      result("h1"),
      call("h2", "run_command", { command: "ls" }),
      result("h2"),
    ]);
    const full = `$ ${foldFiles(events).calls[0].line}`;
    expect(full.length).toBeGreaterThan(5_000);
    const clipped = `${full.slice(0, 199)}…`;
    expect(clipped).toHaveLength(200);
    // The table: the cell shows 200 characters, the title the whole command.
    const lines = (tree: El[], cls: string): El[] =>
      tree.filter((el) => hasClass(el, cls) && (el.type === "td" || el.type === "span"));
    const table = lines(run(props({ events }), [press("view-operations")]), "files-ops__line");
    expect(table.map((el) => textOf(el.props.children))).toEqual([clipped, "$ ls"]);
    expect(table.map((el) => el.props.title)).toEqual([full, "$ ls"]);
    // The list of the view all does the same.
    const list = lines(run(props({ events })), "files-op__line");
    expect(list.map((el) => textOf(el.props.children))).toEqual([clipped, "$ ls"]);
    expect(list.map((el) => el.props.title)).toEqual([full, "$ ls"]);
  });

  it("theAllCallsButtonShowsEveryCallAgain", () => {
    const label = dict["filesTab.ops.allCalls"];
    expect(label).toEqual({ de: "alle Aufrufe", en: "all calls" });
    const p = props({ events: A_THREE_TIMES });
    const narrowed = run(p, [pressRow("/ws/src/a.ts")]);
    expect(listState(narrowed)).toEqual({ ops: [1, 3, 7], allCalls: 1, rowPressed: true, selected: [7] });
    const button = only(
      narrowed.filter((el) => el.type === "button" && el.props["data-action"] === "all-calls"),
      "all-calls button",
    );
    expect(textOf(button.props.children)).toBe(label?.en);
    // The button lets the file go the same way a second press does.
    const wide = run(p, [pressRow("/ws/src/a.ts"), press("all-calls")]);
    expect(listState(wide)).toEqual({ ops: [1, 3, 5, 7], allCalls: 0, rowPressed: false, selected: [7] });
    expect(wide.some((el) => hasClass(el, "files-placeholder"))).toBe(false);
  });
});
