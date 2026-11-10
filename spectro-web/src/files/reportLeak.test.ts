// Card 605: the leak guard over every output of the files report (design,
// "Things that must not happen"). One session holds credentials in tool
// results, tool inputs, prompts, a steering message, the title, a file path,
// commands, private key blocks and a model name; none of them, and no rule
// hit, may reach the HTML (both languages) or the CSV. The session lives in
// reportLeakFixture.ts, shared with the guard over the tab's report sheet.

import { describe, expect, it } from "vitest";
import { reportCsv } from "./reportCsv";
import { reportFilename, reportHtml } from "./reportHtml";
import { LEAK_RAW, leakReport } from "./reportLeakFixture";
import { findCredentials } from "./secrets";

const CREDENTIAL_KINDS = new Set([
  "credential-result",
  "credential-input",
  "credential-prompt",
  "credential-used",
]);

describe("the files report leaks no credential", () => {
  const report = leakReport();
  const outputs: [string, string][] = [
    ["html en", reportHtml(report, "en")],
    ["html de", reportHtml(report, "de")],
    ["csv en", reportCsv(report, "en")],
    ["csv de", reportCsv(report, "de")],
    ["file name", reportFilename("html", report.title, report.exportedAt)],
  ];

  it("the fixture is full of credentials", () => {
    const found = report.findings.filter((f) => CREDENTIAL_KINDS.has(f.kind));
    expect(found.length).toBeGreaterThanOrEqual(6);
    for (const kind of CREDENTIAL_KINDS) {
      expect(
        found.some((f) => f.kind === kind),
        kind,
      ).toBe(true);
    }
    const labels = new Set(found.flatMap((f) => f.credentials.map((c) => c.label)));
    expect(labels.size).toBeGreaterThanOrEqual(10);
    // The outputs name the credentials by label. Booleans only: a failing
    // assertion on the text itself would print the output into the log.
    expect(outputs[0][1].includes("[credential 1: github-pat]"), "html").toBe(true);
    expect(outputs[2][1].includes("credential 1 github-pat"), "csv").toBe(true);
  });

  it("no rule matches anywhere in the HTML or the CSV", () => {
    for (const [name, text] of outputs) {
      expect(
        findCredentials(text).hits.map((h) => h.rule),
        name,
      ).toEqual([]);
    }
  });

  it("no raw secret is part of any output", () => {
    // A failure names the index into LEAK_RAW, never the value, so no log holds one.
    const leaked = (text: string, fold: (s: string) => string) =>
      LEAK_RAW.flatMap((v, i) => (fold(text).includes(fold(v)) ? [i] : []));
    for (const [name, text] of outputs) {
      expect(
        leaked(text, (s) => s),
        name,
      ).toEqual([]);
      expect(
        leaked(text, (s) => s.toLowerCase()),
        name,
      ).toEqual([]);
    }
  });
});
