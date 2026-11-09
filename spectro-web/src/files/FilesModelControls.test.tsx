// Card 604: the model controls of the files tab, the consent sheet and the
// merged reading in the tab. There is no DOM: the controls render on the
// server renderer and the drive kit presses their buttons; effects never run,
// so the provider registry is seeded and fetch is a stub. Nothing reaches the
// network, and nothing may be sent before the consent click.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { __resetProviderRegistry, __seedProviderRows, type ProviderRow } from "../state/providerRegistry";
import type { AnalysisState } from "../state/runAnalysis";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { buildFilesDigest } from "./digest";
import { FilesConsent } from "./FilesConsent";
import { FilesDetail } from "./FilesDetail";
import { FilesExplorer } from "./FilesExplorer";
import {
  closeFilesConsent,
  filesAnalysisOf,
  filesConsentOf,
  PICK_STORAGE_KEY,
  resetFilesAnalysis,
  startFilesAnalysis,
} from "./filesAnalysis";
import { FilesModelControls, type ReadingMode } from "./FilesModelControls";
import { FilesTimeline } from "./FilesTimeline";
import { FilesView } from "./FilesView";
import { foldFiles, type FileLedger } from "./fold";

const T0 = 1_760_000_000_000;

function stamp(events: object[]): RunEvent[] {
  return events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
}

/** An edit, then a script run the heuristic cannot see into (call index 3). */
const EVENTS = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  {
    type: "tool_call",
    agentId: "main",
    callId: "c1",
    name: "edit_file",
    input: { path: "a.ts", old_string: "1", new_string: "2" },
  },
  {
    type: "tool_result",
    agentId: "main",
    callId: "c1",
    output: "ok",
    isError: false,
    durationMs: 5,
    fileChange: "changed",
  },
  {
    type: "tool_call",
    agentId: "main",
    callId: "c2",
    name: "run_command",
    input: { command: "python3 gen.py out/" },
  },
  {
    type: "tool_result",
    agentId: "main",
    callId: "c2",
    output: "wrote out/x.txt",
    isError: false,
    durationMs: 5,
  },
]);
const LEDGER: FileLedger = foldFiles(EVENTS);
const SHELL_CALL = 3;

const META = { provider: "ollama", model: "qwen2.5:7b", address: "localhost:11434" };
const IDLE: AnalysisState = { status: "idle", meta: null, text: "", error: null };

function row(over: Partial<ProviderRow>): ProviderRow {
  return {
    id: "ollama",
    kind: "local",
    state: "reachable",
    keyPresent: false,
    endpoint: "http://localhost:11434",
    models: ["qwen2.5:7b", "llama3.2"],
    live: true,
    reason: null,
    checkedAt: 0,
    ...over,
  };
}

const ROWS: ProviderRow[] = [
  row({}),
  row({ id: "anthropic", kind: "cloud", state: "configured", endpoint: null, models: ["claude-sonnet"] }),
  row({ id: "spectro-local", kind: "builtin", state: "configured", endpoint: null, models: ["vibe"] }),
];

/** A localStorage that works, backed by a map the case can read. */
let stored: Map<string, string>;

beforeAll(() => setLang("en"));

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  });
  __seedProviderRows(ROWS);
  for (const key of ["s-1", "s-2"]) {
    resetFilesAnalysis(key);
    closeFilesConsent(key);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetProviderRegistry();
});

const EXPAND = [FilesModelControls, FilesConsent];

function controls(over: { mode?: ReadingMode; analysis?: AnalysisState; viewKey?: string } = {}) {
  const viewKey = over.viewKey ?? "s-1";
  return (
    <FilesModelControls
      lang="en"
      viewKey={viewKey}
      mode={over.mode ?? "model"}
      onMode={() => {}}
      ledger={LEDGER}
      analysis={over.analysis ?? filesAnalysisOf(viewKey)}
    />
  );
}

function textOf(n: ReactNode): string {
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map((c) => textOf(c as ReactNode)).join("");
  if (isValidElement(n)) return textOf((n as El).props.children);
  return "";
}

function inside(el: El): El[] {
  const out: El[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c as ReactNode);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n as El);
    walk((n as El).props.children);
  };
  walk(el.props.children);
  return out;
}

const classOf = (el: El): string => (typeof el.props.className === "string" ? el.props.className : "");
const hasClass = (el: El, name: string): boolean => classOf(el).split(/\s+/).includes(name);

function action(tree: El[], name: string): El {
  const el = tree.find((e) => e.props["data-action"] === name);
  if (el === undefined) throw new Error(`no element ${name}`);
  return el;
}

