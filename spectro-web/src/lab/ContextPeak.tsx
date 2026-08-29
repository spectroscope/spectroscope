// Card 300: the lab's context dock — how full each agent's context got, and
// what that number is a share OF.
//
// The component is deliberately thin. Every decision it could get wrong lives
// in contextPeakMath.ts, which is pure and pinned: which rows exist, which of them
// may carry a percentage, which divisor was used and what kind of fact it is.
// What is left here is words and pixels — and the words are chosen by the
// note the join raised, never by a second reading of the data.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { formatTokens } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { agentDirectory, agentTagColor } from "./agentDirectory";
// contextPeakMath, not contextPeak: this repo is built on a case-INSENSITIVE
// filesystem, where `./ContextPeak` would resolve to a sibling `contextPeak.ts`
// ahead of this file's own .tsx and the component would import as undefined.
// The ContextRing/contextRingMath pair beside it is named the same way.
import { contextPeaks, type ContextPeakRow, type ContextPeakTable } from "./contextPeakMath";
import { deriveDetail } from "./flowmap/sceneToFlow";

/** The join, over exactly the events the cursor has applied — so the panel
 *  scrubs with everything else on the lab's row. */
export function contextPeakOf(applied: RunEvent[], model?: string): ContextPeakTable {
  const detail = deriveDetail([...applied]);
  const totals = detail.ctxTotals;
  return contextPeaks({
    spend: detail.spend,
    models: detail.models,
    directory: agentDirectory(applied),
    reported:
      totals === null
        ? null
        : {
            threshold: totals.threshold,
            ...(totals.thresholdSource === undefined ? {} : { source: totals.thresholdSource }),
          },
    ...(model === undefined ? {} : { fallbackModel: model }),
  });
}

function Row(props: { row: ContextPeakRow; lang: ReturnType<typeof useLang> }) {
  const { row, lang } = props;
  // The root's bar is a share of its divisor; a child's is a share of the
  // biggest peak on this list, which is a measurement of something that
  // actually happened rather than of a number a model promised.
  const width = `${Math.round((row.frac ?? row.relFrac) * 100)}%`;
  const share =
    row.denominator === null || row.pct === null
      ? t(lang, "lab.ctx.shareNoLimit", { peak: formatTokens(row.peak) })
      : t(lang, "lab.ctx.share", {
          peak: formatTokens(row.peak),
          limit: formatTokens(row.denominator.value),
          pct: row.pct,
        });
  return (
    <li className="lab-ctx-row">
      <div className="lab-ctx-row-head">
        <span className="lab-ctx-tag mono" style={{ color: agentTagColor(row.tag) }}>
          {row.tag}
        </span>
        <span className="lab-ctx-name" title={row.model ?? undefined}>
          {row.name}
        </span>
        <span className="lab-ctx-turns tabular">
          {row.turns === 1 ? t(lang, "lab.ctx.turnsOne") : t(lang, "lab.ctx.turns", { n: row.turns })}
        </span>
      </div>
      <div
        className={`lab-ctx-bar${row.denominator === null ? " lab-ctx-bar--rel" : ""}`}
        title={row.denominator === null ? t(lang, "lab.ctx.barRelTitle") : undefined}
      >
        <span className="lab-ctx-bar-fill" style={{ width, background: agentTagColor(row.tag) }} />
      </div>
      <p className="lab-ctx-share tabular">{share}</p>
    </li>
  );
}

export function ContextPeak(props: { applied: RunEvent[]; model?: string }) {
  const lang = useLang();
  const { applied, model } = props;
  const table = useMemo(() => contextPeakOf(applied, model), [applied, model]);

  const root = table.rows.find((r) => r.root);
  const limit =
    root?.denominator === undefined || root.denominator === null ? "" : formatTokens(root.denominator.value);
  const noteModel = root?.model ?? model ?? "—";

  return (
    <aside className="lab-ctx" aria-label={t(lang, "lab.ctx.aria")}>
      <div className="lab-ctx-head">
        <span className="eyebrow">{t(lang, "lab.ctx.title")}</span>
      </div>
      <div className="lab-ctx-scroll">
        <p className="lab-ctx-hint">{t(lang, "lab.ctx.hint")}</p>
        {table.rows.length === 0 ? (
          <p className="lab-ctx-empty">{t(lang, "lab.ctx.empty")}</p>
        ) : (
          <ul className="lab-ctx-list">
            {table.rows.map((row) => (
              <Row key={row.agentId} row={row} lang={lang} />
            ))}
          </ul>
        )}
        {table.notes.map((note) => (
          <p key={note} className="lab-ctx-note">
            {t(lang, `lab.ctx.note.${note}`, { limit, model: noteModel })}
          </p>
        ))}
      </div>
    </aside>
  );
}
