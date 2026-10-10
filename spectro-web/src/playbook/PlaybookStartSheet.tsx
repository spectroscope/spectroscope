// Card 482: the confirmation before a playbook run. It shows the drawing, a
// row per step with the provider and model it runs on, the skills with their
// source, every command a check may execute, verbatim, and the short hash the
// start frame repeats. Start stays disabled while the server names any reason
// the run may not start; the server checks the hash again on the frame.
//
// Since the merge with card 483 the drawing takes the document of the file on
// disk, the one a run pins, as the read view draws it.
//
// Card 485: the sheet also lists what the playbook brings (skills, commands,
// hooks, agents, workflows) through the read only contents list, names every
// item changed since the install, counts what is not installed and shows the
// full contents hash. The contents are shown, not pinned: the run hash stays
// the one the server computes.
//
// Styles: styles/playbook-run.css, imported by app.css.

import { useEffect } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { changedItems, loadContents, type ContentsPreview } from "../state/playbookContents";
import { fetchStartPreview, type StartPreview } from "../state/playbookRuns";
import { ContentsList } from "./ContentsList";
import type { PlaybookDoc } from "./editor/doc";
import { PlaybookGraph } from "./PlaybookGraph";

const SOURCE_KEY = {
  playbook: "pb.run.skillPlaybook",
  installed: "pb.run.skillInstalled",
  missing: "pb.run.skillMissing",
} as const;

/** `sha256:` and the first 12 hex characters of the digest. */
function shortHash(hash: string): string {
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return `sha256:${hex.slice(0, 12)}`;
}

/**
 * What the sheet needs, read when Build by this is pressed: the start preview,
 * and the contents of the same folder read again, so a file changed since the
 * pane opened shows as changed. A contents read the server refuses leaves the
 * sheet without a list; it does not keep the sheet closed.
 *
 * @param dir the registered playbook folder
 * @param workspace the session's workspace
 */
export async function readConfirmation(
  dir: string,
  workspace: string,
): Promise<{ preview: StartPreview; contents: ContentsPreview | null }> {
  const [preview, contents] = await Promise.all([
    fetchStartPreview(dir, workspace),
    loadContents(dir, workspace).catch(() => null),
  ]);
  return { preview, contents };
}

/** The contents section: the read only list, the changed line, the count not installed, the contents hash. */
function ContentsSection({ contents }: { contents: ContentsPreview }) {
  const lang = useLang();
  const changed = changedItems(contents);
  const notInstalled = contents.items.filter((i) => i.state === "new").length;
  return (
    <section className="pb-sheet-section pb-run-contents">
      <h3 className="pb-h">{t(lang, "pc.runTitle")}</h3>
      {changed.length > 0 && (
        <p className="pb-run-changed" role="status">
          {t(lang, "pc.runChanged", { names: changed.map((i) => i.name).join(", ") })}
        </p>
      )}
      {notInstalled > 0 && (
        <p className="pb-run-not-installed">
          {notInstalled === 1
            ? t(lang, "pc.notInstalledOne")
            : t(lang, "pc.notInstalled", { n: notInstalled })}
        </p>
      )}
      <ContentsList preview={contents} readOnly onlyChanged={false} />
      <p className="pb-run-contents-hash">
        <span className="pb-run-hash-label">{t(lang, "pc.hash")}</span>{" "}
        <span className="pb-mono">{contents.contentsHash}</span>
      </p>
    </section>
  );
}

