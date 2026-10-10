// Step 3 of the Spectrolyzr wizard (card 484): the file tree beside the reader
// (the selected file's Why sentence and content), the summary, the project
// folder with the native picker, Generate, and what the last answer said:
// the written files, the conflicting paths per folder, or a refused field.

import { useState } from "react";
import { t, type Lang } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import { choose, useLyzr, type LyzrFile, type LyzrResult } from "../../state/spectrolyzr";
import { FileTree, fileKey } from "./FileTree";
import { effectivePlaybookDir, PLAYBOOK_ADDON } from "./StepAddons";
import { FieldError, mark, type Invalid } from "./StepProject";

function copy(dir: string): void {
  void navigator.clipboard?.writeText(dir).catch(() => {});
}

function Outcome({ result, lang }: { result: LyzrResult | null; lang: Lang }) {
  if (result === null) return null;
  if (result.kind === "written") {
    const roots = [result.project, ...(result.playbook === null ? [] : [result.playbook])];
    return (
      <div className="lyzr-result is-done" role="status">
        {roots.map((r) => (
          <p key={r.dir} className="lyzr-written">
            <span>{t(lang, "lyzr.written", { n: r.written.length, dir: r.dir })}</span>
            <button type="button" className="lyzr-copy" onClick={() => copy(r.dir)}>
              {t(lang, "lyzr.copyPath")}
            </button>
          </p>
        ))}
        {result.pinned && <p className="lyzr-pinned">{t(lang, "lyzr.pinned")}</p>}
      </div>
    );
  }
  if (result.kind === "conflicts") {
    const lists: [string, string[]][] = [
      ["lyzr.dir", result.project],
      ["lyzr.playbookDir", result.playbook],
    ];
    return (
      <div className="lyzr-result is-conflict" role="alert">
        <p className="lyzr-result-head">{t(lang, "lyzr.conflicts")}</p>
        {lists
          .filter(([, paths]) => paths.length > 0)
          .map(([label, paths]) => (
            <div key={label}>
              <p className="lyzr-label">{t(lang, label)}</p>
              <ul className="lyzr-conflicts">
                {paths.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    );
  }
  if (result.kind === "failed") {
    return (
      <p className="lyzr-error" role="alert">
        {result.message}
      </p>
    );
  }
  return null;
}

/** The tree, the reader, the summary, the folder and Generate. */
export function StepReview({
  invalid,
  busy,
  onGenerate,
}: {
  invalid: Invalid;
  busy: boolean;
  onGenerate: () => void;
}) {
  const lang = useLang();
  const { catalog, choices, preview, result } = useLyzr();
  const [selected, setSelected] = useState<string | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);

  const files: LyzrFile[] = preview?.files ?? [];
  const shown = files.find((f) => fileKey(f) === selected) ?? files[0] ?? null;
  const playbookOn = choices.addons.includes(PLAYBOOK_ADDON);
  const playbookDir = effectivePlaybookDir(choices);
  const projectCount = files.filter((f) => f.root === "project").length;
  const playbookCount = files.filter((f) => f.root === "playbook").length;
  const archetype = catalog?.archetypes.find((a) => a.id === choices.archetype);
  const language = catalog?.languages.find((l) => l.id === choices.language);
  const addonNames = (catalog?.addons ?? [])
    .filter((a) => choices.addons.includes(a.id))
    .map((a) => a.name[lang]);
  const ready = preview !== null && choices.dir.trim() !== "" && (!playbookOn || playbookDir !== "") && !busy;
  const notSet = t(lang, "lyzr.notSet");

  const pick = async (): Promise<void> => {
    setPickNote(null);
    try {
      const res = await fetch("/api/pick-workspace", { method: "POST" });
      if (res.status === 200) {
        const { path } = (await res.json()) as { path: string };
        choose({ dir: path });
      } else if (res.status === 409) {
        setPickNote(t(lang, "lyzr.pickBusy"));
      } else if (res.status !== 204) {
        setPickNote(t(lang, "lyzr.pickUnavailable"));
      }
    } catch {
      setPickNote(t(lang, "lyzr.pickUnavailable"));
    }
  };

  return (
    <div className="lyzr-step">
      <div className="lyzr-review">
        <FileTree files={files} selected={shown === null ? null : fileKey(shown)} onSelect={setSelected} />
        <div className="lyzr-reader">
          {shown !== null && (
            <>
              <h4 className="lyzr-h">{t(lang, "lyzr.why")}</h4>
              <p className="lyzr-why">{shown.why[lang]}</p>
              <p className="lyzr-path">{shown.path}</p>
              <pre className="lyzr-content">{shown.content}</pre>
            </>
          )}
        </div>
      </div>

      <section className="lyzr-summary" aria-label={t(lang, "lyzr.summary")}>
        <h3 className="lyzr-h">{t(lang, "lyzr.summary")}</h3>
        <dl>
          <dt>{t(lang, "lyzr.archetype")}</dt>
          <dd>{archetype?.name[lang] ?? notSet}</dd>
          <dt>{t(lang, "lyzr.language")}</dt>
          <dd>{language?.name ?? notSet}</dd>
          <dt>{t(lang, "lyzr.step.addons")}</dt>
          <dd>{addonNames.length > 0 ? addonNames.join(", ") : t(lang, "lyzr.none")}</dd>
          <dt>{t(lang, "lyzr.dir")}</dt>
          <dd>
            {t(lang, "lyzr.files", { n: projectCount })}, {choices.dir.trim() !== "" ? choices.dir : notSet}
          </dd>
          {playbookOn && (
            <>
              <dt>{t(lang, "lyzr.playbookDir")}</dt>
              <dd>
                {t(lang, "lyzr.files", { n: playbookCount })}, {playbookDir !== "" ? playbookDir : notSet}
              </dd>
            </>
          )}
          <dt>{t(lang, "lyzr.testCommand")}</dt>
          <dd>{preview?.commands.test ?? notSet}</dd>
          <dt>{t(lang, "lyzr.checkCommand")}</dt>
          <dd>{preview?.commands.check ?? notSet}</dd>
        </dl>
      </section>

      <div className="lyzr-target">
        <label className="lyzr-field">
          <span className="lyzr-label">{t(lang, "lyzr.dir")}</span>
          <input
            className={`lyzr-dir lyzr-input${mark(invalid, "dir")}`}
            type="text"
            value={choices.dir}
            placeholder={t(lang, "lyzr.typePath")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => choose({ dir: e.target.value })}
          />
        </label>
        <button type="button" className="lyzr-pick" onClick={() => void pick()}>
          {t(lang, "lyzr.pick")}
        </button>
      </div>
      {pickNote !== null && (
        <p className="lyzr-hint" role="status">
          {pickNote}
        </p>
      )}
      <FieldError invalid={invalid} field="dir" />
      {invalid !== null &&
        !["archetype", "language", "name", "addons", "playbookDir", "dir"].includes(invalid.field) && (
          <p className="lyzr-error" role="alert">
            {invalid.message}
          </p>
        )}

      <div className="lyzr-go">
        <button type="button" className="lyzr-generate" disabled={!ready} onClick={onGenerate}>
          {t(lang, "lyzr.generate")}
        </button>
      </div>
      <Outcome result={result} lang={lang} />
    </div>
  );
}
