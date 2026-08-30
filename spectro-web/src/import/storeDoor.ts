// Card 318: what a click on a store-list row actually does.
//
// This used to be a closure inside `ImportDialog`, and that is why the card
// shipped with its own headline requirement unguarded. The suite could only
// SEARCH the component's source for `/api/claude/transcripts/run` and
// `importClaudeCodeRun`, and a reviewer restored the defect three separate ways
// with every case green: the row wired to the session door, the coordinator
// called with `sidecars: []`, the run branch made unreachable. None of those
// removes a substring.
//
// So the decision and the two fetches live here, where a test hands them a
// stubbed store and measures what comes back — the roster, the reading the work
// panel draws, the sentence a refusal prints. The component keeps the wiring and
// nothing else, and `App` reaches the same door for a deep link, so the address
// a run load writes reopens as the run rather than as the file alone.

import { detectAndLoad } from "./detect";
import type { ImportSource } from "./detect";
import { importClaudeCodeRun, runSummary, type ImportedRunSummary } from "./claudeCodeRun";
import { runBundleInput, runRefusal } from "./runBundle";
import { formatBytes } from "./rowState";
import type { SubagentTranscript } from "./subagentFile";
import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";

/** Which door a click takes. The default is the run; see `rowState.doorFor`. */
export type StoreDoor = "run" | "session";

/**
 * Why a run load came back as the session file alone.
 *
 * Three DIFFERENT facts, and they are apart on purpose: "more than this server
 * carries", "the server did not answer", "the agents the row promised are not
 * on disk any more". One code for the set would print a sentence that is false
 * for two of them. The sentence is chosen by the CODE — every one has its own
 * `imp.run.<code>` key, and `storeRowBringsTheRun.test.ts` walks this array and
 * demands a distinct de and en string for each, so a fourth reason without a
 * word is red rather than silent.
 */
export const RUN_DEGRADE_REASONS = ["tooLarge", "unreachable", "vanished"] as const;

/** One of {@link RUN_DEGRADE_REASONS}. */
export type RunDegradeReason = (typeof RUN_DEGRADE_REASONS)[number];

/**
 * The dictionary key one degrade reason prints through.
 *
 * @param reason the code
 * @returns the i18n key
 */
export function degradeKey(reason: RunDegradeReason): string {
  return `imp.run.${reason}`;
}

/** One finished store load, ready for `onLoad`. */
export interface StoreLoad {
  events: RunEvent[];
  /** The row's file name, which is what the tab is labelled with. */
  label: string;
  kind: "spectroscope" | "claude-code" | "vscode-agent";
  source: ImportSource;
  subagent?: SubagentTranscript;
  /** Always carried: a store load has an address, and the agents panel asks it
   *  what sits beside the file. Dropping it kills the deep link, the sidecar
   *  listing and the import address in one edit. */
  storePath: string;
  /** What the merge measured. Absent for the session-file door, which is what
   *  keeps that path exactly as it was. */
  run?: ImportedRunSummary;
  /** One sentence this import owes the reader beyond its own counts: the run
   *  did not arrive and here is what is missing. Absent when it did. */
  note?: string;
}

/** The positional arguments `onLoad` takes, in its own order. */
export type OnLoadArgs = [
  RunEvent[],
  string,
  "spectroscope" | "claude-code" | "vscode-agent",
  ImportSource,
  SubagentTranscript | undefined,
  string | undefined,
  ImportedRunSummary | undefined,
  string | undefined,
];

/**
 * A finished load as the argument list `onLoad` is called with.
 *
 * It exists so the call site cannot quietly drop a field. `onLoad` takes eight
 * positional parameters and a reviewer proved the point by deleting `storePath`
 * from the middle of the call — type-clean, and green through a guard that
 * searched the source for `tr.path`, which is in the fetch URL either way. The
 * dialog now spreads this tuple, and the tuple is measured.
 *
 * @param load the finished load
 * @returns the arguments, in `onLoad` order
 */
export function onLoadArgs(load: StoreLoad): OnLoadArgs {
  return [
    load.events,
    load.label,
    load.kind,
    load.source,
    load.subagent,
    load.storePath,
    load.run,
    load.note,
  ];
}

