// Card 506: the workflows of the loaded playbook. Card 554 (criterion 8a): a
// workflow starts from the chat of a session with /playbook workflow <name>
// <input> and runs at once there, so this list only lists: each workflow with
// its hash, and for one that reads as a step list (state "runnable") the
// command that runs it. A file that is not a step list, or that starts a
// worker helper (it can write, and a workflow starts without a sheet), is
// listed and says it does not run.
//
// The stylesheet is styles/playbook-run.css, imported by app.css.

import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { ContentItem } from "../state/playbookContents";

/** The characters of a hash the list shows; the title carries the rest. */
const HASH_SHOWN = 12;

/**
 * The chat command that runs a workflow: its file below workflows/ without
 * the extension, the name the server reads.
 *
 * @param source the workflow's path in the playbook folder, workflows/<name>.json
 */
export function workflowCommand(source: string): string {
  const name = source.replace(/^workflows\//, "").replace(/\.[^./]+$/, "");
  return `/playbook workflow ${name}`;
}

/**
 * @param props.items the contents list of the loaded playbook; only workflows are drawn
 */
export function WorkflowList({ items }: { items: ContentItem[] }) {
  const lang = useLang();
  const workflows = items.filter((i) => i.kind === "workflow");
  if (workflows.length === 0) return null;
  return (
    <section className="pb-section wf-list" aria-label={t(lang, "wf.title")}>
      <h3 className="pb-h">{t(lang, "wf.title")}</h3>
      <p className="wf-hint">{t(lang, "wf.fromChat")}</p>
      <ul className="wf-items">
        {workflows.map((w) => (
          <li className="wf-item" data-name={w.name} key={w.source}>
            <div className="wf-head">
              <span className="wf-name">{w.name}</span>
              <code className="pc-hash" title={w.sha256}>
                {w.sha256.slice(0, HASH_SHOWN)}
              </code>
            </div>
            {w.state === "runnable" ? (
              <code className="wf-command">{workflowCommand(w.source)}</code>
            ) : (
              <p className="wf-note">{t(lang, "wf.notRunnable")}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
