// Card 506: the workflows of the loaded playbook, each with a Run control. A
// workflow that reads as a step list (state "runnable") runs in this session:
// Run sends the file, the hash the contents list shows and the text typed
// beside it, and the run shows in the chat, with the fan-out drawn as card 505
// draws one. A file that is not a step list, or that starts a worker
// helper (it can write, and a workflow starts without a sheet), is listed
// and not run.
//
// The stylesheet is styles/playbook.css, imported by app.css.

import { useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { ContentItem } from "../state/playbookContents";

/** The characters of a hash the list shows; the title carries the rest. */
const HASH_SHOWN = 12;

/**
 * @param props.items  the contents list of the loaded playbook; only workflows are drawn
 * @param props.canRun true when a live session with a workspace can take a run
 * @param props.onRun  sends the start frame; true when it reached the socket
 */
export function WorkflowList({
  items,
  canRun,
  onRun,
}: {
  items: ContentItem[];
  canRun: boolean;
  onRun: (file: string, hash: string, input: string) => boolean;
}) {
  const lang = useLang();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [started, setStarted] = useState<string | null>(null);
  const workflows = items.filter((i) => i.kind === "workflow");
  if (workflows.length === 0) return null;
  return (
    <section className="pb-section wf-list" aria-label={t(lang, "wf.title")}>
      <h3 className="pb-h">{t(lang, "wf.title")}</h3>
      <p className="wf-hint">{t(lang, canRun ? "wf.hint" : "wf.needsSession")}</p>
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
              <div className="wf-row">
                <input
                  className="wf-input"
                  type="text"
                  value={inputs[w.source] ?? ""}
                  placeholder={t(lang, "wf.input")}
                  aria-label={t(lang, "wf.input")}
                  spellCheck={false}
                  onChange={(e) => setInputs((all) => ({ ...all, [w.source]: e.target.value }))}
                />
                <button
                  type="button"
                  className="wf-run"
                  disabled={!canRun}
                  onClick={() => {
                    if (onRun(w.source, w.sha256, inputs[w.source] ?? "")) setStarted(w.name);
                  }}
                >
                  {t(lang, "wf.run")}
                </button>
              </div>
            ) : (
              <p className="wf-note">{t(lang, "wf.notRunnable")}</p>
            )}
          </li>
        ))}
      </ul>
      {started !== null && (
        <p className="wf-notice" role="status">
          {t(lang, "wf.started", { name: started })}
        </p>
      )}
    </section>
  );
}