const press =
  (name: string): Step =>
  (tree) =>
    action(tree, name).props.onClick?.();

const choose =
  (name: string, value: string): Step =>
  (tree) =>
    action(tree, name).props.onChange?.({ target: { value } });

/** The options of a select, as value, label and disabled. */
function options(tree: El[], name: string): { value: string; label: string; disabled: boolean }[] {
  return inside(action(tree, name))
    .filter((el) => el.type === "option")
    .map((el) => ({
      value: String(el.props.value),
      label: textOf(el.props.children),
      disabled: el.props.disabled === true,
    }));
}

function json(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function ndjson(lines: object[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), { status: 200 });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the model picker", () => {
  it("theBuiltInModelIsNotOffered", () => {
    const tree = drive(controls(), EXPAND, []);
    const offered = options(tree, "model-provider").map((o) => o.value);
    expect(offered).not.toContain("spectro-local");
    // The positive twin: the cloud and the local row are there.
    expect(offered).toEqual(["", "ollama", "anthropic"]);
  });

  it("thePickerStartsEmpty", () => {
    const tree = drive(controls(), EXPAND, []);
    expect(action(tree, "model-provider").props.value).toBe("");
    expect(tree.some((el) => el.props["data-action"] === "model-name")).toBe(false);
    expect(action(tree, "analyze-model").props.disabled).toBe(true);
    expect(textOf(tree.find((el) => hasClass(el, "files-model__status"))?.props.children)).toBe(
      dict["filesTab.model.choose"]?.en,
    );
    // A provider alone is not enough.
    const half = drive(controls(), EXPAND, [choose("model-provider", "ollama")]);
    expect(action(half, "model-name").props.value).toBe("");
    expect(action(half, "analyze-model").props.disabled).toBe(true);
    // Both chosen, the button is ready.
    const both = drive(controls(), EXPAND, [
      choose("model-provider", "ollama"),
      choose("model-name", "llama3.2"),
    ]);
    expect(options(both, "model-name").map((o) => o.value)).toEqual(["", "qwen2.5:7b", "llama3.2"]);
    expect(action(both, "analyze-model").props.disabled).toBe(false);
  });

  it("theRememberedPickComesBackWhileItsProviderIsOffered", () => {
    stored.set(PICK_STORAGE_KEY, JSON.stringify({ provider: "anthropic", model: "claude-sonnet" }));
    const tree = drive(controls(), EXPAND, []);
    expect(action(tree, "model-provider").props.value).toBe("anthropic");
    expect(action(tree, "model-name").props.value).toBe("claude-sonnet");
    // A remembered provider that is no longer offered leaves the picker empty.
    stored.set(PICK_STORAGE_KEY, JSON.stringify({ provider: "spectro-local", model: "vibe" }));
    const gone = drive(controls(), EXPAND, []);
    expect(action(gone, "model-provider").props.value).toBe("");
    expect(action(gone, "analyze-model").props.disabled).toBe(true);
  });

  it("aProviderThatCannotRunIsListedWithItsReason", () => {
    __seedProviderRows([
      row({ state: "failed", reason: "refused" }),
      row({ id: "openai", kind: "cloud", state: "needs-key", endpoint: null, models: [] }),
      row({ id: "copilot", kind: "cloud", state: "needs-signin", endpoint: null, models: [] }),
      row({ id: "lmstudio", endpoint: "http://localhost:1234" }),
    ]);
    const tree = drive(controls(), EXPAND, []);
    expect(options(tree, "model-provider")).toEqual([
      { value: "", label: "choose a provider", disabled: false },
      { value: "ollama", label: "ollama, not answering at http://localhost:11434 (refused)", disabled: true },
      { value: "openai", label: "openai, no key set", disabled: true },
      { value: "copilot", label: "copilot, not signed in", disabled: true },
      { value: "lmstudio", label: "lmstudio", disabled: false },
    ]);
    // A remembered pick on a provider that is down is not taken.
    stored.set(PICK_STORAGE_KEY, JSON.stringify({ provider: "ollama", model: "qwen2.5:7b" }));
    expect(action(drive(controls(), EXPAND, []), "model-provider").props.value).toBe("");
  });

  it("heuristicModeShowsOnlyTheSwitch", () => {
    const tree = drive(controls({ mode: "heuristic" }), EXPAND, []);
    expect(action(tree, "mode-heuristic").props["aria-pressed"]).toBe(true);
    expect(action(tree, "mode-model").props["aria-pressed"]).toBe(false);
    expect(tree.some((el) => el.props["data-action"] === "model-provider")).toBe(false);
    expect(tree.some((el) => el.props["data-action"] === "analyze-model")).toBe(false);
    const onMode = vi.fn();
    drive(
      <FilesModelControls
        lang="en"
        viewKey="s-1"
        mode="heuristic"
        onMode={onMode}
        ledger={LEDGER}
        analysis={IDLE}
      />,
      EXPAND,
      [press("mode-model")],
    );
    expect(onMode).toHaveBeenCalledWith("model");
  });
});

