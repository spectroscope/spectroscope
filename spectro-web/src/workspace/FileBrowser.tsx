// Card 525: the file browser the Files panel and the playbook pane share.
// Tree is the Files panel's own row list, lifted out of WorkspaceTab.tsx with
// its markup unchanged; the Files panel keeps its own open state and its own
// container. FileBrowser wraps the same rows for the playbook pane: it keeps
// which folders are open (the top ones start open), and the arrow keys, Home
// and End move over the visible files as in the Spectrolyzr tree
// (playbook/spectrolyzr/FileTree.tsx) and open the file they reach, unless
// openOnMove says no: such a file is only selected, and Enter on the box opens
// it. Enter on a row button is that row's own press. Keys pressed on a row move
// the focus to the row they reach.

import { useState, type KeyboardEvent } from "react";
import { formatBytes } from "./preview";

export interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  children: FileNode[];
}

/** Tree indentation: base padding plus a step per depth level. */
const INDENT_BASE_PX = 8;
const INDENT_STEP_PX = 14;

/**
 * The rows of a file tree.
 *
 * @param props.items true when the rows sit in a box with role tree: each row
 *   then carries role treeitem, its level, and expanded or selected. The Files
 *   panel leaves it out and keeps its markup.
 */
export function Tree({
  nodes,
  depth,
  open,
  onToggle,
  selected,
  onSelect,
  items = false,
}: {
  nodes: FileNode[];
  depth: number;
  open: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (node: FileNode) => void;
  items?: boolean;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path} role={items ? "none" : undefined}>
          <button
            type="button"
            className={`ws-row${selected === node.path ? " ws-row--active" : ""}`}
            style={{ paddingLeft: `${INDENT_BASE_PX + depth * INDENT_STEP_PX}px` }}
            title={node.path}
            role={items ? "treeitem" : undefined}
            aria-level={items ? depth + 1 : undefined}
            aria-expanded={items && node.dir ? open.has(node.path) : undefined}
            aria-selected={items && !node.dir ? selected === node.path : undefined}
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
              items={items}
            />
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The files a reader sees, top to bottom: a file inside a shut folder is not
 * among them.
 *
 * @param nodes the nodes the tree draws
 * @param open  the paths of the open folders
 */
export function visibleFiles(nodes: FileNode[], open: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (list: FileNode[]): void => {
    for (const node of list) {
      if (!node.dir) out.push(node.path);
      else if (open.has(node.path)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The file a key moves the selection to: ArrowDown and ArrowUp step and stop
 * at the ends, Home and End jump to them. Any other key keeps the selection.
 *
 * @param files    the visible files in order
 * @param selected the selected path, or null
 * @param key      the key pressed
 */
export function moveAmong(files: string[], selected: string | null, key: string): string | null {
  if (files.length === 0) return selected;
  const at = selected === null ? -1 : files.indexOf(selected);
  switch (key) {
    case "ArrowDown":
      return at < 0 ? files[0] : files[Math.min(at + 1, files.length - 1)];
    case "ArrowUp":
      return at < 0 ? files[0] : files[Math.max(at - 1, 0)];
    case "Home":
      return files[0];
    case "End":
      return files[files.length - 1];
    default:
      return selected;
  }
}

const MOVES = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);
const OPEN_KEY = "Enter";

function find(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.dir) {
      const hit = find(node.children, path);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * The rows of Tree in a box of their own, with open folders and the keyboard.
 *
 * @param props.nodes    the nodes to draw; the folders among them start open
 * @param props.selected the path of the file shown on the right, or null
 * @param props.onSelect   called with the file pressed, reached by a key, or under the cursor on Enter on the box
 * @param props.openOnMove whether a file the keys reach is handed to onSelect; when not, the keys
 *   only select it and Enter or a press opens it. All files open on a move when left out.
 * @param props.label      the accessible name of the tree
 */
export function FileBrowser({
  nodes,
  selected,
  onSelect,
  openOnMove = () => true,
  label,
}: {
  nodes: FileNode[];
  selected: string | null;
  onSelect: (node: FileNode) => void;
  openOnMove?: (node: FileNode) => boolean;
  label: string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(nodes.filter((n) => n.dir).map((n) => n.path)),
  );
  // A file the keys selected without opening it; null when the selection is the open file.
  const [cursor, setCursor] = useState<string | null>(null);
  // A new open file (another file opened, or the open one closed) drops the cursor.
  const [cursorOver, setCursorOver] = useState<string | null>(selected);
  if (cursorOver !== selected) {
    setCursorOver(selected);
    setCursor(null);
  }
  const parked = cursorOver === selected ? cursor : null;
  const shown = parked ?? selected;

  const pick = (node: FileNode): void => {
    setCursor(null);
    onSelect(node);
  };

  const toggle = (path: string): void => {
    setCursor(null);
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === OPEN_KEY) {
      if (e.target !== e.currentTarget || parked === null) return;
      e.preventDefault();
      const node = find(nodes, parked);
      if (node !== null) pick(node);
      return;
    }
    if (!MOVES.has(e.key)) return;
    e.preventDefault();
    const next = moveAmong(visibleFiles(nodes, open), shown, e.key);
    if (next === null || next === shown) return;
    const node = find(nodes, next);
    if (node === null) return;
    if (next === selected) setCursor(null);
    else if (openOnMove(node)) pick(node);
    else setCursor(next);
    // Keep the row the keys moved to in sight once React has drawn it, and focused when the keys came from a row.
    const box = e.currentTarget;
    const fromRow = e.target !== box;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        const row = box.querySelector<HTMLElement>(".ws-row--active");
        row?.scrollIntoView({ block: "nearest" });
        if (fromRow) row?.focus();
      });
    }
  };

  return (
    <div className="pbb-tree" role="tree" tabIndex={0} aria-label={label} onKeyDown={onKeyDown}>
      <Tree nodes={nodes} depth={0} open={open} onToggle={toggle} selected={shown} onSelect={pick} items />
    </div>
  );
}
