// Card 604: the files tab with its explorer and the detail of one call. The
// suite has no DOM: the tab renders on the server renderer, and the drive kit
// presses its buttons (testkit/driveComponent.tsx). Nothing a case needs may
// happen in an effect, because effects never run here.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { buildFilesDigest } from "./digest";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { resetFilesAnalysis, stampOf, startFilesAnalysis } from "./filesAnalysis";
import { FilesModelControls } from "./FilesModelControls";
import { FilesReportSheet } from "./FilesReportSheet";
import { FilesTimeline } from "./FilesTimeline";
import { FilesView, type FilesViewProps } from "./FilesView";
import { foldFiles, type FileLedger } from "./fold";

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

/** One edit, one created write, one read and one shell command that runs a script. */
const EVENTS = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "edit_file", { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  result("c1", { fileChange: "changed" }),
  call("c2", "write_file", { path: "src/new.ts", content: "export const n = 1;\n" }),
  result("c2", { fileChange: "created" }),
  call("c3", "read_file", { path: "README.md" }),
  result("c3"),
  call("c4", "Bash", { command: "python3 scripts/gen.py out/" }),
  result("c4", { output: "wrote out/x.txt" }),
]);

const EXPAND = [FilesView, FilesExplorer, FilesDetail, FilesTimeline];

