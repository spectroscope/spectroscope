// Card 604: the timeline of the files tab and the tab's own cursor. One row per
// explorer path and a row for the shell commands; touches after the cursor are
// dimmed in every view; arrow keys step through the calls. The suite has no
// DOM: the tab renders on the server renderer and the drive kit presses its
// controls (testkit/driveComponent.tsx), so nothing a case needs may wait for an
// effect.

import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { blockOf, read } from "../testkit/source";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { FilesTimeline, timelineAxis, type FilesTimelineProps } from "./FilesTimeline";
import { FilesView, type FilesViewProps } from "./FilesView";
import { fileRows, foldFiles, type FileLedger } from "./fold";

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
const PLAIN = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "edit_file", { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
  result("c1", { fileChange: "changed" }),
  call("c2", "write_file", { path: "src/new.ts", content: "export const n = 1;\n" }),
  result("c2", { fileChange: "created" }),
  call("c3", "read_file", { path: "README.md" }),
  result("c3"),
  call("c4", "Bash", { command: "python3 scripts/gen.py out/" }),
  result("c4", { output: "wrote out/x.txt" }),
];
const EVENTS = stamp(PLAIN);

const EXPAND = [FilesView, FilesExplorer, FilesDetail, FilesTimeline];

function props(over: Partial<FilesViewProps> = {}): FilesViewProps {
  return {
    viewKey: "s-1",
    events: EVENTS,
    startAt: null,
    onStartHandled: () => {},
    onFocusEvent: () => {},
    onOpenPath: () => {},
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
const byClass = (tree: El[], name: string): El[] => tree.filter((el) => hasClass(el, name));

/** The timeline's marks, as call index, path and class list. */
function marks(tree: El[]): { call: number; path: string; classes: string[] }[] {
  return byClass(tree, "files-tl__mark").map((el) => ({
    call: Number(el.props["data-call"]),
    path: String(el.props["data-file"]),
    classes: classOf(el).split(/\s+/),
  }));
}

function only<T>(list: T[], what: string): T {
  if (list.length !== 1) throw new Error(`expected one ${what}, found ${list.length}`);
  return list[0];
}

function action(tree: El[], name: string): El {
  return only(
    tree.filter((el) => el.type === "button" && el.props["data-action"] === name),
    `button ${name}`,
  );
}

const press =
  (name: string): Step =>
  (tree) =>
    action(tree, name).props.onClick?.();

const pressRow =
  (path: string): Step =>
  (tree) =>
    only(
      tree.filter(
        (el) => el.type === "button" && hasClass(el, "files-row") && el.props["data-path"] === path,
      ),
      `explorer row ${path}`,
    ).props.onClick?.();

type KeyHandler = (e: { key: string; target: unknown; preventDefault: () => void }) => void;

const key =
  (name: string, tagName = "DIV", prevented: string[] = []): Step =>
  (tree) =>
    (only(byClass(tree, "files-tab"), "tab root").props.onKeyDown as KeyHandler)({
      key: name,
      target: { tagName },
      preventDefault: () => prevented.push(name),
    });

const readout = (tree: El[]): string =>
  textOf(only(byClass(tree, "files-tl__readout"), "readout").props.children);

/** The added lines of the detail's diff, which name the call it shows. */
const added = (tree: El[]): string[] =>
  tree
    .filter((el) => el.type === "tr" && hasClass(el, "files-diff__add"))
    .map((tr) => textOf(tr.props.children));

const selectedRow = (tree: El[]): string[] =>
  byClass(tree, "files-row--sel").map((el) => String(el.props["data-path"]));

beforeAll(() => setLang("en"));

describe("the files tab's timeline", () => {
  it("drawsOneRowPerPathAndAShellRow", () => {
    const tree = run(props());
    const expected = fileRows(foldFiles(EVENTS), null).map((r) => r.path);
    expect(expected).toEqual([
      "/ws/src/a.ts",
      "/ws/src/new.ts",
      "/ws/README.md",
      "/ws/scripts/gen.py",
      "/ws/out",
    ]);
    const rows = byClass(tree, "files-tl__row");
    expect(rows.map((el) => el.props["data-path"] ?? el.props["data-row"])).toEqual([...expected, "shell"]);
    // Each path row carries the marks of that path; the shell row one per shell call.
    for (const row of rows.slice(0, -1)) {
      const inRow = inside(row).filter((el) => hasClass(el, "files-tl__mark"));
      expect(inRow.length).toBeGreaterThan(0);
      for (const mark of inRow) expect(mark.props["data-file"]).toBe(row.props["data-path"]);
    }
    const shell = inside(rows[rows.length - 1]).filter((el) => hasClass(el, "files-tl__mark"));
    expect(shell.map((el) => Number(el.props["data-call"]))).toEqual([7]);
    // The labels beside the rows, in the same order, and no "+K more" line at this size.
    const labels = byClass(tree, "files-tl__label").map((el) => textOf(el.props.children));
    expect(labels).toEqual([
      "src/a.ts",
      "src/new.ts",
      "README.md",
      "scripts/gen.py",
      "out/",
      "shell commands",
    ]);
    expect(byClass(tree, "files-tl__more")).toEqual([]);
  });

  it("aLongSessionCapsTheRows", () => {
    const many: object[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
    ];
    for (let i = 0; i < 45; i++) many.push(call(`r${i}`, "read_file", { path: `f${i}.ts` }), result(`r${i}`));
    const events = stamp(many);
    const tree = run(props({ events }));
    const rows = byClass(tree, "files-tl__row");
    expect(rows.length).toBe(30 + 1);
    expect(rows[29].props["data-path"]).toBe("/ws/f29.ts");
    expect(textOf(only(byClass(tree, "files-tl__more"), "more line").props.children)).toBe(
      "+15 more files, listed in the explorer",
    );
    // A file picked in the explorer beyond the cap gets its row on the timeline too.
    const picked = run(props({ events }), [pressRow("/ws/f40.ts")]);
    const pickedRows = byClass(picked, "files-tl__row").map(
      (el) => el.props["data-path"] ?? el.props["data-row"],
    );
    expect(pickedRows).toHaveLength(32);
    expect(pickedRows.slice(-2)).toEqual(["/ws/f40.ts", "shell"]);
    expect(textOf(only(byClass(picked, "files-tl__more"), "more line").props.children)).toBe(
      "+14 more files, listed in the explorer",
    );
  });

  it("probableTouchesAreDashed", () => {
    const all = marks(run(props()));
    const probable = all.filter((m) => m.classes.includes("files-tl__mark--probable"));
    // The shell call's two touches and its mark on the shell row, nothing else.
    expect(probable.map((m) => [m.call, m.path])).toEqual([
      [7, "/ws/scripts/gen.py"],
      [7, "/ws/out"],
      [7, ""],
    ]);
    const recorded = all.filter((m) => m.call !== 7);
    expect(recorded.map((m) => m.call)).toEqual([1, 3, 5]);
    for (const m of recorded) expect(m.classes).not.toContain("files-tl__mark--probable");
    // Kinds: an edit is a change, a created write a create, a read a read.
    expect(recorded.map((m) => m.classes.find((c) => /--(create|change|read)$/.test(c)))).toEqual([
      "files-tl__mark--change",
      "files-tl__mark--create",
      "files-tl__mark--read",
    ]);
    // The stylesheet draws the probable mark dashed and the others solid.
    const css = read("./files.css", import.meta.url);
    expect(blockOf(css, ".files-tl__mark::before")).toMatch(/border-left:\s*3px solid/);
    expect(blockOf(css, ".files-tl__mark--probable::before")).toMatch(/border-left-style:\s*dashed/);
  });

  it("aModelTouchIsARing", () => {
    const ledger = foldFiles(EVENTS);
    const shellCall = ledger.calls[3];
    const withModel: FileLedger = {
      ...ledger,
      calls: ledger.calls.map((c) =>
        c !== shellCall
          ? c
          : {
              ...c,
              touches: c.touches.map((touch) =>
                touch.path === "/ws/out"
                  ? { ...touch, kind: "create" as const, sources: ["probable", "model"] }
                  : touch,
              ),
            },
      ),
    };
    const rows = fileRows(withModel, null);
    const timeline: FilesTimelineProps = {
      lang: "en",
      ledger: withModel,
      events: EVENTS,
      axis: timelineAxis(withModel, EVENTS),
      rows,
      calls: withModel.calls,
      cursor: { follow: true },
      playing: false,
      selection: { call: null, path: null },
      onPick: () => {},
      onSelectRow: () => {},
      onCursor: () => {},
      onPlay: () => {},
      onFollow: () => {},
    };
    const tree = drive(<FilesTimeline {...timeline} />, [FilesTimeline], []);
    const out = only(
      marks(tree).filter((m) => m.path === "/ws/out"),
      "mark on /ws/out",
    );
    expect(out.classes).toContain("files-tl__mark--model");
    expect(out.classes).toContain("files-tl__mark--create");
    // A ring stands for the model's reading; a probable touch without it stays a line.
    const gen = only(
      marks(tree).filter((m) => m.path === "/ws/scripts/gen.py"),
      "mark on gen.py",
    );
    expect(gen.classes).not.toContain("files-tl__mark--model");
    const css = read("./files.css", import.meta.url);
    expect(blockOf(css, ".files-tl__mark--model::before")).toMatch(/border-radius:\s*50%/);
    // And it renders as markup, not only as elements.
    expect(renderToStaticMarkup(<FilesTimeline {...timeline} />)).toContain("files-tl__mark--model");
  });

  it("touchesAfterTheCursorAreDimmed", () => {
    // The route opened the tab at the created write (event 3).
    const tree = run(props({ startAt: EVENTS[3] }));
    const after = marks(tree)
      .filter((m) => m.classes.includes("files-tl__mark--after"))
      .map((m) => m.call);
    expect(after).toEqual([5, 7, 7, 7]);
    const before = marks(tree).filter((m) => !m.classes.includes("files-tl__mark--after"));
    expect(before.map((m) => m.call)).toEqual([1, 3]);
    expect(readout(tree)).toBe("+3.0 s");
    // The explorer dims the files not touched yet and says when they first appear.
    const later = byClass(tree, "files-row--later");
    expect(later.map((el) => el.props["data-path"])).toEqual([
      "/ws/out",
      "/ws/README.md",
      "/ws/scripts/gen.py",
    ]);
    const readme = only(
      later.filter((el) => el.props["data-path"] === "/ws/README.md"),
      "README row",
    );
    expect(
      textOf(
        only(
          inside(readme).filter((el) => hasClass(el, "files-row__when")),
          "when",
        ).props.children,
      ),
    ).toBe("at +5.0 s");
    expect(inside(readme).some((el) => hasClass(el, "files-letter"))).toBe(false);
    // A file touched by then keeps its letter.
    const edited = only(
      tree.filter((el) => hasClass(el, "files-row") && el.props["data-path"] === "/ws/src/a.ts"),
      "a.ts row",
    );
    expect(hasClass(edited, "files-row--later")).toBe(false);
    expect(inside(edited).some((el) => hasClass(el, "files-letter"))).toBe(true);
    // The detail of a call after the cursor is dimmed as well, one before it is not.
    const late = run(props({ startAt: EVENTS[3] }), [pressRow("/ws/README.md")]);
    expect(hasClass(only(byClass(late, "files-detail"), "detail"), "files-detail--after")).toBe(true);
    const early = run(props({ startAt: EVENTS[3] }), [pressRow("/ws/src/a.ts")]);
    expect(hasClass(only(byClass(early, "files-detail"), "detail"), "files-detail--after")).toBe(false);
    // The twin: a cursor that follows the end dims nothing.
    const following = run(props());
    expect(marks(following).filter((m) => m.classes.includes("files-tl__mark--after"))).toEqual([]);
    expect(byClass(following, "files-row--later")).toEqual([]);
    expect(readout(following)).toBe("+8.0 s (end of run)");
  });

  it("promptsAreNumberedOnTheAxis", () => {
    const events = stamp([
      ...PLAIN.slice(0, 3),
      { type: "user_message", text: "now the new file\nand more" },
      ...PLAIN.slice(3),
    ]);
    const tree = run(props({ events }));
    const prompts = byClass(tree, "files-tl__prompt");
    expect(prompts.map((el) => textOf(el.props.children))).toEqual(["1", "2"]);
    expect(prompts.map((el) => el.props.title)).toEqual(["prompt 1: go", "prompt 2: now the new file"]);
    const left = prompts.map((el) => parseFloat(String((el.props.style as { left: string }).left)));
    expect(left[0]).toBe(0);
    // The second prompt stands at its second, 3 of 9.
    expect(left[1]).toBeCloseTo((3 / 9) * 100, 5);
  });

  it("anUntimedLedgerCountsCalls", () => {
    const events = PLAIN.map((e) => ({ ...e }) as unknown as RunEvent);
    expect(foldFiles(events).timed).toBe(false);
    // Placed on the second call, so later rows and a placed readout show as well.
    const tree = run(props({ events, startAt: events[3] }));
    const unit = dict["filesTab.timeline.axisCalls"]?.en;
    expect(unit).toBeTruthy();
    expect(textOf(only(byClass(tree, "files-tl__unit"), "axis unit").props.children)).toBe(unit);
    expect(byClass(tree, "files-tl__step").map((el) => textOf(el.props.children))).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(readout(tree)).toBe("call 2");
    const readme = only(
      tree.filter((el) => hasClass(el, "files-row") && el.props["data-path"] === "/ws/README.md"),
      "README row",
    );
    expect(textOf(inside(readme).find((el) => hasClass(el, "files-row__when"))?.props.children)).toBe(
      "at call 3",
    );
    // No seconds anywhere in the tab.
    const all = tree.map((el) => (typeof el.props.children === "string" ? el.props.children : "")).join("\n");
    expect(all).not.toMatch(/\d s\b/);
    expect(tree.map((el) => String(el.props.title ?? "")).join("\n")).not.toMatch(/\d s\b/);
    // The twin: a ledger with a clock labels its axis in seconds and says nothing about calls.
    const timed = run(props());
    expect(byClass(timed, "files-tl__unit")).toEqual([]);
    expect(byClass(timed, "files-tl__step").map((el) => textOf(el.props.children))[0]).toBe("0 s");
  });

  it("arrowKeysStepTheSelection", () => {
    const prevented: string[] = [];
    // Pick the edit, then step to the created write.
    const next = run(props(), [pressRow("/ws/src/a.ts"), key("ArrowRight", "DIV", prevented)]);
    expect(added(next)).toEqual(["+export const n = 1;"]);
    expect(selectedRow(next)).toEqual(["/ws/src/new.ts"]);
    expect(readout(next)).toBe("+3.0 s");
    expect(prevented).toEqual(["ArrowRight"]);
    // And back.
    const back = run(props(), [pressRow("/ws/src/a.ts"), key("ArrowRight"), key("ArrowLeft")]);
    expect(added(back)).toEqual(["+const a = 2;"]);
    expect(selectedRow(back)).toEqual(["/ws/src/a.ts"]);
    expect(readout(back)).toBe("+1.0 s");
    // Not while the focus is in a field.
    const typing: string[] = [];
    const held = run(props(), [pressRow("/ws/src/a.ts"), key("ArrowRight", "SELECT", typing)]);
    expect(added(held)).toEqual(["+const a = 2;"]);
    expect(typing).toEqual([]);
    // The tab root takes the focus, so the keys reach it.
    expect(only(byClass(next, "files-tab"), "tab root").props.tabIndex).toBe(0);
  });

  it("aMarkPressSelectsItsCallAndFile", () => {
    const tree = run(props(), [
      (t) =>
        only(
          byClass(t, "files-tl__mark").filter((el) => el.props["data-call"] === 3),
          "mark of call 3",
        ).props.onClick?.(),
    ]);
    expect(added(tree)).toEqual(["+export const n = 1;"]);
    expect(selectedRow(tree)).toEqual(["/ws/src/new.ts"]);
    expect(readout(tree)).toBe("+3.0 s");
  });

  it("draggingPlacesTheCursorAndEndFollowsAgain", () => {
    type PointerHandler = (e: unknown) => void;
    const plot = (t: El[]) => only(byClass(t, "files-tl__plot"), "plot");
    const pointer = (fraction: number) => ({
      clientX: 100 + fraction * 400,
      pointerId: 1,
      target: { closest: () => null },
      currentTarget: {
        getBoundingClientRect: () => ({ left: 100, width: 400 }),
        setPointerCapture: () => {},
        hasPointerCapture: () => true,
      },
    });
    // Half way along 8 seconds is 4 s; the cursor takes the last call at or before it, at 3 s.
    const dragged = run(props(), [(t) => (plot(t).props.onPointerDown as PointerHandler)(pointer(0.5))]);
    expect(readout(dragged)).toBe("+3.0 s");
    expect(
      marks(dragged)
        .filter((m) => m.classes.includes("files-tl__mark--after"))
        .map((m) => m.call),
    ).toEqual([5, 7, 7, 7]);
    const moved = run(props(), [
      (t) => (plot(t).props.onPointerDown as PointerHandler)(pointer(0.5)),
      (t) => (plot(t).props.onPointerMove as PointerHandler)(pointer(0.7)),
    ]);
    expect(readout(moved)).toBe("+5.0 s");
    // "end" makes it follow the run again.
    const ended = run(props(), [
      (t) => (plot(t).props.onPointerDown as PointerHandler)(pointer(0.5)),
      press("cursor-end"),
    ]);
    expect(readout(ended)).toBe("+8.0 s (end of run)");
    expect(action(ended, "cursor-end").props["aria-pressed"]).toBe(true);
    expect(action(dragged, "cursor-end").props["aria-pressed"]).toBe(false);
  });

  it("playStartsAtTheFirstCall", () => {
    const tree = run(props(), [press("play")]);
    expect(readout(tree)).toBe("+1.0 s");
    expect(selectedRow(tree)).toEqual(["/ws/src/a.ts"]);
    expect(textOf(action(tree, "play").props.children)).toBe("pause");
    const paused = run(props(), [press("play"), press("play")]);
    expect(textOf(action(paused, "play").props.children)).toBe("play");
    expect(readout(paused)).toBe("+1.0 s");
  });
});
