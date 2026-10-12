// Card 431: the surface a session open raises over the main column.
//
// It is in the DOM from the click and fades in after a delay (opening.css), so
// a fast open never shows it. The spinner and the fade are CSS animations of
// transform and opacity, which Chromium can run on the compositor thread, so
// they can keep moving while the main thread is busy with the open. No
// JavaScript timer drives either of them.

import { useSyncExternalStore } from "react";
import { t, type Lang } from "../i18n/i18n";
import { openCount, openWire, type OpenProgress } from "../state/openProgress";
import type { SessionOpening } from "../state/sessionOpening";

export function OpeningSurface(props: { lang: Lang; opening: SessionOpening; progress: OpenProgress }) {
  const { lang, opening, progress } = props;
  // The count comes from the store, not from App state: a new reading renders
  // this surface and nothing around it.
  const reading = useSyncExternalStore(progress.subscribe, progress.read, progress.read);
  const counted = reading !== null && reading.ticket === opening.ticket ? reading : null;
  const title =
    opening.title === null
      ? opening.sessionId
      : opening.title !== ""
        ? opening.title
        : t(lang, "nav.emptySession");
  return (
    <div className="opening-surface" role="status" aria-live="polite">
      <div className="opening-card">
        <span className="opening-spinner" aria-hidden="true" />
        <div className="opening-text">
          <span className="opening-line">
            {t(lang, opening.purpose === "trace" ? "open.traceLine" : "open.line")}
          </span>
          <span className={opening.title === null ? "opening-title mono" : "opening-title"}>{title}</span>
          {/* Hidden from screen readers: it changes up to ten times a second,
              and a live region would announce every change. The line is there
              from the start, empty until the fold reports: the card is
              centred, and a line that arrived later moved it up by 11.3 px
              (measured in Chrome, 2026-09-25). */}
          <span className="opening-count tabular" aria-hidden="true">
            {counted === null
              ? "\u00a0"
              : counted.unit === "wire"
                ? openWire(lang, counted.folded, counted.total)
                : openCount(lang, counted.folded, counted.total)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Card 527 criterion 8: the same card and spinner while the speech model
 * loads, over the composer, faded in after the same delay (opening.css).
 * Card 528: Chat renders it only after the server's loading frame. With
 * whisper-cli that frame comes on every press, because every process loads
 * the model (683 to 2070 ms from the ready frame over 10 presses in card 527's
 * live checks of 2026-10-11). With the resident whisper-server it comes on the
 * first press and after the server stopped, not on the presses between.
 *
 * @param props the language and the model's file name
 */
export function SpeechModelOpening(props: { lang: Lang; model: string }) {
  return (
    <div className="opening-surface opening-surface--speech" role="status" aria-live="polite">
      <div className="opening-card">
        <span className="opening-spinner" aria-hidden="true" />
        <div className="opening-text">
          <span className="opening-line">{t(props.lang, "open.speechModel")}</span>
          <span className="opening-title mono">{props.model}</span>
        </div>
      </div>
    </div>
  );
}
