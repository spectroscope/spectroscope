// Card 604: the explorer of the files tab. Two groups, the files the run
// changed or probably changed and the files it read or probably read, each
// drawn as a folder tree. A row shows a letter and the source behind that
// letter; a letter no file tool backs is drawn dashed, so a guess never looks
// recorded (P4 of the design).

import type { CSSProperties, JSX } from "react";
import { t, type Lang } from "../i18n/i18n";
import type { FileRow, Source } from "./fold";
import type { TouchKind } from "./shell";

/** The kinds that say a file's content or existence moved, as fold.ts counts them. */
export const CHANGE_KINDS: ReadonlySet<TouchKind> = new Set<TouchKind>([
  "create",
  "change",
  "overwrite",
  "write",
  "append",
  "delete",
]);

const LETTER_CLASS: Record<FileRow["letter"], string> = {
  A: "create",
  M: "change",
  D: "delete",
  R: "read",
  "?": "unknown",
};

/**
 * The sources behind a row's letter. Only the touches that set the letter
 * count: a file a tool read and a shell command probably changed is M, and
 * that M is a guess. A recorded source stands alone; otherwise the guesses
 * are listed in their order.
 */
export function letterSources(row: FileRow): Source[] {
  const changes = row.touches.filter((touch) => CHANGE_KINDS.has(touch.kind));
  const basis =
    row.letter === "A"
      ? changes.slice(0, 1)
      : row.letter === "D"
        ? changes.slice(-1)
        : row.letter === "M"
          ? changes
          : row.touches.filter((touch) => touch.kind === (row.letter === "?" ? "unknown" : "read"));
  const has = (source: Source): boolean => basis.some((touch) => touch.sources.includes(source));
  if (has("recorded")) return ["recorded"];
  return (["probable", "model"] as const).filter(has);
}

/** One tag per source, in the order given. */
export function sourceTags(lang: Lang, sources: readonly Source[]): JSX.Element[] {
  return sources.map((source) => (
    <span key={source} className={`files-src files-src--${source}`}>
      {t(lang, `filesTab.source.${source}`)}
    </span>
  ));
}

/** A path as the explorer and the detail name it: a folder ends in a slash, a pattern does not. */
export function shownPath(label: string, folder: boolean): string {
  return folder && !label.endsWith("/") && !/[*?[\]{}]/.test(label) ? `${label}/` : label;
}

export interface FilesExplorerProps {
  lang: Lang;
  rows: readonly FileRow[];
  selected: string | null;
  onSelect: (row: FileRow) => void;
}

export function FilesExplorer(props: FilesExplorerProps): JSX.Element {
  const { lang, rows } = props;
  const changed = rows.filter((row) => row.group === "changed");
  const read = rows.filter((row) => row.group === "read");
  return (
    <div className="files-panel files-explorer">
      <div className="files-panel__head">{t(lang, "filesTab.explorer.title")}</div>
      <div className="files-panel__body">
        {group(props, "changed", changed)}
        {group(props, "read", read)}
      </div>
      <p className="files-legend">{t(lang, "filesTab.explorer.legend")}</p>
    </div>
  );
}

function group(props: FilesExplorerProps, name: FileRow["group"], rows: readonly FileRow[]): JSX.Element {
  return (
    <div className="files-group" data-group={name}>
      <div className="files-group__label">{t(props.lang, `filesTab.group.${name}`, { n: rows.length })}</div>
      {lines(tree(rows), 0, "", props)}
    </div>
  );
}

/** A folder or a file of the tree; `rows` holds the rows whose label ends here. */
interface Node {
  name: string;
  rows: FileRow[];
  children: Map<string, Node>;
}

function segmentsOf(label: string): string[] {
  const parts = label.split("/").filter((part) => part !== "");
  if (parts.length === 0) return [label];
  if (label.startsWith("/")) parts[0] = `/${parts[0]}`;
  return parts;
}

function tree(rows: readonly FileRow[]): Node {
  const root: Node = { name: "", rows: [], children: new Map() };
  for (const row of rows) {
    let node = root;
    for (const part of segmentsOf(row.label)) {
      let next = node.children.get(part);
      if (next === undefined) {
        next = { name: part, rows: [], children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
    node.rows.push(row);
  }
  return root;
}

/** A folder with no row of its own and one subfolder is drawn as one line, `a/b`. */
function collapse(node: Node): Node {
  let n = node;
  while (n.rows.length === 0 && n.children.size === 1) {
    const only = [...n.children.values()][0];
    if (only.children.size === 0) break;
    n = { name: `${n.name}/${only.name}`, rows: only.rows, children: only.children };
  }
  return n;
}

function lines(node: Node, depth: number, prefix: string, props: FilesExplorerProps): JSX.Element[] {
  const out: JSX.Element[] = [];
  const kids = [...node.children.values()].map(collapse).sort((a, b) => a.name.localeCompare(b.name));
  for (const kid of kids) {
    const key = `${prefix}/${kid.name}`;
    const depthStyle = { "--files-depth": depth } as CSSProperties;
    if (kid.rows.length === 0) {
      out.push(
        <div key={key} className="files-row files-row--dir" style={depthStyle}>
          {`${kid.name}/`}
        </div>,
      );
    }
    for (const row of kid.rows) out.push(rowLine(row, kid.name, depthStyle, props));
    out.push(...lines(kid, depth + 1, key, props));
  }
  return out;
}

function rowLine(
  row: FileRow,
  name: string,
  depthStyle: CSSProperties,
  props: FilesExplorerProps,
): JSX.Element {
  const sources = letterSources(row);
  const guess = !sources.includes("recorded");
  const selected = props.selected === row.path;
  const folder = row.touches.some((touch) => touch.folder);
  return (
    <button
      key={row.path}
      type="button"
      className={selected ? "files-row files-row--sel" : "files-row"}
      data-path={row.path}
      title={row.path}
      aria-pressed={selected}
      style={depthStyle}
      onClick={() => props.onSelect(row)}
    >
      <span className="files-row__name">{shownPath(name, folder)}</span>
      <span className="files-row__right">
        {sourceTags(props.lang, sources)}
        <span
          className={`files-letter files-letter--${LETTER_CLASS[row.letter]}${guess ? " files-letter--guess" : ""}`}
        >
          {row.letter}
        </span>
      </span>
    </button>
  );
}
