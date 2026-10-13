// Card 587: /graph on the page, kept general so another graph program can
// take graphify's place: every sentence names the backend the server reports.
//
// build and update start the job the folder chip menu starts (POST
// /api/codegraph/start, the sheet's "No labels") and follow it until it ends,
// then say in the chat what happened: built, updated, already current, only
// finished (an update whose output said neither), or failed with its reason. show opens the graph the way the menu's Show row
// does. ask leaves as graph_ask on the session's own socket; the server
// refuses it where the folder has no graph and otherwise hands the model the
// question with a line that asks for the graph tool. help lists the
// subcommands from the command list, in the page's language.
//
// The reads and the timer come in as deps, so the suite drives it in node.

import type { ClientMessage } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { GRAPH_ACTIONS, graphAskFrame, type GraphAction } from "./chatCommands";
import { helpOf, type CommandRow } from "./commandList";
import type { LocalLine, PageRun } from "./pageCommands";
import { asTypedCommand } from "./typedCommand";
import {
  fetchCodeGraphStatus,
  POLL_MS,
  postCodeGraphStart,
  startBody,
  type CodeGraphJob,
  type CodeGraphResult,
  type CodeGraphStatus,
  type StartBody,
} from "../codegraph/codeGraphModel";
import { codeGraphState, refreshCodeGraph } from "../codegraph/codeGraphStore";
import { openGraphInBrowser } from "../codegraph/CodeGraphHeaderStatus";

export type { GraphAction } from "./chatCommands";

/** How many reads in a row may fail before the chat stops following a build. */
export const MAX_MISSES = 30;

/**
 * How many reads the chat follows one build for. The server stops a build
 * after 60 minutes (CodeGraphJobs.LIMIT); 2000 reads at POLL_MS are a little
 * longer, so a build the server forgot cannot keep the chat reading forever.
 */
export const MAX_FOLLOW_READS = 2000;

/** What /graph reads and starts; the app's own unless a test hands in others. */
export interface GraphDeps {
  /** The session the code graph status follows, as the menu rows read it. */
  sessionId: () => string | null;
  fetchStatus: (sessionId: string) => Promise<CodeGraphStatus | null>;
  postStart: (body: StartBody) => Promise<{ status: number; message?: string; job?: CodeGraphJob }>;
  /** The menu's Show row. */
  openGraph: (sessionId: string) => void;
  /** Asks the header for a fresh status. */
  refresh: () => void;
  sleep: (ms: number) => Promise<void>;
}

/** What /graph needs from the composer. */
export interface GraphHost {
  rows: readonly CommandRow[];
  lang: Lang;
  /** The session's own frames; false when the frame did not leave. */
  sendSession: (frame: ClientMessage) => boolean;
  /** A line in the chat the command was typed in; absent where none can be shown. */
  line?: (line: LocalLine) => void;
}

