// Phase 5: the workspace tab in the right panel — a read-only, sandboxed view
// of the agent's working directory. Tree on top (GET /api/files), preview
// below (GET /api/file): HTML renders in a CSP-sandboxed iframe (its scripts
// run in an opaque origin and can never reach the spectroscope UI), markdown through
// the shared Markdown component, images inline, everything else as text.

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Markdown } from "../components/Markdown";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { hlLangForPath, tokenize } from "./highlight";
import { fileUrl, formatBytes, previewKind, previewNoteKey } from "./preview";
import {
  closeAllFiles,
  closeFile,
  emptyFileTabs,
  fileTabLabel,
  openFile,
  selectFile,
  setFileView,
  sourceOffered,
  type FileTabsState,
} from "./fileTabs";
import { SourceView } from "./SourceView";
import { WS_SPLIT_KEY, clampSplitPct, readStoredSplit, splitPctFromPointer } from "./wsSplit";
import type { WorkspaceInfo } from "../state/reducer";
import { listableBeforeTheFirstRun, paneState, recordedWorkspace } from "./paneState";
import type { FetchOutcome } from "./paneState";

interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  children: FileNode[];
}

interface FilesResponse {
  root: string;
  truncated: boolean;
  entries: FileNode[];
}

/** Tree indentation: base padding plus a step per depth level. */
const INDENT_BASE_PX = 8;
const INDENT_STEP_PX = 14;

function Tree({
  nodes,
  depth,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  nodes: FileNode[];
  depth: number;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (node: FileNode) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            type="button"
            className={`ws-row${selected === node.path ? " ws-row--active" : ""}`}
            style={{ paddingLeft: `${INDENT_BASE_PX + depth * INDENT_STEP_PX}px` }}
            title={node.path}
            onClick={() => (node.dir ? onToggle(node.path) : onSelect(node))}
          >
            <span className="ws-row-glyph" aria-hidden="true">
              {node.dir ? (open.has(node.path) ? "▾" : "▸") : "·"}
            </span>
            <span className="ws-row-name">{node.name}</span>
            {!node.dir && <span className="ws-row-size tabular">{formatBytes(node.size)}</span>}
          </button>
          {node.dir && open.has(node.path) && (
            <Tree
              nodes={node.children}
              depth={depth + 1}
              open={open}
              onToggle={onToggle}
              selected={selected}
              onSelect={onSelect}
            />
          )}
        </div>
      ))}
    </>
  );
}

/** Read-only syntax highlighting for recognised languages; plain text otherwise. */
function HighlightedText({ path, text }: { path: string; text: string }) {
  const lang = hlLangForPath(path);
  if (lang === null) return <pre className="ws-text">{text}</pre>;
  const tokens = tokenize(text, lang);
  return (
    <pre className="ws-text ws-code">
      {tokens.map((tok, idx) =>
        tok.cls === "plain" ? (
          tok.text
        ) : (
          <span key={idx} className={`hl hl-${tok.cls}`}>
            {tok.text}
          </span>
        ),
      )}
    </pre>
  );
}

function Preview({
  path,
  sessionId,
  prospective,
}: {
  path: string;
  sessionId?: string;
  prospective: boolean;
}) {
  const lang = useLang();
  const kind = previewKind(path);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<number | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (kind !== "text" && kind !== "markdown") return;
    let alive = true;
    fetch(fileUrl(path, sessionId, prospective))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (alive) setText(body);
      })
      .catch((e) => {
        if (alive) setError(Number((e as Error).message) || 0);
      });
    return () => {
      alive = false;
    };
  }, [path, kind, sessionId, prospective]);

  if (kind === "html") {
    // The iframe sandbox plus the server's CSP sandbox header: scripts may
    // run, but in an opaque origin — no cookies, no /api, no parent access.
    return (
      <iframe
        className="ws-frame"
        sandbox="allow-scripts"
        src={fileUrl(path, sessionId, prospective)}
        title={path}
      />
    );
  }
  if (kind === "image") {
    return (
      <div className="ws-image">
        <img src={fileUrl(path, sessionId, prospective)} alt={path} />
      </div>
    );
  }
  if (error !== null) {
    return <p className="ws-note">{t(lang, previewNoteKey(error, path))}</p>;
  }
  if (text === null) {
    return <p className="ws-note">{t(lang, "ws.loading")}</p>;
  }
  if (kind === "markdown") {
    return (
      <div className="ws-md">
        <Markdown text={text} />
      </div>
    );
  }
  return <HighlightedText path={path} text={text} />;
}

