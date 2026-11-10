// Card 605: the report sheet of the files tab. There is no DOM: the sheet
// renders on the server renderer and the drive kit presses its buttons.
// Effects never run here, so the half of the sheet an effect starts (the
// version request and the deferred build) is driven through openReportSheet
// with a schedule the case runs by hand. saveTextFile is a stub and the
// print frame a stand-in object. Every credential vector is joined at run
// time, so no credential-shaped literal sits in this file.

import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { saveTextFile } from "../export/save";
import { dict, t, type Lang } from "../i18n/i18n";
import { drive, type El } from "../testkit/driveComponent";
import { read, rules, stripComments } from "../testkit/source";
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
import { LEAK_RAW, leakReport } from "./reportLeakFixture";
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

  it("afterPrintTheFocusComesBackToThePdfButton", () => {
    const report = reportOf(ENV_READ);
    const log: string[] = [];
    const frame = {
      srcdoc: "",
      onload: null as null | (() => void),
      contentWindow: { focus: () => log.push("frame"), print: () => log.push("print") },
    };
    drive(
      <ReportSheetPanel lang="en" report={report} onClose={() => {}} />,
      [ReportSheetPanel],
      [
        (t) => {
          const iframe = t.find((el) => el.type === "iframe");
          (iframe?.props.ref as { current: unknown }).current = frame;
          const pdf = action(t, "report-pdf");
          (pdf.props.ref as { current: unknown }).current = { focus: () => log.push("pdf button") };
          pdf.props.onClick?.();
        },
      ],
    );
    frame.onload?.();
    // The frame takes the focus for the dialog; once print returns, the sheet has it again.
    expect(log).toEqual(["frame", "print", "pdf button"]);
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
    // The close button closes it too.
    action(tree, "report-close").props.onClick?.();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("onlyAPressThatStartsOnTheBackdropClosesTheSheet", () => {
    const onClose = vi.fn();
    const tree = panel("en", reportOf(ENV_READ), onClose);
    const backdrop = tree.find((el) => el.props.role === "presentation");
    expect(backdrop).toBeDefined();
    const down = backdrop!.props.onMouseDown as (e: unknown) => void;
    // A press that starts inside the panel bubbles up with the panel as target.
    const panelEl = {};
    const backdropEl = {};
    down({ target: panelEl, currentTarget: backdropEl });
    expect(onClose).not.toHaveBeenCalled();
    down({ target: backdropEl, currentTarget: backdropEl });
    expect(onClose).toHaveBeenCalledTimes(1);
    // No click handler: a text drag from the panel that ends over the backdrop closes nothing.
    expect(backdrop!.props.onClick).toBeUndefined();
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
  it("theLevelWordsAreTheReportDocumentsWords", () => {
    // One fixture per level, so each verdict word of the document is read off a rendered page.
    const byLevel: Record<string, RunEvent[]> = {
      critical: ENV_READ,
      sensitive: stamp([
        { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
        call("c1", "read_file", { path: "/etc/hosts" }),
        result("c1"),
      ]),
      unknown: stamp([
        { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
        call("c1", "run_command", { command: "python3 gen.py out/" }),
        result("c1", { output: "done" }),
      ]),
      project: PROJECT,
    };
    for (const [level, events] of Object.entries(byLevel)) {
      const report = reportOf(events);
      expect(report.verdict, level).toBe(level);
      for (const lang of ["en", "de"] as const) {
        const verdict = /data-section="verdict"[^>]*>\s*<p class="level">([^<]*)<\/p>/.exec(
          reportHtml(report, lang),
        );
        expect(verdict, `${level} ${lang}`).not.toBeNull();
        const mark = panel(lang, report).find((el) => hasClass(el, "files-report__level"));
        expect(textOf(mark?.props.children), `${level} ${lang}`).toBe(verdict![1]);
        expect(t(lang, `filesTab.report.level.${level}`)).toBe(verdict![1]);
      }
    }
  });

  it("theSheetIsNarrowerThanTheKeymapPanel", () => {
    // keymap.css loads after files.css and gives .km-panel its width, so the
    // sheet's width needs both classes to win.
    const widthOf = (css: string, rel: string) =>
      rules(rel, css).filter((r) => /(^|[;\s])width\s*:/.test(r.body));
    const keymap = widthOf(read("../styles/keymap.css", import.meta.url), "keymap.css");
    expect(keymap.filter((r) => r.selector === ".km-panel")).toHaveLength(1);
    const sheetRules = widthOf(read("./files.css", import.meta.url), "files.css").filter(
      (r) =>
        r.selector.includes(".files-report") &&
        r.subject.includes("files-report") &&
        !r.subject.includes("__"),
    );
    expect(sheetRules.map((r) => r.selector)).toEqual([".km-panel.files-report"]);
    expect(sheetRules[0].body).toMatch(/width:\s*min\(520px,\s*100%\)/);
  });

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
    // Final wave item 6d: the German button says Bericht, the sheet's title Dateibericht.
    expect([t("en", "filesTab.report.button"), t("de", "filesTab.report.button")]).toEqual([
      "Report",
      "Bericht",
    ]);
    expect(t("de", "filesTab.report.title")).toBe("Dateibericht");
    // No dash of either kind in the sheet's words.
    const dashed = keys.filter((k) => /[\u2013\u2014]/.test(dict[k].en + dict[k].de));
    expect(dashed).toEqual([]);
  });
});

// ---- The leak guard over the sheet ------------------------------------------------
//
// The session of reportLeak.test.ts, from the shared fixture: credentials in
// tool results, tool inputs, prompts, a steering message, the title, a file
// path, commands, private key blocks and a model name.

describe("the report sheet leaks no credential", () => {
  const report = leakReport();
  const outputs: [string, string][] = (["en", "de"] as const).flatMap((lang): [string, string][] => [
    [
      `markup ${lang}`,
      renderToStaticMarkup(<ReportSheetPanel lang={lang} report={report} onClose={() => {}} />),
    ],
    [`text ${lang}`, texts(panel(lang, report)).join("\n")],
  ]);

  it("theFixtureIsImportedOnlyByTests", () => {
    // The fixture carries credential vectors; no shipped module may pull it into the bundle.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const sources = (readdirSync(root, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => f.split(sep).join("/"));
    // Any mention in code counts (a static, bare or dynamic import); comments do not.
    const importers = sources.filter((f) =>
      stripComments(readFileSync(join(root, f), "utf8")).includes("reportLeakFixture"),
    );
    expect(importers.sort()).toEqual(["files/FilesReportSheet.test.tsx", "files/reportLeak.test.ts"]);
  });

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
    // A failure names the index into LEAK_RAW, never the value.
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
