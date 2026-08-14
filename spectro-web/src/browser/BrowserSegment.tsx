// The browser surface — where the visible browser lives, and the honest sign
// when it cannot.
//
// What this component draws is a HOLE. The page itself is a native
// WebContentsView the desktop shell lays over this window, so React reserves the
// rectangle, measures it, and posts it to /api/browser/viewport; the server
// forwards it down the control channel the shell already holds. The frame, the
// address line and the empty state are React's; the pixels inside the frame are
// Chromium's.
//
// ONE component, TWO doors (card 218). The owner asked for both: a `browser` tab
// inside the session, which binds the browser to the session by construction,
// AND the rail's Browser segment as the large view onto the current session's
// browser. Both mount this file with the same session id, and the shell keys its
// views by that id — so the second door is a view, never a second instance.
// Whichever is on screen posts the rectangle it reserved, and the pane moves to
// it; only one of them can be on screen at a time, because they are two arms of
// the same layout.
//
// On the web face there is no shell, so there is nothing behind the frame. That
// is the trade card 200 made and the owner ratified — foreign sites refuse
// framing, the same-origin policy forbids reading or scripting what is framed
// (which kills eval, 41 % of the measured calls), and frame content cannot be
// rasterised — and it is said HERE, in the panel, rather than only in a
// document, because an empty rectangle reads as a bug.

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  isDesktopShell,
  panelNoteKey,
  panelState,
  paneVisibility,
  shouldReport,
  toPaneRect,
  type BrowserStatus,
  type PaneRect,
} from "./viewport";

/** How often the segment re-asks whether a shell is on the other end. */
const STATUS_POLL_MS = 4000;

/**
 * The browser surface for one session.
 *
 * @param props.active      whether this surface is the one on screen — the dock
 *                          panel (card 219) also folds "collapsed" and "a modal
 *                          covers me" into this, because no CSS can cover the
 *                          native pane
 * @param props.sessionId   whose browser belongs in the hole, or null when the
 *                          shown session has not minted an id yet
 * @param props.floorGuard  card 219: this hole can be crowded below the shell's
 *                          MIN_PANE — post `visible: false` under the floor
 *                          instead of a rectangle the shell would refuse
 * @param props.reportNonce card 219: changes whenever the surrounding layout
 *                          commits. A ResizeObserver fires on size, never on
 *                          position, so a hole moved by a neighbour closing
 *                          would otherwise leave the native page over the old
 *                          rectangle.
 */
export function BrowserSegment(props: {
  active: boolean;
  sessionId: string | null;
  floorGuard?: boolean;
  reportNonce?: string;
}): React.JSX.Element {
  const lang = useLang();
  const hole = useRef<HTMLDivElement | null>(null);
  // Whether the pane can be over THIS window at all. Read once: a page does not
  // move between hosts.
  const inShell = isDesktopShell(navigator.userAgent);
  const lastSent = useRef<PaneRect | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [floored, setFloored] = useState(false);
  const sessionId = props.sessionId;
  const floorGuard = props.floorGuard === true;

  // The rectangle. Measured from the hole itself rather than computed from the
  // layout, because the layout is the sidebar's width plus the header's height
  // plus whatever the design tokens say today — three numbers that go stale.
  useEffect(() => {
    const report = (): void => {
      // Only the shell's own window may position the pane. Without this a
      // second reader in an ordinary browser would drag the native overlay to
      // match THEIR window, moving a page out from under the operator.
      if (!inShell) return;
      const box = hole.current?.getBoundingClientRect();
      if (!box) return;
      const { visible, belowFloor } = paneVisibility(box, props.active, floorGuard);
      setFloored(belowFloor);
      const next = toPaneRect(box, visible, sessionId);
      if (!shouldReport(next, lastSent.current)) return;
      lastSent.current = next;
      void fetch("/api/browser/viewport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).catch(() => {
        // No shell, or the server restarting. The panel already says so; a
        // failed rectangle post must not become an error the reader sees twice.
      });
    };
    report();
    const observer = new ResizeObserver(report);
    if (hole.current) observer.observe(hole.current);
    window.addEventListener("resize", report);
    return () => {
      // Observers only — the hide POST lives in its own effect below. It used
      // to live here, firing on every dep change; that was invisible while the
      // deps were three slow-moving values, and became a hide/show pair per
      // pointer move once reportNonce (card 219) made layout commits a dep.
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
    // reportNonce is not read inside — it is a layout-commit signal: the dock
    // bumps it when panels open, close, fold or the weights move, so the hole
    // is re-measured after React commits even when its SIZE did not change.
    // An active flip needs no cleanup post either: this same effect re-runs
    // and report() posts the visible:false itself (paneVisibility, wanted=false).
  }, [props.active, inShell, sessionId, floorGuard, props.reportNonce]);

  // Leaving the surface hides the pane. Without this the native overlay stays
  // on top of whatever the reader switched TO, which is the one failure a
  // native overlay makes that a div never could. Keyed on the session, not on
  // the layout: it must fire on unmount and on a session swap, never on a
  // divider drag.
  useEffect(() => {
    return () => {
      if (!inShell) return;
      void fetch("/api/browser/viewport", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(lastSent.current ?? toPaneRect({ left: 0, top: 0, width: 0, height: 0 }, false, sessionId)),
          visible: false,
        }),
      }).catch(() => {});
    };
  }, [inShell, sessionId]);

  // The address line asks about THIS session's browser. Asking without a
  // session id would answer with the shell's own idea of "the" page, which is
  // the mistake card 218 exists to remove.
  useEffect(() => {
    let alive = true;
    if (sessionId === null) {
      setStatus(null);
      return () => {
        alive = false;
      };
    }
    const ask = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/browser/status?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as BrowserStatus;
        if (alive) setStatus(body);
      } catch {
        if (alive) setStatus({ attached: false, url: null });
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), STATUS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  const state = panelState(status, inShell, sessionId);

  return (
    <section className="browser-segment" aria-label={t(lang, "browser.title")}>
      <header className="browser-bar">
        <span className="browser-dot" data-attached={state === "attached"} aria-hidden="true" />
        <span className="browser-address" title={status?.url ?? undefined}>
          {status?.url ?? t(lang, "browser.noPage")}
        </span>
      </header>
      <div className="browser-hole" ref={hole}>
        {state !== "attached" && (
          <div className="browser-empty">
            <h2>{t(lang, "browser.title")}</h2>
            <p>{t(lang, panelNoteKey(state))}</p>
            {state === "no-shell" && <p className="browser-empty-hint">{t(lang, "browser.noShellHint")}</p>}
          </div>
        )}
        {state === "attached" && floored && (
          // The pane is hidden on purpose: this hole is under the shell's
          // MIN_PANE floor, and a posted rectangle would be refused and
          // replaced with a fallback the frame is not. Saying so beats an
          // empty rectangle that reads as a bug.
          <p className="browser-floor-note">{t(lang, "browser.floorNote")}</p>
        )}
      </div>
      {/* What the fence promises, where the OPERATOR can read it. A review on
          2026-08-13 found the settings text promising a fence that a redirect
          walked around; the hole is closed, and what is still outside anybody's
          reach is said here rather than only in a source comment. */}
      <p className="browser-fence">{t(lang, "browser.fenceNote")}</p>
    </section>
  );
}
