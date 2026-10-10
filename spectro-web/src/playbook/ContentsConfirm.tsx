// Card 485: the confirmation that stands between a person and what a playbook
// brings. Install lists every skill, command, hook, agent and workflow with its
// source, hash and reach, and writes only what was shown: the click carries the
// hash of the list on screen, so a folder that changed since is refused by the
// server and the new list is shown instead. The hooks tick is off when the
// dialog opens, because a hook runs before the permission gate. Remove lists
// what goes and what stays.
//
// ContentsConfirmView holds no hook and takes the language as a prop, so its
// tree can be read in a test. ContentsConfirm adds the store, the tick and the
// two writes.

import { useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { loadPlaybook } from "../state/playbooks";
import {
  installContents,
  loadContents,
  removeContents,
  usePlaybookContents,
  type ContentItem,
  type ContentsPreview,
  type InstallFailure,
} from "../state/playbookContents";
import { ContentsList } from "./ContentsList";

/** What the dialog says after a write. */
export interface Outcome {
  message: string | null;
  names: string[];
  /** True when the write happened; the dialog then offers nothing more to do. */
  done: boolean;
}

/** The server's refusal as a sentence: translated where the app knows it, else the server's own words. */
function refusalText(lang: Lang, f: InstallFailure): string {
  if (f.reason === "CHANGED") return t(lang, "pc.changed");
  // The server writes the English sentence of pc.already (PlaybookInstallerTest pins the two together).
  const already = /^Already installed from (.+) on (\S+)\. Remove it first, then install again\.$/.exec(
    f.message,
  );
  if (f.reason === "ALREADY" && already !== null) {
    return t(lang, "pc.already", { dir: already[1], date: already[2] });
  }
  return f.message;
}

/**
 * After a write the list and the playbook are read again: the list moves its
 * states to installed or new, and the playbook's step table, which resolves
 * each skill against what the harness has, stops offering an install that is
 * done (or offers it again after a remove).
 */
async function readAgain(dir: string, workspace: string | null): Promise<void> {
  await loadContents(dir, workspace).catch(() => undefined);
  await loadPlaybook(dir, workspace ?? "").catch(() => undefined);
}

/**
 * Install what the list showed. The hash is the one of the list the person saw.
 * A written install reads the list and the playbook again, so the states move
 * to installed. A refused one leaves the dialog open; the store reads the list
 * again itself when the folder changed.
 */
export async function confirmInstall(
  lang: Lang,
  dir: string,
  preview: ContentsPreview,
  hooks: boolean,
  workspace: string | null,
): Promise<Outcome> {
  const answer = await installContents(dir, preview.contentsHash, hooks);
  if (answer.ok) {
    await readAgain(dir, workspace);
    return { message: t(lang, "pc.reach"), names: answer.installed, done: true };
  }
  return { message: refusalText(lang, answer), names: [], done: false };
}

/** Remove what the ledger records; copies edited since the install are kept and named. */
export async function confirmRemove(lang: Lang, dir: string, workspace: string | null): Promise<Outcome> {
  const answer = await removeContents(dir);
  if (answer.ok) {
    await readAgain(dir, workspace);
    const kept = answer.kept.length > 0 ? t(lang, "pc.kept", { names: answer.kept.join(", ") }) : null;
    return { message: kept, names: answer.removed, done: true };
  }
  return { message: refusalText(lang, answer), names: [], done: false };
}

const INSTALLED_STATES = new Set(["same", "source-changed", "copy-changed"]);

/** Items an install put on disk and a remove would look at. */
function installedItems(preview: ContentsPreview): ContentItem[] {
  return preview.items.filter((i) => INSTALLED_STATES.has(i.state));
}

/** True when an install can be sent for this list. */
function canInstall(preview: ContentsPreview | null, loading: boolean): boolean {
  if (preview === null || loading) return false;
  return preview.findings.length === 0 && !preview.items.some((i) => i.state === "taken");
}

export interface ConfirmViewProps {
  lang: Lang;
  mode: "install" | "remove";
  /** Null until a list has been read for this folder. */
  preview: ContentsPreview | null;
  loading: boolean;
  hooks: boolean;
  busy: boolean;
  outcome: Outcome | null;
  onHooks: (on: boolean) => void;
  onInstall: () => void;
  onRemove: () => void;
  onClose: () => void;
}

export function ContentsConfirmView(props: ConfirmViewProps) {
  const { lang, mode, preview, loading, hooks, busy, outcome } = props;
  const done = outcome?.done === true;
  const hasHooks = preview?.items.some((i) => i.kind === "hook") ?? false;
  const installed = preview === null ? [] : installedItems(preview);
  const goes = installed.filter((i) => i.state !== "copy-changed");
  const stays = installed.filter((i) => i.state === "copy-changed");

  return (
    <div className="pc-backdrop" role="presentation" onClick={props.onClose}>
      <div
        className="pc-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "pc.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pc-head">
          <span className="pc-title">{t(lang, "pc.title")}</span>
          <button
            type="button"
            className="pc-close"
            onClick={props.onClose}
            aria-label={t(lang, "common.close")}
          >
            ×
          </button>
        </div>

        {preview === null && <p className="pc-note">{t(lang, "pc.loading")}</p>}

        {preview !== null && preview.findings.length > 0 && (
          <ul className="pb-findings">
            {preview.findings.map((f, i) => (
              <li className="pb-finding" key={`${f.path}#${i}`}>
                <code className="pb-mono">{f.path}</code> {f.message}
              </li>
            ))}
          </ul>
        )}

        {preview !== null && mode === "install" && (
          <ContentsList preview={preview} readOnly={false} onlyChanged={false} />
        )}

        {preview !== null && mode === "remove" && (
          <>
            {installed.length === 0 && <p className="pc-note">{t(lang, "pc.removeNothing")}</p>}
            {goes.length > 0 && (
              <div className="pc-group" data-group="goes">
                <h4 className="pc-group-h">{t(lang, "pc.removeGoes")}</h4>
                <ContentsList preview={{ ...preview, items: goes }} readOnly onlyChanged={false} />
              </div>
            )}
            {stays.length > 0 && (
              <div className="pc-group" data-group="stays">
                <h4 className="pc-group-h">{t(lang, "pc.removeStays")}</h4>
                <ContentsList preview={{ ...preview, items: stays }} readOnly onlyChanged={false} />
              </div>
            )}
          </>
        )}

        {preview !== null && mode === "install" && preview.promptChars > 0 && (
          <p className="pc-note">{t(lang, "pc.promptCost", { n: preview.promptChars })}</p>
        )}

        {preview !== null && mode === "install" && hasHooks && (
          <div className="pc-hooks">
            <label className="pc-tick">
              <input
                type="checkbox"
                checked={hooks}
                disabled={busy || done}
                onChange={(e) => props.onHooks(e.target.checked)}
              />{" "}
              {t(lang, "pc.hooks.tick")}
            </label>
            {(preview.hooksOrigin === "project" || preview.hooksOrigin === "local") && (
              <p className="pc-note pc-note--warn">{t(lang, "pc.hooks.silenced")}</p>
            )}
          </div>
        )}

        {outcome !== null && (
          <div className="pc-outcome" role="status" ref={(el) => el?.scrollIntoView({ block: "nearest" })}>
            {outcome.message !== null && <p className="pc-note">{outcome.message}</p>}
            {outcome.names.length > 0 && (
              <p className="pc-note">
                {t(lang, mode === "install" ? "pc.written" : "pc.removed")}: {outcome.names.join(", ")}
              </p>
            )}
          </div>
        )}

        <div className="pc-actions">
          {mode === "install" ? (
            <button
              type="button"
              className="pc-primary"
              data-action="install"
              disabled={!canInstall(preview, loading) || busy || done}
              onClick={props.onInstall}
            >
              {t(lang, "pc.install")}
            </button>
          ) : (
            <button
              type="button"
              className="pc-primary"
              data-action="remove"
              disabled={preview === null || loading || installed.length === 0 || busy || done}
              onClick={props.onRemove}
            >
              {t(lang, "pc.remove")}
            </button>
          )}
          <button type="button" data-action="cancel" onClick={props.onClose}>
            {t(lang, done ? "common.close" : "pc.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ContentsConfirm({
  dir,
  mode,
  onClose,
  workspace = null,
}: {
  dir: string;
  mode: "install" | "remove";
  onClose: () => void;
  /** The workspace whose settings layers decide the hooks origin. */
  workspace?: string | null;
}) {
  const lang = useLang();
  const stored = usePlaybookContents();
  const preview = stored !== null && stored.dir === dir ? stored : null;
  const [loading, setLoading] = useState(true);
  const [hooks, setHooks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Read the list again on open: the folder may have changed since the row was drawn.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadContents(dir, workspace)
      .catch((e: unknown) => {
        if (alive)
          setOutcome({ message: e instanceof Error ? e.message : String(e), names: [], done: false });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dir, workspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const write = (work: Promise<Outcome>): void => {
    setBusy(true);
    work
      .then(setOutcome)
      .catch((e: unknown) =>
        setOutcome({ message: e instanceof Error ? e.message : String(e), names: [], done: false }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <ContentsConfirmView
      lang={lang}
      mode={mode}
      preview={preview}
      loading={loading}
      hooks={hooks}
      busy={busy}
      outcome={outcome}
      onHooks={setHooks}
      onInstall={() => {
        if (preview !== null) write(confirmInstall(lang, dir, preview, hooks, workspace));
      }}
      onRemove={() => write(confirmRemove(lang, dir, workspace))}
      onClose={onClose}
    />
  );
}
