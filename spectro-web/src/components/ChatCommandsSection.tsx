// Card 554, task 11 (owner answer 6): the chat commands on the Skills and
// Commands page, from the one shared list the server serves. Every row the web
// chat runs, grouped, each with its spellings and its help in the page
// language; the rows the picker offers in developer mode only are marked.
// Card 588: a row that has a template shows it, in the page's language.
// Read-only: a command is typed in the chat.
//
// Its own component so the page keeps no reader of its own; the list's store
// asks for it (state/commandList.ts). Styles: styles/skillspane.css.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { helpOf, usageOf, useCommandList, webCommands } from "../state/commandList";
import { spellingsOf } from "../state/chatCommands";

export function ChatCommandsSection() {
  const lang = useLang();
  const { rows } = useCommandList();
  const web = rows === null ? [] : webCommands(rows);
  const groups = [...new Set(web.map((row) => row.group))];

  return (
    <section className="skills-commands" aria-label={t(lang, "skv.commands")}>
      <h3 className="skills-commands-title">{t(lang, "skv.commands")}</h3>
      <p className="skills-claim">{t(lang, "skv.commandsClaim")}</p>
      {rows === null ? (
        <p className="skills-claim" role="status">
          {t(lang, "slash.loading")}
        </p>
      ) : (
        groups.map((group) => (
          <div className="skills-commands-group" key={group}>
            <h4 className="skills-commands-group-title">{t(lang, `cmd.group.${group}`)}</h4>
            <ul className="skills-commands-list">
              {web
                .filter((row) => row.group === group)
                .map((row) => (
                  <li className="skills-command" data-command={row.id} key={row.id}>
                    <span className="skills-command-names">
                      {spellingsOf(row).map((spelling) => (
                        <code className="skills-command-name" key={spelling}>{`/${spelling}`}</code>
                      ))}
                      {row.developerOnly && (
                        <span className="wsg-scope-tag">{t(lang, "skv.developerOnly")}</span>
                      )}
                    </span>
                    <span className="skills-command-help">{helpOf(row, lang)}</span>
                    {usageOf(row, lang) !== null && (
                      <code className="skills-command-usage">{usageOf(row, lang)}</code>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
