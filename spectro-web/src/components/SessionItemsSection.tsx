// Card 558, integrator decision 7b: the section "This session" on the Skills
// and Commands page. The session in view's skills, commands and agents as the
// server reads them for its next turn (session_items), by kind, each with its
// source. Read only: the items come from the workspace, the picked playbook
// and the user's folders, and nothing here changes any of them.
//
// Asks the session for its list once when it opens without one. Styles:
// styles/skillspane.css.

import { useEffect, useRef } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { ITEM_KINDS, sourceLabel, wantsItems, type SessionItems } from "../state/sessionItems";

export function SessionItemsSection({
  items,
  onAsk,
}: {
  /** The session's items, or null while it has sent none. */
  items: SessionItems | null;
  /** Asks the session for its items; absent where no session is in view. */
  onAsk?: () => void;
}) {
  const lang = useLang();
  const asked = useRef(false);
  useEffect(() => {
    if (onAsk !== undefined && wantsItems(true, items, asked.current)) {
      asked.current = true;
      onAsk();
    }
  }, [items, onAsk]);

  return (
    <section className="skills-commands skills-session" aria-label={t(lang, "skv.session")}>
      <h3 className="skills-commands-title">{t(lang, "skv.session")}</h3>
      <p className="skills-claim">{t(lang, "skv.sessionClaim")}</p>
      {items === null ? (
        <p className="skills-claim" role="status">
          {t(lang, "skv.sessionNone")}
        </p>
      ) : (
        ITEM_KINDS.map((kind) => {
          const rows = items.items.filter((i) => i.kind === kind);
          if (rows.length === 0) return null;
          return (
            <div className="skills-commands-group" key={kind}>
              <h4 className="skills-commands-group-title">{t(lang, `skv.kind.${kind}`)}</h4>
              <ul className="skills-commands-list">
                {rows.map((item) => (
                  <li className="skills-command" data-item={item.name} key={`${item.source}:${item.name}`}>
                    <span className="skills-command-names">
                      <code className="skills-command-name">
                        {kind === "agent" ? item.name : `/${item.name}`}
                      </code>
                      <span className="wsg-scope-tag" data-source={item.source}>
                        {sourceLabel(
                          { source: item.source, sourceName: items.playbook?.name ?? item.namespace },
                          lang,
                        )}
                      </span>
                    </span>
                    <span className="skills-command-help">{item.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
