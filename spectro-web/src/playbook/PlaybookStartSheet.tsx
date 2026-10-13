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
// Card 584: the server asks every provider for its model list before the
// sheet opens. Each row that runs on a model (the steps, and the review
// checks in their own rows) names why the playbook's model does not serve,
// a rejected key with its HTTP status and where the key came from, and has a
// model picker: the playbook's model as the default, then the models of every
// provider whose list answered, local providers only for a private row. Start
// stays disabled while a row has no model that serves, and a line above it
// names those rows. A pick holds for this run only; Start sends the picks and
// the server checks them again (state/playbookPicks.ts).
//
// Styles: styles/playbook-run.css, imported by app.css.

import { useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { loadContents, type ContentsPreview } from "../state/playbookContents";
import {
  applyPick,
  blockingRows,
  offersFor,
  pickValue,
  reasonLines,
  rowServes,
  startPicks,
  type Pick,
  type Picks,
} from "../state/playbookPicks";
import type { ModelCheck, ModelOffer, StartPreview, StepPlan } from "../state/playbookRuns";
import type { PlaybookConfirm } from "../state/playbookChat";
import { ContentsList } from "./ContentsList";
import type { PlaybookDoc } from "./editor/doc";
import { PlaybookGraph } from "./PlaybookGraph";

/** Card 558: a run reads a step's skills from the playbook folder in place. */
const SOURCE_KEY = {
  playbook: "pb.run.skillPlaybook",
  missing: "pb.run.skillMissing",
} as const;

/** The privacy column's word; an unknown value is shown as it came. */
function privacyWord(lang: Lang, privacy: string): string {
  if (privacy === "private") return t(lang, "pb.run.private");
  if (privacy === "cheap") return t(lang, "pb.run.cheap");
  return privacy;
}

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

/** One row of the table: a step, a review check, or both halves of a step. */
interface SheetRow {
  id: string;
  name: string;
  /** The step's plan; absent for a review check. */
  step?: StepPlan;
  /** Card 584: whether a model serves; absent on a server before the card. */
  check?: ModelCheck;
}

/** The rows in node order: the server's model rows when it sends them, else the steps. */
function sheetRows(preview: StartPreview): SheetRow[] {
  if (preview.models === undefined)
    return preview.steps.map((step) => ({ id: step.id, name: step.name, step }));
  return preview.models.map((check) => ({
    id: check.node,
    name: check.name,
    step: preview.steps.find((s) => s.id === check.node),
    check,
  }));
}

/** Fix round (review N8): whether a row has a pick of its own that serves. */
function pickServes(check: ModelCheck, pick: Pick | undefined, offers: ModelOffer[]): boolean {
  return pick !== undefined && rowServes(check, pick, offers);
}

/**
 * Card 584: what a row says about its model and its picker. Called as a
 * function, so the sheet's own state holds the picks.
 */
function modelPick(
  lang: Lang,
  check: ModelCheck,
  pick: Pick | undefined,
  offers: ModelOffer[],
  onPick: (check: ModelCheck, value: string) => void,
) {
  const picked = pick !== undefined && pickServes(check, pick, offers);
  return (
    <>
      {pick === undefined &&
        reasonLines(check).map((line) => (
          <span key={line.key} className="pb-run-why" data-why={check.reason ?? "fallback"}>
            {t(lang, line.key, line.vars)}
          </span>
        ))}
      <label className="pb-run-pick">
        <span className="pb-run-pick-label">{t(lang, "pb.run.pickLabel")}</span>
        <select
          className="provider-select pb-run-pick-select"
          data-pick={check.node}
          value={pickValue(pick)}
          onChange={(e) => onPick(check, e.target.value)}
        >
          <option value="">
            {t(lang, "pb.run.pickDefault", { provider: check.provider, model: check.model })}
          </option>
          {offersFor(check, offers).map((o) => (
            <optgroup key={o.provider} label={o.provider}>
              {o.models.map((m) => (
                <option key={m} value={`${o.provider}|${m}`}>
                  {m}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {picked && (
        <span className="pb-run-picked">
          {t(lang, "pb.run.picked", { provider: pick.provider, model: pick.model })}
        </span>
      )}
    </>
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
  /** Card 584, fix round (review N7): Start was sent and the server has not answered yet. */
  starting?: boolean;
  /** Card 584, fix round: why the server did not start the run, shown above Start. */
  refusal?: string | null;
  /** Card 584: the picks that serve, by node id; empty when nothing was picked. */
  onStart: (picks: Picks) => void;
  onClose: () => void;
}) {
  const { doc, preview, contents, onStart, onClose, starting = false, refusal = null } = props;
  const lang = useLang();
  // Card 584: the picks belong to the preview they were made on; a new
  // confirmation starts without any.
  const [held, setHeld] = useState<{ of: StartPreview; picks: Picks }>({ of: preview, picks: {} });
  const picks = held.of === preview ? held.picks : {};
  const offers = preview.offers ?? [];
  const onPick = (check: ModelCheck, value: string): void =>
    setHeld({ of: preview, picks: applyPick(picks, check, value, offers) });
  const blocked = blockingRows(preview, picks);

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
                  {sheetRows(preview).map(({ id, name, step, check }) => (
                    <tr
                      data-step={id}
                      key={id}
                      data-serves={
                        check === undefined ? undefined : String(rowServes(check, picks[id], offers))
                      }
                    >
                      <td className="pb-cell-name">{name}</td>
                      <td>
                        <span className="pb-model">
                          <span>
                            {step === undefined
                              ? t(lang, "pb.run.review")
                              : t(lang, step.performer === "child" ? "pb.child" : "pb.chat")}
                          </span>
                          {step !== undefined && step.role !== null && step.role !== "" && (
                            <span className="pb-meta-line pb-mono">{step.role}</span>
                          )}
                        </span>
                      </td>
                      <td>
                        <span className="pb-model">
                          <span className="pb-mono">{step?.choice ?? check?.choice}</span>
                          <span className="pb-meta-line pb-mono">
                            {step?.provider ?? check?.provider} {step?.model ?? check?.model}
                          </span>
                          {step !== undefined &&
                            !(check !== undefined && pickServes(check, picks[id], offers)) && (
                              <span className={`pb-state pb-state--${step.providerState}`}>
                                {step.providerKind} · {step.providerState}
                              </span>
                            )}
                          {check !== undefined && modelPick(lang, check, picks[id], offers, onPick)}
                        </span>
                      </td>
                      <td data-privacy={step?.privacy ?? check?.privacy}>
                        {privacyWord(lang, step?.privacy ?? check?.privacy ?? "")}
                      </td>
                      <td className="pb-mono">{step?.permission ?? ""}</td>
                      <td data-nod={step === undefined ? undefined : String(step.nod)}>
                        {step === undefined ? "" : t(lang, step.nod ? "pb.yes" : "pb.no")}
                      </td>
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
          {refusal !== null && refusal !== "" && (
            <p className="pb-run-start-refused" role="alert">
              {t(lang, "pb.run.startRefused", { reason: refusal })}
            </p>
          )}
          {blocked.length > 0 && (
            <p className="pb-run-blocked" role="status">
              {t(lang, "pb.run.blocked", { steps: blocked.map((m) => m.name).join(", ") })}
            </p>
          )}
          <button type="button" className="pb-run-close" onClick={onClose}>
            {t(lang, "pb.run.close")}
          </button>
          <button
            type="button"
            className="pb-run-start"
            disabled={refused || blocked.length > 0 || starting}
            onClick={() => onStart(startPicks(preview, picks))}
          >
            {t(lang, starting ? "pb.run.starting" : "pb.run.start")}
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
 * @param props.onStart   sends start_playbook on the session's own route, with the picks (card 584)
 * @param props.onClose   closes the sheet in the session's state
 */
export function PlaybookChatSheet(props: {
  confirm: PlaybookConfirm;
  workspace: string | null;
  onStart: (picks: Picks) => void;
  onClose: () => void;
}) {
  const { contents, doc } = useSheetExtras(props.confirm, props.workspace);
  return (
    <PlaybookStartSheet
      doc={doc}
      contents={contents}
      preview={props.confirm.preview}
      prompt={props.confirm.prompt}
      starting={props.confirm.starting === true}
      refusal={props.confirm.refusal ?? null}
      onStart={props.onStart}
      onClose={props.onClose}
    />
  );
}