function props(over: Partial<FilesViewProps> = {}): FilesViewProps {
  return {
    viewKey: "s-1",
    events: EVENTS,
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

/** The text of a host element and everything below it. */
function textOf(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map((c) => textOf(c as ReactNode)).join("");
  if (isValidElement(n)) return textOf((n as El).props.children);
  return "";
}

const classOf = (el: El): string => (typeof el.props.className === "string" ? el.props.className : "");
const hasClass = (el: El, name: string): boolean => classOf(el).split(/\s+/).includes(name);

function rowOf(tree: El[], path: string): El {
  const row = tree.find((el) => el.type === "button" && el.props["data-path"] === path);
  if (row === undefined) throw new Error(`no explorer row for ${path}`);
  return row;
}

const pressRow =
  (path: string): Step =>
  (tree) =>
    rowOf(tree, path).props.onClick?.();

function action(tree: El[], name: string): El {
  const button = tree.find((el) => el.type === "button" && el.props["data-action"] === name);
  if (button === undefined) throw new Error(`no button ${name}`);
  return button;
}

const press =
  (name: string): Step =>
  (tree) =>
    action(tree, name).props.onClick?.();

/** The rows of one explorer group, as path and letter. */
function groupRows(tree: El[], group: "changed" | "read"): { path: string; letter: string }[] {
  const box = tree.find((el) => el.props["data-group"] === group);
  if (box === undefined) throw new Error(`no group ${group}`);
  return inside(box)
    .filter((el) => el.type === "button")
    .map((row) => ({
      path: String(row.props["data-path"]),
      letter: textOf(inside(row).find((el) => hasClass(el, "files-letter"))?.props.children),
    }));
}

beforeAll(() => setLang("en"));

describe("the files tab", () => {
  it("explorerGroupsChangedAndRead", () => {
    const tree = run(props());
    expect(groupRows(tree, "changed")).toEqual([
      { path: "/ws/out", letter: "?" },
      { path: "/ws/src/a.ts", letter: "M" },
      { path: "/ws/src/new.ts", letter: "A" },
    ]);
    expect(groupRows(tree, "read")).toEqual([
      { path: "/ws/README.md", letter: "R" },
      { path: "/ws/scripts/gen.py", letter: "R" },
    ]);
    // A folder line names its folder in the same truncating span as a file line,
    // so a long path ends in an ellipsis inside the panel.
    const folders = tree.filter((el) => hasClass(el, "files-row--dir"));
    expect(folders.map((el) => textOf(el.props.children))).toEqual(["src/", "scripts/"]);
    for (const folder of folders) {
      expect(inside(folder).some((el) => hasClass(el, "files-row__name"))).toBe(true);
    }
  });

  it("aProbableRowIsNeverDrawnAsRecorded", () => {
    const tree = run(props());
    const out = inside(rowOf(tree, "/ws/out"));
    expect(out.some((el) => hasClass(el, "files-src--probable"))).toBe(true);
    expect(out.some((el) => hasClass(el, "files-src--recorded"))).toBe(false);
    expect(out.find((el) => hasClass(el, "files-letter"))?.props.className).toContain("files-letter--guess");
    // The positive twin: a row a file tool changed is drawn as recorded, solid.
    const edited = inside(rowOf(tree, "/ws/src/a.ts"));
    expect(edited.some((el) => hasClass(el, "files-src--recorded"))).toBe(true);
    expect(edited.find((el) => hasClass(el, "files-letter"))?.props.className).not.toContain(
      "files-letter--guess",
    );
  });

  it("editDetailShowsTheReplacement", () => {
    const tree = run(props(), [pressRow("/ws/src/a.ts")]);
    const removed = tree.filter((el) => el.type === "tr" && hasClass(el, "files-diff__del"));
    const added = tree.filter((el) => el.type === "tr" && hasClass(el, "files-diff__add"));
    expect(removed.map((tr) => textOf(tr.props.children))).toEqual(["-const a = 1;"]);
    expect(added.map((tr) => textOf(tr.props.children))).toEqual(["+const a = 2;"]);
    // Before | after puts the same two lines side by side.
    const split = run(props(), [pressRow("/ws/src/a.ts"), press("style-split")]);
    const cell = (cls: string) =>
      split.filter((el) => el.type === "td" && hasClass(el, cls)).map((td) => textOf(td.props.children));
    expect(cell("files-diff__text--del")).toEqual(["const a = 1;"]);
    expect(cell("files-diff__text--add")).toEqual(["const a = 2;"]);
  });

  it("scriptDetailLinksTheScript", () => {
    const onOpenPath = vi.fn();
    run(props({ onOpenPath }), [pressRow("/ws/out"), press("open-script")]);
    expect(onOpenPath).toHaveBeenCalledWith("/ws/scripts/gen.py");
    const note = dict["filesTab.detail.noFolder"]?.en;
    expect(note).toBeTruthy();
    const linked = run(props(), [pressRow("/ws/out")]);
    expect(action(linked, "open-script").props.disabled).toBe(false);
    expect(linked.some((el) => textOf(el.props.children) === note)).toBe(false);
    const folderless = run(props({ onOpenPath: null }), [pressRow("/ws/out")]);
    expect(action(folderless, "open-script").props.disabled).toBe(true);
    expect(folderless.some((el) => textOf(el.props.children) === note)).toBe(true);
  });

  it("openScriptSaysWhereItOpens", () => {
    const title = (): unknown => action(run(props(), [pressRow("/ws/out")]), "open-script").props.title;
    expect(title()).toBe("Opens /ws/scripts/gen.py in the Files panel beside the chat.");
    setLang("de");
    try {
      expect(title()).toBe("Öffnet /ws/scripts/gen.py im Panel Dateien neben dem Chat.");
    } finally {
      setLang("en");
    }
  });

  it("eachReplacementOfAMultiEditHasItsCaption", () => {
    const multi = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("m1", "MultiEdit", {
        file_path: "/ws/a.ts",
        edits: [
          { old_string: "one", new_string: "1" },
          { old_string: "two", new_string: "2" },
          { old_string: "three", new_string: "3" },
        ],
      }),
      result("m1"),
      call("e1", "edit_file", { path: "b.ts", old_string: "x", new_string: "y" }),
      result("e1", { fileChange: "changed" }),
    ]);
    const captions = (tree: El[]) =>
      tree.filter((el) => hasClass(el, "files-diff__cap--pair")).map((el) => textOf(el.props.children));
    const mainCaption = dict["filesTab.diff.replaced"]?.en;
    expect(mainCaption).toBeTruthy();
    const three = run(props({ events: multi }), [pressRow("/ws/a.ts")]);
    expect(captions(three)).toEqual(["replacement 1 of 3", "replacement 2 of 3", "replacement 3 of 3"]);
    expect(three.filter((el) => el.type === "table" && hasClass(el, "files-diff__table"))).toHaveLength(3);
    // Before | after keeps one caption per pair.
    const split = run(props({ events: multi }), [pressRow("/ws/a.ts"), press("style-split")]);
    expect(captions(split)).toHaveLength(3);
    setLang("de");
    try {
      expect(captions(run(props({ events: multi }), [pressRow("/ws/a.ts")]))).toEqual([
        "Ersetzung 1 von 3",
        "Ersetzung 2 von 3",
        "Ersetzung 3 von 3",
      ]);
    } finally {
      setLang("en");
    }
    // One pair needs no count: the edit shows its caption and no pair caption.
    const one = run(props({ events: multi }), [pressRow("/ws/b.ts")]);
    expect(captions(one)).toEqual([]);
    expect(
      one.some((el) => hasClass(el, "files-diff__cap") && textOf(el.props.children) === mainCaption),
    ).toBe(true);
  });

  it("openInTraceHandsTheCallEvent", () => {
    const onFocusEvent = vi.fn();
    run(props({ onFocusEvent }), [pressRow("/ws/src/a.ts"), press("open-in-trace")]);
    const at = EVENTS.findIndex((e) => e.type === "tool_call" && e.callId === "c1");
    expect(onFocusEvent).toHaveBeenCalledTimes(1);
    expect(onFocusEvent).toHaveBeenCalledWith("main", EVENTS[at]);
    expect(onFocusEvent.mock.calls[0][1]).toBe(EVENTS[at]);
  });

  it("theStepperWalksTheChangesOfTheSelectedFile", () => {
    const twice = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("e1", "edit_file", { path: "a.ts", old_string: "one", new_string: "two" }),
      result("e1"),
      call("e2", "edit_file", { path: "a.ts", old_string: "two", new_string: "three" }),
      result("e2"),
    ]);
    const added = (tree: El[]) =>
      tree
        .filter((el) => el.type === "tr" && hasClass(el, "files-diff__add"))
        .map((tr) => textOf(tr.props.children));
    // A press on the file shows its latest change, and the stepper walks back to the first.
    const last = run(props({ events: twice }), [pressRow("/ws/a.ts")]);
    expect(added(last)).toEqual(["+three"]);
    expect(action(last, "next-change").props.disabled).toBe(true);
    const first = run(props({ events: twice }), [pressRow("/ws/a.ts"), press("previous-change")]);
    expect(added(first)).toEqual(["+two"]);
    expect(action(first, "previous-change").props.disabled).toBe(true);
    expect(action(first, "next-change").props.disabled).toBe(false);
  });

  it("everyKeyTheTabUsesIsInTheDictionary", () => {
    // Literal keys, read off every source file of the tab, and the families built from a value.
    const sources = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .sort();
    expect(sources).toEqual(
      expect.arrayContaining(["FilesCreated.tsx", "FilesOperations.tsx", "FilesView.tsx"]),
    );
    const literal = sources.flatMap((file) => [
      ...stripComments(read(`./${file}`, import.meta.url)).matchAll(/"(filesTab\.[\w.]+)"/g),
    ]);
    expect(literal.length).toBeGreaterThan(20);
    const families = [
      ...["all", "diff", "created", "operations"].map((v) => `filesTab.view.${v}`),
      ...["unified", "split"].map((s) => `filesTab.style.${s}`),
      ...["recorded", "probable", "model"].map((s) => `filesTab.source.${s}`),
      ...["changed", "read"].map((g) => `filesTab.group.${g}`),
      ...["read", "create", "change", "overwrite", "write", "append", "delete", "unknown"].map(
        (k) => `filesTab.kind.${k}`,
      ),
      ...["pdf", "html", "csv"].map((k) => `filesTab.report.${k}`),
      ...["critical", "sensitive", "unknown", "project"].map((l) => `filesTab.report.level.${l}`),
    ];
    const missing = [...literal.map((m) => m[1]), ...families].filter((key) => dict[key] === undefined);
    expect(missing).toEqual([]);
  });

  it("agentChipsFilterTheRowsAndTheSummary", () => {
    const two = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("m1", "edit_file", { path: "a.ts", old_string: "1", new_string: "2" }),
      result("m1", { fileChange: "changed" }),
      call("w1", "write_file", { path: "b.ts", content: "b\n" }, "worker-1"),
      result("w1", { fileChange: "created" }, "worker-1"),
      call("w2", "run_command", { command: "echo hi > c.txt" }, "worker-1"),
      result("w2", {}, "worker-1"),
    ]);
    const chips = (tree: El[]) =>
      tree
        .filter((el) => el.type === "button" && el.props["data-agent"] !== undefined)
        .map((el) => [el.props["data-agent"], el.props["aria-pressed"]]);
    const paths = (tree: El[]) =>
      [...groupRows(tree, "changed"), ...groupRows(tree, "read")].map((r) => r.path);
    const summary = (tree: El[]) => textOf(tree.find((el) => hasClass(el, "files-summary"))?.props.children);
    const lanes = (tree: El[]) =>
      tree
        .filter((el) => hasClass(el, "files-tl__row"))
        .map((el) => el.props["data-path"] ?? el.props["data-row"]);
    const both = run(props({ events: two }));
    expect(chips(both)).toEqual([
      ["main", true],
      ["worker-1", true],
    ]);
    expect(paths(both)).toEqual(["/ws/a.ts", "/ws/b.ts", "/ws/c.txt"]);
    expect(summary(both)).toBe(
      "2 files changed by file tools · 1 more probably changed by shell commands · 0 only read · 1 shell command, 0 of them ran a script whose effect is not in the session",
    );
    // Switching worker-1 off takes its files, its shell call and its counts away.
    const pressChip =
      (agent: string): Step =>
      (tree) =>
        tree.find((el) => el.type === "button" && el.props["data-agent"] === agent)?.props.onClick?.();
    const mainOnly = run(props({ events: two }), [pressChip("worker-1")]);
    expect(chips(mainOnly)).toEqual([
      ["main", true],
      ["worker-1", false],
    ]);
    expect(paths(mainOnly)).toEqual(["/ws/a.ts"]);
    expect(lanes(mainOnly)).toEqual(["/ws/a.ts", "shell"]);
    expect(summary(mainOnly)).toBe(
      "1 file changed by file tools · 0 more probably changed by shell commands · 0 only read · 0 shell commands",
    );
    // The last agent shown stays on, so the tab never filters itself empty.
    const kept = run(props({ events: two }), [pressChip("worker-1"), pressChip("main")]);
    expect(chips(kept)).toEqual([
      ["main", true],
      ["worker-1", false],
    ]);
    // And worker-1 comes back.
    const again = run(props({ events: two }), [pressChip("worker-1"), pressChip("worker-1")]);
    expect(paths(again)).toEqual(["/ws/a.ts", "/ws/b.ts", "/ws/c.txt"]);
  });

  it("oneAgentShowsNoChips", () => {
    const tree = run(props());
    expect(tree.some((el) => el.props["data-agent"] !== undefined)).toBe(false);
    // The fixture really has one agent and real file calls, so the absence means something.
    expect(tree.some((el) => hasClass(el, "files-explorer"))).toBe(true);
  });

  it("aSessionChangeDropsTheStartOfAnotherSession", () => {
    // App cannot render here, so its half of the seam is read off disk: the
    // effect that closes the lightbox on a session change also drops a files
    // start that is not an event of the session now shown.
    const app = stripComments(read("../App.tsx", import.meta.url));
    const end = app.indexOf("}, [replay?.id, enteredFleet]);");
    expect(end).toBeGreaterThan(-1);
    const effect = app.slice(app.lastIndexOf("useEffect(", end), end);
    expect(effect).toContain("setLightboxAt(null)");
    expect(effect).toMatch(/setFilesFocus\(/);
    expect(effect).toContain(".events.includes(");
  });

  it("aSessionWithoutFileCallsSaysSo", () => {
    const empty = dict["filesTab.empty"]?.en;
    expect(empty).toBeTruthy();
    const quiet = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("w1", "web_fetch", { url: "https://example.com" }),
      result("w1"),
    ]);
    const tree = run(props({ events: quiet }));
    expect(tree.some((el) => textOf(el.props.children) === empty)).toBe(true);
    expect(tree.some((el) => hasClass(el, "files-explorer"))).toBe(false);
    // The twin: a session with file calls draws the explorer and not the line.
    const busy = run(props());
    expect(busy.some((el) => hasClass(el, "files-explorer"))).toBe(true);
    expect(busy.some((el) => textOf(el.props.children) === empty)).toBe(false);
  });
});