export function PlaybookStartSheet(props: {
  /** The saved document of the folder; null draws no graph. */
  doc: PlaybookDoc | null;
  preview: StartPreview;
  /** What the folder brings, read with the preview; null draws no contents section. */
  contents: ContentsPreview | null;
  onStart: () => void;
  onClose: () => void;
}) {
  const { doc, preview, contents, onStart, onClose } = props;
  const lang = useLang();

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refused = preview.refusals.length > 0;

  return (
    <div className="pb-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pb-sheet" role="dialog" aria-modal="true" aria-label={t(lang, "pb.run.confirmTitle")}>
        <header className="pb-sheet-head">
          <h2 className="pb-sheet-title">{t(lang, "pb.run.confirmTitle")}</h2>
          <span className="pb-sheet-dir pb-mono" title={preview.dir}>
            {preview.dir}
          </span>
        </header>

        <div className="pb-sheet-body">
          {doc !== null && (
            <section className="pb-sheet-canvas">
              <PlaybookGraph doc={doc} />
            </section>
          )}

          <section className="pb-sheet-section">
            <div className="pb-table-wrap">
              <table className="pb-steps pb-run-steps">
                <thead>
                  <tr>
                    <th>{t(lang, "pb.col.step")}</th>
                    <th>{t(lang, "pb.col.performer")}</th>
                    <th>{t(lang, "pb.col.model")}</th>
                    <th>{t(lang, "pb.col.privacy")}</th>
                    <th>{t(lang, "pb.run.permission")}</th>
                    <th>{t(lang, "pb.col.nod")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.steps.map((s) => (
                    <tr data-step={s.id} key={s.id}>
                      <td className="pb-cell-name">{s.name}</td>
                      <td>
                        <span className="pb-model">
                          <span>{t(lang, s.performer === "child" ? "pb.child" : "pb.chat")}</span>
                          {s.role !== null && s.role !== "" && (
                            <span className="pb-meta-line pb-mono">{s.role}</span>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="pb-model">
                          <span className="pb-mono">{s.choice}</span>
                          <span className="pb-meta-line pb-mono">
                            {s.provider} {s.model}
                          </span>
                          <span className={`pb-state pb-state--${s.providerState}`}>
                            {s.providerKind} · {s.providerState}
                          </span>
                        </span>
                      </td>
                      <td data-privacy={s.privacy}>
                        {s.privacy === "private"
                          ? t(lang, "pb.run.private")
                          : s.privacy === "cheap"
                            ? t(lang, "pb.run.cheap")
                            : s.privacy}
                      </td>
                      <td className="pb-mono">{s.permission}</td>
                      <td data-nod={String(s.nod)}>{t(lang, s.nod ? "pb.yes" : "pb.no")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {preview.skills.length > 0 && (
            <section className="pb-sheet-section">
              <h3 className="pb-h">{t(lang, "pb.run.skills")}</h3>
              <ul className="pb-run-skills">
                {preview.skills.map((k) => (
                  <li key={k.name} className={`is-${k.source}`}>
                    <span className="pb-mono">{k.name}</span>{" "}
                    <span className="pb-state">{t(lang, SOURCE_KEY[k.source] ?? "pb.run.skillMissing")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {preview.commands.length > 0 && (
            <section className="pb-sheet-section">
              <h3 className="pb-h">{t(lang, "pb.run.commands")}</h3>
              <ul className="pb-run-commands">
                {preview.commands.map((c, i) => (
                  <li key={`${i}:${c}`}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {contents !== null && <ContentsSection contents={contents} />}

          {preview.hash !== null && (
            <p className="pb-run-hash">
              <span className="pb-run-hash-label">{t(lang, "pb.run.hash")}</span>{" "}
              <span className="pb-mono" title={preview.hash}>
                {shortHash(preview.hash)}
              </span>
            </p>
          )}

          {refused && (
            <section className="pb-sheet-section pb-run-refusals" role="alert">
              <h3 className="pb-h">{t(lang, "pb.run.refusals")}</h3>
              <ul>
                {preview.refusals.map((r, i) => (
                  <li key={`${i}:${r}`}>{r}</li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="pb-sheet-foot">
          <button type="button" className="pb-run-close" onClick={onClose}>
            {t(lang, "pb.run.close")}
          </button>
          <button
            type="button"
            className="pb-run-start"
            disabled={preview.refusals.length > 0}
            onClick={onStart}
          >
            {t(lang, "pb.run.start")}
          </button>
        </footer>
      </div>
    </div>
  );
}
