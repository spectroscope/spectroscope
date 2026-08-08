// Which microphone, chosen (card 187 step 2), on the house's own popover
// mechanics: outside click, Escape, arrow keys, the wsg-* look. Same shape as
// DisclosureMenu and ComposerGear, so the third popover in the composer bar
// behaves exactly like the first two.
//
// ⚠️ THE ONE RULE THIS PANE EXISTS TO KEEP: `enumerateDevices()` answers with
// EMPTY labels until the microphone has been granted once. A list rendered from
// those is five blank rows, which reads as a broken picker rather than an
// unpermitted one. So the unnamed case gets a SENTENCE, and the list appears by
// itself the moment permission turns the names on — the hook refreshes right
// after a successful grant.

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { setMicDevice, useMicDevice, type MicChoice } from "../state/micDevice";

export function MicMenu({
  choice,
  onOpen,
}: {
  choice: MicChoice;
  /** Asked for a fresh list whenever the menu opens: devices come and go, and a
   *  list from three minutes ago is a list of what used to be plugged in. */
  onOpen: () => void;
}) {
  const lang = useLang();
  const chosen = useMicDevice();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    onOpen();
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpen]);

  const pick = (deviceId: string | null): void => {
    setMicDevice(deviceId);
    setOpen(false);
  };

  // The rows: "system default" first, because it is a real choice and the one a
  // reader starts on, then whatever the browser named.
  const named = choice.unnamed ? [] : choice.devices;

  return (
    <div className="wsg-anchor mic-anchor" ref={ref}>
      <button
        type="button"
        className="icon-button mic-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(lang, "voice.pick.title")}
        title={t(lang, "voice.pick.title")}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
          <path d="M4 6l4 4 4-4z" />
        </svg>
      </button>

      {open && (
        <div className="wsg-pop mic-pop" role="dialog" aria-label={t(lang, "voice.pick.title")}>
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "voice.pick.title")}</span>
            </div>
            {choice.unnamed ? (
              /* Not an error and not an empty list: the browser HAS devices and
                 is withholding their names until permission is granted. Saying
                 so beats painting five blank rows. */
              <p className="wsg-mode-hint mic-pop-note">{t(lang, "voice.pick.unnamed")}</p>
            ) : (
              <div className="wsg-modes" role="menu" aria-label={t(lang, "voice.pick.title")}>
                <div
                  role="menuitemradio"
                  aria-checked={chosen === null}
                  className={`wsg-mode-row${chosen === null ? " wsg-mode-row--active" : ""}`}
                  onClick={() => pick(null)}
                >
                  <span className="wsg-mode-marker" aria-hidden="true">
                    {chosen === null ? "›" : ""}
                  </span>
                  <span className="wsg-mode-body">
                    <span className="wsg-mode-name">{t(lang, "voice.pick.system")}</span>
                  </span>
                </div>
                {named.map((d) => (
                  <div
                    key={d.deviceId}
                    role="menuitemradio"
                    aria-checked={chosen === d.deviceId}
                    className={`wsg-mode-row${chosen === d.deviceId ? " wsg-mode-row--active" : ""}`}
                    onClick={() => pick(d.deviceId)}
                  >
                    <span className="wsg-mode-marker" aria-hidden="true">
                      {chosen === d.deviceId ? "›" : ""}
                    </span>
                    <span className="wsg-mode-body">
                      <span className="wsg-mode-name">{d.label}</span>
                    </span>
                  </div>
                ))}
                {named.length === 0 && (
                  <p className="wsg-mode-hint mic-pop-note">{t(lang, "voice.pick.none")}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
