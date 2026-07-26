// The level pill: a name and a six-slot spectrum strip that gains one coloured
// line per rung climbed, and holds the whole spectrum once the ladder is done.
// The brand image doing mechanical work — the same five lines as the logo, in
// the same order, so the mark on the website and the mark in the header are the
// same object at different stages.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { levelName, slotKinds, translated, type LevelingSnapshot } from "../state/leveling";

/** The five spectral lines in ladder order. These are the app's existing event
 *  tokens, re-derived per design, so the strip is correct in all three skins
 *  without a single new colour. Same five lines as the logo, same order. */
const LINE_VARS = ["--sp-amber", "--sp-teal", "--sp-red", "--sp-violet", "--sp-ocean"];

export function LevelPill(props: {
  snapshot: LevelingSnapshot;
  /** The slot that just lit up, for the ignite animation. -1 for none. */
  flareSlot?: number;
  onOpen: () => void;
}) {
  const lang = useLang();
  const { snapshot, flareSlot = -1, onOpen } = props;
  const rung = snapshot.ladder.levels[snapshot.level];
  const shown = translated((k) => t(lang, k), rung?.nameKey ?? "", levelName(snapshot.levelId));

  return (
    <button
      type="button"
      className="lvl-pill"
      onClick={onOpen}
      title={t(lang, "leveling.pill.title", { name: shown })}
      aria-label={t(lang, "leveling.pill.title", { name: shown })}
    >
      <span className="lvl-pill__name">{shown}</span>
      <span className="lvl-pill__strip" aria-hidden="true">
        {slotKinds(snapshot.level).map((kind, slot) => (
          <span
            key={slot}
            className={
              "lvl-slot" +
              (kind === "line" ? " lvl-slot--line" : "") +
              (kind === "band" ? " lvl-slot--band" : "") +
              (slot === flareSlot ? " lvl-slot--new" : "")
            }
            style={kind === "line" ? { ["--lvl-c" as string]: `var(${LINE_VARS[slot]})` } : undefined}
          />
        ))}
      </span>
    </button>
  );
}