/**
 * One row's click, through the door the row named.
 *
 * ONE request either way. The run door hands its answer to the coordinator the
 * folder pick already uses — untouched — so the two doors cannot drift into two
 * merges, which is the defect this card exists to end rather than to move.
 *
 * Every way the run can fail lands on the session file WITH a sentence. Before
 * this, only a 413 degraded and everything else threw, so a 500 — the shape a
 * heap-starved server really answers with — left the reader with nothing at all,
 * where the door before this card had loaded the session file.
 *
 * @param row the listing row: its store address and its file name
 * @param door which door, from `rowState`'s plan
 * @param agents what the row promised sits beside this session, for the two
 *        sentences that name a count. Zero for a caller with no row to ask —
 *        a deep link — and the sentences that would then print a number nobody
 *        measured do not print one
 * @param lang the UI-chrome language
 * @returns the finished load
 * @throws Error when even the session file cannot be read; the dialog prints it
 */
export async function openFromStore(
  row: { path: string; file: string },
  door: StoreDoor,
  agents: number,
  lang: Lang,
): Promise<StoreLoad> {
  if (door === "session") return sessionFileOnly(row, lang);

  const answer = await fetch(`/api/claude/transcripts/run?path=${encodeURIComponent(row.path)}`);
  if (!answer.ok) {
    if (answer.status === 413) {
      // The run is more than this server carries at once. Fall back to the file
      // — and SAY so, with both of the server's own numbers and the agents left
      // on disk. A silent fall-back is this card's own defect wearing a coat.
      const refusal = runRefusal(await answer.json().catch(() => null));
      return sessionFileOnly(
        row,
        lang,
        refusal === null
          ? t(lang, degradeKey("unreachable"), { status: 413 })
          : t(lang, degradeKey("tooLarge"), {
              size: formatBytes(refusal.totalBytes),
              limit: formatBytes(refusal.limitBytes),
              // The server counted while it weighed the bundle; the row's
              // number came from a fold whose cache key is the SESSION file's
              // stat, so it can be stale by exactly this much.
              agents: refusal.agents ?? agents,
            }),
      );
    }
    return sessionFileOnly(row, lang, t(lang, degradeKey("unreachable"), { status: answer.status }));
  }

  const input = runBundleInput((await answer.json()) as unknown);
  const run = importClaudeCodeRun(input);
  return {
    events: run.events,
    label: row.file,
    kind: run.kind,
    source: run.source,
    subagent: run.subagent,
    storePath: row.path,
    run: runSummary(run),
    // The row promised agents and the bundle carried none. The facts cache is
    // keyed on the session file's path, mtime and size — the sidecar directory
    // is not in that key — so a pruned or moved folder leaves the row promising
    // N while the merge of zero sidecars is byte-for-byte the single-file
    // import. Unannounced, that is the row promising the run and delivering the
    // defect.
    ...(agents > 0 && input.sidecars.length === 0
      ? { note: t(lang, degradeKey("vanished"), { agents }) }
      : {}),
  };
}

/**
 * The session file on its own, through the route that has always served it.
 *
 * Both the escape button and every degrade land here.
 *
 * @param row the listing row
 * @param lang the UI-chrome language
 * @param note the sentence to carry, when this was a fall-back rather than a
 *        choice
 * @returns the finished load
 */
async function sessionFileOnly(
  row: { path: string; file: string },
  lang: Lang,
  note?: string,
): Promise<StoreLoad> {
  const answer = await fetch(`/api/claude/transcripts/content?path=${encodeURIComponent(row.path)}`);
  if (!answer.ok) {
    // The rows are disabled before the click, so a refusal here means the
    // listing went stale: the store is live and a transcript can grow past the
    // ceiling between the render and the click.
    throw new Error(t(lang, "imp.err.fetch", { status: answer.status }));
  }
  const { events, kind, source, subagent } = detectAndLoad(await answer.text());
  return {
    events,
    label: row.file,
    kind,
    source,
    subagent,
    storePath: row.path,
    ...(note === undefined ? {} : { note }),
  };
}
