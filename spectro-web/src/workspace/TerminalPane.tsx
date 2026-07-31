// The terminal pane under the file tree (card 93). One tab is one WebSocket is
// one PTY, so a tab's terminal lives exactly as long as its component: unmount
// closes the socket, and the server reaps the child. Inactive tabs stay mounted
// but hidden, because scrollback that disappears when you glance at another tab
// is not scrollback.
//
// The wire lives in shellWire.ts; the VT engine loads on demand from
// xtermLoader.ts. Nothing here parses escape sequences by hand.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { useLang } from "../state/lang";
import { loadXterm } from "./xtermLoader";
import { decodeStatus, encodeKeyBytes, encodeKeys, encodeResize, shellSocketUrl } from "./shellWire";
import { SHELL_MAX_TABS, closeTab, emptyTabs, openTab, retitleTab, selectTab, tabLabel } from "./shellTabs";
import type { ShellTabsState } from "./shellTabs";

/** Fallback window if the host has no layout yet; the server clamps anyway. */
const FALLBACK_ROWS = 24;
const FALLBACK_COLS = 80;

/** What one tab is doing, for the line under its terminal. */
type Phase =
  | { at: "starting" }
  | { at: "ready"; note: string; shell: string; cwd: string }
  | { at: "exited"; code: number }
  | { at: "refused"; reason: string };

/** Read one CSS custom property off the mounted host. */
function cssVar(host: HTMLElement, name: string, fallback: string): string {
  const value = getComputedStyle(host).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

function TerminalView({
  tabId,
  sessionId,
  active,
  onTitle,
}: {
  tabId: number;
  sessionId: string;
  active: boolean;
  onTitle: (id: number, title: string) => void;
}) {
  const lang = useLang();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const refitRef = useRef<() => void>(() => {});
  const [phase, setPhase] = useState<Phase>({ at: "starting" });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let live = true;
    let socket: WebSocket | null = null;
    let term: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    let frame = 0;

    void loadXterm().then(
      ({ Terminal: Xterm, FitAddon }) => {
        if (!live) return;
        term = new Xterm({
          // The 16 ANSI colours are deliberately xterm's own: the operator's
          // .zshrc and oh-my-zsh theme were written against a standard palette,
          // and re-tinting them here is exactly how a themed prompt gets
          // mangled. Only the empty canvas is ours, and it stays dark in both
          // designs for the same reason — that palette assumes a dark ground.
          theme: {
            background: cssVar(host, "--term-bg", "#12100e"),
            foreground: cssVar(host, "--term-fg", "#ede7dc"),
            cursor: cssVar(host, "--term-cursor", "#ce9440"),
            selectionBackground: cssVar(host, "--term-selection", "rgba(206,148,64,0.28)"),
          },
          fontFamily: cssVar(host, "--font-mono", "monospace"),
          fontSize: 12,
          lineHeight: 1.2,
          cursorBlink: true,
          // zsh's alt-word bindings are half the reason to have a real shell.
          macOptionIsMeta: true,
          scrollback: 5000,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(host);
        termRef.current = term;

        const refit = (): void => {
          if (host.clientWidth === 0 || host.clientHeight === 0) return;
          try {
            fitAddon.fit();
          } catch {
            // The host was detached mid-measure; the next observation refits.
          }
        };
        refitRef.current = refit;
        refit();

        const rows = term.rows > 0 ? term.rows : FALLBACK_ROWS;
        const cols = term.cols > 0 ? term.cols : FALLBACK_COLS;
        socket = new WebSocket(shellSocketUrl(sessionId, rows, cols, window.location));
        socket.binaryType = "arraybuffer";

        const send = (frames: Uint8Array[]): void => {
          if (socket === null || socket.readyState !== WebSocket.OPEN) return;
          // Copy out of the shared ArrayBuffer view: some engines keep the
          // reference until the frame is flushed.
          for (const one of frames) socket.send(one.slice().buffer);
        };

        term.onData((data) => send(encodeKeys(data)));
        term.onBinary((raw) => {
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
          send(encodeKeyBytes(bytes));
        });
        term.onTitleChange((title) => onTitle(tabId, title));
        // fit() resizes the terminal, which lands here — one funnel for every
        // size change, so the wire and the renderer can never disagree.
        term.onResize(({ rows: r, cols: c }) => {
          if (socket === null || socket.readyState !== WebSocket.OPEN) return;
          socket.send(encodeResize(r, c).slice().buffer);
        });

        socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
          if (typeof event.data === "string") {
            const status = decodeStatus(event.data);
            if (status === null) return;
            if (status.type === "shell_ready") {
              setPhase({ at: "ready", note: status.note, shell: status.shell, cwd: status.cwd });
            } else if (status.type === "shell_exit") {
              setPhase({ at: "exited", code: status.code });
            } else {
              setPhase({ at: "refused", reason: "" });
            }
            return;
          }
          term?.write(new Uint8Array(event.data));
        };
        socket.onclose = (event: CloseEvent) => {
          if (!live) return;
          setPhase((current) =>
            current.at === "exited" ? current : { at: "refused", reason: event.reason },
          );
        };

        observer = new ResizeObserver(() => {
          // Coalesce a drag into one fit per frame; every fit is an ioctl and a
          // SIGWINCH at the other end.
          if (frame !== 0) return;
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            refit();
          });
        });
        observer.observe(host);
      },
      () => {
        if (live) setPhase({ at: "refused", reason: "" });
      },
    );

    return () => {
      live = false;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      // Closing the socket is what reaps the PTY; do it before disposing the
      // renderer so a last burst cannot land on a dead terminal.
      socket?.close();
      termRef.current = null;
      term?.dispose();
    };
  }, [tabId, sessionId, onTitle]);

  // A hidden host measures zero, so a tab that was resized while in the
  // background has to refit and re-announce its size on the way back.
  useEffect(() => {
    if (!active) return;
    refitRef.current();
    termRef.current?.focus();
  }, [active]);

  return (
    <div
      className={`term-view${active ? "" : " term-view--hidden"}`}
      id={`term-panel-${tabId}`}
      role="tabpanel"
    >
      <div className="term-host" ref={hostRef} />
      <p className={`term-status${phase.at === "refused" ? " term-status--bad" : ""}`}>
        {phase.at === "starting" && (lang === "de" ? "shell startet …" : "starting the shell …")}
        {phase.at === "ready" && (
          <>
            <span className="term-status-path mono" title={phase.cwd}>
              {phase.shell} · {phase.cwd}
            </span>
            {/* The server's own wording, verbatim: it is the honest one, and the
                card asks for it to be unmissable. Card 64 folds the German half
                back into i18n.ts. */}
            <span className="term-status-warn">
              {lang === "de"
                ? "diese shell läuft mit deinen eigenen rechten; das permission-gate gilt nicht für das, was du hier tippst"
                : phase.note}
            </span>
          </>
        )}
        {phase.at === "exited" &&
          (lang === "de"
            ? `shell beendet (code ${phase.code}) — schließe den tab oder öffne einen neuen`
            : `shell exited (code ${phase.code}) — close the tab or open a new one`)}
        {phase.at === "refused" &&
          (phase.reason !== ""
            ? phase.reason
            : lang === "de"
              ? "kein terminal verfügbar — der server hat die verbindung abgelehnt"
              : "no terminal available — the server refused the connection")}
      </p>
    </div>
  );
}

