// Card 605: the leak guard over every output of the files report (design,
// "Things that must not happen"). One session holds credentials in tool
// results, tool inputs, prompts, a steering message, the title, a file path,
// commands, private key blocks and a model name; none of them, and no rule
// hit, may reach the HTML (both languages) or the CSV. Every vector is joined
// at run time, so no credential-shaped literal sits in this file.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { foldFiles } from "./fold";
import { buildReport, type FilesReport } from "./report";
import { reportCsv } from "./reportCsv";
import { reportFilename, reportHtml } from "./reportHtml";
import { findCredentials } from "./secrets";

const T0 = 1_760_000_000_000;
const W = "/w";

const AKID = ["AK", "IA", "Z7Q3M2X9", "K4W8P1N6"].join("");
const AKID_IN_PATH = ["AS", "IA", "Q8R2T5V7", "W1X4Y6Z3"].join("");
const DB_PW = ["Hx7p", "Lq2vZw"].join("");
const PAT = ["gh", "p_", "Zq4Lm8Rt2Vx6Bn0Ck3Hs7Jd1Wf5Gy9Pa2Ue6"].join("");
const ANT = ["sk", "-ant-", "api03-", "Tg5Kp9Wd2Lr7Qz4N"].join("");
const OPENAI = ["sk-", "proj-", "Ab3dEf6hIj9kLm2nOp5qRs8t"].join("");
const SLACK = ["xo", "xb-", "1234567890-", "AbCdEfGhIj"].join("");
const GOOGLE = ["AI", "za", "Sy", "B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R"].join("");
const JWT = [
  "ey",
  "JhbGciOiJIUzI1NiJ9",
  ".",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  ".",
  "dozjgNryP4J3jVmNHl0w5N",
].join("");
const URL_PW = ["Pq9", "Wm4zXk"].join("");
const BEARER = ["Rk7", "Tq2Vw9Xz4Lm8Pn3Hs6"].join("");
const EXCHANGE_PW = ["Zt5", "Bn8cQr"].join("");

function keyBlock(kind: string, body: string[]): string {
  const dashes = "-".repeat(5);
  const head = `${dashes}BEGIN ${kind} ${["PRIVATE", "KEY"].join(" ")}${dashes}`;
  const tail = `${dashes}END ${kind} ${["PRIVATE", "KEY"].join(" ")}${dashes}`;
  return [head, ...body, tail].join("\n");
}
const RSA_BODY = ["MIIEowIBAAKCAQEA", "x9Ym4Qz7Rt2Lp8Wk", "Vb3Nc6Hd1Jf5Gs0Q"];
const EC_BODY = ["MHcCAQEEIBq8Zk3", "Lw7Pm2Xr5Tn9Vc4H"];
const RSA_KEY = keyBlock("RSA", RSA_BODY);
const EC_KEY = keyBlock("EC", EC_BODY);

const RAW = [
  AKID,
  AKID_IN_PATH,
  DB_PW,
  PAT,
  ANT,
  OPENAI,
  SLACK,
  GOOGLE,
  JWT,
  URL_PW,
  BEARER,
  EXCHANGE_PW,
  ...RSA_BODY,
  ...EC_BODY,
];

/** A session written event by event, one second apart. */
class Rec {
  readonly events: RunEvent[] = [];
  private ids = 0;

  push(e: object): this {
    this.events.push({ ts: T0 + this.events.length * 1000, ...e } as unknown as RunEvent);
    return this;
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

  exchange(model = "claude-sonnet-4-5", url = "https://api.anthropic.com/v1/messages"): this {
    return this.push({
      type: "llm_exchange",
      xid: "x",
      agentId: "main",
      kind: "chat",
      provider: "anthropic",
      model,
      url,
      requestBytes: 1000,
    });
  }
}

function fixture(): FilesReport {
  const rec = new Rec()
    .push({
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: `use ${PAT} for the push`,
      workspace: W,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    })
    .exchange()
    .push({ type: "user_message", text: `the openai key is ${OPENAI}` })
    .push({ type: "steering_message", agentId: "main", text: `slack: ${SLACK}`, taken: true, turn: 1 })
    .tool("read_file", { path: ".env" }, `AWS_ACCESS_KEY_ID=${AKID}\nDB_PASSWORD=${DB_PW}\n`)
    .tool("read_file", { path: "deploy.txt" }, `postgres://app:${URL_PW}@db.internal/x`)
    .tool("read_file", { path: "keys/id_rsa" }, RSA_KEY)
    .tool("read_file", { path: `backup-${AKID_IN_PATH}.txt` })
    .tool("write_file", { path: "notes.txt", content: `token ${ANT}` }, "ok", "created")
    .tool("db_connect", { host: "db", password: DB_PW })
    .tool("Bash", { command: `mysql -u app -p'${DB_PW}' -e 'select 1'` })
    .tool("Bash", { command: `export GITHUB_TOKEN=${PAT} && git push` })
    .tool("Bash", {
      command: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com/x -d @payload.json`,
    })
    .tool("Bash", { command: `printf '%s\\n' '${EC_KEY}' > k.pem` })
    .tool("Bash", { command: "cat ~/.aws/credentials" }, `aws_access_key_id = ${AKID}\n`)
    .tool("Bash", { command: `echo "${JWT}" | base64 -d` })
    .tool("Bash", { command: "printenv" }, `GITHUB_TOKEN=${PAT}\nHOME=/Users/a\n`)
    .exchange()
    // A model name and an address that carry credentials: the report keeps
    // destinations as recorded, so the renderers mask them.
    .exchange(`m-${JWT}`, `https://u:${EXCHANGE_PW}@api.example.com/v1`);
  const events = rec.events;
  return buildReport({
    events,
    ledger: foldFiles(events),
    sessionId: "s-1",
    title: `deploy with ${GOOGLE}`,
    version: "0.16.1",
    now: Date.UTC(2026, 10, 10, 9, 12),
  });
}

const CREDENTIAL_KINDS = new Set([
  "credential-result",
  "credential-input",
  "credential-prompt",
  "credential-used",
]);

describe("the files report leaks no credential", () => {
  const report = fixture();
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
    // A failure names the index into RAW, never the value, so no log holds one.
    const leaked = (text: string, fold: (s: string) => string) =>
      RAW.flatMap((v, i) => (fold(text).includes(fold(v)) ? [i] : []));
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
