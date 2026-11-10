// Card 605, task 9: a glob's pattern is one row of the explorer, under the
// literal folder before its first glob segment, and never a chain of folders.
// The owner saw `**/` drawn as a folder and `RTK.md/` as its child. The suite
// has no DOM: the explorer renders on the server renderer through the drive kit.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { Lang } from "../i18n/i18n";
import { drive, type El } from "../testkit/driveComponent";
import { FilesExplorer } from "./FilesExplorer";
import { fileRows, foldFiles } from "./fold";

const T0 = 1_760_000_000_000;

const stamp = (events: object[]): RunEvent[] =>
  events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);

let n = 0;
const used = (name: string, input: unknown): object[] => {
  const callId = `c${++n}`;
  return [
    { type: "tool_call", agentId: "main", callId, name, input },
    { type: "tool_result", agentId: "main", callId, output: "", isError: false, durationMs: 1 },
  ];
};

const EVENTS = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/w" },
  ...used("glob", { pattern: "**/*Mock*", path: "/w/src/EdgeTwin" }),
  ...used("glob", { pattern: "**/RTK.md", path: "/w" }),
  ...used("list_dir", { path: "/w/docs" }),
  ...used("view", { path: "/w/app/[id]/page.tsx" }),
  ...used("list_dir", { path: "/w/app/[id]" }),
  ...used("Bash", { command: "cat lib/*.d.ts" }),
]);

function explorer(lang: Lang = "en"): El[] {
  const rows = fileRows(foldFiles(EVENTS), null);
  return drive(
    <FilesExplorer
      lang={lang}
      rows={rows}
      selected={null}
      limit={Number.MAX_SAFE_INTEGER}
      firstSeen={() => ""}
      onSelect={() => {}}
    />,
    [FilesExplorer],
    [],
  );
}

function inside(el: El): El[] {
  const out: El[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child as ReactNode);
      return;
    }
    if (!isValidElement(node)) return;
    out.push(node as El);
    walk((node as El).props.children);
  };
  walk(el.props.children);
  return out;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((c) => textOf(c as ReactNode)).join("");
  if (isValidElement(node)) return textOf((node as El).props.children);
  return "";
}

const hasClass = (el: El, name: string): boolean =>
  typeof el.props.className === "string" && el.props.className.split(/\s+/).includes(name);

/** The lines of the read group in their drawn order: folders and rows. */
function readLines(tree: El[]): El[] {
  const box = tree.find((el) => el.props["data-group"] === "read");
  if (box === undefined) throw new Error("no read group");
  return inside(box).filter((el) => hasClass(el, "files-row"));
}

const nameOf = (line: El): string =>
  textOf(inside(line).find((el) => hasClass(el, "files-row__name"))?.props.children);
const noteOf = (line: El): El | undefined => inside(line).find((el) => hasClass(el, "files-row__pattern"));
const depthOf = (line: El): unknown => (line.props.style as Record<string, unknown>)["--files-depth"];

function lineOf(lines: El[], path: string): El {
  const line = lines.find((el) => el.props["data-path"] === path);
  if (line === undefined) throw new Error(`no row for ${path}`);
  return line;
}

describe("pattern rows in the explorer (card 605)", () => {
  it("draws a pattern at the top as one row labelled from its first glob segment", () => {
    const lines = readLines(explorer());
    const rtk = lineOf(lines, "/w/**/RTK.md");
    expect(nameOf(rtk)).toBe("**/RTK.md");
    expect(depthOf(rtk)).toBe(0);
    expect(textOf(noteOf(rtk)?.props.children)).toBe("pattern");
  });

  it("places a pattern under the literal folder before its first glob segment", () => {
    const lines = readLines(explorer());
    const mock = lineOf(lines, "/w/src/EdgeTwin/**/*Mock*");
    expect(nameOf(mock)).toBe("**/*Mock*");
    expect(depthOf(mock)).toBe(1);
    expect(noteOf(mock)).toBeDefined();
    const before = lines[lines.indexOf(mock) - 1];
    expect(hasClass(before, "files-row--dir")).toBe(true);
    expect(nameOf(before)).toBe("src/EdgeTwin/");
  });

  it("draws no glob segment as a folder and gives no pattern a trailing slash", () => {
    const lines = readLines(explorer());
    const names = lines.map(nameOf);
    // The lines the owner saw: a glob segment as a folder, the leaf with a slash.
    for (const drawn of ["**/", "src/EdgeTwin/**/", "RTK.md/", "*Mock*/"]) expect(names).not.toContain(drawn);
    // The positive twin: the two pattern rows are there to be checked.
    expect(names).toEqual(expect.arrayContaining(["**/RTK.md", "**/*Mock*"]));
  });

  it("keeps the trailing slash of a real folder and gives it no pattern note", () => {
    const docs = lineOf(readLines(explorer()), "/w/docs");
    expect(nameOf(docs)).toBe("docs/");
    expect(noteOf(docs)).toBeUndefined();
  });

  it("keeps a file whose folder name holds a bracket a file in its tree", () => {
    const lines = readLines(explorer());
    const page = lineOf(lines, "/w/app/[id]/page.tsx");
    expect(nameOf(page)).toBe("page.tsx");
    expect(noteOf(page)).toBeUndefined();
    expect(lines[lines.indexOf(page) - 1].props["data-path"]).toBe("/w/app/[id]");
  });

  it("draws a listed folder named with a bracket as a folder, with its slash and no note", () => {
    const folder = lineOf(readLines(explorer()), "/w/app/[id]");
    expect(nameOf(folder)).toBe("app/[id]/");
    expect(noteOf(folder)).toBeUndefined();
  });

  it("draws a shell glob word as a pattern row under its literal folder", () => {
    const lines = readLines(explorer());
    const types = lineOf(lines, "/w/lib/*.d.ts");
    expect(nameOf(types)).toBe("*.d.ts");
    expect(noteOf(types)).toBeDefined();
    expect(nameOf(lines[lines.indexOf(types) - 1])).toBe("lib/");
  });

  it("says pattern in German as Muster", () => {
    const rtk = lineOf(readLines(explorer("de")), "/w/**/RTK.md");
    expect(textOf(noteOf(rtk)?.props.children)).toBe("Muster");
  });
});
