// Card 481: the playbook module, the fourth segment, drawn in developer only
// and loaded from a chunk of its own. It holds the folder picker (the known
// folders, the one pinned to this workspace, a path field, and the button that
// copies the shipped spectro playbook into a folder), and for the folder shown
// the graph, the step table and the findings.
//
// Card 483 (Task 11): the graph is drawn from the document the editor store
// holds, the header offers Edit when the file can be edited without losing
// anything, and an open editor replaces the graph and the table with the edit
// layout. While the draft has unsaved changes the folder picker is locked.
//
// Card 484 (Task 11): the header carries two tabs, Playbook and New (named
// New project until card 515). The second draws the Spectrolyzr page App
// hands in, so its chunk is requested only when the tab opens or when
// developer prefetches it.
//
// Card 512: a Choose button beside the path field opens the native folder
// dialog through the folder chip's endpoint and only fills the field.
//
// Card 485: a contents row under the step table counts what the folder brings
// and opens the install and remove confirmations.
//
// Card 482: Build by this asks the server for the start preview and opens the
// confirmation sheet (since card 485 with the contents read again beside it); Start sends the start frame with the hash the sheet
// showed. Under the graph the run view draws this session's latest run.
//
// The stylesheets are styles/playbook.css and styles/playbook-run.css,
// imported by app.css: a surface chunk carries no stylesheet of its own.

import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/i18n";
import { chooseFolder, usePickNote } from "../state/folderPick";
import { useLang } from "../state/lang";
import { closeEditor, loadView, openEditor, useEditorState } from "../state/playbookEditor";
import {
  copyBundled,
  loadPlaybook,
  pinFolder,
  refreshFolders,
  registerFolder,
  useLoadedPlaybook,
  usePlaybookFolders,
} from "../state/playbooks";
import { loadContents, usePlaybookContents, type ContentKind } from "../state/playbookContents";
import type { StartPreview } from "../state/playbookRuns";
import { ContentsConfirm } from "./ContentsConfirm";
import type { PlaybookDoc } from "./editor/doc";
import { EditorShell } from "./editor/EditorShell";
import { PlaybookGraph } from "./PlaybookGraph";
import { PlaybookRunView } from "./PlaybookRunView";
import { PlaybookStartSheet, readConfirmation } from "./PlaybookStartSheet";
import { StepTable } from "./StepTable";

/** The kinds the contents row counts, in the order the list shows them. */
const COUNTED: ContentKind[] = ["skill", "command", "hook", "agent", "workflow"];

/** The id of the playbook the product ships. */
const BUNDLED = "spectro";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param props.workspace       the workspace the folder chip in the header shows
 * @param props.wizard          the Spectrolyzr page App built under a ChunkBoundary; the New tab draws it (cards 484, 515)
 * @param props.sessionId       the live or stored session a run starts in and whose runs the run view draws (card 482)
 * @param props.onStartPlaybook sends the start frame; true when it reached the socket (card 482)
 */
