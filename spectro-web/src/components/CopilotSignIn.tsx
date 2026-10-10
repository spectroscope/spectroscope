// The Copilot sign-in (card 495): a status line for the provider menu and the
// sheet it opens. The sheet shows the code to type and the address to open
// while a device flow waits, polls until the browser confirmed it, then says
// "Signed in as <login>". The app never sees a password. A refusal is shown in
// the words the server passed on (GitHub's, the CLI's or the runtime's).

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  accountLine,
  afterRead,
  fetchCopilotAccount,
  linkable,
  notifyCopilotSignInChange,
  pollDelayMs,
  postCopilotAccount,
  signInChanged,
  type AccountNoteState,
  type CopilotAccountAction,
  type CopilotAccountStatus,
} from "./copilotAccount";

/** What a running call is: the CLI sign-in, which can take 30 s, or anything else. */
export type CopilotBusy = "cli" | "other" | null;

/** The sheet itself: what it shows for one status. */
export function CopilotSignInSheet({
  status,
  lang,
  busy,
  readFailed,
  onSignIn,
  onCancel,
  onSignOut,
  onClose,
}: {
  /** undefined before the first answer, null when it could not be read */
  status: CopilotAccountStatus | null | undefined;
  lang: Lang;
  busy: CopilotBusy;
  /** The last read failed while an earlier status is still shown. */
  readFailed: boolean;
  onSignIn: (method: "github" | "cli") => void;
  onCancel: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const waiting = status?.state === "WAITING";
  const signedIn = status?.state === "SIGNED_IN";
  const href = linkable(status?.verificationUri ?? null);
  const offerGithub = !!status && !waiting;
  const offerCli = !!status && !waiting && !(signedIn && status.method === "cli");
  const githubLabel = signedIn && status.method === "github" ? "cp.signInOther" : "cp.signInGithub";
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
  }, []);
  return (
    // The sheet is portalled out of the provider popover, whose window listeners
    // close it on an outside mouse down and on Escape; both stop here.
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="modal cp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cp-title"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="modal-head">
          <span className="eyebrow sand" id="cp-title">
            {t(lang, "cp.title")}
          </span>
        </div>

        {status === null && (
          <p className="import-hint" role="alert">
            {t(lang, "cp.unreachable")}
          </p>
        )}

        {status !== null && <p className="import-hint">{accountLine(status, lang)}</p>}

        {signedIn && (
          <p className="import-hint">{t(lang, status.method === "cli" ? "cp.viaCli" : "cp.viaGithub")}</p>
        )}
        {signedIn && status.method === "github" && (
          <p className="import-hint">{t(lang, "cp.checkedOnRun")}</p>
        )}

        {waiting && (
          <>
            <p className="import-hint">{t(lang, "cp.openAndEnter")}</p>
            <p className="cp-address">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {href}
                </a>
              ) : (
                <span className="mono">{status.verificationUri}</span>
              )}
            </p>
            <p className="cp-code-line">
              <span className="cp-code-label">{t(lang, "cp.codeLabel")}</span>{" "}
              <code className="cp-code mono">{status.userCode}</code>
            </p>
            <p className="import-hint">{t(lang, "cp.afterConfirm")}</p>
          </>
        )}

        {readFailed && status && (
          <p className="import-hint" role="alert">
            {t(lang, "cp.readFailed")}
          </p>
        )}

        {status?.message && (
          <p className="import-hint" role={status.state === "REFUSED" ? "alert" : "note"}>
            {status.message}
          </p>
        )}

        {busy && (
          <p className="import-hint" role="status" aria-live="polite">
            {t(lang, busy === "cli" ? "cp.workingCli" : "cp.working")}
          </p>
        )}

        <div className="provider-pop-foot cp-actions">
          {waiting && (
            <button type="button" className="ob-opt-cta" onClick={onCancel} disabled={!!busy}>
              {t(lang, "cp.cancel")}
            </button>
          )}
          {signedIn && (
            <button type="button" className="ob-opt-cta" onClick={onSignOut} disabled={!!busy}>
              {t(lang, "cp.signOut")}
            </button>
          )}
          {offerGithub && (
            <button
              type="button"
              className={signedIn ? "ob-opt-cta" : "soft-primary"}
              onClick={() => onSignIn("github")}
              disabled={!!busy || !status.github}
            >
              {t(lang, githubLabel)}
            </button>
          )}
          {offerCli && (
            <button
              type="button"
              className="ob-opt-cta"
              onClick={() => onSignIn("cli")}
              disabled={!!busy || !status.cli}
            >
              {t(lang, "cp.signInCli")}
            </button>
          )}
          <button type="button" className="ob-opt-cta" onClick={onClose}>
            {t(lang, "cp.close")}
          </button>
        </div>
        {offerGithub && !status.github && <p className="import-hint">{t(lang, "cp.noGithub")}</p>}
        {offerCli && !status.cli && <p className="import-hint">{t(lang, "cp.noCli")}</p>}
      </div>
    </div>
  );
}

/**
 * The status line under the Copilot provider and the button that opens the
 * sheet. Reads the status when it mounts, and while a sign-in waits every two
 * seconds, slower after failed reads. A failed read keeps the last status.
 */
export function CopilotAccountNote() {
  const lang = useLang();
  const [note, setNote] = useState<AccountNoteState>({ status: undefined, failures: 0 });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<CopilotBusy>(null);

  useEffect(() => {
    let live = true;
    void fetchCopilotAccount().then((s) => {
      if (live) setNote((prev) => afterRead(prev, s));
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const delay = pollDelayMs(note.status, note.failures);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      void fetchCopilotAccount().then((s) => setNote((prev) => afterRead(prev, s)));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [note]);

  // Review of 2026-10-10: a sign-in or sign-out made here tells the app, which
  // reads the provider status again, so the first-run sheet closes and the
  // model menu lists the account's models without a reload.
  const seen = useRef<CopilotAccountStatus | null | undefined>(undefined);
  useEffect(() => {
    if (signInChanged(seen.current, note.status)) notifyCopilotSignInChange();
    if (note.status) seen.current = note.status;
  }, [note.status]);

  const act = useCallback((action: CopilotAccountAction, body: Record<string, string> = {}) => {
    setBusy(action === "sign-in" && body.method === "cli" ? "cli" : "other");
    void postCopilotAccount(action, body).then((s) => {
      setNote((prev) => afterRead(prev, s));
      setBusy(null);
    });
  }, []);

  return (
    <div className="provider-local-note">
      <span>{accountLine(note.status, lang)}</span>{" "}
      <button type="button" className="ob-opt-cta" onClick={() => setOpen(true)}>
        {t(lang, "cp.manage")}
      </button>
      {open &&
        createPortal(
          <CopilotSignInSheet
            status={note.status}
            lang={lang}
            busy={busy}
            readFailed={note.failures > 0 && !!note.status}
            onSignIn={(method) => act("sign-in", { method })}
            onCancel={() => act("cancel")}
            onSignOut={() => act("sign-out")}
            onClose={() => {
              if (note.status?.state === "WAITING") act("cancel");
              setOpen(false);
            }}
          />,
          document.body,
        )}
    </div>
  );
}
