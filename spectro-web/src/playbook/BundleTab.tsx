// Card 525: the kind tabs and the Files tab of the playbook pane. One
// component for all six, driven by the tab's spec in PANE_TABS: the contents
// entries of the kind (listed, on disk only, or listed but missing), the
// shared file browser scoped to the kind's folder, and on the right the
// selected text file in a textarea with a preview beside it. KindTools puts
// the tab's own buttons into the pane's toolbar; the panels they open (the
// skill picker, the hooks import, the New forms) and the remove confirmation
// are drawn here, under the toolbar.
//
// Every write goes through the routes of cards 522 and 523 (state/
// bundleEditor.ts); the server decides, and a refusal is shown with its
// reason in the chosen language.

import { useState, type KeyboardEvent } from "react";
import { Markdown } from "../components/Markdown";
import { t } from "../i18n/i18n";
import {
  askRemove,
  cancelRemove,
  closePanel,
  deleteFile,
  discardEdits,
  editText,
  entriesOf,
  fileDirty,
  importHooks,
  importSkills,
  listEntry,
  loadSources,
  newAgent,
  newCommand,
  openPanel,
  openPath,
  opensGraph,
  PROTECTED,
  reasonText,
  reloadFile,
  removeEntry,
  removeUnlisted,
  saveFile,
  scopeTree,
  scopeTruncated,
  useBundleEditor,
  type KindId,
  type PaneTabSpec,
  type SkillItem,
} from "../state/bundleEditor";
import { useLang } from "../state/lang";
import type { LoadedPlaybook } from "../state/playbooks";
import { FileBrowser } from "../workspace/FileBrowser";
import { SourceView } from "../workspace/SourceView";

/** The agent types the template of card 523 accepts. */
const AGENT_TYPES = ["explore", "worker", "research"];

/**
 * The buttons a tab adds to the pane's toolbar, before Export and Import ZIP.
 *
 * @param props.spec the tab
 * @param props.dir  the folder shown
 */
export function KindTools({
  spec,
  dir,
  workspace,
}: {
  spec: PaneTabSpec;
  dir: string;
  workspace: string | null;
}) {
  const lang = useLang();
  const s = useBundleEditor();
  const busy = s.busy || fileDirty(s);
  switch (spec.kind) {
    case "skills":
      return (
        <button
          type="button"
          className="pbb-import-skills"
          disabled={busy}
          onClick={() => {
            openPanel("import-skills");
            void loadSources(dir, workspace);
          }}
        >
          {t(lang, "pbb.skills.import")}
        </button>
      );
    case "hooks":
      return (
        <button
          type="button"
          className="pbb-import-hooks"
          disabled={busy}
          onClick={() => {
            openPanel("import-hooks");
            void loadSources(dir, workspace);
          }}
        >
          {t(lang, "pbb.hooks.import")}
        </button>
      );
    case "agents":
    case "commands":
      return (
        <button
          type="button"
          className="pbb-new"
          disabled={busy}
          onClick={() => openPanel(spec.kind === "agents" ? "new-agent" : "new-command")}
        >
          {t(lang, "pbb.new")}
        </button>
      );
    default:
      return null;
  }
}

const skillKey = (item: SkillItem): string =>
  item.source === "installed"
    ? `installed:${item.root}:${item.pack ?? ""}:${item.name}`
    : `catalogue:${item.pack}:${item.name}`;

/**
 * The picker over the import sources: installed skills, then the catalogue,
 * each with a checkbox. A skill already in the playbook or one the server
 * will not import is shown and cannot be ticked.
 */
