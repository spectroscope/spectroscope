// Card 605: the leak guard over every output of the files report (design,
// "Things that must not happen"). One session holds credentials in tool
// results, tool inputs, prompts, a steering message, the title, a file path,
// commands, private key blocks and a model name; none of them, and no rule
// hit, may reach the HTML (both languages) or the CSV. The session lives in
// reportLeakFixture.ts, shared with the guard over the tab's report sheet.

import { describe, expect, it } from "vitest";
import { reportCsv } from "./reportCsv";
import { reportFilename, reportHtml } from "./reportHtml";
import { LEAK_CALLS, LEAK_NET, LEAK_QUIET, LEAK_RAW, leakReport } from "./reportLeakFixture";
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

  it("every position and terminator value made a credential finding at its call", () => {
    // Positive guard for the index check below: a value that no rule and no
    // position found would also be absent from the outputs, and pass it.
    expect(LEAK_CALLS.length).toBe(27);
    const missing = LEAK_CALLS.filter(
      ({ call }) =>
        !report.findings.some(
          (f) => f.callIndex === call && (f.kind === "credential-input" || f.kind === "credential-used"),
        ),
    ).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it("a value in a position that says nothing of a credential makes no finding, and stays masked", () => {
    // Task 10 item 9. The masking half is the raw-secret check below, which
    // holds these values too; this is the counting half.
    expect(LEAK_QUIET.length).toBe(3);
    const counted = LEAK_QUIET.filter(({ call }) =>
      report.findings.some((f) => f.callIndex === call && f.kind.startsWith("credential-")),
    ).map((c) => c.name);
    expect(counted).toEqual([]);
    // The positive twin: each of those calls is in the report as a network command, masked.
    for (const { name, call } of LEAK_QUIET) {
      const network = report.findings.find((f) => f.callIndex === call && f.kind === "network");
      expect(network?.command?.includes("[value]"), name).toBe(true);
    }
  });

  it("every C1 and C2 input of fix round 2 is counted by a rule or hidden by the net at its call", () => {
    // Positive guard for the raw-secret check below (fix round 2 item 1).
    expect(LEAK_NET.length).toBe(12);
    const missing = LEAK_NET.filter(
      ({ call }) =>
        !report.findings.some(
          (f) =>
            f.callIndex === call &&
            (f.kind.startsWith("credential-") || (f.command ?? "").includes("[hidden]")),
        ),
    ).map((c) => c.name);
    expect(missing).toEqual([]);
    expect(report.title?.includes("[hidden]"), "title").toBe(true);
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
