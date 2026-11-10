// Card 605, task 9: a GitHub Copilot CLI session reaches the files tab. The
// session is the CLI's dotted format, read by the same importer as a VS Code
// export (import/vscodeAgent.ts), and the fold reads its calls through
// describeTool. Before the card, `view`, `create`, `edit` and `bash` were
// unknown names and the tab showed nothing but the glob.

import { describe, expect, it } from "vitest";
import copilotCli from "../import/fixtures/copilot-cli.jsonl?raw";
import { parseVscodeAgentExport } from "../import/vscodeAgent";
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

  it("draws the file create wrote as a recorded write", () => {
    // The dotted format keeps no word for what a write did to the file, so the
    // fold claims no creation: the letter is the one any unreported write gets.
    const created = row("/w/src/parser/test/EmptyLineTest.cpp");
    expect([created.letter, created.group, created.sources]).toEqual(["M", "changed", ["recorded"]]);
    expect(created.touches[0].kind).toBe("write");
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
});
