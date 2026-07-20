// Phase 5: the workspace tab in the right panel — a read-only, sandboxed view
// of the agent's working directory. Tree on top (GET /api/files), preview
// below (GET /api/file): HTML renders in a CSP-sandboxed iframe (its scripts
// run in an opaque origin and can never reach the spectroscope UI), markdown through
// the shared Markdown component, images inline, everything else as text.

import { useCallback, useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { fileUrl, formatBytes, previewKind } from "./preview";
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
    return <iframe className="ws-frame" sandbox="allow-scripts" src={fileUrl(path, sessionId)} title={path} />;
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
        {error === 415 ? t(lang, "ws.binary") : error === 413 ? t(lang, "ws.tooBig") : t(lang, "ws.loadError")}
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
  return <pre className="ws-text">{text}</pre>;
}

export function WorkspaceTab({
  workspace,
  onPickFolder,
  canPickFolder,
}: {
  workspace: WorkspaceInfo | null;
  /** Opens the native folder picker on the spectroscope machine (macOS dialog). */
  onPickFolder?: () => void;
  /** False once the agent ran — then the workspace is baked in. */
  canPickFolder?: boolean;
}) {
  const lang = useLang();
  const [tree, setTree] = useState<FilesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const sessionId = workspace?.sessionId;
  const load = useCallback((): void => {
    fetch(sessionId === undefined ? "/api/files" : `/api/files?session=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res) => {
        setTree(res as FilesResponse);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [sessionId]);

  useEffect(load, [load]);

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
    <div className="ws">
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
      <div className="ws-tree" role="tree" aria-label="Workspace">
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
