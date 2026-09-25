// Card 445: the one question before a session is deleted from its row menu.
// It names the session by the title its row shows, focuses Cancel first, and
// closes on Escape or a press on the backdrop. Portalled to the body for the
// same reason as the menu (SessionRowMenu.tsx): the rail is a size container,
// and a fixed backdrop inside it would cover the rail and not the window.

import { useEffect, useRef, type Ref } from "react";
import { createPortal } from "react-dom";
import { t, type Lang } from "../i18n/i18n";

/** The dialog itself, without the portal, so its markup is tested without one. */
export function SessionDeleteDialogBody(props: {
  lang: Lang;
  /** The title the row shows. */
  title: string;
  /** True while the delete is on its way; both buttons wait. */
  busy: boolean;
  /** True after a delete that did not go through. */
  failed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  cancelRef?: Ref<HTMLButtonElement>;
}) {
  const { lang } = props;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !props.busy) props.onCancel();
      }}
    >
      <div
        className="modal session-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-delete-title"
        aria-describedby="session-delete-note"
      >
        <h2 id="session-delete-title">{t(lang, "sess.delete.title")}</h2>
        <p className="session-delete-name">{props.title}</p>
        <p className="session-delete-note" id="session-delete-note">
          {t(lang, "sess.delete.note")}
        </p>
        {props.failed && (
          <p className="session-delete-failed" role="alert">
            {t(lang, "sess.delete.failed")}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="ghost"
            ref={props.cancelRef}
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {t(lang, "common.cancel")}
          </button>
          <button
            type="button"
            className="ghost session-delete-confirm"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {t(lang, "sess.delete.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SessionDeleteDialog(props: {
  lang: Lang;
  title: string;
  busy: boolean;
  failed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { busy, onCancel } = props;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return createPortal(<SessionDeleteDialogBody {...props} cancelRef={cancelRef} />, document.body);
}
