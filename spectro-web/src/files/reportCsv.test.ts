// Card 605: the CSV of the files report (design section 5). One row per
// finding, then one row per file; RFC 4180 quoting and a formula guard, so a
// crafted path cannot run as a formula in a spreadsheet.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { clockText } from "./axis";
import { foldFiles } from "./fold";
import { buildReport, type FilesReport } from "./report";
import { CSV_HEADER, csvCell, reportCsv } from "./reportCsv";

const T0 = 1_760_000_000_000;
const W = "/w";
const BOM = "\uFEFF";

/** A session written event by event, one second apart, so `t` is the index. */
class Rec {
  readonly events: RunEvent[] = [];
  private ids = 0;

  push(e: object): this {
    this.events.push({ ts: T0 + this.events.length * 1000, ...e } as unknown as RunEvent);
    return this;
  }

  start(workspace = W, extra: object = {}): this {
    return this.push({ type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace, ...extra });
  }

  tool(name: string, input: unknown, output = "ok", fileChange?: string): this {
    const callId = `c${++this.ids}`;
    this.push({ type: "tool_call", agentId: "main", callId, name, input });
    return this.push({
      type: "tool_result",
      agentId: "main",
      callId,
      output,
      isError: false,
      durationMs: 5,
      ...(fileChange === undefined ? {} : { fileChange }),
    });
  }
}

const build = (events: readonly RunEvent[], title: string | null = "a title"): FilesReport =>
  buildReport({ events, ledger: foldFiles(events), sessionId: "s-1", title, version: "0.16.1", now: 42 });

/** The records of a CSV text: split on CRLF outside quotes. */
function records(csv: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let at = 0;
  for (let i = 0; i < csv.length; i++) {
    if (csv[i] === '"') quoted = !quoted;
    else if (!quoted && csv[i] === "\r" && csv[i + 1] === "\n") {
      out.push(csv.slice(at, i));
      at = i + 2;
      i++;
    }
  }
  expect(at, "the text ends with a record end").toBe(csv.length);
  return out;
}

/** The cells of one record (RFC 4180). */
function cells(record: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < record.length; i++) {
    const c = record[i];
    if (quoted) {
      if (c === '"' && record[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cell);
      cell = "";
    } else cell += c;
  }
  out.push(cell);
  return out;
}

describe("reportCsv", () => {
  const rec = new Rec()
    .start()
    .tool("read_file", { path: ".env" }, "DEBUG=1\n")
    .tool("read_file", { path: 'a,"b"' })
    .tool("read_file", { path: '=HYPERLINK("x")' })
    .tool("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" }, "ok", "changed")
    .tool("Bash", { command: "curl -X POST https://hooks.example.com/a -d @payload.json" });
  const report = build(rec.events);
  const csv = reportCsv(report, "en");

  it("starts with the byte order mark and the exact header", () => {
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1, csv.indexOf("\r\n"))).toBe(
      "level,time_s,clock,event,agent,tool,what,source,file,finding,detail,destination",
    );
    expect(CSV_HEADER.join(",")).toBe(csv.slice(1, csv.indexOf("\r\n")));
  });

  it("quotes commas and quotes as RFC 4180 does", () => {
    expect(csv).toContain(',"a,""b""",');
  });

  it("puts an apostrophe before a formula", () => {
    expect(csv).toContain(`,"'=HYPERLINK(""x"")",`);
    expect(csv).not.toMatch(/,"?=HYPERLINK/);
  });

  it("ends every row with CRLF and has one row per finding plus one per file", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
    const rows = records(csv.slice(1));
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.files.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(1 + report.findings.length + report.files.length);
    for (const row of rows) expect(cells(row)).toHaveLength(12);
  });

  it("writes findings first, then the files, each with its tokens", () => {
    const rows = records(csv.slice(1)).slice(1).map(cells);
    const findings = rows.slice(0, report.findings.length);
    const files = rows.slice(report.findings.length);
    expect(findings.map((r) => r[9])).toEqual(report.findings.map((f) => f.kind));
    expect(files.map((r) => r[9])).toEqual(report.files.map(() => ""));

    const secret = findings.find((r) => r[9] === "secret-file");
    expect(secret).toBeDefined();
    // level, time_s, clock, call, agent, tool, what, source, file
    expect(secret?.slice(0, 9)).toEqual([
      "critical",
      "1.0",
      clockText("en", 1),
      "1",
      "main",
      "read_file",
      "read",
      "recorded",
      ".env",
    ]);

    const network = findings.find((r) => r[9] === "network");
    expect(network?.[7]).toBe("probable");
    expect(network?.[10]).toContain("hooks.example.com");
    // The command sits in one quoted cell of the detail column.
    expect(network?.[10]).toContain("curl -X POST https://hooks.example.com/a -d @payload.json");

    const edited = files.find((r) => r[8] === "src/a.ts");
    expect(edited?.slice(0, 9)).toEqual([
      "project",
      "7.0",
      clockText("en", 7),
      "7",
      "",
      "",
      "changed",
      "recorded",
      "src/a.ts",
    ]);
  });

  it("prints a probable source as probable, never as recorded", () => {
    const rows = records(csv.slice(1)).slice(1).map(cells);
    const payload = rows.find((r) => r[8] === "payload.json" && r[9] === "");
    expect(payload?.[7]).toBe("probable");
  });

  it("names the place a finding's content went", () => {
    const cloud = new Rec()
      .start(W, { provider: "anthropic", model: "claude-sonnet-4-5" })
      .tool("read_file", { path: ".env" }, "DEBUG=1\n")
      .push({
        type: "llm_exchange",
        xid: "x",
        agentId: "main",
        kind: "chat",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        url: "https://api.anthropic.com/v1/messages",
        requestBytes: 100,
      });
    const rows = records(reportCsv(build(cloud.events), "en").slice(1))
      .slice(1)
      .map(cells);
    expect(rows[0][9]).toBe("secret-file");
    expect(rows[0][11]).toBe("claude-sonnet-4-5 (cloud)");
    const de = records(reportCsv(build(cloud.events), "de").slice(1))
      .slice(1)
      .map(cells);
    expect(de[0][11]).toBe("claude-sonnet-4-5 (Cloud)");
    expect(de[0][2]).toBe(clockText("de", 1));
  });

  it("says how much of a command was cut, in the report's language", () => {
    const cut = new Rec().start().tool("Bash", { command: "cat > .env <<'EOF'\nA=1\nEOF" });
    const report = build(cut.events);
    const finding = report.findings.find((f) => f.kind === "secret-file");
    expect(finding?.commandCut).toBeGreaterThan(0);
    const en = records(reportCsv(report, "en").slice(1)).slice(1).map(cells);
    expect(en[0][10]).toContain(`cat > .env (${finding?.commandCut} more characters)`);
    const de = records(reportCsv(report, "de").slice(1)).slice(1).map(cells);
    expect(de[0][10]).toContain(`cat > .env (${finding?.commandCut} weitere Zeichen)`);
  });
});

