// The browser segment — where the visible browser lives, and the honest sign
// when it cannot.
//
// What this component draws is a HOLE. The page itself is a native
// WebContentsView the desktop shell lays over this window, so React reserves the
// rectangle, measures it, and posts it to /api/browser/viewport; the server
// forwards it down the control channel the shell already holds. The frame, the
// address line and the empty state are React's; the pixels inside the frame are
// Chromium's.
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
  shouldReport,
  toPaneRect,
  type BrowserStatus,
  type PaneRect,
} from "./viewport";

/** How often the segment re-asks whether a shell is on the other end. */
const STATUS_POLL_MS = 4000;

export function BrowserSegment(props: { active: boolean }): React.JSX.Element {
  const lang = useLang();
  const hole = useRef<HTMLDivElement | null>(null);
  // Whether the pane can be over THIS window at all. Read once: a page does not
  // move between hosts.
  const inShell = isDesktopShell(navigator.userAgent);
  const lastSent = useRef<PaneRect | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);

  // The rectangle. Measured from the hole itself rather than computed from the
  // layout, because the layout is the sidebar's width plus the header's height
  // plus whatever the design tokens say today — three numbers that go stale.
  useEffect(() => {
    let alive = true;
    const report = (): void => {
      // Only the shell's own window may position the pane. Without this a
      // second reader in an ordinary browser would drag the native overlay to
      // match THEIR window, moving a page out from under the operator.
      if (!inShell) return;
      const box = hole.current?.getBoundingClientRect();
      if (!box) return;
      const next = toPaneRect(box, props.active);
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
      alive = false;
      observer.disconnect();
      window.removeEventListener("resize", report);
      // Leaving the segment hides the pane. Without this the native overlay
      // stays on top of whatever the reader switched TO, which is the one
      // failure a native overlay makes that a div never could.
      if (!alive && inShell) {
        void fetch("/api/browser/viewport", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(lastSent.current ?? toPaneRect({ left: 0, top: 0, width: 0, height: 0 }, false)),
            visible: false,
          }),
        }).catch(() => {});
      }
    };
  }, [props.active, inShell]);

  useEffect(() => {
    let alive = true;
    const ask = async (): Promise<void> => {
      try {
        const res = await fetch("/api/browser/status");
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
  }, []);

  const state = panelState(status, inShell);

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
      </div>
      {/* What the fence promises, where the OPERATOR can read it. A review on
          2026-08-13 found the settings text promising a fence that a redirect
          walked around; the hole is closed, and what is still outside anybody's
          reach is said here rather than only in a source comment. */}
      <p className="browser-fence">{t(lang, "browser.fenceNote")}</p>
    </section>
  );
}
