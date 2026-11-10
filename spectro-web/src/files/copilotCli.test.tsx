// Card 605, task 9: a GitHub Copilot CLI session reaches the files tab. The
// session is the CLI's dotted format, read by the same importer as a VS Code
// export (import/vscodeAgent.ts), and the fold reads its calls through
// describeTool. Before the card, `view`, `create`, `edit` and `bash` were
// unknown names and the tab showed nothing but the glob.

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import copilotCli from "../import/fixtures/copilot-cli.jsonl?raw";
import { parseVscodeAgentExport } from "../import/vscodeAgent";
import { drive, type El } from "../testkit/driveComponent";
import { FilesExplorer } from "./FilesExplorer";
import { fileRows, foldFiles, summarize } from "./fold";

const events = parseVscodeAgentExport(copilotCli);
const ledger = foldFiles(events);
const rows = fileRows(ledger, null);
const row = (path: string) => {
  const found = rows.find((r) => r.path === path);
  if (found === undefined) throw new Error(`no row for ${path}`);
  return found;
};

describe("a Copilot CLI session in the files tab (card 605)", () => {
  it("reads view as a recorded read, with the page it asked for", () => {
    const test = row("/w/src/parser/test/ParserTest.cpp");
    expect([test.letter, test.group, test.sources]).toEqual(["R", "read", ["recorded"]]);
    expect(test.touches[0].reason).toMatch(/^read lines 320\D500$/);
    expect(test.touches[0].folder).toBe(false);
  });

  it("draws the file a successful create wrote as created", () => {
    // Final wave item 6e: the importer marks a successful create's result as
    // created (17 of 17 local creates answer "Created file"), so the row is A.
    const created = row("/w/src/parser/test/EmptyLineTest.cpp");
    expect([created.letter, created.group, created.sources]).toEqual(["A", "changed", ["recorded"]]);
    expect(created.touches[0].kind).toBe("create");
    expect(created.touches[0].content).toBe("// empty line cases\n");
  });

  it("draws the file view read and edit changed as one changed row", () => {
    const edited = row("/w/src/parser/Parser.cpp");
    expect([edited.letter, edited.group, edited.sources]).toEqual(["M", "changed", ["recorded"]]);
    expect(edited.touches.map((t) => t.kind)).toEqual(["read", "change"]);
    expect(edited.touches[1].replaced).toEqual([
      { old: "if (line.size() == 0) return;", new: "if (line.empty()) return {};" },
    ]);
  });

  it("reads bash through the shell heuristic, as probable touches", () => {
    const shell = ledger.calls.filter((c) => c.shell);
    expect(shell.map((c) => c.tool)).toEqual(["bash"]);
    expect(row("/w/build/test.log").sources).toEqual(["probable"]);
    expect(row("/w/out/head.txt").sources).toEqual(["probable"]);
    expect(row("/w/out/head.txt").group).toBe("changed");
    expect(summarize(ledger, rows, null).shellCalls).toBe(1);
  });

  it("keeps the glob as its pattern, and leaves the shell session verb and the failed view out", () => {
    const glob = row("/w/src/parser/**/*Mock*");
    expect(glob.touches[0].folder).toBe(true);
    expect(ledger.calls.map((c) => c.tool)).not.toContain("write_bash");
    expect(rows.map((r) => r.path)).not.toContain("/w/src/parser/Missing.h");
    // The positive twin: the failed view is a call of the ledger, only without a touch.
    const failed = ledger.calls.find((c) => c.line === "/w/src/parser/Missing.h");
    expect(failed?.status).toBe("failed");
  });

  it("lists every row the session gave, and nothing else", () => {
    expect(rows.map((r) => r.path)).toEqual([
      "/w/src/parser/test/ParserTest.cpp",
      "/w/src/parser/Parser.cpp",
      "/w/src/parser/**/*Mock*",
      "/w/build/test.log",
      "/w/out/head.txt",
      "/w/src/parser/test/EmptyLineTest.cpp",
    ]);
  });

  it("takes the workspace from session.start, so the explorer labels are relative to it", () => {
    expect(ledger.workspace).toBe("/w");
    expect(rows.map((r) => r.label)).toEqual([
      "src/parser/test/ParserTest.cpp",
      "src/parser/Parser.cpp",
      "src/parser/**/*Mock*",
      "build/test.log",
      "out/head.txt",
      "src/parser/test/EmptyLineTest.cpp",
    ]);
  });

  it("draws the explorer as folders, files and one pattern row", () => {
    const tree = drive(
      <FilesExplorer
        lang="en"
        rows={rows}
        selected={null}
        limit={Number.MAX_SAFE_INTEGER}
        firstSeen={() => ""}
        onSelect={() => {}}
      />,
      [FilesExplorer],
      [],
    );
    expect(groupLines(tree, "changed")).toEqual([
      "0 out/",
      "1 head.txt",
      "0 src/parser/",
      "1 Parser.cpp",
      "1 test/",
      "2 EmptyLineTest.cpp",
    ]);
    expect(groupLines(tree, "read")).toEqual([
      "0 build/",
      "1 test.log",
      "0 src/parser/",
      "1 **/*Mock* [pattern]",
      "1 test/",
      "2 ParserTest.cpp",
    ]);
  });
});

/** The lines of one explorer group as "<depth> <name>", a pattern row marked. */
function groupLines(tree: El[], group: "changed" | "read"): string[] {
  const box = tree.find((el) => el.props["data-group"] === group);
  if (box === undefined) throw new Error(`no group ${group}`);
  return below(box)
    .filter((el) => hasClass(el, "files-row"))
    .map((line) => {
      const parts = below(line);
      const name = textOf(parts.find((el) => hasClass(el, "files-row__name"))?.props.children);
      const pattern = parts.some((el) => hasClass(el, "files-row__pattern")) ? " [pattern]" : "";
      const depth = String((line.props.style as Record<string, unknown>)["--files-depth"]);
      return `${depth} ${name}${pattern}`;
    });
}

function below(el: El): El[] {
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
