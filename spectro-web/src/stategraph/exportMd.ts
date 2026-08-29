// The run as a Markdown summary: what a reader pastes into a ticket when the
// picture itself is too much. Everything in it comes off the two artifacts —
// nothing is invented, and absence stays legible ("never entered" for a node
// the run missed, an em dash for a fact the file does not carry).
//
// The chrome goes through the same dictionary as the view, so the file reads
// in the language the app was in when it was written.

import type { StateGraphLayout } from "./layout";
import { lifecycleAt, type StateGraphRun } from "./artifact";
import { t, type Lang } from "../i18n/i18n";

export interface MdInput {
  run: StateGraphRun;
  /** The layout on screen — it contributes the rank column and the row order. */
  laid: StateGraphLayout;
  source: string;
  lang: Lang;
}

const DASH = "—";

/** Every superstep a node was visited at, in record order, deduplicated. */
function superstepsOf(run: StateGraphRun, id: string): number[] {
  const seen: number[] = [];
  for (const r of run.records) {
    if (r.node !== id || r.superstep === undefined) continue;
    if (r.type !== "node_start" && r.type !== "node_end" && r.type !== "node_error") continue;
    if (!seen.includes(r.superstep)) seen.push(r.superstep);
  }
  return seen;
}

/** Every runId the pair names: the drawing's, plus any the payloads carry. */
function runIdsOf(run: StateGraphRun): string[] {
  const ids: string[] = [];
  for (const id of [run.runId, ...run.payloads.map((p) => p.runId)]) {
    if (id !== null && id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The run summary as Markdown: source, run/thread identity, the node table,
 * and the recording policy line when the values file was loaded.
 */
export function stateGraphMarkdown({ run, laid, source, lang }: MdInput): string {
  const end = run.records.length - 1;
  const runIds = runIdsOf(run);

  const head = [
    `# ${t(lang, "nav.stategraph")} · ${source}`,
    "",
    `- ${t(lang, "sg.source")}: ${source}`,
    `- run: ${runIds.length > 0 ? runIds.join(", ") : DASH}`,
    // The thread line exists only when the artifact names one — an em dash
    // here would claim the writer said "none", which it did not.
    ...(run.threadId !== null ? [`- ${t(lang, "sg.thread")}: ${run.threadId}`] : []),
    `- ${t(lang, "sg.nodes")}: ${run.topology.nodes.length}`,
    `- ${t(lang, "sg.edges")}: ${run.topology.edges.length}`,
    `- ${t(lang, "sg.supersteps")}: ${run.supersteps}`,
    `- ${
      run.policy === null
        ? t(lang, "sg.noStateFile")
        : `${t(lang, "sg.state")}: ${run.policy.mode} · ${run.payloads.length}`
    }`,
  ];

  const header =
    `| ${t(lang, "sg.node")} | ${t(lang, "sg.rank")} | ${t(lang, "sg.lifecycle")} | ` +
    `${t(lang, "sg.superstep")} | ${t(lang, "sg.duration")} | ${t(lang, "sg.updateKeys")} |`;
  const rule = "| --- | --- | --- | --- | --- | --- |";

  // Reading order = drawing order: by rank, then by position across it.
  const rows = laid.nodes
    .slice()
    .sort((a, b) => a.rank - b.rank || a.y - b.y || a.x - b.x)
    .map((n) => {
      const nr = run.nodes.get(n.id);
      const steps = superstepsOf(run, n.id);
      const cells = [
        n.label,
        String(n.rank),
        t(lang, "sg.st." + lifecycleAt(run.records, end, n.id)),
        steps.length > 0 ? steps.join(", ") : DASH,
        nr?.durationMs != null ? `${nr.durationMs} ms` : DASH,
        (nr?.updateKeys.length ?? 0) > 0 ? nr!.updateKeys.join(", ") : DASH,
      ];
      // A pipe inside a cell would split the row; the artifact is third-party.
      return `| ${cells.map((c) => c.replaceAll("|", "\\|")).join(" | ")} |`;
    });

  return [...head, "", header, rule, ...rows, ""].join("\n");
}
