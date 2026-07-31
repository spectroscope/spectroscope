// What a surface shows before it has been earned: what it is, what opens it,
// and the way out.
//
// A teaser rather than a hidden tab, on purpose. A feature nobody can see is a
// feature nobody adopts, and a professional who hits a wall with no exit writes
// the angry post. So the tab stays visible, the teaser says plainly what is
// behind it, and "open everything" sits right there, one click, permanent, no
// second asking.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { criteriaFor, levelName, levelOpening, translated, type LevelingSnapshot } from "../state/leveling";

export function LockedSurface(props: {
  snapshot: LevelingSnapshot;
  /** The surface id, as it appears in the ladder's `opens` lists. */
  surface: string;
  onOpenEverything: () => void;
}) {
  const lang = useLang();
  const { snapshot, surface, onOpenEverything } = props;
  const opening = levelOpening(snapshot, surface);
  const name = opening ? translated((k) => t(lang, k), opening.nameKey, levelName(opening.id)) : "";
  const blurb = opening ? translated((k) => t(lang, k), opening.blurbKey, "") : "";
  // What the operator has to DO, not the name they are already looking at: the
  // still-open criteria of the rung BELOW this surface.
  const todo = opening
    ? criteriaFor(snapshot, opening.index - 1)
        .filter((criterion) => !criterion.mastery && !snapshot.marks[criterion.id])
        .map((criterion) => translated((k) => t(lang, k), criterion.labelKey, criterion.id))
        .join(" · ")
    : "";

  return (
    <div className="lvl-teaser">
      <div className="lvl-teaser__name">{name}</div>
      <div className="lvl-teaser__what">{blurb}</div>
      <div className="lvl-teaser__unlock">
        {t(lang, "leveling.teaser.unlocks", { what: todo })}
        <div>
          <button type="button" className="lvl-open-all" onClick={onOpenEverything}>
            {t(lang, "leveling.openAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
