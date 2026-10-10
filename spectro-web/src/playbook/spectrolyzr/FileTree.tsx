// The file tree of the Spectrolyzr review step (card 484). The files the
// preview lists, grouped by root (the project, then the playbook) and then by
// folder, folders before files and each by name. Folders collapse; the arrow
// keys, Home and End move the selection over the files that are visible.
// treeRows and moveSelection are pure so the suite pins them without a DOM.

import { useState, type KeyboardEvent } from "react";
import { t } from "../../i18n/i18n";
import { useLang } from "../../state/lang";
import type { LyzrFile } from "../../state/spectrolyzr";

type Root = LyzrFile["root"];

const ROOTS: Root[] = ["project", "playbook"];

export type TreeRow =
  | { kind: "root"; key: string; depth: number; root: Root }
  | { kind: "folder"; key: string; depth: number; name: string; expanded: boolean }
  | { kind: "file"; key: string; depth: number; name: string; file: LyzrFile };

/** The key of a file in the tree and in the selection: its root and its path. */
export function fileKey(file: LyzrFile): string {
  return `${file.root}:${file.path}`;
}

interface Folder {
  folders: Map<string, Folder>;
  files: LyzrFile[];
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emit(
  rows: TreeRow[],
  node: Folder,
  root: Root,
  prefix: string,
  depth: number,
  collapsed: Set<string>,
) {
  for (const name of [...node.folders.keys()].sort(byName)) {
    const key = `${root}:${prefix}${name}/`;
    const expanded = !collapsed.has(key);
    rows.push({ kind: "folder", key, depth, name, expanded });
    if (expanded) emit(rows, node.folders.get(name)!, root, `${prefix}${name}/`, depth + 1, collapsed);
  }
  const files = [...node.files].sort((a, b) => byName(a.path, b.path));
  for (const file of files) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    rows.push({ kind: "file", key: fileKey(file), depth, name, file });
  }
}

/**
 * The rows the tree draws, top to bottom.
 *
 * @param files     the files of the preview
 * @param collapsed the keys of the folders that are shut
 */
export function treeRows(files: LyzrFile[], collapsed: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const root of ROOTS) {
    const mine = files.filter((f) => f.root === root);
    if (mine.length === 0) continue;
    const top: Folder = { folders: new Map(), files: [] };
    for (const file of mine) {
      const parts = file.path.split("/");
      let node = top;
      for (const part of parts.slice(0, -1)) {
        let next = node.folders.get(part);
        if (next === undefined) {
          next = { folders: new Map(), files: [] };
          node.folders.set(part, next);
        }
        node = next;
      }
      node.files.push(file);
    }
    rows.push({ kind: "root", key: `${root}:`, depth: 0, root });
    emit(rows, top, root, "", 1, collapsed);
  }
  return rows;
}

/**
 * The file a key moves the selection to: ArrowDown and ArrowUp step over the
 * visible files and stop at the ends, Home and End jump to them. Any other key
 * leaves the selection as it is.
 *
 * @param rows     the rows the tree draws
 * @param selected the key of the selected file, or null
 * @param key      the key pressed
 */
export function moveSelection(rows: TreeRow[], selected: string | null, key: string): string | null {
  const files = rows.filter((r) => r.kind === "file").map((r) => r.key);
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

/** The tree of the files a choice of archetype, language and add-ons renders. */
export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: LyzrFile[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const lang = useLang();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = treeRows(files, collapsed);

  const toggle = (key: string): void => {
    setCollapsed((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!MOVES.has(e.key)) return;
    e.preventDefault();
    const next = moveSelection(rows, selected, e.key);
    if (next === null || next === selected) return;
    onSelect(next);
    // Keep the row the keys moved to in sight once React has drawn it.
    const tree = e.currentTarget;
    requestAnimationFrame(() => tree.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" }));
  };

  const indent = (depth: number) => ({ paddingInlineStart: `${depth * 14 + 6}px` });

  return (
    <div
      className="lyzr-tree"
      role="tree"
      tabIndex={0}
      aria-label={t(lang, "lyzr.files", { n: files.length })}
      onKeyDown={onKeyDown}
    >
      {rows.map((row) =>
        row.kind === "root" ? (
          <div key={row.key} className="lyzr-root" role="treeitem" aria-level={1} aria-expanded={true}>
            {t(lang, row.root === "project" ? "lyzr.dir" : "lyzr.playbookDir")}
          </div>
        ) : row.kind === "folder" ? (
          <button
            key={row.key}
            type="button"
            className="lyzr-folder"
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.expanded}
            tabIndex={-1}
            style={indent(row.depth)}
            onClick={() => toggle(row.key)}
          >
            <span className="lyzr-caret" aria-hidden="true">
              {row.expanded ? "▾" : "▸"}
            </span>
            {row.name}/
          </button>
        ) : (
          <button
            key={row.key}
            type="button"
            aria-selected={row.key === selected}
            className={`lyzr-file${row.key === selected ? " is-selected" : ""}`}
            role="treeitem"
            aria-level={row.depth + 1}
            tabIndex={-1}
            title={row.file.path}
            style={indent(row.depth)}
            onClick={() => onSelect(row.key)}
          >
            {row.name}
          </button>
        ),
      )}
    </div>
  );
}
