// Card 309A: the moments panel.
//
// Thin on purpose, the way HandoverLane and FileFootprint are thin. Which
// moments a run has, which step each sits in, what cursor a click seeks to and
// whose moment it is all live in moments.ts, which is pure and bitten one kind
// at a time. The sentence lives in chapterLabel.ts, beside the one the scrub
// tick shows, so the two cannot drift into different words for one moment.
// What is left here is words and pixels.
//
// THE WHOLE RUN, NOT THE APPLIED PREFIX. Every other dock panel folds what has
// already been stepped through, because "what has this run done so far" is
// their question. This panel's question is "where is the interesting part", and
// half the answer is always ahead of the cursor — the scrub ticks have pointed
// forward since card 299, and a list that stopped at the cursor would be the
// one surface that could not take a reader to the error they can already see a
// tick for.
//
// THE SEEK IS THE TRANSPORT'S OWN, imported rather than re-derived: the same
// `seek` the tick calls, on the same cursor `moments.ts` computes from the same
// boundaries. `setMode("step")` first, because a click that lands somewhere and
// is immediately auto-played away from is a control that does not work; it
// no-ops when the run is not flowing.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { clockLabel, elapsedAt, seek, setMode } from "../state/stepper";
import { agentDirectory, agentTagColor } from "./agentDirectory";
import type { AgentDirectory } from "./agentDirectory";
import { momentLabel } from "./chapterLabel";
import { MOMENT_KIND_KEY, momentsOf } from "./moments";
import type { Moment } from "./moments";

function Row(props: {
  moment: Moment;
  dir: AgentDirectory;
  lang: ReturnType<typeof useLang>;
  /** Milliseconds from the run's start, or null where the recording carries no
   *  clock to measure with. Silence, never a fabricated 0:00. */
  elapsedMs: number | null;
}) {
  const { moment, dir, lang, elapsedMs } = props;
  // The directory is the ONLY source of a name here — the same rule the file
  // panel's badges follow. Where it holds no handle the row says nothing about
  // who, rather than printing an opaque id.
  const tag = moment.agentId === null ? null : (dir.get(moment.agentId)?.tag ?? null);
  const line = momentLabel(moment.mark, tag, lang);

  return (
    <li className="lab-moment-row">
      <button
        type="button"
        className="lab-moment-open"
        title={t(lang, "lab.moments.open")}
        onClick={() => {
          setMode("step"); // a seek that auto-play walks away from is not a seek
          seek(moment.cursor);
        }}
      >
        <span className="lab-moment-step mono tabular">
          {t(lang, "lab.moments.step", { n: moment.step })}
        </span>
        <span className={`lab-moment-kind lab-moment-kind--${moment.mark.kind}`}>
          {t(lang, MOMENT_KIND_KEY[moment.mark.kind])}
        </span>
        {tag === null ? null : (
          <span className="lab-moment-tag mono" style={{ color: agentTagColor(tag) }}>
            {tag}
          </span>
        )}
        <span className="lab-moment-text">{line}</span>
        {elapsedMs === null ? null : (
          <span className="lab-moment-clock mono tabular">{clockLabel(elapsedMs)}</span>
        )}
      </button>
    </li>
  );
}

export function MomentList(props: {
  /** The WHOLE run — applied plus queued. See the note at the top. */
  stream: RunEvent[];
}) {
  const lang = useLang();
  const { stream } = props;
  const moments = useMemo(() => momentsOf(stream), [stream]);
  const dir = useMemo(() => agentDirectory(stream), [stream]);

  const count =
    moments.length === 1
      ? t(lang, "lab.moments.countOne")
      : t(lang, "lab.moments.count", { n: moments.length });

  return (
    <div className="lab-moments">
      <p className="lab-moments-hint">{t(lang, "lab.moments.hint")}</p>
      {moments.length === 0 ? (
        /* A run really can carry none of these — a replay of two text deltas
           has no turn, no gate and no ending. Saying so is a measurement; an
           empty panel would read as broken. */
        <p className="lab-moments-empty">{t(lang, "lab.moments.empty")}</p>
      ) : (
        <>
          <p className="lab-moments-count tabular">{count}</p>
          <ul className="lab-moments-list">
            {moments.map((m, i) => (
              <Row
                key={`${m.mark.at}-${i}`}
                moment={m}
                dir={dir}
                lang={lang}
                elapsedMs={elapsedAt(stream, m.mark.at)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
