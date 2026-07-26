// The whole ladder, with ticks and receipts.
//
// Every criterion says what counts, and a met one says where it was met: the
// session and the event, which is the point of building this on an event stream
// instead of checkboxes. You did not level up because you claimed to; you
// levelled up because the trace shows you did, and here is the line.
//
// A hand tick is available and quiet. It is labelled as a hand tick forever
// after, because a ladder that cannot tell what it saw from what it was told
// would be decoration.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { criteriaFor, levelName, translated, type LevelingSnapshot } from "../state/leveling";

export function LevelingPanel(props: {
  snapshot: LevelingSnapshot;
  onTick: (criterion: string) => void;
  onOpenEverything: () => void;
  /** Opens the session that a receipt points at, at the recorded event. */
  onOpenEvidence?: (sessionId: string, eventIndex: number | null) => void;
}) {
  const lang = useLang();
  const { snapshot, onTick, onOpenEverything, onOpenEvidence } = props;
  const here = snapshot.ladder.levels[snapshot.level];
  const hereName = here ? translated((k) => t(lang, k), here.nameKey, levelName(here.id)) : "";
  const advance = here?.advanceWhen ?? [];
  const met = advance.filter((id) => snapshot.marks[id]).length;

  return (
    <div className="lvl-panel">
      <div className="lvl-panel__at">
        {t(lang, "leveling.panel.at", { name: hereName })}
        {advance.length > 0 && (
          <>
            {" · "}
            {t(lang, "leveling.panel.toward", { met, total: advance.length })}
          </>
        )}
      </div>

      {snapshot.ladder.levels.map((level) => {
        const gating = criteriaFor(snapshot, level.index).filter((c) => !c.mastery);
        const mastery = criteriaFor(snapshot, level.index).filter((c) => c.mastery);
        const reached = level.index < snapshot.level;
        const isHere = level.index === snapshot.level;
        return (
          <section key={level.id} className={"lvl-rung" + (isHere ? " lvl-rung--here" : "")}>
            <div className="lvl-rung__head">
              <span className="lvl-rung__tag">L{level.index}</span>
              <span>{translated((k) => t(lang, k), level.nameKey, levelName(level.id))}</span>
              {reached && <span className="lvl-rung__tag">{t(lang, "leveling.panel.reached")}</span>}
            </div>
            <div className="lvl-rung__blurb">{translated((k) => t(lang, k), level.blurbKey, "")}</div>

            {gating.map((criterion) => (
              <Criterion
                key={criterion.id}
                snapshot={snapshot}
                criterionId={criterion.id}
                labelKey={criterion.labelKey}
                countsKey={criterion.countsKey}
                onTick={onTick}
                onOpenEvidence={onOpenEvidence}
              />
            ))}

            {mastery.length > 0 && (
              <>
                <div className="lvl-mastery">{t(lang, "leveling.panel.mastery")}</div>
                {mastery.map((criterion) => (
                  <Criterion
                    key={criterion.id}
                    snapshot={snapshot}
                    criterionId={criterion.id}
                    labelKey={criterion.labelKey}
                    countsKey={criterion.countsKey}
                    onTick={onTick}
                    onOpenEvidence={onOpenEvidence}
                  />
                ))}
              </>
            )}
          </section>
        );
      })}

      {snapshot.mode === "ladder" && (
        <div className="lvl-teaser__unlock">
          {t(lang, "leveling.openAll.note")}
          <div>
            <button type="button" className="lvl-open-all" onClick={onOpenEverything}>
              {t(lang, "leveling.openAll")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Criterion(props: {
  snapshot: LevelingSnapshot;
  criterionId: string;
  labelKey: string;
  countsKey: string;
  onTick: (criterion: string) => void;
  onOpenEvidence?: (sessionId: string, eventIndex: number | null) => void;
}) {
  const lang = useLang();
  const { snapshot, criterionId, labelKey, countsKey, onTick, onOpenEvidence } = props;
  const mark = snapshot.marks[criterionId];

  return (
    <div className={"lvl-crit" + (mark ? " lvl-crit--met" : "")}>
      <span className="lvl-crit__mark" aria-hidden="true">
        {mark ? "✓" : "·"}
      </span>
      <span>
        {t(lang, labelKey)} <span className="lvl-crit__counts">{t(lang, countsKey)}</span>
      </span>
      {mark?.origin === "manual" && (
        <span className="lvl-crit__receipt">{t(lang, "leveling.panel.byHand")}</span>
      )}
      {mark?.origin === "observed" && mark.sessionId && onOpenEvidence && (
        <button
          type="button"
          className="lvl-crit__receipt"
          onClick={() => onOpenEvidence(mark.sessionId as string, mark.eventIndex)}
          title={t(lang, "leveling.panel.evidence")}
        >
          {mark.sessionId.slice(0, 15)}
          {mark.eventIndex !== null ? `@${mark.eventIndex}` : ""}
        </button>
      )}
      {!mark && (
        <button
          type="button"
          className="lvl-crit__tick"
          onClick={() => onTick(criterionId)}
          title={t(lang, "leveling.panel.tickByHand")}
        >
          {t(lang, "leveling.panel.tickByHand")}
        </button>
      )}
    </div>
  );
}