export function PlaybookPane({
  workspace,
  wizard,
  sessionId,
  onStartPlaybook,
}: {
  workspace: string | null;
  wizard?: ReactNode;
  sessionId: string | null;
  onStartPlaybook: (dir: string, hash: string) => boolean;
}) {
  const lang = useLang();
  const [tab, setTab] = useState<"playbook" | "lyzr">("playbook");
  const { folders, active } = usePlaybookFolders();
  const loaded = useLoadedPlaybook();
  const ed = useEditorState();
  const editing = ed.open;
  const locked = ed.dirty;
  const [path, setPath] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pickNote = usePickNote("pane");
  const [dialog, setDialog] = useState<"install" | "remove" | null>(null);
  const contents = usePlaybookContents();
  const [preview, setPreview] = useState<StartPreview | null>(null);
  /** Counts the starts sent, so the run view mounts again and looks for the new run. */
  const [starts, setStarts] = useState(0);
  const ws = workspace ?? "";
  const shown = picked ?? active;

  useEffect(() => {
    refreshFolders(ws).catch((e: unknown) => setNotice(messageOf(e)));
  }, [ws]);

  // Read mode reads the folder twice: the load route for the step table and
  // the findings, the draft route for the document the graph draws. An open
  // editor keeps its own view; closing it reads both again.
  useEffect(() => {
    if (shown === null || editing) return;
    loadPlaybook(shown, ws).catch((e: unknown) => setNotice(messageOf(e)));
    loadView(shown, workspace).catch((e: unknown) => setNotice(messageOf(e)));
  }, [shown, ws, workspace, editing]);

  const loadedDir = loaded?.playbook != null ? loaded.dir : null;
  useEffect(() => {
    if (loadedDir === null) return;
    loadContents(loadedDir, workspace).catch((e: unknown) => setNotice(messageOf(e)));
  }, [loadedDir, workspace]);

  const run = (work: () => Promise<void>): void => {
    setNotice(null);
    work().catch((e: unknown) => setNotice(messageOf(e)));
  };

  const add = (): void => {
    const dir = path.trim();
    if (dir === "") return;
    run(async () => {
      await registerFolder(dir);
      setPicked(dir);
      setPath("");
    });
  };

  const copy = (): void => {
    const dir = path.trim();
    if (dir === "") return;
    setNotice(null);
    void copyBundled(BUNDLED, dir).then((result) => {
      if (result.ok) {
        setPicked(dir);
        setPath("");
      } else if (result.conflicts !== undefined && result.conflicts.length > 0) {
        setNotice(t(lang, "pb.copyConflicts", { files: result.conflicts.join(", ") }));
      } else {
        setNotice(t(lang, "pb.copyFailed", { dir }));
      }
    });
  };

  const view = ed.view;
  const doc: PlaybookDoc | null = editing
    ? (ed.history?.present ?? null)
    : (ed.saved ?? view?.document ?? null);
  const p = loaded?.playbook ?? null;
  const title = doc?.name ?? p?.name ?? t(lang, "pb.title");
  const description = doc?.description ?? p?.description ?? "";
  const dir = ed.dir ?? shown;
  const here = contents !== null && loaded !== null && contents.dir === loaded.dir ? contents : null;
  const count = (kind: ContentKind): number => here?.items.filter((i) => i.kind === kind).length ?? 0;
  const anyInstalled =
    here?.items.some(
      (i) => i.state === "same" || i.state === "source-changed" || i.state === "copy-changed",
    ) ?? false;

  const canBuild = loaded !== null && p !== null && workspace !== null && sessionId !== null;

  const build = (): void => {
    if (loaded === null || workspace === null) return;
    run(async () => {
      setPreview((await readConfirmation(loaded.dir, workspace)).preview);
    });
  };

  const start = (): void => {
    if (loaded === null || preview === null || preview.hash === null) return;
    if (onStartPlaybook(loaded.dir, preview.hash)) {
      setPreview(null);
      setStarts((n) => n + 1);
    }
  };

  // The run view needs only the session: a stored session opened from the
  // list has no workspace, so no playbook loads, and its runs still show.
  const runView =
    sessionId !== null ? <PlaybookRunView key={`${sessionId}#${starts}`} sessionId={sessionId} /> : null;

  const tabs = (
    <div className="pb-tabs" role="tablist" aria-label={t(lang, "lyzr.title")}>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "playbook"}
        className={`pb-tab${tab === "playbook" ? " is-on" : ""}`}
        onClick={() => setTab("playbook")}
      >
        {t(lang, "pb.title")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "lyzr"}
        className={`pb-tab${tab === "lyzr" ? " is-on" : ""}`}
        onClick={() => setTab("lyzr")}
      >
        {t(lang, "lyzr.tab")}
      </button>
    </div>
  );

  if (tab === "lyzr") {
    return (
      <div className="pb-pane">
        {tabs}
        <div className="pb-lyzr" role="tabpanel">
          {wizard}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-pane">
      {tabs}
      <header className="pb-head">
        <h2 className="pb-title">{title}</h2>
        {description !== "" && <p className="pb-description">{description}</p>}
        <p className="pb-run-hint">{t(lang, "pb.run.hint")}</p>
        {p !== null && (
          <button type="button" className="pb-run-build" disabled={!canBuild} onClick={build}>
            {t(lang, "pb.run.build")}
          </button>
        )}
        <div className="pbe-bar">
          {editing ? (
            <button type="button" className="pbe-stop" disabled={ed.dirty} onClick={closeEditor}>
              {t(lang, "pbe.stop")}
            </button>
          ) : view !== null && view.editable && view.document !== null ? (
            <button
              type="button"
              className="pbe-edit"
              onClick={() => {
                if (dir !== null) run(() => openEditor(dir, workspace));
              }}
            >
              {t(lang, "pbe.edit")}
            </button>
          ) : view !== null ? (
            <p className="pbe-note-line">{t(lang, "pbe.notEditable")}</p>
          ) : null}
        </div>
      </header>

      <section className="pb-picker" aria-label={t(lang, "pb.folders")}>
        <h3 className="pb-h">{t(lang, "pb.folders")}</h3>
        <div className="pb-folders">
          {folders.length > 0 && (
            <ul className="pb-folder-list">
              {folders.map((dir) => (
                <li key={dir}>
                  <button
                    type="button"
                    className={`pb-folder${dir === shown ? " is-active" : ""}`}
                    title={dir}
                    disabled={locked}
                    onClick={() => setPicked(dir)}
                  >
                    {dir}
                  </button>
                  {workspace !== null && dir !== active && (
                    <button
                      type="button"
                      className="pb-pin"
                      disabled={locked}
                      onClick={() => run(() => pinFolder(workspace, dir))}
                    >
                      {t(lang, "pb.useHere")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="pb-add-row">
          <div className="pb-path-field">
            <input
              className="pb-path"
              type="text"
              value={path}
              placeholder={t(lang, "pb.addFolder")}
              aria-label={t(lang, "pb.addFolder")}
              spellCheck={false}
              disabled={locked}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <button
              type="button"
              className="pb-choose"
              disabled={locked}
              onClick={() => void chooseFolder("pane", setPath)}
            >
              {t(lang, "pick.choose")}
            </button>
          </div>
          <button type="button" className="pb-add" disabled={locked} onClick={add}>
            {t(lang, "pb.add")}
          </button>
          <button type="button" className="pb-copy" disabled={locked} onClick={copy}>
            {t(lang, "pb.copyBundled")}
          </button>
        </div>
        {pickNote !== null && (
          <p className="pb-notice" role="status">
            {pickNote}
          </p>
        )}
        {locked && (
          <p className="pb-notice" role="status">
            {t(lang, "pbe.folderLocked")}
          </p>
        )}
        {notice !== null && (
          <p className="pb-notice" role="status">
            {notice}
          </p>
        )}
      </section>

      {editing ? (
        <section className="pb-section pbe-editor">
          {!ed.canonical && (
            <p className="pbe-notice" role="status">
              {t(lang, "pbe.notCanonical")}
            </p>
          )}
          <EditorShell />
        </section>
      ) : (
        <>
          {loaded !== null && loaded.findings.length > 0 && (
            <section className="pb-section">
              <h3 className="pb-h">{t(lang, "pb.findings")}</h3>
              <ul className="pb-findings">
                {loaded.findings.map((f, i) => (
                  <li className="pb-finding" key={`${f.path}#${i}`}>
                    <code className="pb-mono">{f.path === "" ? loaded.dir : f.path}</code> {f.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(loaded === null || p === null) && runView}

          {doc !== null && (
            <section className="pb-section pb-canvas">
              <PlaybookGraph doc={doc} />
            </section>
          )}
          {loaded !== null && p !== null && (
            <>
              {runView}
              <section className="pb-section">
                <h3 className="pb-h">{t(lang, "pb.steps")}</h3>
                <StepTable loaded={loaded} onInstall={() => setDialog("install")} />
              </section>
              {here !== null && (
                <section className="pb-section pc-row">
                  <h3 className="pb-h">{t(lang, "pc.title")}</h3>
                  <p className="pc-counts">
                    {COUNTED.map((kind) => {
                      const n = count(kind);
                      return n === 1 ? t(lang, `pc.count.${kind}One`) : t(lang, `pc.count.${kind}`, { n });
                    }).join(", ")}
                  </p>
                  <div className="pc-row-actions">
                    <button type="button" data-action="install" onClick={() => setDialog("install")}>
                      {t(lang, "pc.install")}
                    </button>
                    <button
                      type="button"
                      data-action="remove"
                      disabled={!anyInstalled}
                      onClick={() => setDialog("remove")}
                    >
                      {t(lang, "pc.remove")}
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}

      {dialog !== null && loaded !== null && (
        <ContentsConfirm
          dir={loaded.dir}
          mode={dialog}
          workspace={workspace}
          onClose={() => setDialog(null)}
        />
      )}

      {preview !== null && loaded !== null && (
        <PlaybookStartSheet
          doc={ed.saved ?? view?.document ?? null}
          preview={preview}
          contents={here}
          onStart={start}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