const APP_DEPS: GraphDeps = {
  sessionId: () => codeGraphState().sessionId,
  fetchStatus: (sessionId) => fetchCodeGraphStatus(sessionId),
  postStart: (body) => postCodeGraphStart(body),
  openGraph: openGraphInBrowser,
  refresh: refreshCodeGraph,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

const DONE: Promise<void> = Promise.resolve();

/**
 * The answer to /graph help: one line per subcommand, from the list.
 *
 * @param rows the command list
 * @param lang the page's language
 * @returns the lines, joined by line breaks
 */
export function graphHelpText(rows: readonly CommandRow[], lang: Lang): string {
  const lines = [t(lang, "gcmd.help.title")];
  for (const action of GRAPH_ACTIONS) {
    const row = rows.find((r) => r.name === "graph" && r.sub === action);
    if (row !== undefined) lines.push(`/graph ${action}: ${helpOf(row, lang)}`);
  }
  const parent = rows.find((r) => r.name === "graph" && r.sub === null);
  if (parent !== undefined && parent.aliases.length > 0) {
    const names = parent.aliases.map((a) => `/${a}`);
    const joined =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} ${t(lang, "gcmd.and")} ${names[names.length - 1]}`;
    lines.push(t(lang, "gcmd.help.aliases", { aliases: joined ?? "" }));
  }
  return lines.join("\n");
}

/**
 * Runs one /graph subcommand.
 *
 * @param action   the subcommand
 * @param question the words after ask; ignored by the others
 * @param host     the composer and its host
 * @param deps     the reads and the timer; the app's own by default
 * @returns accepted true when the draft may empty; settled once the last line is out
 */
export function runGraphCommand(
  action: GraphAction,
  question: string,
  host: GraphHost,
  deps: GraphDeps = APP_DEPS,
): PageRun {
  const { lang } = host;
  if (action === "ask") {
    const asked = question.trim();
    if (asked === "") {
      host.line?.({ text: t(lang, "gcmd.askUsage"), tone: "warn" });
      return { accepted: false, settled: DONE };
    }
    if (!host.sendSession(asTypedCommand(graphAskFrame(asked)))) {
      host.line?.({ text: t(lang, "gcmd.notSent"), tone: "warn" });
      return { accepted: false, settled: DONE };
    }
    return { accepted: true, settled: DONE };
  }
  const line = host.line;
  if (line === undefined) return { accepted: false, settled: DONE };
  if (action === "help") {
    line({ text: graphHelpText(host.rows, lang) });
    return { accepted: true, settled: DONE };
  }
  const sessionId = deps.sessionId();
  if (sessionId === null) {
    line({ text: t(lang, "wchip.needsSession"), tone: "warn" });
    return { accepted: true, settled: DONE };
  }
  // Fix round, M3: an error a step throws is named as what it is.
  const settled = (
    action === "show" ? show(sessionId, lang, line, deps) : build(action, sessionId, lang, line, deps)
  ).catch((error: unknown) =>
    line({
      text: t(lang, "gcmd.error", { reason: error instanceof Error ? error.message : String(error) }),
      tone: "warn",
    }),
  );
  return { accepted: true, settled };
}

/** /graph show: the menu's Show row, for a folder that has a graph. */
async function show(
  sessionId: string,
  lang: Lang,
  line: (l: LocalLine) => void,
  deps: GraphDeps,
): Promise<void> {
  const status = await deps.fetchStatus(sessionId);
  if (status === null) {
    line({ text: t(lang, "gcmd.unread"), tone: "warn" });
    return;
  }
  if (status.graph === null || !status.graph.exists) {
    line({ text: t(lang, "gcmd.noGraph"), tone: "warn" });
    return;
  }
  deps.openGraph(sessionId);
  line({ text: t(lang, "gcmd.opened", { folder: status.folder ?? "" }) });
}

/** /graph build and /graph update: start the menu's job, or follow the one that runs. */
async function build(
  action: "build" | "update",
  sessionId: string,
  lang: Lang,
  line: (l: LocalLine) => void,
  deps: GraphDeps,
): Promise<void> {
  const command = `/graph ${action}`;
  const status = await deps.fetchStatus(sessionId);
  if (status === null) {
    line({ text: t(lang, "gcmd.unread"), tone: "warn" });
    return;
  }
  const folder = status.folder ?? "";
  if (status.job !== null && status.job.state === "running") {
    line({ text: t(lang, "gcmd.busy") });
    await follow(sessionId, status.job.startedAt, folder, lang, line, deps);
    return;
  }
  if (!status.installed) {
    line({ text: notInstalled(status, command, lang), tone: "warn" });
    return;
  }
  if (action === "update" && (status.graph === null || !status.graph.exists)) {
    line({ text: t(lang, "gcmd.noGraph"), tone: "warn" });
    return;
  }
  const mode = action === "build" ? "full" : "update";
  const started = await deps.postStart(startBody(sessionId, mode, null, null));
  if (started.status === 409) {
    line({ text: t(lang, "gcmd.busy") });
    const now = await deps.fetchStatus(sessionId);
    if (now?.job?.state === "running") await follow(sessionId, now.job.startedAt, folder, lang, line, deps);
    else if (now?.job != null) line(outcome(now.job, now.result ?? null, folder, lang));
    return;
  }
  if (started.status === 503) {
    line({ text: notInstalled(status, command, lang), tone: "warn" });
    return;
  }
  if (started.status !== 202) {
    const reason =
      started.message ??
      (started.status === 0
        ? t(lang, "wchip.unreachable")
        : t(lang, "wchip.failed", { status: started.status }));
    line({ text: t(lang, "gcmd.notStarted", { reason }), tone: "warn" });
    return;
  }
  deps.refresh();
  line({ text: t(lang, mode === "full" ? "gcmd.started.full" : "gcmd.started.update", { folder }) });
  const startedAt = started.job?.startedAt ?? (await deps.fetchStatus(sessionId))?.job?.startedAt;
  if (startedAt === undefined) {
    line({ text: t(lang, "gcmd.lost"), tone: "warn" });
    return;
  }
  await follow(sessionId, startedAt, folder, lang, line, deps);
}

/** Reads the status every POLL_MS until the build that started at startedAt has ended. */
async function follow(
  sessionId: string,
  startedAt: string,
  folder: string,
  lang: Lang,
  line: (l: LocalLine) => void,
  deps: GraphDeps,
): Promise<void> {
  let misses = 0;
  for (let read = 0; read < MAX_FOLLOW_READS; read++) {
    await deps.sleep(POLL_MS);
    const status = await deps.fetchStatus(sessionId);
    if (status === null) {
      misses++;
      if (misses >= MAX_MISSES) {
        line({ text: t(lang, "gcmd.lostRead"), tone: "warn" });
        return;
      }
      continue;
    }
    misses = 0;
    const job = status.job;
    if (job === null || job.startedAt !== startedAt) {
      line({ text: t(lang, "gcmd.lost"), tone: "warn" });
      return;
    }
    if (job.state === "running") continue;
    deps.refresh();
    line(outcome(job, status.result ?? null, folder, lang));
    return;
  }
  line({ text: t(lang, "gcmd.lost"), tone: "warn" });
}

/** The line for a build that ended. */
function outcome(job: CodeGraphJob, result: CodeGraphResult | null, folder: string, lang: Lang): LocalLine {
  if (job.state === "failed" || result?.kind === "failed") {
    const exit = job.exitCode === null ? t(lang, "cg.noExit") : t(lang, "cg.exit", { code: job.exitCode });
    return { text: t(lang, "gcmd.failed", { exit, last: job.lastLine ?? "" }), tone: "warn" };
  }
  if (result?.kind === "current") return { text: t(lang, "gcmd.current", { folder }) };
  // Fix round, I1: an update is "updated" only on the server's evidence.
  if (job.mode === "update" && result?.kind !== "updated")
    return { text: t(lang, "gcmd.finished", { folder }) };
  const counts = countsOf(result?.counts ?? null, lang);
  const kind = job.mode === "update" ? "updated" : "built";
  return counts === null
    ? { text: t(lang, `gcmd.${kind}`, { folder }) }
    : { text: t(lang, `gcmd.${kind}.counts`, { folder, counts }) };
}

/** The size graphify printed, in the page's language, or null when there is none. */
function countsOf(counts: string | null, lang: Lang): string | null {
  const m = counts === null ? null : /(\d+) nodes, (\d+) edges, (\d+) communities/.exec(counts);
  if (m === null) return null;
  return t(lang, "gcmd.counts", { nodes: m[1] ?? "", edges: m[2] ?? "", communities: m[3] ?? "" });
}

/** The program the setting names is not installed: its name and how to install it. */
function notInstalled(status: CodeGraphStatus, command: string, lang: Lang): string {
  return t(lang, "gcmd.notInstalled", {
    backend: status.backend ?? "graphify",
    install: status.install,
    command,
  });
}
