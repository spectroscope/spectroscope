// Card 605: the leak session of the files report, shared by the leak guard of
// the report's outputs (reportLeak.test.ts) and of the tab's report sheet
// (FilesReportSheet.test.tsx). The session holds credentials in tool results,
// tool inputs, prompts, a steering message, the title, a file path, commands,
// private key blocks and a model name. Since the final fix wave it also holds
// one value in each credential position of a network command (item 1b) and
// one password with each terminator a rule stops at (item 1a).
//
// Test support only: no module outside a test imports it, which
// FilesReportSheet.test.tsx pins, so it never reaches the shipped bundle.
// Every vector is joined at run time, so no credential-shaped literal sits in
// this file.

import type { RunEvent } from "../events";
import { foldFiles } from "./fold";
import { buildReport, type FilesReport } from "./report";

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

/** One value per credential position of item 1b, each with the command that holds it. */
const POSITIONS: readonly [string, string, (v: string) => string][] = [
  ["url user and password", ["Ur1", "Pw7kQx"].join(""), (v) => `curl https://bob:${v}@api.example.com/x`],
  ["url user only", ["Ut4", "Kw9pZr2m"].join(""), (v) => `git push https://${v}@github.com/o/r.git main`],
  ["query value", ["Qv3", "Lm8nTs"].join(""), (v) => `curl "https://api.example.com/x?key=${v}&page=20"`],
  ["-u", ["Uo5", "Rt2wXc"].join(""), (v) => `curl -u bob:${v} https://a.example.com`],
  ["--user", ["Us6", "Np3vBd"].join(""), (v) => `curl --user=bob:${v} https://a.example.com`],
  ["--proxy-user", ["Px8", "Hq4mJf"].join(""), (v) => `curl --proxy-user px:${v} https://a.example.com`],
  ["sshpass -p", ["Sp2", "Gz7cWk"].join(""), (v) => `sshpass -p ${v} scp out.tar deploy@10.0.0.5:/srv/`],
  [
    "--password with a space",
    ["Op9", "Dk5rYs"].join(""),
    (v) => `curl --password ${v} https://a.example.com`,
  ],
  ["--password=", ["Oe4", "Mj8tLq"].join(""), (v) => `wget --password=${v} https://a.example.com/f`],
  [
    "Authorization",
    ["Az7", "Fb3nWp"].join(""),
    (v) => `curl -H "Authorization: Basic ${v}" https://a.example.com`,
  ],
  [
    "Proxy-Authorization",
    ["Pa5", "Ck9xVr"].join(""),
    (v) => `curl -H "Proxy-Authorization: Bearer ${v}" https://a.example.com`,
  ],
  ["Cookie", ["Ck2", "Wd6sTn"].join(""), (v) => `curl -H "Cookie: sid=${v}" https://a.example.com`],
  ["a key header", ["Hk8", "Ry4bMz"].join(""), (v) => `curl -H "X-Api-Key: ${v}" https://a.example.com`],
];

/** One password per terminator of item 1a: the two halves around the mark, and the command. */
const TERMINATED: readonly [string, string, string, (v: string) => string][] = [
  [
    "comma",
    ["Ta1", "Qw5zXc"].join(""),
    ["Tb2", "Er6yUv"].join(""),
    (v) => `curl -d 'password=${v}' https://a.example.com`,
  ],
  [
    "quote",
    ["Tc3", "Ty7iOp"].join(""),
    ["Td4", "As8dFg"].join(""),
    (v) => `curl -d "password=${v}" https://a.example.com`,
  ],
  [
    "semicolon",
    ["Te5", "Hj9kLz"].join(""),
    ["Tf6", "Xc1vBn"].join(""),
    (v) => `curl -d 'secret=${v}' https://a.example.com`,
  ],
  [
    "@",
    ["Tg7", "Mq2wEr"].join(""),
    ["Th8", "Ty3uIo"].join(""),
    (v) => `psql postgres://app:${v}@db.internal/x -c 'select 1'`,
  ],
  [
    "/",
    ["Ti9", "Pa4sDf"].join(""),
    ["Tj1", "Gh5jKl"].join(""),
    (v) => `curl -d 'password=${v}' https://a.example.com`,
  ],
];
const MARKS: Record<string, string> = { comma: ",", quote: "'", semicolon: ";", "@": "@", "/": "/" };
const terminated = (name: string, a: string, b: string) => `${a}${MARKS[name]}${b}`;

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

/** Every raw secret of the session. A failing guard names an index into this list, never a value. */
export const LEAK_RAW: readonly string[] = [
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
  ...POSITIONS.map(([, v]) => v),
  ...TERMINATED.flatMap(([name, a, b]) => [a, b, terminated(name, a, b)]),
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

/** The session's events and, for each value of POSITIONS and TERMINATED, the event index of the call that holds it. */
function leakSession(): { events: RunEvent[]; calls: { name: string; call: number }[] } {
  const rec = new Rec();
  const calls: { name: string; call: number }[] = [];
  rec
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
    .tool("Bash", { command: "printenv" }, `GITHUB_TOKEN=${PAT}\nHOME=/Users/a\n`);
  for (const [name, value, command] of POSITIONS) {
    calls.push({ name, call: rec.events.length });
    rec.tool("Bash", { command: command(value) });
  }
  for (const [name, a, b, command] of TERMINATED) {
    calls.push({ name: `terminator ${name}`, call: rec.events.length });
    rec.tool("Bash", { command: command(terminated(name, a, b)) });
  }
  rec
    .exchange()
    // A model name and an address that carry credentials: the report keeps
    // destinations as recorded, so the renderers mask them.
    .exchange(`m-${JWT}`, `https://u:${EXCHANGE_PW}@api.example.com/v1`);
  return { events: rec.events, calls };
}

/** The session's events, written fresh on every call. */
export function leakEvents(): RunEvent[] {
  return leakSession().events;
}

/** The call of each position and terminator value, by name: a guard names the case, never the value. */
export const LEAK_CALLS: readonly { name: string; call: number }[] = leakSession().calls;

/** The report of the session, with a title that carries a key and version 0.16.1. */
export function leakReport(): FilesReport {
  const events = leakEvents();
  return buildReport({
    events,
    ledger: foldFiles(events),
    sessionId: "s-1",
    title: `deploy with ${GOOGLE}`,
    version: "0.16.1",
    now: Date.UTC(2026, 10, 10, 9, 12),
  });
}