/** Card 249: the source reading needs the bytes whatever the kind — html and
 *  svg render via src elsewhere, but their SOURCE is fetched like text. */
function SourcePane({
  path,
  sessionId,
  prospective,
}: {
  path: string;
  sessionId?: string;
  prospective: boolean;
}) {
  const lang = useLang();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<number | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    let alive = true;
    fetch(fileUrl(path, sessionId, prospective))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (alive) setText(body);
      })
      .catch((e) => {
        if (alive) setError(Number((e as Error).message) || 0);
      });
    return () => {
      alive = false;
    };
  }, [path, sessionId, prospective]);

  if (error !== null) {
    return <p className="ws-note">{t(lang, previewNoteKey(error, path))}</p>;
  }
  if (text === null) return <p className="ws-note">{t(lang, "ws.loading")}</p>;
  return <SourceView path={path} text={text} />;
}

export function WorkspaceTab({
  workspace,
  recordedCwd = null,
  onPickFolder,
  canPickFolder,
  refreshSignal,
}: {
  workspace: WorkspaceInfo | null;
  /** The cwd an imported run recorded (card 291): shown, labelled as
   *  recorded, where the pane would otherwise promise a first run. Display
   *  only — nothing on this machine is read or created from it. */
  recordedCwd?: string | null;
  /** Opens the native folder picker on the spectroscope machine (macOS dialog). */
  onPickFolder?: () => void;
  /** Bumped by App when the live run touched the disk (tool_result/run_end) —
   *  the tree refetches, throttled, so it never feels stale (card 89). */
  refreshSignal?: number;
  /** False once the agent ran — then the workspace is baked in. */
  canPickFolder?: boolean;
}) {
  const lang = useLang();
  const [tree, setTree] = useState<FilesResponse | null>(null);
  const [outcome, setOutcome] = useState<FetchOutcome | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Card 249: several files stay open as tabs; the active path doubles as the
  // tree's highlight. The fold lives in workspace/fileTabs.ts.
  const [files, setFiles] = useState<FileTabsState>(emptyFileTabs);
  const selected = files.active;

  // Resizable tree/preview divider: `split` is the tree's % of the vertical space.
  const containerRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [split, setSplit] = useState<number>(() => {
    try {
      return readStoredSplit(localStorage.getItem(WS_SPLIT_KEY));
    } catch {
      return readStoredSplit(null);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WS_SPLIT_KEY, String(Math.round(split)));
    } catch {
      /* storage blocked — the split just resets on the next load */
    }
  }, [split]);
  // Card 362: the divisor is the CONTAINER's inner height, which is what a
  // percentage flex-basis resolves against — head and gaps included. It used to
  // be the distance from the tree's top to the container's bottom, a smaller
  // number, so the tree grew by more than the pointer had moved and the divider
  // ran ahead of the cursor. clientHeight and not a rect: the rect is the
  // border box, and the basis resolves against the content box.
  const applySplitFromClientY = (clientY: number): void => {
    const tree = treeRef.current;
    const cont = containerRef.current;
    if (tree === null || cont === null) return;
    const next = splitPctFromPointer(clientY, tree.getBoundingClientRect().top, cont.clientHeight);
    if (next !== null) setSplit(next);
  };
  const onDividerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onDividerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragging.current) applySplitFromClientY(e.clientY);
  };
  const onDividerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onDividerKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    setSplit((s) => clampSplitPct(s + (e.key === "ArrowUp" ? -4 : 4)));
  };

  // The terminal left this surface with card 219: it is a dock panel of its
  // own (panels/TerminalPanel.tsx), so glancing at another panel no longer
  // kills a running shell.

  const sessionId = workspace?.sessionId;
  // Before the first run there is no session, but there may still be a folder:
  // a configured workspace the announcement named and reported as existing.
  // The server names it again from its own config — the query carries no path.
  const prospective = listableBeforeTheFirstRun(workspace);
  // Auto-refresh dedupe (card 89): identical payloads never re-render the
  // tree — the 5 s safety poll must not make the panel flicker.
  const lastJson = useRef("");
  const load = useCallback((): void => {
    // No session and no named folder, no request. The sessionless call used to
    // be answered with the server's own working directory; there is nothing to
    // ask for until one of the two exists.
    if (sessionId === undefined && !prospective) {
      setOutcome(null);
      return;
    }
    const query = sessionId !== undefined ? `session=${encodeURIComponent(sessionId)}` : "scope=prospective";
    fetch(`/api/files?${query}`)
      .then((r) => {
        if (!r.ok) {
          setOutcome({ kind: "status", status: r.status });
          return null;
        }
        return r.json();
      })
      .then((res) => {
        if (res === null) return;
        setOutcome({ kind: "ok" });
        const next = JSON.stringify(res);
        if (next !== lastJson.current) {
          lastJson.current = next;
          setTree(res as FilesResponse);
        }
      })
      // A throw is the network, not a status: a dead server and a folder that
      // does not exist yet are different things and must read differently.
      .catch(() => setOutcome({ kind: "offline" }));
  }, [sessionId, prospective]);

  useEffect(load, [load]);

  // Card 89: the tree follows the RUN — a tool wrote something (tool_result)
  // or the run ended, App bumped the signal, the tree refetches at most once
  // per second (trailing throttle, so the LAST write always lands).
  const REFRESH_THROTTLE_MS = 1000;
  const lastSignalFetch = useRef(0);
  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === 0) return;
    const since = Date.now() - lastSignalFetch.current;
    const wait = since >= REFRESH_THROTTLE_MS ? 0 : REFRESH_THROTTLE_MS - since;
    const timer = window.setTimeout(() => {
      lastSignalFetch.current = Date.now();
      load();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [refreshSignal, load]);

  // The safety net for writers OUTSIDE the run (the operator's editor): a slow
  // poll while the tab is actually visible; the dedupe above keeps it calm.
  const SAFETY_POLL_MS = 5000;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, SAFETY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggle = (path: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // The recorded folder of an imported run wins over the pending wording, and
  // nothing else: any live announcement makes recordedWorkspace defer.
  const pane = recordedWorkspace(recordedCwd, workspace, lang) ?? paneState(workspace, outcome, lang);
  const beforeTheRun = pane.kind === "tree" && pane.scope === "prospective";
  if (pane.kind === "unreachable") return <p className="ctx-empty">{t(lang, "ws.unreachable")}</p>;
  if (pane.kind === "loading") return <p className="ctx-empty">{pane.message}</p>;
  if (pane.kind === "pending") {
    // Before the first run there is no folder and no session. Saying what will
    // happen beats both a tree of somebody else's directory and a bare
    // "unreachable" that blames the server for a decision nobody made yet.
    return (
      <div className="ctx-empty ws-pending">
        <p>{pane.message}</p>
        {pane.path !== null && (
          <p className="ws-pending-path mono" title={pane.path}>
            {pane.path}
          </p>
        )}
      </div>
    );
  }
  if (tree === null) return <p className="ctx-empty">{t(lang, "ws.loading")}</p>;

  return (
    <div className="ws" ref={containerRef}>
      <div className="ws-head">
        <span className="ws-root mono" title={workspace !== null ? workspace.path : t(lang, "ws.rootTitle")}>
          {tree.root}/
        </span>
        {workspace !== null && (
          // Which folder this is, said out loud. A tree drawn before any run is
          // the folder the first run WILL use, and calling it a session
          // workspace would claim a session that has not started.
          <span className="ws-session-note" title={workspace.path}>
            {beforeTheRun
              ? t(lang, "ws.firstRunFolder")
              : workspace.configured
                ? t(lang, "ws.pinned")
                : t(lang, "ws.perSession")}
          </span>
        )}
        {onPickFolder !== undefined && (
          <button
            type="button"
            className="ws-pick"
            disabled={canPickFolder === false}
            onClick={onPickFolder}
            title={canPickFolder === false ? t(lang, "ws.pickLocked") : t(lang, "ws.pickTitle")}
          >
            {t(lang, "ws.pick")}
          </button>
        )}
        <button type="button" className="ws-refresh" onClick={load} title={t(lang, "ws.refresh")}>
          ⟳
        </button>
      </div>
      <div
        className="ws-tree"
        role="tree"
        aria-label="Workspace"
        ref={treeRef}
        style={{ flex: `0 0 ${split}%` }}
      >
        {tree.entries.length === 0 ? (
          <p className="ws-note">{t(lang, "ws.empty")}</p>
        ) : (
          <Tree
            nodes={tree.entries}
            depth={0}
            open={open}
            onToggle={toggle}
            selected={selected}
            onSelect={(node) => setFiles((s) => openFile(s, node.path))}
          />
        )}
        {tree.truncated && <p className="ws-note">{t(lang, "ws.truncated")}</p>}
      </div>
      <div
        className="ws-divider"
        role="separator"
        aria-orientation="horizontal"
        aria-label={lang === "de" ? "trenner ziehen, um die höhe zu ändern" : "drag to resize"}
        tabIndex={0}
        onPointerDown={onDividerDown}
        onPointerMove={onDividerMove}
        onPointerUp={onDividerUp}
        onKeyDown={onDividerKey}
      />
      <div className="ws-preview">
        {files.tabs.length === 0 ? (
          <p className="ws-note">{t(lang, "ws.hint")}</p>
        ) : (
          <>
            {/* Card 249: the open files as a closable tab row — the terminal
                strip's idiom, keyed by path. */}
            <div className="ws-tabs" role="tablist">
              {files.tabs.map((tab) => (
                <span
                  key={tab.path}
                  className={`ws-tab${files.active === tab.path ? " ws-tab--active" : ""}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={files.active === tab.path}
                    className="ws-tab-pick"
                    title={tab.path}
                    onClick={() => setFiles((s) => selectFile(s, tab.path))}
                  >
                    {fileTabLabel(tab)}
                  </button>
                  <button
                    type="button"
                    className="ws-tab-close"
                    aria-label={t(lang, "ws.closeFile")}
                    title={t(lang, "ws.closeFile")}
                    onClick={() => setFiles((s) => closeFile(s, tab.path))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {files.tabs.length > 1 && (
                <button type="button" className="ws-close-all" onClick={() => setFiles(closeAllFiles)}>
                  {t(lang, "ws.closeAll")}
                </button>
              )}
            </div>
            {/* Every open tab stays mounted, hidden behind the active one, so
                a scrolled iframe or a folded region survives the switch; a
                CLOSED tab unmounts and releases its content. */}
            {files.tabs.map((tab) => (
              <div
                key={tab.path}
                className="ws-tab-body"
                style={files.active === tab.path ? undefined : { display: "none" }}
              >
                <div className="ws-preview-head">
                  <span className="ws-preview-path mono" title={tab.path}>
                    {tab.path}
                  </span>
                  {sourceOffered(tab.path) && (
                    <span className="ws-view-toggle" role="group">
                      <button
                        type="button"
                        className={`ws-view-chip${tab.view === "rendered" ? " ws-view-chip--on" : ""}`}
                        aria-pressed={tab.view === "rendered"}
                        onClick={() => setFiles((s) => setFileView(s, tab.path, "rendered"))}
                      >
                        {t(lang, "ws.rendered")}
                      </button>
                      <button
                        type="button"
                        className={`ws-view-chip${tab.view === "source" ? " ws-view-chip--on" : ""}`}
                        aria-pressed={tab.view === "source"}
                        onClick={() => setFiles((s) => setFileView(s, tab.path, "source"))}
                      >
                        {t(lang, "ws.source")}
                      </button>
                    </span>
                  )}
                </div>
                {tab.view === "source" && sourceOffered(tab.path) ? (
                  <SourcePane path={tab.path} sessionId={sessionId} prospective={beforeTheRun} />
                ) : (
                  <Preview path={tab.path} sessionId={sessionId} prospective={beforeTheRun} />
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
