// Card 481: the playbook module, the fourth segment, drawn in developer only
// and loaded from a chunk of its own. It holds the folder picker (the known
// folders, the one pinned to this workspace, a path field, and the button that
// copies the shipped spectro playbook into a folder), and for the folder shown
// the graph, the step table and the findings. It runs nothing: it says so.
//
// Card 483 (Task 11): the graph is drawn from the document the editor store
// holds, the header offers Edit when the file can be edited without losing
// anything, and an open editor replaces the graph and the table with the edit
// layout. While the draft has unsaved changes the folder picker is locked.
//
// The stylesheet is styles/playbook.css, imported by app.css: a surface chunk
// carries no stylesheet of its own.

import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/i18n";
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
import type { PlaybookDoc } from "./editor/doc";
import { EditorShell } from "./editor/EditorShell";
import { PlaybookGraph } from "./PlaybookGraph";
import { StepTable } from "./StepTable";

/** The id of the playbook the product ships. */
const BUNDLED = "spectro";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param props.workspace the workspace the folder chip in the header shows
 * @param props.wizard    the Spectrolyzr wizard App built under a ChunkBoundary; the New project tab draws it (card 484, Task 11)
 */
export function PlaybookPane({ workspace }: { workspace: string | null; wizard?: ReactNode }) {
  const lang = useLang();
  const { folders, active } = usePlaybookFolders();
  const loaded = useLoadedPlaybook();
  const ed = useEditorState();
  const editing = ed.open;
  const locked = ed.dirty;
  const [path, setPath] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  return (
    <div className="pb-pane">
      <header className="pb-head">
        <h2 className="pb-title">{title}</h2>
        {description !== "" && <p className="pb-description">{description}</p>}
        <p className="pb-no-runs">{t(lang, "pb.noRuns")}</p>
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
          <button type="button" className="pb-add" disabled={locked} onClick={add}>
            {t(lang, "pb.add")}
          </button>
          <button type="button" className="pb-copy" disabled={locked} onClick={copy}>
            {t(lang, "pb.copyBundled")}
          </button>
        </div>
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

          {doc !== null && (
            <section className="pb-section pb-canvas">
              <PlaybookGraph doc={doc} />
            </section>
          )}
          {loaded !== null && p !== null && (
            <section className="pb-section">
              <h3 className="pb-h">{t(lang, "pb.steps")}</h3>
              <StepTable loaded={loaded} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
