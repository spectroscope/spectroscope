// Card 481: the playbook module. This placeholder holds the chunk's place in
// the surface table until the playbook segment brings the folder picker, the
// graph, the step table and the findings.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function PlaybookPane() {
  const lang = useLang();
  return (
    <div className="pb-pane">
      <p className="pb-no-runs">{t(lang, "pb.noRuns")}</p>
    </div>
  );
}
