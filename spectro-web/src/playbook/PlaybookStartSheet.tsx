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
// hooks, agents, workflows) through the read only contents list and shows the
// full contents hash. The contents are shown, not pinned: the run hash stays
// the one the server computes. Card 558: nothing is installed any more, so the
// sheet names no install state, no changed item and no count of items not
// installed, and a step's skill is in the playbook or missing in it.
//
// Card 554 (criterion 8b): the sheet opens in the chat of the session after
// /run-with-playbook, drawn from the socket-only playbook_confirm frame
// (UiState.playbookConfirm), and names the task the run was asked. The pane
// no longer opens it. App draws PlaybookChatSheet lazily (state/surfaceChunks.ts),
// which reads the drawing and the contents beside the frame (readSheetExtras)
// inside this chunk, so the entry never loads this module.
//
// Styles: styles/playbook-run.css, imported by app.css.

import { useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { loadContents, type ContentsPreview } from "../state/playbookContents";
import type { StartPreview } from "../state/playbookRuns";
import type { PlaybookConfirm } from "../state/playbookChat";
import { ContentsList } from "./ContentsList";
import type { PlaybookDoc } from "./editor/doc";
import { PlaybookGraph } from "./PlaybookGraph";

/** Card 558: a run reads a step's skills from the playbook folder in place. */
const SOURCE_KEY = {
  playbook: "pb.run.skillPlaybook",
  missing: "pb.run.skillMissing",
} as const;

/** `sha256:` and the first 12 hex characters of the digest. */
function shortHash(hash: string): string {
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return `sha256:${hex.slice(0, 12)}`;
}

/**
 * Card 554: what the sheet draws beside the frame's preview, read when the
 * frame arrives: the contents of the folder, read again so a file changed
 * since the pane opened shows as changed, and the document the drawing is
 * made of. Either read the server refuses is null; the sheet opens without
 * that part rather than not at all.
 *
 * @param dir the playbook folder the frame names
 * @param workspace the session's workspace, or null
 */
export async function readSheetExtras(
  dir: string,
  workspace: string | null,
): Promise<{ contents: ContentsPreview | null; doc: PlaybookDoc | null }> {
  const [contents, doc] = await Promise.all([
    loadContents(dir, workspace).catch(() => null),
    readDocument(dir, workspace).catch(() => null),
  ]);
  return { contents, doc };
}

/** What readSheetExtras answered, and for which confirmation. */
interface Extras {
  of: PlaybookConfirm;
  contents: ContentsPreview | null;
  doc: PlaybookDoc | null;
}

const NO_EXTRAS = { contents: null, doc: null } as const;

/**
 * Card 554, task 13: the drawing and the contents for one confirmation, read
 * once when it arrives. Until the answer is in, and for an answer that
 * belongs to an earlier confirmation, both are null and the sheet draws
 * without them.
 *
 * @param confirm the playbook_confirm the sheet is drawn from
 * @param workspace the session's workspace, or null
 */
export function useSheetExtras(
  confirm: PlaybookConfirm,
  workspace: string | null,
): { contents: ContentsPreview | null; doc: PlaybookDoc | null } {
  const [extras, setExtras] = useState<Extras | null>(null);
  useEffect(() => {
    let alive = true;
    void readSheetExtras(confirm.dir, workspace).then((read) => {
      if (alive) setExtras({ of: confirm, ...read });
    });
    return () => {
      alive = false;
    };
  }, [confirm, workspace]);
  return extras !== null && extras.of === confirm ? extras : NO_EXTRAS;
}

/** The saved document of a folder, as the read view draws it; null when it has none. */
async function readDocument(dir: string, workspace: string | null): Promise<PlaybookDoc | null> {
  const ws = workspace === null ? "" : `&workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(`/api/playbooks/draft?dir=${encodeURIComponent(dir)}${ws}`);
  if (!res.ok) return null;
  const view = (await res.json()) as { document?: PlaybookDoc | null };
  return view.document ?? null;
}

/** The contents section: the read only list and the contents hash. */
function ContentsSection({ contents }: { contents: ContentsPreview }) {
  const lang = useLang();
  return (
    <section className="pb-sheet-section pb-run-contents">
      <h3 className="pb-h">{t(lang, "pc.runTitle")}</h3>
      <ContentsList preview={contents} readOnly />
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
  /** Card 554: the task the run is asked, the prompt after /run-with-playbook. */
  prompt?: string;
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
        {props.prompt !== undefined && props.prompt !== "" && (
          <p className="pb-sheet-task">{t(lang, "pb.run.task", { task: props.prompt })}</p>
        )}

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

/**
 * Card 554, criterion 8b: the sheet as the chat opens it after
 * /run-with-playbook, from the session's playbook_confirm, with the drawing
 * and the contents read beside it. App draws it lazily, under a ChunkBoundary.
 *
 * @param props.confirm   the confirmation (UiState.playbookConfirm)
 * @param props.workspace the session's workspace, or null
 * @param props.onStart   sends start_playbook on the session's own route
 * @param props.onClose   closes the sheet in the session's state
 */
export function PlaybookChatSheet(props: {
  confirm: PlaybookConfirm;
  workspace: string | null;
  onStart: () => void;
  onClose: () => void;
}) {
  const { contents, doc } = useSheetExtras(props.confirm, props.workspace);
  return (
    <PlaybookStartSheet
      doc={doc}
      contents={contents}
      preview={props.confirm.preview}
      prompt={props.confirm.prompt}
      onStart={props.onStart}
      onClose={props.onClose}
    />
  );
}
