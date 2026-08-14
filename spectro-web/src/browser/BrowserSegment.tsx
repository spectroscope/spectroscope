// The browser surface — where the visible browser lives, on BOTH faces.
//
// TWO faces, one component, decided by where this page runs (card 226):
//
// - In the desktop shell, what this component draws is a HOLE. The page itself
//   is a native WebContentsView the shell lays over this window, so React
//   reserves the rectangle, measures it, and posts it to /api/browser/viewport;
//   the server forwards it down the control channel the shell already holds.
//   The frame, the address line and the empty state are React's; the pixels
//   inside the frame are Chromium's.
//
// - In an ordinary browser (the web face), there is no shell and nothing to lay
//   over the hole — card 200 measured why an iframe cannot fill it. What fills
//   it instead, since card 226: the server's own headless Chrome, watched over
//   /ws/browser-view. The pixels are a CDP screencast drawn into an <img>, and
//   the reader's clicks, keys and typed addresses travel back up the same
//   socket in browser_computer's own argument names. The desktop pane still
//   wins whenever its shell is attached — one browser per session — and this
//   segment SAYS which face is live rather than leaving a still picture to
//   read as a bug.
//
// ONE component, TWO doors (card 218). The owner asked for both: a `browser`
// tab inside the session, which binds the browser to the session by
// construction, AND the rail's Browser segment as the large view onto the
// current session's browser. Both mount this file with the same session id;
// on the desktop face the shell keys its views by that id, on the web face
// the view socket keys its one-viewer-per-session rule by it. Only one door is
// ever on screen, because they are two arms of the same layout.

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useBrowserActionCue } from "../state/browserCue";
import { useLang } from "../state/lang";
import {
  clickFrame,
  faceLabelKey,
  historyFrame,
  keyFrame,
  keyName,
  navigateFrame,
  parseViewMessage,
  screenshotFilename,
  scrollFrame,
  toDevicePoint,
  typedAddress,
  unwatchFrame,
  viewSocketUrl,
  watchFrame,
  webFaceMode,
  wheelStep,
  type ViewPicture,
  type ViewState,
  type WebFaceMode,
} from "./liveView";
import {
  isDesktopShell,
  panelNoteKey,
  panelState,
  shouldReport,
  toPaneRect,
  type BrowserStatus,
  type PaneRect,
} from "./viewport";

/** How often the shell path re-asks whether a pane is on the other end. */
const STATUS_POLL_MS = 4000;

/** How long a dropped view socket waits before dialling again. */
const VIEW_RETRY_MS = 2000;

/** How long wheel deltas pool before ONE scroll frame carries them. A trackpad
 *  fires dozens of events per gesture; a frame per event would put a CDP call
 *  on each. A timer, deliberately not requestAnimationFrame: a hidden pane
 *  fires no rAF (the trace-metrics lesson, 2026-08-13), and a measurement that
 *  waits on frames while hidden waits forever. */
const WHEEL_FLUSH_MS = 80;

/**
 * The browser surface for one session.
 *
 * @param props.active    whether this surface is the one on screen
 * @param props.sessionId whose browser belongs here, or null when the shown
 *                        session has not minted an id yet
 */
