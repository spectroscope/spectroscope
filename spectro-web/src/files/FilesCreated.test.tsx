// Card 604: the created view of the files tab. One card per file the run
// created (letter A), with the content the creating call wrote when the session
// has it, and a link into the diff view. The suite has no DOM: the tab renders
// on the server renderer and the drive kit presses its buttons
// (testkit/driveComponent.tsx), so nothing a case needs may wait for an effect.

import { isValidElement, type ReactNode } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { FilesCreated } from "./FilesCreated";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import { FilesOperations, FilesOpList } from "./FilesOperations";
import { FilesTimeline } from "./FilesTimeline";
import { FilesView, type FilesViewProps } from "./FilesView";
import { fileRows, foldFiles } from "./fold";

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

/**
 * A recorded create with content, a probable create without it, a write whose
 * result does not say whether the file existed, and a later edit of the first
 * file.
 */
const EVENTS = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "write_file", { path: "src/new.ts", content: "export const n = 1;\nexport const m = 2;\n" }),
  result("c1", { fileChange: "created" }),
  call("c2", "run_command", { command: "touch notes.txt" }),
  result("c2"),
  call("c3", "write_file", { path: "legacy.ts", content: "old\n" }),
  result("c3"),
  call("c4", "edit_file", { path: "src/new.ts", old_string: "m = 2", new_string: "m = 3" }),
  result("c4", { fileChange: "changed" }),
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

const cards = (tree: El[]): El[] => tree.filter((el) => hasClass(el, "files-card"));
const cardOf = (tree: El[], path: string): El =>
  only(
    cards(tree).filter((el) => el.props["data-path"] === path),
    `card ${path}`,
  );

/** The added lines drawn below `el`. */
const addedBelow = (el: El): string[] =>
  inside(el)
    .filter((tr) => tr.type === "tr" && hasClass(tr, "files-diff__add"))
    .map((tr) => textOf(tr.props.children));

const showInDiff =
  (path: string): Step =>
  (tree) =>
    only(
      inside(cardOf(tree, path)).filter(
        (el) => el.type === "button" && el.props["data-action"] === "show-in-diff",
      ),
      `show-in-diff of ${path}`,
    ).props.onClick?.();

beforeAll(() => setLang("en"));

describe("the created view", () => {
  it("createdShowsOneCardPerCreatedFile", () => {
    const noContent = dict["filesTab.created.noContent"]?.en;
    expect(noContent).toBeTruthy();
    // The fixture really has a write without a known existence: the explorer lists it as changed.
    const rows = fileRows(foldFiles(EVENTS), null);
    expect(rows.find((row) => row.path === "/ws/legacy.ts")?.letter).toBe("M");
    expect(rows.find((row) => row.path === "/ws/legacy.ts")?.touches[0].kind).toBe("write");

    const tree = run(props(), [press("view-created")]);
    expect(cards(tree).map((el) => el.props["data-path"])).toEqual(["/ws/src/new.ts", "/ws/notes.txt"]);
    // The recorded create shows what it wrote, as added lines, and when the file changed later.
    const known = cardOf(tree, "/ws/src/new.ts");
    expect(addedBelow(known)).toEqual(["+export const n = 1;", "+export const m = 2;"]);
    expect(textOf(known.props.children)).toContain("2 lines");
    expect(textOf(known.props.children)).toContain("1 later change");
    expect(textOf(known.props.children)).toContain("write_file");
    expect(inside(known).some((el) => hasClass(el, "files-src--recorded"))).toBe(true);
    expect(textOf(known.props.children)).not.toContain(noContent);
    // The probable create has no content in the session, and says so.
    const touched = cardOf(tree, "/ws/notes.txt");
    expect(addedBelow(touched)).toEqual([]);
    expect(inside(touched).some((el) => textOf(el.props.children) === noContent)).toBe(true);
    expect(inside(touched).some((el) => hasClass(el, "files-src--probable"))).toBe(true);
    expect(inside(touched).some((el) => hasClass(el, "files-src--recorded"))).toBe(false);
    // The write that does not say the file was new is not a creation.
    expect(cards(tree).some((el) => el.props["data-path"] === "/ws/legacy.ts")).toBe(false);
  });

  it("createdLinksIntoTheDiff", () => {
    // The cursor stands on the run's start, before every call, so every card is dimmed.
    const before = run(props({ startAt: EVENTS[0] }), [press("view-created")]);
    expect(hasClass(cardOf(before, "/ws/src/new.ts"), "files-card--after")).toBe(true);
    const tree = run(props({ startAt: EVENTS[0] }), [press("view-created"), showInDiff("/ws/src/new.ts")]);
    const tab = only(
      tree.filter((el) => hasClass(el, "files-tab")),
      "files tab",
    );
    expect(tab.props["data-view"]).toBe("diff");
    expect(
      only(
        tree.filter((el) => el.type === "button" && el.props["data-action"] === "view-diff"),
        "view-diff",
      ).props["aria-pressed"],
    ).toBe(true);
    // The file is selected in the explorer, and the detail shows the creating call.
    const row = only(
      tree.filter(
        (el) =>
          el.type === "button" && hasClass(el, "files-row") && el.props["data-path"] === "/ws/src/new.ts",
      ),
      "explorer row",
    );
    expect(row.props["aria-pressed"]).toBe(true);
    const detail = only(
      tree.filter((el) => hasClass(el, "files-detail")),
      "detail",
    );
    expect(addedBelow(detail)).toEqual(["+export const n = 1;", "+export const m = 2;"]);
    // The cursor moved onto the creating call, so the detail is not dimmed.
    expect(hasClass(detail, "files-detail--after")).toBe(false);
    expect(cards(tree)).toEqual([]);
  });
});