describe("consent before anything is sent", () => {
  it("nothingIsSentBeforeConsent", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("/api/files/analyze/engine")
        ? json({ available: true, ...META })
        : ndjson([{ meta: META }, { delta: '{"files":[]}' }, { done: true }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const urls = () => fetchMock.mock.calls.map((c) => c[0]);
    drive(controls(), EXPAND, [
      choose("model-provider", "ollama"),
      choose("model-name", "qwen2.5:7b"),
      (tree) => {
        expect(urls()).toEqual([]);
        action(tree, "analyze-model").props.onClick?.();
      },
      (tree) => {
        // Only the pre-flight went out, and it names the pair; the sheet waits for its answer.
        expect(urls()).toEqual(["/api/files/analyze/engine?provider=ollama&model=qwen2.5%3A7b"]);
        expect(action(tree, "consent-run").props.disabled).toBe(true);
      },
    ]);
    await flush();
    expect(filesConsentOf("s-1")?.report?.available).toBe(true);
    const shown = buildFilesDigest(LEDGER).text;
    drive(controls(), EXPAND, [
      (tree) => {
        expect(urls()).toHaveLength(1);
        expect(action(tree, "consent-run").props.disabled).toBe(false);
        const digest = tree.find((el) => hasClass(el, "an-digest-text"));
        expect(textOf(digest?.props.children)).toBe(shown);
        action(tree, "consent-run").props.onClick?.();
      },
      (tree) => {
        expect(urls()).toHaveLength(2);
        const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(url).toBe("/api/files/analyze");
        expect(JSON.parse(String(init.body))).toEqual({
          digest: shown,
          provider: "ollama",
          model: "qwen2.5:7b",
          lang: "en",
        });
        // The click closed the sheet.
        expect(tree.some((el) => el.props["data-action"] === "consent-run")).toBe(false);
      },
    ]);
    await flush();
    expect(filesAnalysisOf("s-1").status).toBe("done");
    expect(JSON.parse(stored.get(PICK_STORAGE_KEY) ?? "null")).toEqual({
      provider: "ollama",
      model: "qwen2.5:7b",
    });
  });

  it("aClosedSheetSendsNothing", async () => {
    const fetchMock = vi.fn(async () => json({ available: true, ...META }));
    vi.stubGlobal("fetch", fetchMock);
    drive(controls(), EXPAND, [
      choose("model-provider", "ollama"),
      choose("model-name", "qwen2.5:7b"),
      press("analyze-model"),
      press("consent-cancel"),
      (tree) => expect(tree.some((el) => el.props["data-action"] === "consent-run")).toBe(false),
    ]);
    await flush();
    expect(filesConsentOf("s-1")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(filesAnalysisOf("s-1").status).toBe("idle");
  });
});

describe("the consent sheet", () => {
  const digest = buildFilesDigest(LEDGER);
  const sheet = (over: Partial<Parameters<typeof FilesConsent>[0]> = {}) =>
    drive(
      <FilesConsent
        lang="en"
        consent={{ pick: { provider: "ollama", model: "qwen2.5:7b" }, digest, report: null, error: null }}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
        {...over}
      />,
      [FilesConsent],
      [],
    );
  const texts = (tree: El[]) => tree.map((el) => textOf(el.props.children));

  it("showsWhatLeavesAndWhere", () => {
    const local = sheet({
      consent: {
        pick: { provider: "ollama", model: "qwen2.5:7b" },
        digest,
        report: { available: true, ...META },
        error: null,
      },
    });
    expect(texts(local)).toContain("Nothing leaves this machine.");
    expect(texts(local).some((s) => s.includes("localhost:11434"))).toBe(true);
    expect(
      texts(local).some((s) => s.startsWith(`${digest.text.length} characters from 2 tool calls.`)),
    ).toBe(true);
    expect(textOf(local.find((el) => hasClass(el, "an-digest-text"))?.props.children)).toBe(digest.text);
    expect(action(local, "consent-run").props.disabled).toBe(false);
    expect(textOf(action(local, "consent-run").props.children)).toBe("send to qwen2.5:7b");
    // A remote address says the text leaves, and never says it stays.
    const remote = sheet({
      consent: {
        pick: { provider: "anthropic", model: "claude-sonnet" },
        digest,
        report: {
          available: true,
          provider: "anthropic",
          model: "claude-sonnet",
          address: "api.anthropic.com",
        },
        error: null,
      },
    });
    expect(texts(remote)).not.toContain("Nothing leaves this machine.");
    expect(texts(remote)).toContain(dict["filesTab.consent.remote"]?.en);
    setLang("de");
    try {
      const de = drive(
        <FilesConsent
          lang="de"
          consent={{
            pick: { provider: "ollama", model: "qwen2.5:7b" },
            digest,
            report: { available: true, ...META },
            error: null,
          }}
          running={false}
          onRun={() => {}}
          onClose={() => {}}
        />,
        [FilesConsent],
        [],
      );
      expect(texts(de)).toContain("Nichts verlässt diesen Rechner.");
    } finally {
      setLang("en");
    }
  });

  it("theRunWaitsForThePreflight", () => {
    expect(action(sheet(), "consent-run").props.disabled).toBe(true);
    const out = sheet({
      consent: {
        pick: { provider: "openai", model: "gpt" },
        digest,
        report: { available: false, reason: "needs-key", detail: "OPENAI_API_KEY is not set" },
        error: null,
      },
    });
    expect(action(out, "consent-run").props.disabled).toBe(true);
    expect(texts(out).some((s) => s.includes("OPENAI_API_KEY is not set"))).toBe(true);
    const running = sheet({
      consent: {
        pick: { provider: "ollama", model: "qwen2.5:7b" },
        digest,
        report: { available: true, ...META },
        error: null,
      },
      running: true,
    });
    expect(action(running, "consent-run").props.disabled).toBe(true);
    const failed = sheet({
      consent: { pick: { provider: "ollama", model: "m" }, digest, report: null, error: "HTTP 404" },
    });
    expect(action(failed, "consent-run").props.disabled).toBe(true);
    expect(texts(failed).some((s) => s.includes("HTTP 404"))).toBe(true);
  });

  it("aCutDigestSaysSo", () => {
    const cut = { ...digest, truncated: true };
    const tree = sheet({
      consent: { pick: { provider: "ollama", model: "m" }, digest: cut, report: null, error: null },
    });
    expect(texts(tree).some((s) => s.includes("the tab cut the oldest outputs first"))).toBe(true);
    expect(texts(sheet()).some((s) => s.includes("the tab cut the oldest outputs first"))).toBe(false);
  });
});

describe("the reading in the tab", () => {
  const VIEW = [FilesView, FilesExplorer, FilesDetail, FilesTimeline, FilesModelControls, FilesConsent];
  const viewProps = {
    viewKey: "s-1",
    events: EVENTS,
    startAt: null,
    onStartHandled: () => {},
    onFocusEvent: () => {},
    onOpenPath: () => {},
  };

  async function readAs(answer: string, meta = META): Promise<void> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ndjson([{ meta }, { delta: answer }, { done: true }])),
    );
    await startFilesAnalysis(
      "s-1",
      buildFilesDigest(LEDGER).text,
      { provider: "ollama", model: "qwen2.5:7b" },
      "en",
    );
    expect(filesAnalysisOf("s-1").status).toBe("done");
  }

  const ANSWER = JSON.stringify({
    files: [
      { callIndex: SHELL_CALL, path: "./out", kind: "create", reason: "the output names it" },
      { callIndex: SHELL_CALL, path: "out/x.txt", kind: "create", reason: "the output says it wrote it" },
      { callIndex: 1, path: "a.ts", kind: "delete", reason: "not a shell call" },
    ],
  });

  const rowEl = (tree: El[], path: string): El | undefined =>
    tree.find((el) => el.type === "button" && el.props["data-path"] === path);
  const tags = (el: El | undefined) =>
    el === undefined
      ? []
      : inside(el)
          .filter((e) => hasClass(e, "files-src"))
          .map((e) => classOf(e));

  it("aModelRowIsNeverDrawnAsRecorded", async () => {
    await readAs(ANSWER);
    const tree = drive(<FilesView {...viewProps} />, VIEW, [
      press("mode-model"),
      (t) => rowEl(t, "/ws/out")?.props.onClick?.(),
    ]);
    // The merged row: both guesses tagged, a dashed letter, never recorded.
    const merged = rowEl(tree, "/ws/out");
    expect(tags(merged)).toEqual(["files-src files-src--probable", "files-src files-src--model"]);
    const letter = inside(merged!).find((el) => hasClass(el, "files-letter"));
    expect(textOf(letter?.props.children)).toBe("A");
    expect(classOf(letter!)).toContain("files-letter--guess");
    // The model's own row.
    const own = rowEl(tree, "/ws/out/x.txt");
    expect(tags(own)).toEqual(["files-src files-src--model"]);
    // The detail of the shell call shows the merged touch with both tags, and no recorded one.
    const detail = tree.find((el) => hasClass(el, "files-detail"));
    const detailTags = inside(detail!)
      .filter((el) => hasClass(el, "files-src"))
      .map(classOf);
    expect(detailTags).toContain("files-src files-src--model");
    expect(detailTags).toContain("files-src files-src--probable");
    expect(detailTags).not.toContain("files-src files-src--recorded");
    // The file tool's call kept its recorded touch: the entry on it was dropped.
    expect(tags(rowEl(tree, "/ws/a.ts"))).toEqual(["files-src files-src--recorded"]);
    // The status names the model of the stream.
    const status = textOf(tree.find((el) => hasClass(el, "files-model__status"))?.props.children);
    expect(status).toBe("showing the reading of ollama · qwen2.5:7b");
  });

  it("heuristicHidesTheReadingAndKeepsIt", async () => {
    await readAs(ANSWER);
    const paths = (tree: El[]) =>
      tree
        .filter((el) => el.type === "button" && typeof el.props["data-path"] === "string")
        .map((el) => el.props["data-path"]);
    const heuristic = drive(<FilesView {...viewProps} />, VIEW, []);
    expect(paths(heuristic)).not.toContain("/ws/out/x.txt");
    expect(tags(rowEl(heuristic, "/ws/out"))).toEqual(["files-src files-src--probable"]);
    const back = drive(<FilesView {...viewProps} />, VIEW, [press("mode-model"), press("mode-heuristic")]);
    expect(paths(back)).not.toContain("/ws/out/x.txt");
    expect(filesAnalysisOf("s-1").status).toBe("done");
    const again = drive(<FilesView {...viewProps} />, VIEW, [
      press("mode-model"),
      press("mode-heuristic"),
      press("mode-model"),
    ]);
    expect(paths(again)).toContain("/ws/out/x.txt");
    // The summary says where the extra guesses come from.
    const summary = textOf(again.find((el) => hasClass(el, "files-summary"))?.props.children);
    expect(summary).toContain("or by the model's reading");
    expect(textOf(heuristic.find((el) => hasClass(el, "files-summary"))?.props.children)).not.toContain(
      "model's reading",
    );
    // Another session shows none of it.
    const other = drive(<FilesView {...viewProps} viewKey="s-2" />, VIEW, [press("mode-model")]);
    expect(paths(other)).not.toContain("/ws/out/x.txt");
  });

  it("aProseAnswerIsANoteAndAddsNothing", async () => {
    await readAs("I think the script wrote out/x.txt.", { ...META, model: "llama3.2" });
    const tree = drive(<FilesView {...viewProps} />, VIEW, [press("mode-model")]);
    const note = tree.find((el) => hasClass(el, "files-model__note"));
    expect(textOf(note?.props.children)).toContain("I think the script wrote out/x.txt.");
    expect(tree.some((el) => el.props["data-path"] === "/ws/out/x.txt")).toBe(false);
    const status = textOf(tree.find((el) => hasClass(el, "files-model__status"))?.props.children);
    expect(status).toContain("ollama · llama3.2");
    // The JSON twin draws no note.
    await readAs(ANSWER);
    const parsed = drive(<FilesView {...viewProps} />, VIEW, [press("mode-model")]);
    expect(parsed.some((el) => hasClass(el, "files-model__note"))).toBe(false);
  });

  it("theModelRingDrawsInTheModelColour", () => {
    const css = readFileSync(fileURLToPath(new URL("./files.css", import.meta.url)), "utf8");
    const rule = /\.files-tl__mark--model\s*\{([^}]*)\}/g;
    const bodies = [...css.matchAll(rule)].map((m) => m[1]);
    expect(bodies.some((body) => /(^|;|\s)color:\s*var\(--files-model\)/.test(body))).toBe(true);
    // It comes after the kind colours, so it wins the tie.
    const ringAt = css.search(/\.files-tl__mark--model\s*\{[^}]*(^|;|\s)color:\s*var\(--files-model\)/);
    for (const kind of ["create", "change", "delete", "read"]) {
      expect(css.indexOf(`.files-tl__mark--${kind} {`), kind).toBeLessThan(ringAt);
    }
  });
});