export function BrowserSegment(props: { active: boolean; sessionId: string | null }): React.JSX.Element {
  const lang = useLang();
  const hole = useRef<HTMLDivElement | null>(null);
  // Whether the pane can be over THIS window at all. Read once: a page does not
  // move between hosts.
  const inShell = isDesktopShell(navigator.userAgent);
  const lastSent = useRef<PaneRect | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const sessionId = props.sessionId;

  // The web face's half: what /ws/browser-view has said so far.
  const [view, setView] = useState<ViewState | null>(null);
  const [picture, setPicture] = useState<ViewPicture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const cue = useBrowserActionCue();

  // The rectangle (desktop face). Measured from the hole itself rather than
  // computed from the layout, because the layout is the sidebar's width plus
  // the header's height plus whatever the design tokens say today — three
  // numbers that go stale.
  useEffect(() => {
    let alive = true;
    const report = (): void => {
      // Only the shell's own window may position the pane. Without this a
      // second reader in an ordinary browser would drag the native overlay to
      // match THEIR window, moving a page out from under the operator.
      if (!inShell) return;
      const box = hole.current?.getBoundingClientRect();
      if (!box) return;
      const next = toPaneRect(box, props.active, sessionId);
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
      // Leaving the surface hides the pane. Without this the native overlay
      // stays on top of whatever the reader switched TO, which is the one
      // failure a native overlay makes that a div never could.
      if (!alive && inShell) {
        void fetch("/api/browser/viewport", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(lastSent.current ?? toPaneRect({ left: 0, top: 0, width: 0, height: 0 }, false, sessionId)),
            visible: false,
          }),
        }).catch(() => {});
      }
    };
  }, [props.active, inShell, sessionId]);

  // The address line of the DESKTOP face asks about THIS session's browser
  // over REST. The web face does not poll: its view socket pushes a state
  // frame on every change, which is fresher than any interval.
  useEffect(() => {
    let alive = true;
    if (sessionId === null || !inShell) {
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
  }, [sessionId, inShell]);

  // The picture channel (web face): watch this session's browser and keep
  // watching across drops. Watching an idle session spawns nothing — the
  // server asks hasPage() first — so holding the socket open is free.
  useEffect(() => {
    setView(null);
    setPicture(null);
    setNotice(null);
    setDraft(null);
    if (inShell || sessionId === null) return;
    let alive = true;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    const open = (): void => {
      if (!alive) return;
      socket = new WebSocket(viewSocketUrl(window.location));
      socketRef.current = socket;
      socket.onopen = () => socket?.send(JSON.stringify(watchFrame(sessionId)));
      socket.onmessage = (event: MessageEvent) => {
        const msg = parseViewMessage(event.data);
        if (msg === null) return;
        switch (msg.kind) {
          case "state":
            setView(msg.state);
            // A face flip away from the web engine ends the cast; a held last
            // frame would look exactly like a live one, which is the lie the
            // state frame exists to prevent.
            if (msg.state.live !== "web") setPicture(null);
            break;
          case "frame":
            setPicture(msg.picture);
            break;
          case "verb": {
            if (msg.ok) {
              setNotice(null);
              const url = msg.url;
              if (url !== null) setView((v) => (v === null ? v : { ...v, url }));
            } else if (msg.error !== null) {
              setNotice(msg.error);
            }
            break;
          }
          case "refused":
          case "error":
            setNotice(msg.sentence);
            break;
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (!alive) return;
        // The server is gone or restarting: the picture is stale the moment
        // the cast stops, and "connecting" is the honest mode until a state
        // frame answers again.
        setView(null);
        setPicture(null);
        retry = window.setTimeout(open, VIEW_RETRY_MS);
      };
    };
    open();
    return () => {
      alive = false;
      if (retry !== null) window.clearTimeout(retry);
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(unwatchFrame()));
        } catch {
          // Closing anyway; the server's afterConnectionClosed unwatches too.
        }
      }
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [inShell, sessionId]);

  // The agent drove the browser (a browser_action arrived on the main socket):
  // re-issue watch, which restarts the cast on the page the agent is now on.
  // The core half discloses that an agent navigation mid-watch does not
  // restart it by itself; this effect is the UI's side of that contract.
  useEffect(() => {
    if (cue === 0 || inShell || sessionId === null) return;
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(watchFrame(sessionId)));
    }
  }, [cue, inShell, sessionId]);

  const send = useCallback((frame: Record<string, unknown>): void => {
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }, []);

  if (!inShell && sessionId !== null) {
    return (
      <WebFaceView
        sessionId={sessionId}
        mode={webFaceMode(view)}
        url={view?.url ?? null}
        draft={draft}
        picture={picture}
        notice={notice}
        send={send}
        onDraft={setDraft}
      />
    );
  }

  // The desktop face, and the no-session case on either face: the hole, the
  // read-only address line and the honest empty states — unchanged from card
  // 201, because the shell's pane still fills this exact rectangle.
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
      </div>
      {/* What the fence promises, where the OPERATOR can read it. A review on
          2026-08-13 found the settings text promising a fence that a redirect
          walked around; the hole is closed, and what is still outside anybody's
          reach is said here rather than only in a source comment. */}
      <p className="browser-fence">{t(lang, "browser.fenceNote")}</p>
    </section>
  );
}

