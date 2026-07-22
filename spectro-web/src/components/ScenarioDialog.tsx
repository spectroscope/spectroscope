// Scenario picker — the dedicated surface behind the sidebar's "Szenarien"
// button (its own area by owner decision, never mixed into the session list).
// Two tabs: chat/agent scenarios play through the SAME replay path as a stored
// session and land in the Lab (stepped from event 0); fleet scenarios compile
// the same way but open in the fleet view so the topology reads at a glance.

import { useState } from "react";
import { SCENARIOS } from "../scenario/registry";
import type { Dsl } from "../scenario/dsl";
import { loc } from "../scenario/dsl";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

type ScnTab = "chats" | "fleet";

export function ScenarioDialog(props: {
  onPick: (dsl: Dsl) => void;
  onClose: () => void;
}) {
  const lang = useLang();
  const [tab, setTab] = useState<ScnTab>("chats");

  // A fleet scenario shows under the fleet tab; everything else under chats.
  const shown = SCENARIOS.filter((s) => (tab === "fleet" ? s.fleet === true : s.fleet !== true));

  return (
    <div className="modal-backdrop">
      <div className="modal scn-modal" role="dialog" aria-modal="true" aria-labelledby="scn-title">
        <div className="modal-head">
          <span className="eyebrow sand">{t(lang, "nav.scenarios")}</span>
        </div>
        <h2 id="scn-title">{t(lang, "scn.title")}</h2>
        <p className="import-hint">{t(lang, "scn.hint")}</p>
        <div className="scn-tabs" role="tablist" aria-label={t(lang, "scn.title")}>
          {(["chats", "fleet"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`scn-tab${tab === id ? " scn-tab--active" : ""}`}
              onClick={() => setTab(id)}
            >
              {t(lang, id === "chats" ? "scn.tab.chats" : "scn.tab.fleet")}
            </button>
          ))}
        </div>
        <div className="scn-list">
          {shown.length === 0 ? (
            <p className="ws-note">{t(lang, "scn.empty.fleet")}</p>
          ) : (
            shown.map((s) => (
              <button
                key={s.id}
                type="button"
                className="scn-row"
                onClick={() => props.onPick(s)}
              >
                <span className="scn-name">{loc(s.name, lang)}</span>
                <span className="scn-prompt">{loc(s.prompt, lang)}</span>
              </button>
            ))
          )}
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
