// Spectrolyzr as one page (card 515, decisions A and C; the three step wizard
// of card 484 before it). A view of the playbook segment in a chunk of its
// own: learn and light never open that segment, so they never request this
// file. A switch at the top says what the page makes, a new project or a new
// playbook. For a project every choice is in sight at once (archetype,
// language, name, add-ons, the folders), the file tree with the Why sentence
// sits beside them, Generate is at the bottom. The choices live in
// state/spectrolyzr.ts, so a switch of segment keeps them. The stylesheet is
// styles/spectrolyzr.css, imported by app.css: a surface chunk carries no
// stylesheet of its own.

import { useEffect, useState } from "react";
import { t, type Lang } from "../../i18n/i18n";
import { chooseFolder, usePickNote } from "../../state/folderPick";
import { useLang } from "../../state/lang";
import {
  choose,
  chooseKind,
  generate,
  loadCatalog,
  nameUsable,
  useLyzr,
  type LyzrFile,
  type LyzrKind,
  type LyzrResult,
} from "../../state/spectrolyzr";
import { FileTree, fileKey } from "./FileTree";
import { effectivePlaybookDir, followingPlaybookDir, PLAYBOOK_ADDON } from "./folders";

/** The field a 400 answer named, and the server's words for it. */
type Invalid = { field: string; message: string } | null;

/** The fields the page draws; a 400 naming another field shows its message above Generate. */
const FIELDS = ["archetype", "language", "name", "addons", "dir", "playbookDir"];

/** The class suffix that marks a field the last answer refused. */
function mark(invalid: Invalid, field: string): string {
  return invalid !== null && invalid.field === field ? " is-invalid" : "";
}

/** The error line under a refused field, or nothing. */
function FieldError({ invalid, field }: { invalid: Invalid; field: string }) {
  if (invalid === null || invalid.field !== field) return null;
  return (
    <p className="lyzr-error" role="alert">
      {invalid.message}
    </p>
  );
}

function copy(dir: string): void {
  void navigator.clipboard?.writeText(dir).catch(() => {});
}

const KINDS: { kind: LyzrKind; label: string }[] = [
  { kind: "project", label: "lyzr.kind.project" },
  { kind: "playbook", label: "lyzr.kind.playbook" },
];

/** The switch at the top: a new project or a new playbook. */
function KindSwitch({ kind, lang }: { kind: LyzrKind; lang: Lang }) {
  return (
    <div className="lyzr-kind" role="group" aria-label={t(lang, "lyzr.kind")}>
      {KINDS.map((k) => (
        <button
          key={k.kind}
          type="button"
          className={`lyzr-kind-option${kind === k.kind ? " is-on" : ""}`}
          aria-pressed={kind === k.kind}
          onClick={() => chooseKind(k.kind)}
        >
          {t(lang, k.label)}
        </button>
      ))}
    </div>
  );
}