/** What the web face's view needs to render — a function of its props, so the
 *  suite can read every mode without a socket. */
export interface WebFaceViewProps {
  sessionId: string;
  mode: WebFaceMode;
  /** The page's address per the latest state or verb frame. */
  url: string | null;
  /** What the reader typed into the bar and has not committed. */
  draft: string | null;
  picture: ViewPicture | null;
  /** A refusal or error sentence, shown where the address was typed. */
  notice: string | null;
  send(frame: Record<string, unknown>): void;
  onDraft(next: string | null): void;
}

/**
 * The web face of the browser segment (card 226): the streamed picture, the
 * URL bar, back/forward, reload and the screenshot control — the desktop
 * pane's surface, so a reader does not relearn it between faces.
 *
 * The face line is criterion 5's honesty: one browser per session means this
 * segment must say WHOSE picture it shows ("server face"), whose it does not
 * ("desktop pane" — the pane wins), and when there is none at all. The old
 * stub text survives only in that last mode, where no real thing stands.
 */
export function WebFaceView(props: WebFaceViewProps): React.JSX.Element {
  const lang = useLang();
  const { sessionId, mode, url, draft, picture, notice, send, onDraft } = props;
  // Wheel deltas pool here between flushes — a ref, because pooling must not
  // re-render, and the flush must read what accumulated after it was armed.
  const wheel = useRef<{ dx: number; dy: number; point: [number, number] | null; timer: number | null }>({
    dx: 0,
    dy: 0,
    point: null,
    timer: null,
  });
  useEffect(
    () => () => {
      if (wheel.current.timer !== null) window.clearTimeout(wheel.current.timer);
    },
    [],
  );

  /** The event's point on the shown picture, in the PAGE's own pixels. */
  const devicePoint = (event: {
    clientX: number;
    clientY: number;
    currentTarget: Element;
  }): [number, number] | null => {
    if (picture === null) return null;
    const box = event.currentTarget.getBoundingClientRect();
    return toDevicePoint(
      event.clientX - box.left,
      event.clientY - box.top,
      box.width,
      box.height,
      picture.deviceWidth,
      picture.deviceHeight,
    );
  };

  const onPictureClick = (event: React.MouseEvent<HTMLImageElement>): void => {
    const point = devicePoint(event);
    if (point === null) return;
    send(clickFrame(sessionId, point));
    // Focus follows the click, so the keys the reader types next reach the
    // field they just clicked into — the pane's own behaviour.
    event.currentTarget.focus();
  };

  const onPictureWheel = (event: React.WheelEvent<HTMLImageElement>): void => {
    const pooled = wheel.current;
    pooled.dx += event.deltaX;
    pooled.dy += event.deltaY;
    const point = devicePoint(event);
    if (point !== null) pooled.point = point;
    if (pooled.timer !== null) return;
    pooled.timer = window.setTimeout(() => {
      pooled.timer = null;
      const step = wheelStep(pooled.dx, pooled.dy);
      pooled.dx = 0;
      pooled.dy = 0;
      if (step !== null && pooled.point !== null) {
        send(scrollFrame(sessionId, pooled.point, step.direction, step.amount));
      }
    }, WHEEL_FLUSH_MS);
  };

  const onPictureKey = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    const name = keyName(event.key, event.ctrlKey, event.metaKey);
    if (name === null) return; // Tab, Escape and shortcuts stay the app's
    event.preventDefault();
    send(keyFrame(sessionId, name));
  };

  const commit = (): void => {
    const target = typedAddress(draft ?? "");
    if (target === null) return;
    // A standing refusal clears on the ANSWER, not on the ask: the navigate
    // comes back as a verb frame (clears it) or a fresh refusal (replaces it).
    send(navigateFrame(sessionId, target));
    onDraft(null);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    commit();
  };

  const saveShot = (): void => {
    if (picture === null) return;
    const anchor = document.createElement("a");
    anchor.href = picture.dataUrl;
    anchor.download = screenshotFilename(Date.now());
    anchor.click();
  };

  const live = mode === "web";

  return (
    <section className="browser-segment" aria-label={t(lang, "browser.title")}>
      <header className="browser-bar">
        <span
          className="browser-dot"
          data-attached={mode === "web" || mode === "desktop"}
          aria-hidden="true"
        />
        {live ? (
          <>
            <button
              type="button"
              className="view-nav"
              aria-label={t(lang, "browser.view.back")}
              onClick={() => send(historyFrame(sessionId, "back"))}
            >
              ‹
            </button>
            <button
              type="button"
              className="view-nav"
              aria-label={t(lang, "browser.view.forward")}
              onClick={() => send(historyFrame(sessionId, "forward"))}
            >
              ›
            </button>
            <button
              type="button"
              className="view-nav"
              aria-label={t(lang, "browser.view.reload")}
              disabled={url === null}
              onClick={() => {
                if (url !== null) send(navigateFrame(sessionId, url));
              }}
            >
              ⟳
            </button>
            <form
              className="view-address"
              onSubmit={submit}
              // The typed address travels the fence before any engine dials;
              // a refusal comes back as its own frame and lands in the notice.
            >
              <input
                className="view-address-input"
                aria-label={t(lang, "browser.view.address")}
                placeholder={t(lang, "browser.view.addressHint")}
                value={draft ?? url ?? ""}
                onChange={(event) => onDraft(event.target.value)}
                // Enter is handled HERE, not left to implicit form submission.
                // Measured live on 2026-08-14: a CDP-injected Return — the way
                // this product's own pane drives keys — never fired the
                // implicit path, while requestSubmit() navigated fine.
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                  }
                }}
                spellCheck={false}
                autoComplete="off"
              />
            </form>
          </>
        ) : (
          <span className="browser-address" title={url ?? undefined}>
            {url ?? t(lang, "browser.noPage")}
          </span>
        )}
        {mode !== "connecting" && (
          <span className="view-face" title={t(lang, "browser.view.faceTitle")}>
            {t(lang, faceLabelKey(mode))}
          </span>
        )}
        {live && (
          <button
            type="button"
            className="view-nav"
            aria-label={t(lang, "browser.view.screenshot")}
            disabled={picture === null}
            onClick={saveShot}
          >
            ⤓
          </button>
        )}
      </header>
      <div className="browser-hole">
        {live && picture !== null ? (
          <img
            className="view-live"
            src={picture.dataUrl}
            alt={t(lang, "browser.view.pictureLabel")}
            tabIndex={0}
            draggable={false}
            onClick={onPictureClick}
            onWheel={onPictureWheel}
            onKeyDown={onPictureKey}
          />
        ) : (
          <div className="browser-empty">
            {mode === "connecting" ? (
              <p>{t(lang, "browser.loadingNote")}</p>
            ) : (
              <>
                <h2>{t(lang, "browser.title")}</h2>
                {mode === "web" ? (
                  <p>{t(lang, "browser.view.idleNote")}</p>
                ) : mode === "desktop" ? (
                  <p>{t(lang, "browser.view.desktopLiveNote")}</p>
                ) : (
                  <>
                    <p>{t(lang, "browser.noShellNote")}</p>
                    <p className="browser-empty-hint">{t(lang, "browser.noShellHint")}</p>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {notice !== null && (
        <p className="view-notice" role="alert">
          {notice}
        </p>
      )}
      <p className="browser-fence">{t(lang, "browser.fenceNote")}</p>
    </section>
  );
}
