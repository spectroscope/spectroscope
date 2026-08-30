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
import { dismissesMenu, MODAL_LAYER } from "../components/menuDismiss";
import { t } from "../i18n/i18n";
import { useBrowserActionCue } from "../state/browserCue";
import { useLang } from "../state/lang";
import {
  clickFrame,
  closePageFrame,
  heldPictureSurvives,
  faceLabelKey,
  historyFrame,
  reloadFrame,
  keyFrame,
  keyName,
  launchListFrame,
  launchPlayFrame,
  navigateFrame,
  parseViewMessage,
  screenshotFilename,
  screenshotVerbFrame,
  scrollFrame,
  toDevicePoint,
  typedAddress,
  unwatchFrame,
  viewSocketUrl,
  watchFrame,
  webFaceMode,
  wheelStep,
  type LaunchList,
  type VerbShot,
  type ViewPicture,
  type ViewState,
  type WebFaceMode,
} from "./liveView";
import {
  isDesktopShell,
  panelNoteKey,
  panelState,
  paneVisibility,
  shouldReport,
  toPaneRect,
  type BrowserStatus,
  type PaneRect,
  type PanelState,
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
  const hole = useRef<HTMLDivElement | null>(null);
  // Whether the pane can be over THIS window at all. Read once: a page does not
  // move between hosts.
  const inShell = isDesktopShell(navigator.userAgent);
  const lastSent = useRef<PaneRect | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [floored, setFloored] = useState(false);
  const sessionId = props.sessionId;
  const floorGuard = props.floorGuard === true;

  // What /ws/browser-view has said so far. Since card 227 the socket serves
  // BOTH faces: the web face's picture, and the desktop face's control row
  // and start page — the pictures stay the shell's, the verbs travel here.
  const [view, setView] = useState<ViewState | null>(null);
  const [picture, setPicture] = useState<ViewPicture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  // The start page's data (card 227), and which play button is mid-press.
  const [launch, setLaunch] = useState<LaunchList | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const cue = useBrowserActionCue();

  // The rectangle (desktop face). Measured from the hole itself rather than
  // computed from the layout, because the layout is the sidebar's width plus
  // the header's height plus whatever the design tokens say today — three
  // numbers that go stale.
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

  // The view channel — both faces since card 227: watch this session's
  // browser and keep watching across drops. Watching an idle session spawns
  // nothing — the server asks hasPage() first — so holding the socket open is
  // free. On the desktop face no frame ever arrives (the shell's pane carries
  // the pixels); what travels are the control row's verbs, the state frames
  // and the start page's data.
  useEffect(() => {
    setView(null);
    setPicture(null);
    setNotice(null);
    setDraft(null);
    setLaunch(null);
    setPlaying(null);
    if (sessionId === null) return;
    let alive = true;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    const open = (): void => {
      if (!alive) return;
      socket = new WebSocket(viewSocketUrl(window.location));
      socketRef.current = socket;
      socket.onopen = () => {
        socket?.send(JSON.stringify(watchFrame(sessionId)));
        // The start page's data rides the same socket (card 227).
        socket?.send(JSON.stringify(launchListFrame(sessionId)));
      };
      socket.onmessage = (event: MessageEvent) => {
        const msg = parseViewMessage(event.data);
        if (msg === null) return;
        switch (msg.kind) {
          case "state":
            setView(msg.state);
            // A held last frame would look exactly like a live one, which is
            // the lie the state frame exists to prevent. This asked only about
            // the FACE, and closing the page does not flip the face: the last
            // frame of the closed page stayed on screen and stayed clickable.
            // See heldPictureSurvives — it answers for both cases at once.
            if (!heldPictureSurvives(msg.state)) setPicture(null);
            break;
          case "frame":
            setPicture(msg.picture);
            break;
          case "verb": {
            if (msg.ok) {
              setNotice(null);
              const url = msg.url;
              // Applied unconditionally, which is only safe because no verb
              // answers with an address it is not on: navigate, back, forward
              // and reload each name where they LANDED, and the one verb whose
              // reply carried a pre-click address — input — no longer sends
              // one (BrowserViewSocket.answerVerb, and the test named
              // aClickThatMovesThePage… on the server side). A verb url that
              // could be older than the state frame beside it would undo it.
              if (url !== null) setView((v) => (v === null ? v : { ...v, url }));
              // The desktop row's screenshot: no client-side picture exists on
              // that face, so the shot rides the answer and is saved here.
              if (msg.verb === "screenshot" && msg.shot !== null) saveWireShot(msg.shot);
            } else if (msg.error !== null) {
              setNotice(msg.error);
            }
            break;
          }
          case "refused":
          case "error":
            setNotice(msg.sentence);
            break;
          case "launchConfigs":
            setLaunch(msg);
            break;
          case "launchPlayed":
            setPlaying(null);
            if (msg.ok) {
              setNotice(null);
            } else if (msg.sentence !== null) {
              setNotice(msg.sentence);
            }
            // Whatever happened, the list's up/exited chips are stale now.
            socket?.send(JSON.stringify(launchListFrame(sessionId)));
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
  }, [sessionId]);

  // The agent drove the browser (a browser_action arrived on the main socket):
  // re-issue watch, which restarts the cast on the page the agent is now on —
  // and on the desktop face refreshes the state frame the address field reads.
  // The core half discloses that an agent navigation mid-watch does not
  // restart it by itself; this effect is the UI's side of that contract.
  useEffect(() => {
    if (cue === 0 || sessionId === null) return;
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(watchFrame(sessionId)));
    }
  }, [cue, sessionId]);

  const send = useCallback((frame: Record<string, unknown>): void => {
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }, []);

  // The play button (card 227): the server starts the configuration through
  // the SESSION's own supervisor and answers launch_played; `playing` holds
  // the pressed name so every play button disables while one start is in
  // flight — a second press mid-start would race the first.
  const onPlay = useCallback(
    (name: string): void => {
      if (sessionId === null) return;
      setPlaying(name);
      send(launchPlayFrame(sessionId, name));
    },
    [sessionId, send],
  );

  if (!inShell && sessionId !== null) {
    return (
      <WebFaceView
        sessionId={sessionId}
        mode={webFaceMode(view)}
        url={view?.url ?? null}
        canGoBack={view?.canGoBack ?? null}
        canGoForward={view?.canGoForward ?? null}
        draft={draft}
        picture={picture}
        notice={notice}
        launch={launch}
        playing={playing}
        send={send}
        onDraft={setDraft}
        onPlay={onPlay}
      />
    );
  }

  // The desktop face, and the no-session case on either face: the hole the
  // shell's pane fills, with card 227's control row above it and the start
  // page inside it while no page is open.
  return (
    <DesktopFaceView
      state={panelState(status, inShell, sessionId)}
      floored={floored}
      sessionId={sessionId}
      url={view?.url ?? status?.url ?? null}
      canGoBack={view?.canGoBack ?? null}
      canGoForward={view?.canGoForward ?? null}
      draft={draft}
      notice={notice}
      launch={launch}
      playing={playing}
      holeRef={hole}
      send={send}
      onDraft={setDraft}
      onPlay={onPlay}
      onShot={() => {
        if (sessionId !== null) send(screenshotVerbFrame(sessionId));
      }}
    />
  );
}

/** Saves a shot that arrived as verb fields — the desktop face's screenshot
 *  (card 227): the pixels live in the shell's pane, so the server hands the
 *  bytes back over the wire and this anchor writes them to a file. */
function saveWireShot(shot: VerbShot): void {
  const anchor = document.createElement("a");
  anchor.href = `data:${shot.mediaType};base64,${shot.dataBase64}`;
  anchor.download = screenshotFilename(Date.now(), shot.mediaType);
  anchor.click();
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
  /** The start page's data (card 227), or null before the server answered. */
  launch: LaunchList | null;
  /** The configuration a play press is starting, while it is in flight. */
  playing: string | null;
  /** Whether the live face has anywhere to go back to, or null for "it did not
   *  say" — card 344 (c). A null never disables; see ViewState. */
  canGoBack: boolean | null;
  canGoForward: boolean | null;
  send(frame: Record<string, unknown>): void;
  onDraft(next: string | null): void;
  onPlay(name: string): void;
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
  const { sessionId, mode, url, draft, picture, notice, launch, playing, send, onDraft, onPlay } = props;
  // Card 345: each face owns whether its launch menu is open. Not lifted —
  // the two faces are mutually exclusive per session, so a shared flag would be
  // one more thing that can disagree with what is on screen.
  const [launchOpen, setLaunchOpen] = useState(false);
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
          <NavControls
            sessionId={sessionId}
            url={url}
            draft={draft}
            canGoBack={props.canGoBack}
            canGoForward={props.canGoForward}
            send={send}
            onDraft={onDraft}
          />
        ) : (
          <>
            <span className="browser-address" title={url ?? undefined}>
              {url ?? t(lang, "browser.noPage")}
            </span>
            {mode === "desktop" && (
              // CARD 344 (a). The row used to collapse to the address alone
              // here, and this is the mode the OWNER is in whenever he runs the
              // desktop app: back, forward, reload, the address field and the
              // screenshot were simply absent, with nothing saying why. The two
              // faces are mutually exclusive by design (one browser per
              // session, the desktop pane wins), so the honest answer is a
              // sentence and not a second driver — the precedence rule is
              // untouched.
              <span className="browser-row-note">{t(lang, "browser.view.rowDesktopNote")}</span>
            )}
          </>
        )}
        <LaunchMenu
          launch={launch}
          playing={playing}
          onPlay={onPlay}
          open={launchOpen}
          onOpenChange={setLaunchOpen}
          onRefresh={() => send(launchListFrame(sessionId))}
        />
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
        {live && picture !== null && url !== null ? (
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
        ) : live && url === null ? (
          // The empty browser is the START PAGE (card 227): the session's
          // launch configurations, one play button each. Only where no page is
          // open at all — a page mid-cast keeps the idle sentence below.
          <StartPage launch={launch} playing={playing} onPlay={onPlay} />
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

/**
 * The control row both faces share (card 227): back, forward, reload, close and
 * the address field, in this order, speaking the view channel's own frames. On
 * the web face the verbs drive the server's headless Chrome; on the desktop
 * face the SAME frames route to the shell's pane — one browser per session,
 * whichever engine is live.
 *
 * <p>Card 344 made three of these honest. Back and forward carry a `disabled`
 * only where the live face SAID there is nothing there — an unknown answer
 * leaves them alone, because a wrong disabled is worse than the error sentence
 * it replaces (see {@link ViewState}). Reload asks for a reload rather than
 * re-navigating to the remembered address. Card 346 added the close.
 */
function NavControls(props: {
  sessionId: string;
  url: string | null;
  draft: string | null;
  /** Null means the live face did not say; a null never disables. */
  canGoBack: boolean | null;
  canGoForward: boolean | null;
  send(frame: Record<string, unknown>): void;
  onDraft(next: string | null): void;
}): React.JSX.Element {
  const lang = useLang();
  const { sessionId, url, draft, canGoBack, canGoForward, send, onDraft } = props;

  const commit = (): void => {
    const target = typedAddress(draft ?? "");
    if (target === null) return;
    // A standing refusal clears on the ANSWER, not on the ask: the navigate
    // comes back as a verb frame (clears it) or a fresh refusal (replaces it).
    send(navigateFrame(sessionId, target));
    onDraft(null);
  };

  return (
    <>
      <button
        type="button"
        className="view-nav"
        aria-label={t(lang, "browser.view.back")}
        disabled={canGoBack === false}
        onClick={() => send(historyFrame(sessionId, "back"))}
      >
        ‹
      </button>
      <button
        type="button"
        className="view-nav"
        aria-label={t(lang, "browser.view.forward")}
        disabled={canGoForward === false}
        onClick={() => send(historyFrame(sessionId, "forward"))}
      >
        ›
      </button>
      <button
        type="button"
        className="view-nav"
        aria-label={t(lang, "browser.view.reload")}
        disabled={url === null}
        onClick={() => send(reloadFrame(sessionId))}
      >
        ⟳
      </button>
      <button
        type="button"
        className="view-nav"
        aria-label={t(lang, "browser.view.closePage")}
        disabled={url === null}
        onClick={() => send(closePageFrame(sessionId))}
      >
        ✕
      </button>
      <form
        className="view-address"
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
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
  );
}

/**
 * The start page (card 227, criterion 2): the browser's empty state lists the
 * session's launch configurations (card 202) — one row per config with its
 * address, its state and a play button. Press play, the server starts the
 * configuration through the session's own supervisor and opens the browser on
 * its address; the answer travels back as a launch_played frame.
 *
 * With no configurations, one terse line says how to add one — the file is
 * authored by hand (card 202 keeps generation out of scope), so the line
 * names the file rather than a settings page that does not exist.
 */
/**
 * An address split so a narrow row cannot clip the part that matters.
 *
 * The row's address is the only flex-shrinkable item in it, and
 * `text-overflow: ellipsis` clips the TAIL — so `http://localhost:8080/` loses
 * the port first and keeps the seven characters that carry no information. Card
 * 227 asked for the configurations "listed with their ports"; this is what makes
 * that true on screen and not only in the DOM.
 *
 * PARSED, never pattern-matched. A regex for `:\d+` would call the `:8080` in
 * `http://user:8080@example.com/` a port, and would miss that an IPv6 host is
 * all colons. `URL` already knows which colon is the port, so it is asked.
 *
 * @param address the launch entry's address
 * @return the head that may shrink, and the tail that may not — tail is null
 *         when the address declares no port, because a row must not grow a
 *         colon the address never had
 */
function splitAddress(address: string): { head: string; tail: string | null } {
  let port: string;
  try {
    port = new URL(address).port;
  } catch {
    return { head: address, tail: null };
  }
  if (port === "") return { head: address, tail: null };
  const at = address.lastIndexOf(":" + port);
  if (at < 0) return { head: address, tail: null };
  return { head: address.slice(0, at), tail: address.slice(at) };
}

/**
 * The launch configurations, reachable while a page is open (card 345).
 *
 * <p>THE DEFECT IT CLOSES. {@link StartPage} is the only place in the product
 * that lists a session's launch configurations, and both its mounts sit behind
 * `live && url === null` — a condition that is true once, before anything opens
 * a page, and never again. The owner: "so kann ich … nie auf das default bild
 * mit den launch konfigs kommen."
 *
 * <p>IT RENDERS StartPage ITSELF rather than its own rows. Not tidiness: a
 * second rendering of the same list is a second place for the empty state, the
 * play button, the running chip and card 335's port split to drift. One
 * component, two places on screen.
 *
 * <p>The dismissal is the house's — `menuDismiss`, which already answers the
 * question card 255 walked into: a row inside a menu can open a modal, and a
 * modal that portals to the body is "outside" the anchor by construction.
 */
export function LaunchMenu(props: {
  launch: LaunchList | null;
  playing: string | null;
  onPlay(name: string): void;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Ask the server for the list again. Called each time the menu opens: the
   *  running/exited chips are otherwise refreshed only on socket open and after
   *  a play, so a long-lived session shows an hour-old state under a green dot. */
  onRefresh(): void;
}): React.JSX.Element {
  const lang = useLang();
  const { launch, playing, onPlay, open, onOpenChange, onRefresh } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    onRefresh();
  }, [open, onRefresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      if (
        dismissesMenu({
          inAnchor: ref.current !== null && ref.current.contains(target),
          inModal: target !== null && target.closest(MODAL_LAYER) !== null,
        })
      ) {
        onOpenChange(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="browser-launchmenu" ref={ref}>
      <button
        type="button"
        className="browser-launchmenu__btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t(lang, "browser.launchMenu")}
        title={t(lang, "browser.launchMenu")}
        onClick={() => onOpenChange(!open)}
      >
        {"\u25B8"}
      </button>
      {open && (
        <div className="browser-launchmenu__pop" role="menu">
          <StartPage launch={launch} playing={playing} onPlay={onPlay} />
        </div>
      )}
    </div>
  );
}

export function StartPage(props: {
  launch: LaunchList | null;
  playing: string | null;
  onPlay(name: string): void;
}): React.JSX.Element {
  const lang = useLang();
  const { launch, playing, onPlay } = props;
  return (
    <div className="browser-start">
      <h2>{t(lang, "browser.start.heading")}</h2>
      {launch === null ? null : !launch.ok ? (
        // The server's own sentence: not open here, no project folder yet,
        // or a launch file that could not be read.
        <p className="browser-start-note">{launch.sentence}</p>
      ) : launch.configs.length === 0 ? (
        <p className="browser-start-note">{t(lang, "browser.start.none")}</p>
      ) : (
        <ul className="browser-start-list">
          {launch.configs.map((config) => (
            <li key={config.name} className="browser-start-row">
              <button
                type="button"
                className="browser-start-play"
                aria-label={t(lang, "browser.start.play", { name: config.name })}
                disabled={playing !== null}
                onClick={() => onPlay(config.name)}
              >
                ▶
              </button>
              <span className="browser-start-name">{config.name}</span>
              {(() => {
                // The tooltip is the same idiom the address bar above uses
                // (title on an ellipsised span); the split is what makes the
                // port survive without one.
                if (config.address === null) {
                  return <span className="browser-start-address">—</span>;
                }
                const { head, tail } = splitAddress(config.address);
                return (
                  <>
                    <span className="browser-start-address" title={config.address}>
                      {head}
                    </span>
                    {tail !== null && <span className="browser-start-port">{tail}</span>}
                  </>
                );
              })()}
              {config.attaches && (
                <span className="browser-start-chip">{t(lang, "browser.start.attach")}</span>
              )}
              {config.up ? (
                <span className="browser-start-chip" data-up="true">
                  {t(lang, "browser.start.running")}
                </span>
              ) : config.exitCode !== null ? (
                <span className="browser-start-chip" data-exit="true">
                  {t(lang, "browser.start.exited", { code: config.exitCode })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {launch !== null && launch.ok && launch.skipped > 0 && (
        <p className="browser-start-skipped">{t(lang, "browser.start.skipped", { n: launch.skipped })}</p>
      )}
    </div>
  );
}

/** What the desktop face's view needs to render — a function of its props,
 *  like WebFaceView, so the suite reads every mode without a socket. */
export interface DesktopFaceViewProps {
  state: PanelState;
  /** Card 219: the hole is under the shell's MIN_PANE floor, pane hidden. */
  floored: boolean;
  sessionId: string | null;
  /** The page's address per the latest state frame or REST answer. */
  url: string | null;
  /** What the reader typed into the bar and has not committed. */
  draft: string | null;
  /** A refusal or error sentence, shown where the address was typed. */
  notice: string | null;
  /** The start page's data (card 227), or null before the server answered. */
  launch: LaunchList | null;
  /** The configuration a play press is starting, while it is in flight. */
  playing: string | null;
  /** Whether the live face has anywhere to go back to, or null for "it did not
   *  say" — card 344 (c). A null never disables; see ViewState. */
  canGoBack: boolean | null;
  canGoForward: boolean | null;
  /** Where BrowserSegment measures the pane's rectangle from. */
  holeRef?: React.Ref<HTMLDivElement>;
  send(frame: Record<string, unknown>): void;
  onDraft(next: string | null): void;
  onPlay(name: string): void;
  /** The screenshot control — the shot rides the wire back (saveWireShot). */
  onShot(): void;
}

/**
 * The desktop face (cards 201/227): the hole the shell's native pane fills,
 * now under the SAME control row the web face has — React above the hole, the
 * verbs travelling the view channel to the one per-session browser. While no
 * page is open the hole carries the start page; the pane, hidden while no
 * page exists, covers it the moment one opens.
 */
export function DesktopFaceView(props: DesktopFaceViewProps): React.JSX.Element {
  const lang = useLang();
  const { state, floored, sessionId, url, draft, notice, launch, playing } = props;
  // Card 345, this face's own — see the note on the web face.
  const [launchOpen, setLaunchOpen] = useState(false);
  const attached = state === "attached" && sessionId !== null;
  return (
    <section className="browser-segment" aria-label={t(lang, "browser.title")}>
      <header className="browser-bar">
        <span className="browser-dot" data-attached={state === "attached"} aria-hidden="true" />
        {attached ? (
          <>
            <NavControls
              sessionId={sessionId}
              url={url}
              draft={draft}
              canGoBack={props.canGoBack}
              canGoForward={props.canGoForward}
              send={props.send}
              onDraft={props.onDraft}
            />
            <button
              type="button"
              className="view-nav"
              aria-label={t(lang, "browser.view.screenshot")}
              disabled={url === null}
              onClick={props.onShot}
            >
              ⤓
            </button>
          </>
        ) : (
          <span className="browser-address" title={url ?? undefined}>
            {url ?? t(lang, "browser.noPage")}
          </span>
        )}
        <LaunchMenu
          launch={launch}
          playing={playing}
          onPlay={props.onPlay}
          open={launchOpen}
          onOpenChange={setLaunchOpen}
          // `sessionId` is nullable on this face — a pane with no session has
          // no list to ask for, and asking with an empty id would be a frame the
          // server has to refuse.
          onRefresh={() => {
            if (sessionId !== null) props.send(launchListFrame(sessionId));
          }}
        />
      </header>
      <div className="browser-hole" ref={props.holeRef}>
        {state !== "attached" && (
          <div className="browser-empty">
            <h2>{t(lang, "browser.title")}</h2>
            <p>{t(lang, panelNoteKey(state))}</p>
            {state === "no-shell" && <p className="browser-empty-hint">{t(lang, "browser.noShellHint")}</p>}
          </div>
        )}
        {attached && floored && (
          // The pane is hidden on purpose: this hole is under the shell's
          // MIN_PANE floor, and a posted rectangle would be refused and
          // replaced with a fallback the frame is not. Saying so beats an
          // empty rectangle that reads as a bug.
          <p className="browser-floor-note">{t(lang, "browser.floorNote")}</p>
        )}
        {attached && !floored && url === null && (
          // No page open, so the pane is hidden and this hole is really
          // visible: the start page stands where the emptiness stood.
          <StartPage launch={launch} playing={playing} onPlay={props.onPlay} />
        )}
      </div>
      {notice !== null && (
        <p className="view-notice" role="alert">
          {notice}
        </p>
      )}
      {/* What the fence promises, where the OPERATOR can read it. A review on
          2026-08-13 found the settings text promising a fence that a redirect
          walked around; the hole is closed, and what is still outside anybody's
          reach is said here rather than only in a source comment. */}
      <p className="browser-fence">{t(lang, "browser.fenceNote")}</p>
    </section>
  );
}