export function SkillPicker({ dir, workspace }: { dir: string; workspace: string | null }) {
  const lang = useLang();
  const s = useBundleEditor();
  const [ticked, setTicked] = useState<ReadonlyMap<string, SkillItem>>(new Map());
  const sources = s.sources;

  const toggle = (item: SkillItem): void => {
    setTicked((was) => {
      const next = new Map(was);
      const key = skillKey(item);
      if (next.has(key)) next.delete(key);
      else next.set(key, item);
      return next;
    });
  };

  const row = (item: SkillItem, description: string, off: boolean, note: string | null) => {
    const key = skillKey(item);
    const label = item.pack === null || item.pack === "" ? item.name : `${item.pack}:${item.name}`;
    return (
      <li key={key} className="pbb-pick-row">
        <label>
          <input
            type="checkbox"
            checked={ticked.has(key)}
            disabled={off}
            data-skill={key}
            onChange={() => toggle(item)}
          />
          <span className="pbb-pick-name">{label}</span>
          {note !== null && <span className="pbb-pick-note">{note}</span>}
        </label>
        {description !== "" && <p className="pbb-pick-description">{description}</p>}
      </li>
    );
  };

  return (
    <section className="pbb-picker" aria-label={t(lang, "pbb.picker.title")}>
      <h3 className="pb-h">{t(lang, "pbb.picker.title")}</h3>
      {sources === null ? (
        <p className="pbb-note">{t(lang, "pbb.picker.reading")}</p>
      ) : (
        <div className="pbb-pick-groups">
          <div className="pbb-pick-group">
            <h4 className="pbb-group">{t(lang, "pbb.picker.installed")}</h4>
            {sources.installed.length === 0 ? (
              <p className="pbb-note">{t(lang, "pbb.picker.none")}</p>
            ) : (
              <ul className="pbb-pick-list">
                {sources.installed.map((r) =>
                  row(
                    { source: "installed", root: r.root, pack: r.pack, name: r.name },
                    r.description,
                    r.inPlaybook || !r.importable,
                    r.inPlaybook ? t(lang, "pbb.picker.in") : (r.why ?? null),
                  ),
                )}
              </ul>
            )}
          </div>
          <div className="pbb-pick-group">
            <h4 className="pbb-group">{t(lang, "pbb.picker.catalogue")}</h4>
            {sources.catalogue.length === 0 ? (
              <p className="pbb-note">{t(lang, "pbb.picker.none")}</p>
            ) : (
              <ul className="pbb-pick-list">
                {sources.catalogue.map((r) =>
                  row(
                    { source: "catalogue", pack: r.pack, name: r.name },
                    r.description,
                    r.inPlaybook,
                    r.inPlaybook ? t(lang, "pbb.picker.in") : r.licence !== "" ? r.licence : null,
                  ),
                )}
              </ul>
            )}
          </div>
        </div>
      )}
      <div className="pbb-panel-actions">
        <button
          type="button"
          className="pbb-picker-go"
          disabled={ticked.size === 0 || s.busy}
          onClick={() => void importSkills(dir, workspace, [...ticked.values()])}
        >
          {t(lang, "pbb.picker.go")}
        </button>
        <button type="button" className="pbb-cancel" onClick={closePanel}>
          {t(lang, "pbb.cancel")}
        </button>
      </div>
    </section>
  );
}

/** The hooks of the user settings, and the button that copies them into the playbook. */
export function HooksImport({ dir, workspace }: { dir: string; workspace: string | null }) {
  const lang = useLang();
  const s = useBundleEditor();
  const sources = s.sources;
  return (
    <section className="pbb-picker" aria-label={t(lang, "pbb.hooks.import")}>
      <h3 className="pb-h">{t(lang, "pbb.hooks.import")}</h3>
      <p className="pbb-note">{t(lang, "pbb.hooks.hint", { placeholder: "{project}" })}</p>
      {sources === null ? (
        <p className="pbb-note">{t(lang, "pbb.picker.reading")}</p>
      ) : sources.hooks.length === 0 ? (
        <p className="pbb-note">{t(lang, "pbb.hooks.none")}</p>
      ) : (
        <>
          <ul className="pbb-pick-list">
            {sources.hooks.map((h, i) => (
              <li key={`${h.event}#${i}`} className="pbb-pick-row">
                <span className="pbb-pick-name">{h.event}</span>
                {h.matcher !== null && h.matcher !== "" && <span className="pbb-pick-note">{h.matcher}</span>}
                <code className="pb-mono pbb-hook-command">{h.command}</code>
                {h.left === "home-dot-folder" && (
                  <span className="pbb-pick-note pbb-hook-left">{t(lang, "pbb.hooks.leftOut")}</span>
                )}
                {h.left === "project-parent" && (
                  <span className="pbb-pick-note pbb-hook-left">{t(lang, "pbb.hooks.leftOutParent")}</span>
                )}
              </li>
            ))}
          </ul>
          {sources.hooksInPlaybook && <p className="pbb-note">{t(lang, "pbb.hooks.replace")}</p>}
        </>
      )}
      <div className="pbb-panel-actions">
        <button
          type="button"
          className="pbb-hooks-go"
          disabled={sources === null || sources.hooks.length === 0 || s.busy}
          onClick={() => void importHooks(dir, workspace, sources?.hooksInPlaybook ?? false)}
        >
          {t(lang, sources?.hooksInPlaybook === true ? "pbb.hooks.goReplace" : "pbb.hooks.go")}
        </button>
        <button type="button" className="pbb-cancel" onClick={closePanel}>
          {t(lang, "pbb.cancel")}
        </button>
      </div>
    </section>
  );
}