export function TerminalPane({ sessionId }: { sessionId?: string }) {
  const lang = useLang();
  const [state, setState] = useState<ShellTabsState>(() => openTab(emptyTabs()));

  const retitle = useCallback((id: number, title: string) => {
    setState((current) => retitleTab(current, id, title));
  }, []);

  const atCap = state.tabs.length >= SHELL_MAX_TABS;

  if (sessionId === undefined) {
    return (
      <div className="term">
        <p className="term-empty">
          {lang === "de"
            ? "ein terminal braucht eine session — starte einen chat, dann teilt die shell den ordner des agenten."
            : "a terminal needs a session — start a chat and the shell shares the agent's folder."}
        </p>
      </div>
    );
  }

  return (
    <div className="term">
      <div className="term-tabs" role="tablist" aria-label="terminals">
        {state.tabs.map((tab, index) => (
          <span key={tab.id} className={`term-tab${state.active === tab.id ? " term-tab--active" : ""}`}>
            <button
              type="button"
              className="term-tab-pick"
              role="tab"
              aria-selected={state.active === tab.id}
              aria-controls={`term-panel-${tab.id}`}
              title={tab.title ?? ""}
              onClick={() => setState((current) => selectTab(current, tab.id))}
            >
              {tabLabel(tab, index)}
            </button>
            <button
              type="button"
              className="term-tab-close"
              aria-label={lang === "de" ? "terminal schließen" : "close terminal"}
              onClick={() => setState((current) => closeTab(current, tab.id))}
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          className="term-add"
          disabled={atCap}
          title={
            atCap
              ? lang === "de"
                ? `höchstens ${SHELL_MAX_TABS} terminals je session`
                : `at most ${SHELL_MAX_TABS} terminals per session`
              : lang === "de"
                ? "neues terminal"
                : "new terminal"
          }
          onClick={() => setState(openTab)}
        >
          +
        </button>
      </div>
      <div className="term-body">
        {state.tabs.length === 0 ? (
          <p className="term-empty">{lang === "de" ? "kein terminal offen." : "no terminal open."}</p>
        ) : (
          state.tabs.map((tab) => (
            <TerminalView
              key={tab.id}
              tabId={tab.id}
              sessionId={sessionId}
              active={state.active === tab.id}
              onTitle={retitle}
            />
          ))
        )}
      </div>
    </div>
  );
}
