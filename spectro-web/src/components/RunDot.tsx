// The circle in front of a sidebar row. Nothing but the shared `.dot` family
// from base.css — no new colour, no new keyframes, and the halo stays where it
// already was: on the pulse, which only a streaming run wears.
//
// It carries its own word. A colour-only signal fails the house accessibility
// bar and says nothing at all on a monochrome design, so the state is in the
// title and in the accessible name whether or not anyone can see the hue.

import { t } from "../i18n/i18n";
import type { Lang } from "../i18n/i18n";
import { runDotClass, runLabelKey, type RunState } from "./runIndicator";

export function RunDot({ state, lang }: { state: RunState; lang: Lang }) {
  const label = t(lang, runLabelKey(state));
  return <span className={runDotClass(state)} title={label} aria-label={label} role="img" />;
}