/** The New form of the Agents tab (name and type) and of the Commands tab (name). */
export function NewEntryForm({
  dir,
  workspace,
  kind,
}: {
  dir: string;
  workspace: string | null;
  kind: "agents" | "commands";
}) {
  const lang = useLang();
  const s = useBundleEditor();
  const [name, setName] = useState("");
  const [type, setType] = useState(AGENT_TYPES[0]);
  const go = (): void => {
    const n = name.trim();
    if (n === "") return;
    void (kind === "agents" ? newAgent(dir, workspace, n, type) : newCommand(dir, workspace, n));
  };
  const title = t(lang, kind === "agents" ? "pbb.new.agent" : "pbb.new.command");
  return (
    <section className="pbb-picker pbb-new-form" aria-label={title}>
      <h3 className="pb-h">{title}</h3>
      <div className="pbb-new-row">
        <label className="pbb-field">
          <span>{t(lang, "pbb.new.name")}</span>
          <input
            className="pbb-new-name"
            type="text"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
            }}
          />
        </label>
        {kind === "agents" && (
          <label className="pbb-field">
            <span>{t(lang, "pbb.new.type")}</span>
            <select className="pbb-new-type" value={type} onChange={(e) => setType(e.target.value)}>
              {AGENT_TYPES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="pbb-note">{t(lang, "pbb.new.nameHint")}</p>
      <div className="pbb-panel-actions">
        <button type="button" className="pbb-new-go" disabled={name.trim() === "" || s.busy} onClick={go}>
          {t(lang, "pbb.new.go")}
        </button>
        <button type="button" className="pbb-cancel" onClick={closePanel}>
          {t(lang, "pbb.cancel")}
        </button>
      </div>
    </section>
  );
}

/** The question before an entry is removed from contents and from the folder. */
export function RemoveConfirm({ dir, workspace }: { dir: string; workspace: string | null }) {
  const lang = useLang();
  const s = useBundleEditor();
  const c = s.confirm;
  if (c === null) return null;
  return (
    <div className="pbb-confirm" role="alertdialog" aria-label={t(lang, "pbb.remove")}>
      <p className="pbb-note">
        {t(lang, c.listed ? "pbb.confirm.remove" : "pbb.confirm.removeUnlisted", { path: c.path })}
      </p>
      <div className="pbb-panel-actions">
        <button
          type="button"
          className="pbb-confirm-go"
          disabled={s.busy}
          onClick={() =>
            void (c.listed
              ? removeEntry(dir, workspace, c.kind, c.path)
              : removeUnlisted(dir, workspace, c.kind, c.path))
          }
        >
          {t(lang, "pbb.confirm.go")}
        </button>
        <button type="button" className="pbb-cancel" onClick={cancelRemove}>
          {t(lang, "pbb.cancel")}
        </button>
      </div>
    </div>
  );
}

/** The contents entries of a kind, each with its state, List it for one on disk only, and Remove. */
export function Entries({
  kind,
  dir,
  workspace,
  loaded,
}: {
  kind: KindId;
  dir: string;
  workspace: string | null;
  loaded: LoadedPlaybook;
}) {
  const lang = useLang();
  const s = useBundleEditor();
  const listed = loaded.playbook?.contents[kind] ?? [];
  const rows = entriesOf(kind, listed, s.tree?.entries ?? [], loaded.findings);
  return (
    <section className="pbb-entries" aria-label={t(lang, "pbb.entries")}>
      <h3 className="pb-h">{t(lang, "pbb.entries")}</h3>
      {rows.length === 0 ? (
        <p className="pbb-note">{t(lang, "pbb.entries.none")}</p>
      ) : (
        <ul className="pbb-entry-list">
          {rows.map((r) => (
            <li key={r.path} className="pbb-entry" data-state={r.state}>
              <code className="pb-mono pbb-entry-path">{r.path}</code>
              <span className={`pbb-state pbb-state--${r.state}`}>{t(lang, `pbb.state.${r.state}`)}</span>
              {r.finding !== null && <span className="pbb-entry-finding">{r.finding}</span>}
              {r.state === "disk-only" && (
                <button
                  type="button"
                  className="pbb-list-it"
                  disabled={s.busy}
                  onClick={() => void listEntry(dir, workspace, kind, r.path)}
                >
                  {t(lang, "pbb.listIt")}
                </button>
              )}
              <button
                type="button"
                className="pbb-remove"
                disabled={s.busy}
                onClick={() => askRemove(kind, r.path, r.state !== "disk-only")}
              >
                {t(lang, "pbb.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The selected file on the right: a textarea, Save, Delete, and a preview for Markdown and JSON. */
export function FileEditor() {
  const lang = useLang();
  const s = useBundleEditor();
  const f = s.file;
  const [deleting, setDeleting] = useState<string | null>(null);
  if (f === null) return <p className="pbb-note pbb-empty">{t(lang, "pbb.pickFile")}</p>;
  if (f.status === "loading") return <p className="pbb-note">{t(lang, "pbb.loading")}</p>;
  const head = (
    <p className="pbb-file-path">
      <code className="pb-mono">{f.path}</code>
    </p>
  );
  if (f.status === "unreadable") {
    return (
      <div className="pbb-file">
        {head}
        <p className="pbb-refusal" role="alert">
          {reasonText(lang, f.reason ?? "", f.message ?? "")}
        </p>
      </div>
    );
  }
  const dirty = fileDirty(s);
  const lower = f.path.toLowerCase();
  const preview = lower.endsWith(".md") ? (
    <Markdown text={f.text} />
  ) : lower.endsWith(".json") ? (
    <SourceView path={f.path} text={f.text} />
  ) : null;
  const removable = !PROTECTED.includes(f.path);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void saveFile();
    }
  };
  return (
    <div className="pbb-file">
      <div className="pbb-file-head">
        {head}
        <div className="pbb-file-actions">
          <button
            type="button"
            className="pbb-save"
            disabled={!dirty || f.status === "saving"}
            onClick={() => void saveFile()}
          >
            {t(lang, f.status === "saving" ? "pbb.saving" : "pbb.save")}
          </button>
          {dirty && (
            <button type="button" className="pbb-discard" onClick={discardEdits}>
              {t(lang, "pbb.discard")}
            </button>
          )}
          {removable && (
            <button type="button" className="pbb-delete" onClick={() => setDeleting(f.path)}>
              {t(lang, "pbb.delete")}
            </button>
          )}
        </div>
      </div>
      {deleting === f.path && (
        <div className="pbb-confirm" role="alertdialog" aria-label={t(lang, "pbb.delete")}>
          <p className="pbb-note">{t(lang, "pbb.confirmDelete", { path: f.path })}</p>
          <div className="pbb-panel-actions">
            <button
              type="button"
              className="pbb-delete-go"
              onClick={() => {
                setDeleting(null);
                void deleteFile();
              }}
            >
              {t(lang, "pbb.delete")}
            </button>
            <button type="button" className="pbb-cancel" onClick={() => setDeleting(null)}>
              {t(lang, "pbb.cancel")}
            </button>
          </div>
        </div>
      )}
      {f.status === "changed" && (
        <div className="pbb-refusal" role="alert">
          <p>{t(lang, "pbb.reason.changed")}</p>
          <button type="button" className="pbb-reload" onClick={() => void reloadFile()}>
            {t(lang, "pbb.reload")}
          </button>
        </div>
      )}
      {f.status === "refused" && (
        <p className="pbb-refusal" role="alert">
          {reasonText(lang, f.reason ?? "", f.message ?? "")}
        </p>
      )}
      <div className={`pbb-edit${preview === null ? "" : " pbb-edit--split"}`}>
        <textarea
          className="pbb-text"
          value={f.text}
          spellCheck={false}
          aria-label={t(lang, "pbb.text", { path: f.path })}
          onChange={(e) => editText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {preview !== null && (
          <div className="pbb-preview" aria-label={t(lang, "pbb.preview")}>
            {preview}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A kind tab or the Files tab.
 *
 * @param props.spec      the tab
 * @param props.dir       the folder shown
 * @param props.workspace the workspace of the pane
 * @param props.loaded    the playbook loaded from the folder
 */
export function BundleTab({
  spec,
  dir,
  workspace,
  loaded,
}: {
  spec: PaneTabSpec;
  dir: string;
  workspace: string | null;
  loaded: LoadedPlaybook | null;
}) {
  const lang = useLang();
  const s = useBundleEditor();
  const folder = spec.folder ?? null;
  const tree = s.tree !== null && s.dir === dir ? s.tree : null;
  const nodes = tree === null ? null : scopeTree(tree.entries, folder);
  const kind = spec.kind;

  const notice = s.notice;
  return (
    <div className="pbb-tab">
      {kind === "skills" && <p className="pbb-note pbb-hint">{t(lang, "pbb.skills.hint")}</p>}
      {kind === "workflows" && <p className="pbb-note pbb-hint">{t(lang, "pbb.workflows.later")}</p>}
      {notice !== null && (
        <p className={notice.ok ? "pb-notice pbb-done" : "pbb-refusal"} role={notice.ok ? "status" : "alert"}>
          {notice.ok ? t(lang, `pbb.done.${notice.reason}`) : reasonText(lang, notice.reason, notice.message)}
        </p>
      )}
      {s.panel === "import-skills" && <SkillPicker dir={dir} workspace={workspace} />}
      {s.panel === "import-hooks" && <HooksImport dir={dir} workspace={workspace} />}
      {s.panel === "new-agent" && <NewEntryForm dir={dir} workspace={workspace} kind="agents" />}
      {s.panel === "new-command" && <NewEntryForm dir={dir} workspace={workspace} kind="commands" />}
      <RemoveConfirm dir={dir} workspace={workspace} />
      <div className="pbb-split">
        <div className="pbb-left">
          {kind !== undefined && loaded !== null && (
            <Entries kind={kind} dir={dir} workspace={workspace} loaded={loaded} />
          )}
          <section
            className="pbb-files"
            aria-label={
              folder === null ? t(lang, "pbb.filesAll") : t(lang, "pbb.files", { folder: `${folder}/` })
            }
          >
            <h3 className="pb-h">
              {folder === null ? t(lang, "pbb.filesAll") : t(lang, "pbb.files", { folder: `${folder}/` })}
            </h3>
            {s.treeError !== null && s.dir === dir ? (
              <p className="pbb-refusal" role="alert">
                {s.treeError}
              </p>
            ) : tree === null ? (
              <p className="pbb-note">{t(lang, "pbb.loadingTree")}</p>
            ) : nodes === null ? (
              <p className="pbb-note">{t(lang, "pbb.noFolder", { folder: folder ?? "" })}</p>
            ) : (
              <FileBrowser
                key={`${dir}#${folder ?? ""}`}
                nodes={nodes}
                selected={s.file?.path ?? null}
                onSelect={(node) => void openPath(dir, workspace, node.path)}
                openOnMove={(node) => !opensGraph(node.path)}
                label={
                  folder === null ? t(lang, "pbb.filesAll") : t(lang, "pbb.files", { folder: `${folder}/` })
                }
              />
            )}
            {tree !== null && scopeTruncated(tree, folder) && (
              <p className="pbb-note">{t(lang, "pbb.truncated")}</p>
            )}
            {tree !== null && tree.findings.length > 0 && (
              <div className="pbb-tree-findings">
                <p className="pbb-note">{t(lang, "pbb.treeFindings")}</p>
                <ul className="pb-findings">
                  {tree.findings.map((f, i) => (
                    <li className="pb-finding" key={`${f.path}#${i}`}>
                      <code className="pb-mono">{f.path}</code> {f.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
        <div className="pbb-right">
          <FileEditor />
        </div>
      </div>
    </div>
  );
}
