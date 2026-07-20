// The serious moment: the run is paused server-side until a human decides.
// Deny is the safe default (initial focus, Esc). The scrim never closes the
// modal — a decision has to be deliberate. The input is shown in full: you
// approve what you see.

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { PendingPermission } from "../state/reducer";
import { prettyJson } from "../format";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function PermissionDialog(props: {
  permission: PendingPermission;
  /** Position in the queue, 0-based; total open requests. */
  index: number;
  total: number;
  /** True only for a REAL (configured) workspace — a per-session temp folder
   *  has no project settings file to persist a rule into, so the "dauerhaft"
   *  checkbox stays hidden (behind a small hint) rather than offering a
   *  write that would 404. */
  workspaceConfigured: boolean;
  onDecide: (
    callId: string,
    allowed: boolean,
    opts?: { remember?: boolean; persist?: boolean },
  ) => void;
}) {
  const { permission } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const lang = useLang();

  // "Always allow" remembers for the session; "persist" (gated behind it) writes it
  // to the project's .spectro/settings.json. Only Allow carries the flags.
  const [remember, setRemember] = useState(false);
  const [persist, setPersist] = useState(false);

  const decide = (allowed: boolean): void =>
    props.onDecide(
      permission.callId,
      allowed,
      allowed ? { remember, persist: remember && persist } : undefined,
    );

  // Esc denies; Tab is trapped inside the dialog while the run is paused.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      decide(false);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, [tabindex="0"]',
    );
    if (focusables === undefined || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={onKeyDown}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        ref={dialogRef}
      >
        <div className="modal-head">
          <span className="eyebrow sand">Permission</span>
          {props.total > 1 && (
            <span className="queue-counter tabular">
              {t(lang, "perm.queue", { i: props.index + 1, n: props.total })}
            </span>
          )}
        </div>
        <h2 id="permission-title">
          <span className="mono">{permission.name}</span> {t(lang, "perm.wants")}
        </h2>
        {permission.agentId !== "main" && (
          <p className="requested-by">{t(lang, "perm.by", { id: permission.agentId })}</p>
        )}
        <pre className="io-block modal-input" tabIndex={0}>
          {prettyJson(permission.input)}
        </pre>
        <div className="modal-remember">
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked);
                if (!e.target.checked) setPersist(false);
              }}
            />{" "}
            {t(lang, "perm.always")} <span className="mono">{permission.name}</span> {t(lang, "perm.session")}
          </label>
          {remember && props.workspaceConfigured && (
            <label className="modal-remember-persist">
              <input
                type="checkbox"
                checked={persist}
                onChange={(e) => setPersist(e.target.checked)}
              />{" "}
              {t(lang, "perm.persist")}
            </label>
          )}
          {remember && !props.workspaceConfigured && (
            <p className="modal-remember-hint">{t(lang, "perm.noPersistHint")}</p>
          )}
        </div>
        <div className="modal-actions">
          {/* Deny is the ghost button and carries the initial focus — the safe default. */}
          <button type="button" className="ghost" autoFocus onClick={() => decide(false)}>
            {t(lang, "perm.deny")}
          </button>
          <button type="button" className="primary" onClick={() => decide(true)}>
            {t(lang, "perm.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