describe("the report button", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetFilesAnalysis("s-1");
  });

  const sheetOf = (tree: El[]): El | undefined => tree.find((el) => el.type === FilesReportSheet);

  const modelTouches = (ledger: FileLedger): number =>
    ledger.calls.flatMap((c) => c.touches).filter((touch) => touch.sources.includes("model")).length;

  it("theHeaderHasAReportButtonThatOpensTheSheet", () => {
    const closed = run(props({ title: "Fix the build" }));
    const button = action(closed, "report");
    expect(textOf(button.props.children)).toBe("Report");
    expect(button.props["aria-expanded"]).toBe(false);
    expect(sheetOf(closed)).toBeUndefined();
    // It stands in the header, after the model controls.
    const toolbar = closed.find((el) => hasClass(el, "files-toolbar"));
    const order = inside(toolbar!);
    const controlsAt = order.findIndex((el) => el.type === FilesModelControls);
    expect(controlsAt).toBeGreaterThan(-1);
    expect(order.indexOf(button)).toBeGreaterThan(controlsAt);

    const open = run(props({ title: "Fix the build" }), [press("report")]);
    const sheet = sheetOf(open);
    expect(sheet).toBeDefined();
    expect(sheet!.props.events).toBe(EVENTS);
    expect(sheet!.props.sessionId).toBe("s-1");
    expect(sheet!.props.title).toBe("Fix the build");
    expect(sheet!.props.lang).toBe("en");
    expect(action(open, "report").props["aria-expanded"]).toBe(true);
  });

  it("closingTheSheetReturnsTheFocusToTheButton", () => {
    const focus = vi.fn();
    const tree = run(props(), [
      (t) => {
        (action(t, "report").props.ref as { current: unknown }).current = { focus };
        action(t, "report").props.onClick?.();
      },
      (t) => {
        expect(focus).not.toHaveBeenCalled();
        (sheetOf(t)!.props.onClose as () => void)();
      },
    ]);
    expect(sheetOf(tree)).toBeUndefined();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("aSessionWithoutFileCallsStillHasTheReport", () => {
    // Prompts, steering messages and tool results can hold findings of their own.
    const quiet = stamp([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
      call("w1", "web_fetch", { url: "https://example.com" }),
      result("w1"),
    ]);
    const closed = run(props({ events: quiet, title: "Look around" }));
    expect(closed.some((el) => textOf(el.props.children) === dict["filesTab.empty"]?.en)).toBe(true);
    expect(textOf(action(closed, "report").props.children)).toBe("Report");
    const focus = vi.fn();
    let sheet: El | undefined;
    const after = run(props({ events: quiet, title: "Look around" }), [
      (t) => {
        (action(t, "report").props.ref as { current: unknown }).current = { focus };
        action(t, "report").props.onClick?.();
      },
      (t) => {
        sheet = sheetOf(t);
        (sheet?.props.onClose as () => void)();
      },
    ]);
    expect(sheet).toBeDefined();
    expect(sheet!.props.events).toBe(quiet);
    expect((sheet!.props.ledger as FileLedger).calls).toEqual([]);
    expect(sheet!.props.title).toBe("Look around");
    expect(sheet!.props.sessionId).toBe("s-1");
    expect(sheetOf(after)).toBeUndefined();
    expect(focus).toHaveBeenCalledTimes(1);
    // A tab with no events at all has nothing to report.
    expect(run(props({ events: [] })).some((el) => el.props["data-action"] === "report")).toBe(false);
  });

  it("theSheetGetsTheLedgerTheTabShows", async () => {
    const heuristic = foldFiles(EVENTS);
    const shell = heuristic.calls.find((c) => c.shell);
    expect(shell).toBeDefined();
    const answer = JSON.stringify({
      files: [
        { callIndex: shell!.callIndex, path: "out/y.txt", kind: "create", reason: "the output names it" },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            [{ meta: { provider: "ollama", model: "qwen2.5:7b" } }, { delta: answer }, { done: true }]
              .map((line) => JSON.stringify(line) + "\n")
              .join(""),
            { status: 200 },
          ),
      ),
    );
    const digest = buildFilesDigest(heuristic);
    await startFilesAnalysis(
      "s-1",
      digest.text,
      { provider: "ollama", model: "qwen2.5:7b" },
      "en",
      stampOf(heuristic, digest, EVENTS),
    );
    const showModel: Step = (tree) =>
      (tree.find((el) => el.type === FilesModelControls)?.props.onMode as (mode: string) => void)("model");
    const shownLedger = (tree: El[]): FileLedger =>
      tree.find((el) => el.type === FilesDetail)?.props.ledger as FileLedger;

    // With the model's reading on screen, the sheet reports the merged ledger the panes show.
    const merged = run(props(), [showModel, press("report")]);
    const mergedLedger = sheetOf(merged)!.props.ledger as FileLedger;
    expect(mergedLedger).toBe(shownLedger(merged));
    expect(modelTouches(mergedLedger)).toBeGreaterThan(0);
    // Without it, the heuristic ledger, with no model entry in it.
    const plain = run(props(), [press("report")]);
    const plainLedger = sheetOf(plain)!.props.ledger as FileLedger;
    expect(plainLedger).toBe(shownLedger(plain));
    expect(modelTouches(plainLedger)).toBe(0);
  });
});
