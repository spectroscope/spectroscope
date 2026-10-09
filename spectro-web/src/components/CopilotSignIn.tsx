// The Copilot sign-in (card 495): a status line for the provider menu and the
// sheet it opens. The sheet shows the code to type and the address to open
// while a device flow waits, polls until the browser confirmed it, then says
// "Signed in as <login>". The app never sees a password. A refusal is shown in
// the words the server passed on (GitHub's, the CLI's or the runtime's).

import { useCallback, useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  accountLine,
  fetchCopilotAccount,
  linkable,
  pollDelayMs,
  postCopilotAccount,
  type CopilotAccountAction,
  type CopilotAccountStatus,
} from "./copilotAccount";

/** The sheet itself: what it shows for one status. */
export function CopilotSignInSheet({
  status,
  lang,
  busy,
  onSignIn,
  onCancel,
  onSignOut,
  onClose,
}: {
  status: CopilotAccountStatus | null;
  lang: Lang;
  busy: boolean;
  onSignIn: (method: "github" | "cli") => void;
  onCancel: () => void;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const waiting = status?.state === "WAITING";
  const signedIn = status?.state === "SIGNED_IN";
  const href = linkable(status?.verificationUri ?? null);
  return (
    <div className="modal-backdrop">
      <div className="modal cp-modal" role="dialog" aria-modal="true" aria-labelledby="cp-title">
        <div className="modal-head">
          <span className="eyebrow sand" id="cp-title">
            {t(lang, "cp.title")}
          </span>
        </div>

        {!status && (
          <p className="import-hint" role="alert">
            {t(lang, "cp.unreachable")}
          </p>
        )}

        {status && <p className="import-hint">{accountLine(status, lang)}</p>}

        {signedIn && (
          <p className="import-hint">{t(lang, status.method === "cli" ? "cp.viaCli" : "cp.viaGithub")}</p>
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
            <p className="cp-code mono" aria-label={t(lang, "cp.title")}>
              {status.userCode}
            </p>
            <p className="import-hint">{t(lang, "cp.afterConfirm")}</p>
          </>
        )}

        {status?.message && (
          <p className="import-hint" role={status.state === "REFUSED" ? "alert" : "note"}>
            {status.message}
          </p>
        )}

        <div className="provider-pop-foot">
          {waiting && (
            <button type="button" className="ob-opt-cta" onClick={onCancel} disabled={busy}>
              {t(lang, "cp.cancel")}
            </button>
          )}
          {signedIn && (
            <button type="button" className="ob-opt-cta" onClick={onSignOut} disabled={busy}>
              {t(lang, "cp.signOut")}
            </button>
          )}
          {status && !waiting && !signedIn && (
            <>
              <button
                type="button"
                className="soft-primary"
                onClick={() => onSignIn("github")}
                disabled={busy || !status.github}
              >
                {t(lang, "cp.signInGithub")}
              </button>
              <button
                type="button"
                className="ob-opt-cta"
                onClick={() => onSignIn("cli")}
                disabled={busy || !status.cli}
              >
                {t(lang, "cp.signInCli")}
              </button>
            </>
          )}
          <button type="button" className="ob-opt-cta" onClick={onClose}>
            {t(lang, "cp.close")}
          </button>
        </div>
        {status && !waiting && !signedIn && !status.github && (
          <p className="import-hint">{t(lang, "cp.noGithub")}</p>
        )}
        {status && !waiting && !signedIn && !status.cli && (
          <p className="import-hint">{t(lang, "cp.noCli")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The status line under the Copilot provider and the button that opens the
 * sheet. Reads the status when it mounts, and every two seconds while a
 * sign-in waits.
 */
export function CopilotAccountNote() {
  const lang = useLang();
  const [status, setStatus] = useState<CopilotAccountStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchCopilotAccount().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const delay = pollDelayMs(status);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      void fetchCopilotAccount().then(setStatus);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [status]);

  const act = useCallback((action: CopilotAccountAction, body: Record<string, string> = {}) => {
    setBusy(true);
    void postCopilotAccount(action, body).then((s) => {
      setStatus(s);
      setBusy(false);
    });
  }, []);

  return (
    <div className="provider-local-note">
      <span>{accountLine(status, lang)}</span>{" "}
      <button type="button" className="ob-opt-cta" onClick={() => setOpen(true)}>
        {t(lang, "cp.manage")}
      </button>
      {open && (
        <CopilotSignInSheet
          status={status}
          lang={lang}
          busy={busy}
          onSignIn={(method) => act("sign-in", { method })}
          onCancel={() => act("cancel")}
          onSignOut={() => act("sign-out")}
          onClose={() => {
            if (status?.state === "WAITING") act("cancel");
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}
