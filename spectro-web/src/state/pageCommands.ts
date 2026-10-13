// Card 554, task 13: what the composer does with a command of the list that
// is not /compact, /clear or /loop (those stay in Chat.tsx, cards 471 and 504).
//
// Three leave as frames of the session, and only through the host's
// sendSession, which App points at the session's own socket (sessionFrame):
// /run-with-playbook asks the server for the start sheet, /playbook workflow
// starts a workflow at once (owner answer 2), /playbook use picks a playbook
// once its name resolved to one registered folder. The others are answered on
// the page as one info line through the host's `line`: /help, /playbook,
// /playbook list and /playbook show; /skills opens the Skills and Commands
// view. A host without a line or without the view runs none of those, and
// the composer keeps the draft.

import type { ClientMessage } from "../events";
import { t, type Lang } from "../i18n/i18n";
import {
  confirmPlaybookFrame,
  helpText,
  setPlaybookFrame,
  startWorkflowFrame,
  type DraftDecision,
} from "./chatCommands";
import type { CommandRow } from "./commandList";
import type { PlaybookPick } from "./playbookChat";
import {
  currentLine,
  currentOf,
  listLine,
  readFolders,
  readLoaded,
  readNames,
  resolveName,
  showLine,
  showTarget,
} from "./playbookCommands";
import { currentViewMode, type ViewMode } from "./viewMode";

/** One line the page adds to the chat of the session in view. */
export interface LocalLine {
  text: string;
  /** "warn" for a refusal; neutral when absent. */
  tone?: "warn";
  /** The playbook folder whose Steps tab the line's link opens. */
  openPlaybook?: string;
}

/** What a page command needs from the composer and its host. */
export interface PageCommandHost {
  rows: readonly CommandRow[];
  lang: Lang;
  /** The window's mode /help names the rows of; absent reads it at call time. */
  mode?: ViewMode;
  /** The session's pick (UiState.playbook). */
  pick: PlaybookPick | null;
  /** The session's workspace, for the folder pin; null reads no pin. */
  workspace: string | null;
  /** The session's own frames; false when the frame did not leave. */
  sendSession: (frame: ClientMessage) => boolean;
  /** Adds a line to the chat of the session in view; absent where none can be shown. */
  line?: (line: LocalLine) => void;
  /** Opens the Skills and Commands view; absent where there is none. */
  openSkills?: () => void;
}

/** The decisions handled here: every command that is not card 471's, card 504's or a prompt. */
export type PageDecision = Extract<
  DraftDecision,
  {
    kind:
      | "help"
      | "skills"
      | "runPlaybook"
      | "runWorkflow"
      | "playbookUse"
      | "playbookCurrent"
      | "playbookList"
      | "playbookShow";
  }
>;

/** Whether the draft goes (`accepted`), and when every line of the answer is out. */
export interface PageRun {
  accepted: boolean;
  settled: Promise<void>;
}

const DONE: Promise<void> = Promise.resolve();

/**
 * Runs one page command.
 *
 * @param decided the composer's decision
 * @param host    the composer and its host
 * @returns accepted true when the draft may empty; settled once the answer's lines are out
 */
export function runPageCommand(decided: PageDecision, host: PageCommandHost): PageRun {
  switch (decided.kind) {
    case "runPlaybook":
      // An empty prompt goes too: the server answers it with the usage line (criterion 1).
      return { accepted: host.sendSession(confirmPlaybookFrame(decided.prompt)), settled: DONE };
    case "runWorkflow":
      return {
        accepted: host.sendSession(startWorkflowFrame(decided.name, decided.input, host.lang)),
        settled: DONE,
      };
    case "skills":
      if (host.openSkills === undefined) return { accepted: false, settled: DONE };
      host.openSkills();
      return { accepted: true, settled: DONE };
    case "help":
      if (host.line === undefined) return { accepted: false, settled: DONE };
      host.line({ text: helpText(host.rows, host.lang, host.mode ?? currentViewMode()) });
      return { accepted: true, settled: DONE };
    default: {
      const line = host.line;
      if (line === undefined) return { accepted: false, settled: DONE };
      const answer = answerOf(decided, host, line).catch(() => {
        line({ text: t(host.lang, "pbcmd.readFailed"), tone: "warn" });
      });
      return { accepted: true, settled: answer };
    }
  }
}

/** The four playbook commands that read the server first. */
async function answerOf(
  decided: Extract<
    PageDecision,
    { kind: "playbookUse" | "playbookCurrent" | "playbookList" | "playbookShow" }
  >,
  host: PageCommandHost,
  line: (line: LocalLine) => void,
): Promise<void> {
  const { lang, workspace } = host;
  if (
    decided.kind === "playbookCurrent" &&
    host.pick !== null &&
    (host.pick.dir !== null || host.pick.none === true)
  ) {
    // The session's own pick needs no read.
    line({ text: currentLine(currentOf(host.pick, null), null, lang) });
    return;
  }
  const facts = await readFolders(workspace);
  const current = currentOf(host.pick, facts.pinned);
  switch (decided.kind) {
    case "playbookCurrent": {
      const name =
        current.source === "suggested"
          ? ((await readNames([current.dir], workspace))[0]?.name ?? null)
          : null;
      line({ text: currentLine(current, name, lang) });
      return;
    }
    case "playbookList":
      line({ text: listLine(await readNames(facts.folders, workspace), current, lang) });
      return;
    case "playbookUse": {
      const resolved = resolveName(decided.name, await readNames(facts.folders, workspace), lang);
      if ("refusal" in resolved) {
        line({ text: resolved.refusal, tone: "warn" });
        return;
      }
      if (!host.sendSession(setPlaybookFrame(resolved.dir))) {
        line({ text: t(lang, "pbcmd.use.notSent"), tone: "warn" });
        return;
      }
      line({ text: t(lang, "pbcmd.use.done", { name: resolved.name, dir: resolved.dir }) });
      return;
    }
    case "playbookShow": {
      const named = decided.name.trim() === "" ? [] : await readNames(facts.folders, workspace);
      const target = showTarget(decided.name, named, current, lang);
      if ("refusal" in target) {
        line({ text: target.refusal, tone: "warn" });
        return;
      }
      const read = await readLoaded(target.dir, workspace);
      if ("error" in read) {
        line({ text: t(lang, "pbcmd.show.unread", { dir: target.dir, reason: read.error }), tone: "warn" });
        return;
      }
      line({ text: showLine(read.loaded, lang), openPlaybook: target.dir });
      return;
    }
  }
}
