// Card 431: the surface a session open raises over the main column.
//
// It is in the DOM from the click and fades in after a delay (opening.css), so
// a fast open never shows it. The spinner and the fade are CSS animations of
// transform and opacity, which Chromium can run on the compositor thread, so
// they can keep moving while the main thread is busy with the open. No
// JavaScript timer drives either of them.

import { useSyncExternalStore } from "react";
import { t, type Lang } from "../i18n/i18n";
import { openCount, type OpenProgress } from "../state/openProgress";
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
            {counted !== null ? openCount(lang, counted.folded, counted.total) : "\u00a0"}
          </span>
        </div>
      </div>
    </div>
  );
}
