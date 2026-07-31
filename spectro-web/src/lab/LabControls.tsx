// The Lab's one-line reading aid under the Flow map. The step controls
// themselves moved to LabTransport (the scrub bar + "now" band, edu port);
// grain + tempo live behind that transport's "advanced" disclosure.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The one-line reading aid under the Flow map, per language. */
export function LabHint() {
  const lang = useLang();
  return <p className="lab-hint">{t(lang, "lab.hint")}</p>;
}
