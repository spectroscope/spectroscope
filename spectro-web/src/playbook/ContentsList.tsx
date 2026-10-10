// Card 485: what a playbook folder brings, as a read only list. One section per
// kind in the order skills, commands, hooks, agents, workflows. Each item shows
// its name, where it comes from, its state, the start of its hash (the whole
// hash in the title) and the sentence that says who sees it. A hook shows the
// command that would run and every file it ships, in full: a person decides on
// this list, so nothing a hook runs is left out of it.
//
// The install dialog and the run confirmation both draw this list; neither adds
// a control to it. The stylesheet is styles/playbook.css, imported by app.css.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  changedItems,
  type ContentItem,
  type ContentKind,
  type ContentState,
  type ContentsPreview,
} from "../state/playbookContents";

const ORDER: ContentKind[] = ["skill", "command", "hook", "agent", "workflow"];

const SCOPE_KEY: Record<ContentItem["scope"], string> = {
  sessions: "pc.scope.sessions",
  "tool-calls": "pc.scope.toolCalls",
  runs: "pc.scope.runs",
  none: "pc.scope.none",
};

const STATE_KEY: Record<ContentState, string> = {
  new: "pc.state.new",
  same: "pc.state.same",
  "source-changed": "pc.state.sourceChanged",
  "copy-changed": "pc.state.copyChanged",
  taken: "pc.state.taken",
  "not-run": "pc.state.notRun",
};

/** The characters of a hash the list shows; the title carries the rest. */
const HASH_SHOWN = 12;

export function ContentsList({
  preview,
  readOnly,
  onlyChanged,
}: {
  preview: ContentsPreview;
  /** True where the list is only shown for reading, as in the run confirmation. */
  readOnly: boolean;
  /** True to list only the items changed since the install. */
  onlyChanged: boolean;
}) {
  const lang = useLang();
  const items = onlyChanged ? changedItems(preview) : preview.items;
  return (
    <div className={`pc-list${readOnly ? " pc-list--readonly" : ""}`}>
      {ORDER.map((kind) => {
        const ofKind = items.filter((i) => i.kind === kind);
        if (ofKind.length === 0) return null;
        return (
          <section className="pc-kind" data-kind={kind} key={kind}>
            <h4 className="pc-kind-h">{t(lang, `pc.kind.${kind}`)}</h4>
            <ul className="pc-items">
              {ofKind.map((item) => (
                <li className="pc-item" data-name={item.name} key={`${item.source}#${item.name}`}>
                  <div className="pc-item-head">
                    <span className="pc-name">{item.name}</span>
                    <span className="pc-state" data-state={item.state}>
                      {t(lang, STATE_KEY[item.state], { target: item.target ?? "" })}
                    </span>
                    <code className="pc-hash" title={item.sha256}>
                      {item.sha256.slice(0, HASH_SHOWN)}
                    </code>
                  </div>
                  <code className="pc-source">{item.source}</code>
                  <p className="pc-scope">{t(lang, SCOPE_KEY[item.scope])}</p>
                  {item.kind === "hook" && item.command !== null && (
                    <p className="pc-command">
                      <code>{item.command}</code>
                    </p>
                  )}
                  {item.kind === "hook" &&
                    item.files.map((f) => (
                      <div className="pc-file" key={f.path}>
                        <span className="pc-file-path">{f.path}</span>
                        <pre className="pc-pre">{f.text}</pre>
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
