// Scenario picker — the dedicated surface behind the sidebar's "Szenarien"
// button (its own area by owner decision, never mixed into the session list).
// Picking one compiles the bilingual DSL in the CURRENT chrome language and
// plays it through the SAME replay path as a stored session, landing in the
// Lab so the run can be stepped from event 0.

import { SCENARIOS } from "../scenario/registry";
import type { Dsl } from "../scenario/dsl";
import { loc } from "../scenario/dsl";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function ScenarioDialog(props: {
  onPick: (dsl: Dsl) => void;
  onClose: () => void;
}) {
  const lang = useLang();

  return (
    <div className="modal-backdrop">
      <div className="modal scn-modal" role="dialog" aria-modal="true" aria-labelledby="scn-title">
        <div className="modal-head">
          <span className="eyebrow sand">{t(lang, "nav.scenarios")}</span>
        </div>
        <h2 id="scn-title">{t(lang, "scn.title")}</h2>
        <p className="import-hint">{t(lang, "scn.hint")}</p>
        <div className="scn-list">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="scn-row"
              onClick={() => props.onPick(s)}
            >
              <span className="scn-name">{loc(s.name, lang)}</span>
              <span className="scn-prompt">{loc(s.prompt, lang)}</span>
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={props.onClose}>
            {t(lang, "common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
