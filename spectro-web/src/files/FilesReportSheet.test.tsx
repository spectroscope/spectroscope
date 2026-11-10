// Card 605: the report sheet of the files tab. There is no DOM: the sheet
// renders on the server renderer and the drive kit presses its buttons.
// Effects never run here, so the half of the sheet an effect starts (the
// version request and the deferred build) is driven through openReportSheet
// with a schedule the case runs by hand. saveTextFile is a stub and the
// print frame a stand-in object. Every credential vector is joined at run
// time, so no credential-shaped literal sits in this file.

import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { saveTextFile } from "../export/save";
import { dict, t, type Lang } from "../i18n/i18n";
import { drive, type El } from "../testkit/driveComponent";
import {
  fetchReportVersion,
  FilesReportSheet,
  openReportSheet,
  ReportSheetPanel,
  type FilesReportSheetProps,
  type SheetReport,
} from "./FilesReportSheet";
import { foldFiles } from "./fold";
import { buildReport, type FilesReport } from "./report";
import { reportCsv } from "./reportCsv";
import { reportFilename, reportHtml, verdictLine } from "./reportHtml";
import { findCredentials } from "./secrets";

vi.mock("../export/save", () => ({ saveTextFile: vi.fn() }));

const T0 = 1_760_000_000_000;
const NOW = Date.UTC(2026, 10, 10, 9, 12);

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

/** An edit in the project and nothing else. */
const PROJECT = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "edit_file", { path: "src/a.ts", old_string: "1", new_string: "2" }),
  result("c1", { fileChange: "changed" }),
]);

/** The same edit after a read of the project's .env. */
const ENV_READ = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "read_file", { path: ".env" }),
  result("c1"),
  call("c2", "edit_file", { path: "src/a.ts", old_string: "1", new_string: "2" }),
  result("c2", { fileChange: "changed" }),
]);

function reportOf(events: RunEvent[], title: string | null = "Fix the build"): FilesReport {
  return buildReport({ events, ledger: foldFiles(events), sessionId: "s-1", title, version: null, now: NOW });
}

function sheetProps(over: Partial<FilesReportSheetProps> = {}): FilesReportSheetProps {
  return {
    lang: "en",
    events: ENV_READ,
    ledger: foldFiles(ENV_READ),
    sessionId: "s-1",
    title: "Fix the build",
    onClose: () => {},
    loadVersion: () => Promise.resolve(null),
    ...over,
  };
}

const EXPAND = [FilesReportSheet, ReportSheetPanel];

const sheet = (p: FilesReportSheetProps): El[] => drive(<FilesReportSheet {...p} />, EXPAND, []);

const panel = (lang: Lang, report: SheetReport | null, onClose: () => void = () => {}): El[] =>
  drive(<ReportSheetPanel lang={lang} report={report} onClose={onClose} />, [ReportSheetPanel], []);

function textOf(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map((c) => textOf(c as ReactNode)).join("");
  if (isValidElement(n)) return textOf((n as El).props.children);
  return "";
}

const classOf = (el: El): string => (typeof el.props.className === "string" ? el.props.className : "");
const hasClass = (el: El, name: string): boolean => classOf(el).split(/\s+/).includes(name);

function action(tree: El[], name: string): El {
  const el = tree.find((e) => e.type === "button" && e.props["data-action"] === name);
  if (el === undefined) throw new Error(`no button ${name}`);
  return el;
}

function dialogOf(tree: El[]): El {
  const el = tree.find((e) => e.props.role === "dialog");
  if (el === undefined) throw new Error("no dialog");
  return el;
}

const texts = (tree: El[]): string[] => tree.map((el) => textOf(el.props.children));