/** Archetype, language, name and add-ons of a new project. */
export function ProjectChoices({ invalid }: { invalid: Invalid }) {
  const lang = useLang();
  const { catalog, choices } = useLyzr();
  if (catalog === null) return <p className="lyzr-hint">{t(lang, "lyzr.loading")}</p>;
  const nameBad = choices.name !== "" && !nameUsable(choices.name);

  return (
    <>
      <section className="lyzr-section">
        <h3 className="lyzr-h">{t(lang, "lyzr.archetype")}</h3>
        <div className={`lyzr-cards${mark(invalid, "archetype")}`}>
          {catalog.archetypes.map((a) => {
            const on = choices.archetype === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`lyzr-card${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => choose({ archetype: a.id })}
              >
                <span className="lyzr-card-name">{a.name[lang]}</span>
                <span className="lyzr-card-line">{a.description[lang]}</span>
              </button>
            );
          })}
        </div>
        <FieldError invalid={invalid} field="archetype" />
      </section>

      <section className="lyzr-section">
        <h3 className="lyzr-h">{t(lang, "lyzr.language")}</h3>
        <div
          className={`lyzr-langs${mark(invalid, "language")}`}
          role="group"
          aria-label={t(lang, "lyzr.language")}
        >
          {catalog.languages.map((l) => {
            const on = choices.language === l.id;
            return (
              <button
                key={l.id}
                type="button"
                className={`lyzr-lang${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => choose({ language: l.id })}
              >
                {l.name}
              </button>
            );
          })}
        </div>
        <FieldError invalid={invalid} field="language" />
      </section>

      <section className="lyzr-section">
        <label className="lyzr-field">
          <span className="lyzr-label">{t(lang, "lyzr.name")}</span>
          <input
            className={`lyzr-name lyzr-input${nameBad ? " is-invalid" : mark(invalid, "name")}`}
            type="text"
            value={choices.name}
            maxLength={40}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => choose(followingPlaybookDir(choices, { name: e.target.value }))}
          />
        </label>
        <p className="lyzr-hint">{t(lang, "lyzr.nameRule")}</p>
        <FieldError invalid={invalid} field="name" />
      </section>

      <section className="lyzr-section">
        <h3 className="lyzr-h">{t(lang, "lyzr.addons")}</h3>
        <div className={`lyzr-addons${mark(invalid, "addons")}`}>
          {catalog.addons.map((a) => {
            const on = choices.addons.includes(a.id);
            return (
              <label key={a.id} className="lyzr-addon-row">
                <input
                  type="checkbox"
                  className="lyzr-addon"
                  checked={on}
                  onChange={() =>
                    choose({
                      addons: on ? choices.addons.filter((x) => x !== a.id) : [...choices.addons, a.id],
                    })
                  }
                />
                <span className="lyzr-addon-text">
                  <span className="lyzr-addon-name">{a.name[lang]}</span>
                  <span className="lyzr-addon-line">{a.description[lang]}</span>
                </span>
              </label>
            );
          })}
        </div>
        <FieldError invalid={invalid} field="addons" />
      </section>
    </>
  );
}

/** The project folder with the native picker (the shared helper of card 512). */
export function ProjectDirField({ invalid }: { invalid: Invalid }) {
  const lang = useLang();
  const { choices } = useLyzr();
  const pickNote = usePickNote("lyzrDir");
  return (
    <>
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
            onChange={(e) => choose(followingPlaybookDir(choices, { dir: e.target.value }))}
          />
        </label>
        <button
          type="button"
          className="lyzr-pick"
          onClick={() =>
            void chooseFolder("lyzrDir", (path) => choose(followingPlaybookDir(choices, { dir: path })))
          }
        >
          {t(lang, "lyzr.pick")}
        </button>
      </div>
      {pickNote !== null && (
        <p className="lyzr-hint" role="status">
          {pickNote}
        </p>
      )}
      <FieldError invalid={invalid} field="dir" />
    </>
  );
}

/**
 * The playbook folder with its Choose button. Beside a new project it holds
 * the sibling of the project folder until the owner types another; for a new
 * playbook it holds only what the owner typed or chose.
 */
export function PlaybookDirField({ invalid, kind }: { invalid: Invalid; kind: LyzrKind }) {
  const lang = useLang();
  const { choices } = useLyzr();
  const pickNote = usePickNote("lyzrPlaybook");
  const value = kind === "project" ? effectivePlaybookDir(choices) : choices.playbookDir;
  return (
    <>
      <div className="lyzr-target">
        <label className="lyzr-field">
          <span className="lyzr-label">{t(lang, "lyzr.playbookDir")}</span>
          <input
            className={`lyzr-playbook-dir lyzr-input${mark(invalid, "playbookDir")}`}
            type="text"
            value={value}
            placeholder={t(lang, "lyzr.typePath")}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => choose({ playbookDir: e.target.value })}
          />
        </label>
        <button
          type="button"
          className="lyzr-choose"
          onClick={() => void chooseFolder("lyzrPlaybook", (path) => choose({ playbookDir: path }))}
        >
          {t(lang, "pick.choose")}
        </button>
      </div>
      {pickNote !== null && (
        <p className="lyzr-hint" role="status">
          {pickNote}
        </p>
      )}
      <p className="lyzr-hint">
        {t(lang, kind === "project" ? "lyzr.playbookDirHint" : "lyzr.playbookOnlyHint")}
      </p>
      <FieldError invalid={invalid} field="playbookDir" />
    </>
  );
}