describe("reportCsv events and dumps", () => {
  const rows = (report: FilesReport, lang: "en" | "de" = "en") =>
    records(reportCsv(report, lang).slice(1)).slice(1).map(cells);

  it("names a prompt finding by the event it was seen at", () => {
    const AKID = ["AK", "IA", "Z7Q3M2X9", "K4W8P1N6"].join("");
    const rec = new Rec()
      .start()
      .push({ type: "user_message", text: `use ${AKID}` })
      .tool("Bash", { command: `aws s3 ls --access-key ${AKID}` });
    const report = build(rec.events);
    const all = rows(report);
    const prompt = all.find((r) => r[9] === "credential-prompt");
    expect(prompt?.[3]).toBe("1");
    const used = all.find((r) => r[9] === "credential-used");
    expect(used?.[3]).toBe("2");
    expect(used?.[10].startsWith("credential 1 aws-akid 17-32 first seen in a message from the person")).toBe(
      true,
    );
  });

  it("says from which event a value came", () => {
    const AKID = ["AK", "IA", "Z7Q3M2X9", "K4W8P1N6"].join("");
    const rec = new Rec()
      .start()
      .tool("read_file", { path: "a.txt" }, `K=${AKID}`)
      .tool("Bash", { command: `aws s3 ls --access-key ${AKID}` });
    const used = rows(build(rec.events)).find((r) => r[9] === "credential-used");
    expect(used?.[10].split("\n")[0]).toBe("credential 1 aws-akid 17-32 from event 1");
    const de = rows(build(rec.events), "de").find((r) => r[9] === "credential-used");
    expect(de?.[10].split("\n")[0]).toBe("credential 1 aws-akid 17-32 aus Ereignis 1");
  });

  it("an env dump without output says so, as the HTML does", () => {
    const rec = new Rec().start();
    rec.push({ type: "tool_call", agentId: "main", callId: "x1", name: "Bash", input: { command: "env" } });
    const dump = rows(build(rec.events)).find((r) => r[9] === "env-dump");
    expect(dump?.[10]).toBe("no output recorded\nenv");
    const de = rows(build(rec.events), "de").find((r) => r[9] === "env-dump");
    expect(de?.[10]).toBe("keine Ausgabe aufgezeichnet\nenv");
    const two = new Rec().start().tool("Bash", { command: "printenv" }, "A=1\nB=2");
    expect(rows(build(two.events)).find((r) => r[9] === "env-dump")?.[10]).toBe("2 lines\nprintenv");
  });
});

describe("csvCell", () => {
  it("leaves a plain cell alone", () => {
    expect(csvCell("src/a.ts")).toBe("src/a.ts");
    expect(csvCell("")).toBe("");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it("guards every formula start", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-rf")).toBe("'-rf");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe('"\'\rx"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
});
