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
import { fileUrl, formatBytes, previewKind } from "./preview";
import { WS_SPLIT_KEY, clampSplitPct, readStoredSplit } from "./wsSplit";
import type { WorkspaceInfo } from "../state/reducer";

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

function Preview({ path, sessionId }: { path: string; sessionId?: string }) {
  const lang = useLang();
  const kind = previewKind(path);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<number | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (kind !== "text" && kind !== "markdown") return;
    let alive = true;
    fetch(fileUrl(path, sessionId))
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
  }, [path, kind, sessionId]);

  if (kind === "html") {
    // The iframe sandbox plus the server's CSP sandbox header: scripts may
    // run, but in an opaque origin — no cookies, no /api, no parent access.
    return (
      <iframe className="ws-frame" sandbox="allow-scripts" src={fileUrl(path, sessionId)} title={path} />
    );
  }
  if (kind === "image") {
    return (
      <div className="ws-image">
        <img src={fileUrl(path, sessionId)} alt={path} />
      </div>
    );
  }
  if (error !== null) {
    return (
      <p className="ws-note">
        {error === 415
          ? t(lang, "ws.binary")
          : error === 413
            ? t(lang, "ws.tooBig")
            : t(lang, "ws.loadError")}
      </p>
    );
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

export function WorkspaceTab({
  workspace,
  onPickFolder,
  canPickFolder,
  refreshSignal,
}: {
  workspace: WorkspaceInfo | null;
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
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

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
  const applySplitFromClientY = (clientY: number): void => {
    const tree = treeRef.current;
    const cont = containerRef.current;
    if (tree === null || cont === null) return;
    const top = tree.getBoundingClientRect().top;
    const height = cont.getBoundingClientRect().bottom - top;
    if (height <= 0) return;
    setSplit(clampSplitPct(((clientY - top) / height) * 100));
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

  const sessionId = workspace?.sessionId;
  // Auto-refresh dedupe (card 89): identical payloads never re-render the
  // tree — the 5 s safety poll must not make the panel flicker.
  const lastJson = useRef("");
  const load = useCallback((): void => {
    fetch(sessionId === undefined ? "/api/files" : `/api/files?session=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res) => {
        setFailed(false);
        const next = JSON.stringify(res);
        if (next !== lastJson.current) {
          lastJson.current = next;
          setTree(res as FilesResponse);
        }
      })
      .catch(() => setFailed(true));
  }, [sessionId]);

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

  if (failed) return <p className="ctx-empty">{t(lang, "ws.unreachable")}</p>;
  if (tree === null) return <p className="ctx-empty">{t(lang, "ws.loading")}</p>;

  return (
    <div className="ws" ref={containerRef}>
      <div className="ws-head">
        <span className="ws-root mono" title={workspace !== null ? workspace.path : t(lang, "ws.rootTitle")}>
          {tree.root}/
        </span>
        {workspace !== null && (
          <span className="ws-session-note" title={workspace.path}>
            {workspace.configured ? t(lang, "ws.pinned") : t(lang, "ws.perSession")}
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
            onSelect={(node) => setSelected(node.path)}
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
        {selected === null ? (
          <p className="ws-note">{t(lang, "ws.hint")}</p>
        ) : (
          <>
            <div className="ws-preview-head">
              <span className="ws-preview-path mono" title={selected}>
                {selected}
              </span>
            </div>
            <Preview path={selected} sessionId={sessionId} />
          </>
        )}
      </div>
    </div>
  );
}
