// Card 481: the playbook module, the fourth segment, drawn in developer only
// and loaded from a chunk of its own. It holds the folder picker (the known
// folders, the one pinned to this workspace, a path field, and the button that
// copies the shipped spectro playbook into a folder), and for the folder shown
// the graph, the step table and the findings.
//
// Card 482: Build by this asks the server for the start preview and opens the
// confirmation sheet; Start sends the start frame with the hash the sheet
// showed. Under the graph the run view draws this session's latest run.
//
// The stylesheets are styles/playbook.css and styles/playbook-run.css,
// imported by app.css: a surface chunk carries no stylesheet of its own.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  copyBundled,
  loadPlaybook,
  pinFolder,
  refreshFolders,
  registerFolder,
  useLoadedPlaybook,
  usePlaybookFolders,
} from "../state/playbooks";
import { fetchStartPreview, type StartPreview } from "../state/playbookRuns";
import { PlaybookGraph } from "./PlaybookGraph";
import { PlaybookRunView } from "./PlaybookRunView";
import { PlaybookStartSheet } from "./PlaybookStartSheet";
import { StepTable } from "./StepTable";

/** The id of the playbook the product ships. */
const BUNDLED = "spectro";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PlaybookPane({
  workspace,
  sessionId,
  onStartPlaybook,
}: {
  workspace: string | null;
  sessionId: string | null;
  /** Sends the start frame; true when it reached the socket. */
  onStartPlaybook: (dir: string, hash: string) => boolean;
}) {
  const lang = useLang();
  const { folders, active } = usePlaybookFolders();
  const loaded = useLoadedPlaybook();
  const [path, setPath] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<StartPreview | null>(null);
  /** Counts the starts sent, so the run view mounts again and looks for the new run. */
  const [starts, setStarts] = useState(0);
  const ws = workspace ?? "";
  const shown = picked ?? active;

  useEffect(() => {
    refreshFolders(ws).catch((e: unknown) => setNotice(messageOf(e)));
  }, [ws]);

  useEffect(() => {
    if (shown === null) return;
    loadPlaybook(shown, ws).catch((e: unknown) => setNotice(messageOf(e)));
  }, [shown, ws]);

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

  const p = loaded?.playbook ?? null;
  const canBuild = loaded !== null && p !== null && workspace !== null && sessionId !== null;

  const build = (): void => {
    if (loaded === null || workspace === null) return;
    run(async () => {
      setPreview(await fetchStartPreview(loaded.dir, workspace));
    });
  };

  const start = (): void => {
    if (loaded === null || preview === null || preview.hash === null) return;
    if (onStartPlaybook(loaded.dir, preview.hash)) {
      setPreview(null);
      setStarts((n) => n + 1);
    }
  };

  return (
    <div className="pb-pane">
      <header className="pb-head">
        <h2 className="pb-title">{p !== null ? p.name : t(lang, "pb.title")}</h2>
        {p !== null && p.description !== "" && <p className="pb-description">{p.description}</p>}
        <p className="pb-run-hint">{t(lang, "pb.run.hint")}</p>
        {p !== null && (
          <button type="button" className="pb-run-build" disabled={!canBuild} onClick={build}>
            {t(lang, "pb.run.build")}
          </button>
        )}
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
                    onClick={() => setPicked(dir)}
                  >
                    {dir}
                  </button>
                  {workspace !== null && dir !== active && (
                    <button
                      type="button"
                      className="pb-pin"
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
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button type="button" className="pb-add" onClick={add}>
            {t(lang, "pb.add")}
          </button>
          <button type="button" className="pb-copy" onClick={copy}>
            {t(lang, "pb.copyBundled")}
          </button>
        </div>
        {notice !== null && (
          <p className="pb-notice" role="status">
            {notice}
          </p>
        )}
      </section>

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

      {loaded !== null && p !== null && (
        <>
          <section className="pb-section pb-canvas">
            <PlaybookGraph loaded={loaded} />
          </section>
          {sessionId !== null && <PlaybookRunView key={`${sessionId}#${starts}`} sessionId={sessionId} />}
          <section className="pb-section">
            <h3 className="pb-h">{t(lang, "pb.steps")}</h3>
            <StepTable loaded={loaded} />
          </section>
        </>
      )}

      {preview !== null && loaded !== null && (
        <PlaybookStartSheet
          loaded={loaded}
          preview={preview}
          onStart={start}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