/** A key press as the dialog's handler receives it. */
function key(name: string, target: unknown, buttons: unknown[], shiftKey = false) {
  return {
    key: name,
    shiftKey,
    target,
    currentTarget: { querySelectorAll: () => buttons },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

const pressKey = (tree: El[], e: ReturnType<typeof key>): void =>
  (dialogOf(tree).props.onKeyDown as (e: unknown) => void)(e);

const saved = vi.mocked(saveTextFile);

beforeEach(() => saved.mockClear());

describe("the report sheet", () => {
  it("isAModalDialogWithThreeButtonsAndTheScopeLineInBothLanguages", () => {
    const scope = {
      en: "Covers the whole session; the filters of this tab do not apply.",
      de: "Umfasst die ganze Session; die Filter dieses Tabs gelten nicht.",
    };
    const note = {
      en: "The print dialog offers Save as PDF.",
      de: "Der Druckdialog bietet Als PDF sichern an.",
    };
    for (const lang of ["en", "de"] as const) {
      const loadVersion = vi.fn(() => Promise.resolve("0.16.1"));
      const tree = sheet(sheetProps({ lang, loadVersion }));
      const dialog = dialogOf(tree);
      expect(dialog.props["aria-modal"]).toBe("true");
      expect(dialog.props["aria-label"]).toBe(t(lang, "filesTab.report.title"));
      expect(
        ["report-pdf", "report-html", "report-csv"].map((a) => textOf(action(tree, a).props.children)),
      ).toEqual(["PDF", "HTML", "CSV"]);
      expect(texts(tree)).toContain(scope[lang]);
      expect(texts(tree)).toContain(note[lang]);
      // The sheet shows first and builds after: the first pass says so, and
      // the buttons wait for the report.
      expect(texts(tree)).toContain(t(lang, "filesTab.report.building"));
      expect(action(tree, "report-html").props.disabled).toBe(true);
      // Nothing is asked while the sheet renders.
      expect(loadVersion).not.toHaveBeenCalled();
    }
  });

  it("theVerdictOfAnEnvReadIsCritical", () => {
    const report = reportOf(ENV_READ);
    for (const lang of ["en", "de"] as const) {
      const tree = panel(lang, report);
      const box = tree.find((el) => hasClass(el, "files-report__verdict"));
      expect(box?.props["data-level"]).toBe("critical");
      const mark = tree.find((el) => hasClass(el, "files-report__level"));
      expect(textOf(mark?.props.children)).toBe(t(lang, "filesTab.report.level.critical"));
      expect(hasClass(mark!, "files-report__level--critical")).toBe(true);
      const line = tree.find((el) => hasClass(el, "files-report__line"));
      expect(textOf(line?.props.children)).toBe(verdictLine(report, lang));
      expect(action(tree, "report-html").props.disabled).toBe(false);
    }
    expect(t("en", "filesTab.report.level.critical")).toBe("critical");
    // The twin: the same edit without the read stays at the project level.
    const quiet = panel("en", reportOf(PROJECT));
    expect(quiet.find((el) => hasClass(el, "files-report__verdict"))?.props["data-level"]).toBe("project");
    expect(textOf(quiet.find((el) => hasClass(el, "files-report__level"))?.props.children)).toBe("project");
  });

  it("htmlAndCsvAreSavedUnderTheReportsNames", () => {
    const report = reportOf(ENV_READ);
    for (const lang of ["en", "de"] as const) {
      saved.mockClear();
      const tree = panel(lang, report);
      action(tree, "report-html").props.onClick?.();
      action(tree, "report-csv").props.onClick?.();
      expect(saved.mock.calls).toEqual([
        [
          reportFilename("html", report.title, report.exportedAt),
          reportHtml(report, lang),
          "text/html;charset=utf-8",
        ],
        [
          reportFilename("csv", report.title, report.exportedAt),
          reportCsv(report, lang),
          "text/csv;charset=utf-8",
        ],
      ]);
    }
    expect(saved.mock.calls[0][0]).toBe("spectroscope-files-report-fix-the-build-20261110-0912.html");
    // While the report builds, a press saves nothing.
    saved.mockClear();
    action(panel("en", null), "report-html").props.onClick?.();
    action(panel("en", "failed"), "report-csv").props.onClick?.();
    expect(saved).not.toHaveBeenCalled();
  });

  it("pdfPrintsTheReportFromAHiddenSandboxedFrame", () => {
    const report = reportOf(ENV_READ);
    const print = vi.fn();
    const focus = vi.fn();
    const frame = { srcdoc: "", onload: null as null | (() => void), contentWindow: { focus, print } };
    const tree = drive(
      <ReportSheetPanel lang="de" report={report} onClose={() => {}} />,
      [ReportSheetPanel],
      [
        (t) => {
          const iframe = t.find((el) => el.type === "iframe");
          expect(iframe?.props.sandbox).toBe("allow-same-origin allow-modals");
          (iframe?.props.ref as { current: unknown }).current = frame;
          action(t, "report-pdf").props.onClick?.();
        },
      ],
    );
    expect(tree.some((el) => el.type === "iframe" && hasClass(el, "files-report__frame"))).toBe(true);
    expect(frame.srcdoc).toBe(reportHtml(report, "de"));
    // The dialog opens once the document has loaded, not before.
    expect(print).not.toHaveBeenCalled();
    frame.onload?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
    expect(saved).not.toHaveBeenCalled();
  });

  it("escapeClosesTheSheet", () => {
    const onClose = vi.fn();
    const tree = panel("en", reportOf(ENV_READ), onClose);
    const other = key("ArrowRight", null, []);
    pressKey(tree, other);
    expect(onClose).not.toHaveBeenCalled();
    // The tab's arrow keys step through calls; inside the sheet they stay in the sheet.
    expect(other.stopPropagation).toHaveBeenCalledTimes(1);
    const escape = key("Escape", null, []);
    pressKey(tree, escape);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.stopPropagation).toHaveBeenCalledTimes(1);
    // The close button and a press on the backdrop close it too; a press inside does not.
    action(tree, "report-close").props.onClick?.();
    expect(onClose).toHaveBeenCalledTimes(2);
    tree.find((el) => el.props.role === "presentation")?.props.onClick?.();
    expect(onClose).toHaveBeenCalledTimes(3);
    const inside = { stopPropagation: vi.fn() };
    (dialogOf(tree).props.onClick as (e: unknown) => void)(inside);
    expect(inside.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("tabAndShiftTabCycleTheSheetsButtons", () => {
    const tree = panel("en", reportOf(ENV_READ));
    const buttons = [0, 1, 2, 3].map(() => ({ focus: vi.fn() }));
    const [first, second, , last] = buttons;
    const forward = key("Tab", last, buttons);
    pressKey(tree, forward);
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(forward.preventDefault).toHaveBeenCalledTimes(1);
    pressKey(tree, key("Tab", first, buttons, true));
    expect(last.focus).toHaveBeenCalledTimes(1);
    pressKey(tree, key("Tab", first, buttons));
    expect(second.focus).toHaveBeenCalledTimes(1);
    // From the dialog itself the focus enters at the first button, or at the last going back.
    pressKey(tree, key("Tab", "dialog", buttons));
    expect(first.focus).toHaveBeenCalledTimes(2);
    pressKey(tree, key("Tab", "dialog", buttons, true));
    expect(last.focus).toHaveBeenCalledTimes(2);
  });
});

describe("opening the sheet", () => {
  afterEach(() => vi.unstubAllGlobals());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("buildsAfterTheSheetShowsAndAsksForTheVersionOnce", async () => {
    const report = reportOf(ENV_READ);
    const build = vi.fn(() => report);
    const load = vi.fn(() => Promise.resolve("0.16.1"));
    const landed: (SheetReport | null)[] = [];
    const jobs: (() => void)[] = [];
    openReportSheet(
      build,
      load,
      (r) => landed.push(r),
      (job) => {
        jobs.push(job);
        return () => {};
      },
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(1);
    jobs[0]();
    expect(build).toHaveBeenCalledTimes(1);
    expect(landed).toEqual([report]);
    await flush();
    // The version arrives after the build and lands on the same report.
    expect(landed).toHaveLength(2);
    expect(landed[1]).toEqual({ ...report, version: "0.16.1" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("aVersionBeforeTheBuildGoesIntoTheFirstReport", async () => {
    const report = reportOf(ENV_READ);
    const landed: (SheetReport | null)[] = [];
    let job: () => void = () => {};
    openReportSheet(
      () => report,
      () => Promise.resolve("0.16.1"),
      (r) => landed.push(r),
      (next) => {
        job = next;
        return () => {};
      },
    );
    await flush();
    expect(landed).toEqual([]);
    job();
    expect(landed).toEqual([{ ...report, version: "0.16.1" }]);
  });

  it("aClosedSheetLandsNothing", async () => {
    const landed: (SheetReport | null)[] = [];
    const cancel = vi.fn();
    let job: () => void = () => {};
    const build = vi.fn(() => reportOf(ENV_READ));
    const stop = openReportSheet(
      build,
      () => Promise.resolve("0.16.1"),
      (r) => landed.push(r),
      (next) => {
        job = next;
        return cancel;
      },
    );
    stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    job();
    await flush();
    expect(build).not.toHaveBeenCalled();
    expect(landed).toEqual([]);
  });

  it("aBuildThatThrowsSaysItFailed", () => {
    const landed: (SheetReport | null)[] = [];
    openReportSheet(
      () => {
        throw new Error("broken");
      },
      () => Promise.resolve(null),
      (r) => landed.push(r),
      (job) => {
        job();
        return () => {};
      },
    );
    expect(landed).toEqual(["failed"]);
    const tree = panel("de", "failed");
    expect(texts(tree)).toContain(t("de", "filesTab.report.failed"));
    expect(action(tree, "report-pdf").props.disabled).toBe(true);
  });

  it("theVersionComesFromApiBundles", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ version: " 0.16.1 " }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchReportVersion()).toBe("0.16.1");
    expect(fetchMock.mock.calls).toEqual([["/api/bundles"]]);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    expect(await fetchReportVersion()).toBeNull();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await fetchReportVersion()).toBeNull();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ version: 16 }), { status: 200 }));
    expect(await fetchReportVersion()).toBeNull();
  });
});

describe("the sheet's words", () => {
  it("everyReportKeyHasEnglishAndGerman", () => {
    const keys = Object.keys(dict).filter((k) => k.startsWith("filesTab.report."));
    const families = [
      ...["critical", "sensitive", "unknown", "project"].map((l) => `filesTab.report.level.${l}`),
      ...["pdf", "html", "csv"].map((k) => `filesTab.report.${k}`),
    ];
    expect(keys).toEqual(
      expect.arrayContaining([...families, "filesTab.report.button", "filesTab.report.scope"]),
    );
    const thin = keys.filter((k) => !(dict[k].en?.trim() && dict[k].de?.trim()));
    expect(thin).toEqual([]);
    expect([t("en", "filesTab.report.button"), t("de", "filesTab.report.button")]).toEqual([
      "Report",
      "Report",
    ]);
    // No dash of either kind in the sheet's words.
    const dashed = keys.filter((k) => /[–—]/.test(dict[k].en + dict[k].de));
    expect(dashed).toEqual([]);
  });
});

// ---- The leak guard over the sheet ------------------------------------------------
//
// The session of reportLeak.test.ts, written out again here: credentials in
// tool results, tool inputs, prompts, a steering message, the title, a file
// path, commands, private key blocks and a model name.

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

function leakEvents(): RunEvent[] {
  return new Rec()
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
    .tool("read_file", { path: "keys/id_rsa" }, keyBlock("RSA", RSA_BODY))
    .tool("read_file", { path: `backup-${AKID_IN_PATH}.txt` })
    .tool("write_file", { path: "notes.txt", content: `token ${ANT}` }, "ok", "created")
    .tool("db_connect", { host: "db", password: DB_PW })
    .tool("Bash", { command: `mysql -u app -p'${DB_PW}' -e 'select 1'` })
    .tool("Bash", { command: `export GITHUB_TOKEN=${PAT} && git push` })
    .tool("Bash", {
      command: `curl -H "Authorization: Bearer ${BEARER}" https://api.example.com/x -d @payload.json`,
    })
    .tool("Bash", { command: `printf '%s\\n' '${keyBlock("EC", EC_BODY)}' > k.pem` })
    .tool("Bash", { command: "cat ~/.aws/credentials" }, `aws_access_key_id = ${AKID}\n`)
    .tool("Bash", { command: `echo "${JWT}" | base64 -d` })
    .tool("Bash", { command: "printenv" }, `GITHUB_TOKEN=${PAT}\nHOME=/Users/a\n`)
    .exchange()
    .exchange(`m-${JWT}`, `https://u:${EXCHANGE_PW}@api.example.com/v1`).events;
}

describe("the report sheet leaks no credential", () => {
  const events = leakEvents();
  const report = buildReport({
    events,
    ledger: foldFiles(events),
    sessionId: "s-1",
    title: `deploy with ${GOOGLE}`,
    version: "0.16.1",
    now: NOW,
  });
  const outputs: [string, string][] = (["en", "de"] as const).flatMap((lang): [string, string][] => [
    [
      `markup ${lang}`,
      renderToStaticMarkup(<ReportSheetPanel lang={lang} report={report} onClose={() => {}} />),
    ],
    [`text ${lang}`, texts(panel(lang, report)).join("\n")],
  ]);

  it("theSheetShowsTheVerdictOfTheSession", () => {
    expect(report.verdict).toBe("critical");
    for (const lang of ["en", "de"] as const) {
      // Booleans only: a failing assertion on the text itself would print it into the log.
      expect(texts(panel(lang, report)).includes(verdictLine(report, lang)), lang).toBe(true);
    }
    expect(outputs[0][1].includes('data-level="critical"')).toBe(true);
  });

  it("noRuleMatchesAnywhereInTheSheet", () => {
    for (const [name, text] of outputs) {
      expect(
        findCredentials(text).hits.map((h) => h.rule),
        name,
      ).toEqual([]);
    }
  });

  it("noRawSecretIsPartOfTheSheet", () => {
    // A failure names the index into RAW, never the value.
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