/** The file tree beside the choices, the selected file's Why sentence and content, and the summary. */
export function FilesColumn() {
  const lang = useLang();
  const { choices, preview } = useLyzr();
  const [selected, setSelected] = useState<string | null>(null);

  const files: LyzrFile[] = preview?.files ?? [];
  const shown = files.find((f) => fileKey(f) === selected) ?? files[0] ?? null;
  const playbookOn = choices.addons.includes(PLAYBOOK_ADDON);
  const playbookDir = effectivePlaybookDir(choices);
  const projectCount = files.filter((f) => f.root === "project").length;
  const playbookCount = files.filter((f) => f.root === "playbook").length;
  const notSet = t(lang, "lyzr.notSet");

  return (
    <aside className="lyzr-files" aria-label={t(lang, "lyzr.tree")}>
      <h3 className="lyzr-h">{t(lang, "lyzr.tree")}</h3>
      {files.length === 0 ? (
        <p className="lyzr-hint">{t(lang, "lyzr.treeEmpty")}</p>
      ) : (
        <>
          <FileTree files={files} selected={shown === null ? null : fileKey(shown)} onSelect={setSelected} />
          {shown !== null && (
            <div className="lyzr-reader">
              <h4 className="lyzr-h">{t(lang, "lyzr.why")}</h4>
              <p className="lyzr-why">{shown.why[lang]}</p>
              <p className="lyzr-path">{shown.path}</p>
              <pre className="lyzr-content">{shown.content}</pre>
            </div>
          )}
        </>
      )}

      <section className="lyzr-summary" aria-label={t(lang, "lyzr.summary")}>
        <h3 className="lyzr-h">{t(lang, "lyzr.summary")}</h3>
        <dl>
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
    </aside>
  );
}

/** What the last answer said: the written folders, the conflicting paths per folder, or a failure. */
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

/** The page that generates a project and its playbook, or a playbook alone. */
export function SpectrolyzrPage() {
  const lang = useLang();
  const s = useLyzr();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (s.catalog !== null) return;
    loadCatalog().catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [s.catalog]);

  const c = s.choices;
  const project = s.kind === "project";
  const invalid = s.result?.kind === "invalid" ? { field: s.result.field, message: s.result.message } : null;
  const playbookOn = c.addons.includes(PLAYBOOK_ADDON);
  // The playbook side is drawn here; its Generate is wired by card 515 part two.
  const ready =
    project &&
    s.preview !== null &&
    c.dir.trim() !== "" &&
    (!playbookOn || effectivePlaybookDir(c) !== "") &&
    !busy;

  const run = async (): Promise<void> => {
    if (playbookOn && c.playbookDir === "") choose({ playbookDir: effectivePlaybookDir(c) });
    setBusy(true);
    try {
      await generate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lyzr" aria-label={t(lang, "lyzr.title")}>
      <h2 className="lyzr-title">{t(lang, "lyzr.title")}</h2>
      <KindSwitch kind={s.kind} lang={lang} />
      {notice !== null && (
        <p className="lyzr-error" role="alert">
          {notice}
        </p>
      )}

      <div className="lyzr-page">
        <div className="lyzr-form">
          {project ? (
            <>
              <ProjectChoices invalid={invalid} />
              <section className="lyzr-section">
                <h3 className="lyzr-h">{t(lang, "lyzr.folders")}</h3>
                <ProjectDirField invalid={invalid} />
                {playbookOn && <PlaybookDirField invalid={invalid} kind="project" />}
              </section>
            </>
          ) : (
            <section className="lyzr-section">
              <h3 className="lyzr-h">{t(lang, "lyzr.folders")}</h3>
              <PlaybookDirField invalid={invalid} kind="playbook" />
            </section>
          )}
        </div>
        {project && <FilesColumn />}
      </div>

      {invalid !== null && !FIELDS.includes(invalid.field) && (
        <p className="lyzr-error" role="alert">
          {invalid.message}
        </p>
      )}
      <div className="lyzr-go">
        <button type="button" className="lyzr-generate" disabled={!ready} onClick={() => void run()}>
          {t(lang, "lyzr.generate")}
        </button>
      </div>
      <Outcome result={s.result} lang={lang} />
    </section>
  );
}

/** The parts the page draws that keep hooks of their own, for the drive kit of the click tests. */
export const PAGE_PARTS: unknown[] = [ProjectChoices, ProjectDirField, PlaybookDirField, FilesColumn];
