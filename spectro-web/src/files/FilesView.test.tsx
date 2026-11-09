// Card 604: the files tab with its explorer and the detail of one call. The
// suite has no DOM: the tab renders on the server renderer, and the drive kit
// presses its buttons (testkit/driveComponent.tsx). Nothing a case needs may
// happen in an effect, because effects never run here.

import { isValidElement, type ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { FilesView, type FilesViewProps } from "./FilesView";

const T0 = 1_760_000_000_000;

/** One event per second from T0, so a call's `t` is its index. */
function stamp(events: object[]): RunEvent[] {
  return events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
}

const call = (callId: string, name: string, input: unknown) => ({
  type: "tool_call",
  agentId: "main",
  callId,
  name,
  input,
});
const result = (callId: string, extra: object = {}) => ({
  type: "tool_result",
  agentId: "main",
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

const EXPAND = [FilesView, FilesExplorer, FilesDetail];

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
    // Literal keys, read off the three views, and the families built from a value.
    const literal = ["FilesView.tsx", "FilesExplorer.tsx", "FilesDetail.tsx"].flatMap((file) => [
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
    ];
    const missing = [...literal.map((m) => m[1]), ...families].filter((key) => dict[key] === undefined);
    expect(missing).toEqual([]);
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
