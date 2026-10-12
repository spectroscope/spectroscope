// Card 503, criterion 10: the agentMessaging switch, a section of the
// composer's settings menu on the model of RtkFilterSection. It writes the
// user settings, so it carries a reach block: the two tools leave the request
// of the next run, and the process stops taking messages from other sessions.

import { ReachBlock } from "./settingsReach";
import { putSettings } from "../state/serverSettings";
import { t, type Lang } from "../i18n/i18n";
import { agentMessagingNext, type AgentMessagingState } from "../state/agentMessaging";

export function AgentMessagingSection({ lang, messaging }: { lang: Lang; messaging: AgentMessagingState }) {
  return (
    <div className="wsg-section">
      <div className="wsg-section-head">
        <span>{t(lang, "am.title")}</span>
      </div>
      <ReachBlock lang={lang} fields={["agentMessaging"]}>
        <div className="wsg-modes" role="group" aria-label={t(lang, "am.title")}>
          <div
            role="menuitemcheckbox"
            aria-checked={messaging.on}
            className={`wsg-mode-row${messaging.on ? " wsg-mode-row--active" : ""}`}
            onClick={() => {
              const next = agentMessagingNext(messaging.on);
              messaging.setOn(next);
              messaging.setError(null);
              void putSettings("user", { agentMessaging: next }).catch((e: unknown) => {
                messaging.setOn(!next);
                messaging.setError(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            <span className="wsg-mode-marker" aria-hidden="true">
              {messaging.on ? "›" : ""}
            </span>
            <span className="wsg-mode-body">
              <span className="wsg-mode-name mono">{t(lang, messaging.on ? "am.on" : "am.off")}</span>
              <span className="wsg-mode-hint">{t(lang, messaging.on ? "am.on.hint" : "am.off.hint")}</span>
            </span>
          </div>
        </div>
        {messaging.error !== null && (
          <p className="settings-note">{t(lang, "am.saveFailed", { e: messaging.error })}</p>
        )}
      </ReachBlock>
    </div>
  );
}
