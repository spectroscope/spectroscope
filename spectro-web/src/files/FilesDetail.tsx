// Card 604: the detail of the files tab. What one call did to its files: when
// it ran, which agent and tool, a way into the trace and, for a script, a way
// to open it; then one block per touch with its source and its text. Edits are
// drawn as a diff, written and appended text as added lines. A shell call shows
// its command and output first.

import type { JSX } from "react";
import { describeTool } from "../components/toolViews";
import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { shortenPath } from "../lab/fileTree";
import { shownPath, sourceTags } from "./FilesExplorer";
import type { FileCall, FileLedger, FileRow, FileTouch } from "./fold";
import type { DiffStyle, FilesSelection } from "./FilesView";

export interface FilesDetailProps {
  lang: Lang;
  events: readonly RunEvent[];
  ledger: FileLedger;
  rows: readonly FileRow[];
  selection: FilesSelection;
  diffStyle: DiffStyle;
  onSelect: (selection: FilesSelection) => void;
  onFocusEvent: (agentId: string, event: RunEvent) => void;
  onOpenPath: ((path: string) => void) | null;
}

export function FilesDetail(props: FilesDetailProps): JSX.Element {
  const { lang, ledger, selection } = props;
  const at = selection.call === null ? -1 : ledger.calls.findIndex((c) => c.callIndex === selection.call);
  if (at < 0) {
    return (
      <div className="files-panel files-detail">
        <div className="files-panel__head">{t(lang, "filesTab.detail.title")}</div>
        <p className="files-placeholder">{t(lang, "filesTab.detail.pick")}</p>
      </div>
    );
  }
  const call = ledger.calls[at];
  return (
    <div className="files-panel files-detail">
      <div className="files-panel__head">
        {t(lang, call.shell ? "filesTab.detail.shellTitle" : "filesTab.detail.title")}
      </div>
      {head(props, call, at)}
      {stepper(props, call)}
      {call.shell && <pre className="files-cmd">{commandText(props.events, call)}</pre>}
      {notes(props, call)}
      {call.touches.map((touch, i) => touchBlock(props, call, touch, i))}
    </div>
  );
}

/** Seconds from the start of the run, or the call's number when the recording has no clock. */
function when(lang: Lang, call: FileCall, at: number): string {
  if (call.t === null) return t(lang, "filesTab.callNumber", { n: at + 1 });
  const s = call.t.toLocaleString(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return t(lang, "filesTab.seconds", { s });
}

function head(props: FilesDetailProps, call: FileCall, at: number): JSX.Element {
  const { lang, onOpenPath, ledger } = props;
  const script = call.script;
  return (
    <div className="files-detail__head">
      <span className="files-detail__when">
        {when(lang, call, at)} · <span className="files-mono">{call.agentId}</span> ·{" "}
        <span className="files-mono">{call.tool}</span>
      </span>
      <span className="files-detail__links">
        {script !== null && (
          <button
            type="button"
            className="files-link"
            data-action="open-script"
            title={script}
            disabled={onOpenPath === null}
            onClick={() => onOpenPath?.(script)}
          >
            {t(lang, "filesTab.detail.openScript", { script: shortenPath(script, ledger.workspace) })}
          </button>
        )}
        <button
          type="button"
          className="files-link"
          data-action="open-in-trace"
          onClick={() => props.onFocusEvent(call.agentId, props.events[call.callIndex])}
        >
          {t(lang, "filesTab.detail.openInTrace")}
        </button>
      </span>
    </div>
  );
}

/** "previous change" and "next change" over the changes of the selected file. */
function stepper(props: FilesDetailProps, call: FileCall): JSX.Element | null {
  const { lang, selection } = props;
  const row = selection.path === null ? undefined : props.rows.find((r) => r.path === selection.path);
  if (row === undefined) return null;
  const changes: number[] = [];
  for (const touch of row.touches) {
    if (touch.kind !== "read" && !changes.includes(touch.callIndex)) changes.push(touch.callIndex);
  }
  const pos = changes.indexOf(call.callIndex);
  if (pos < 0) return null;
  const go = (to: number) => () => props.onSelect({ call: changes[to], path: row.path });
  return (
    <div className="files-detail__tools">
      <span className="files-stepper">
        <button type="button" data-action="previous-change" disabled={pos === 0} onClick={go(pos - 1)}>
          {t(lang, "filesTab.detail.prevChange")}
        </button>
        <span>
          {t(lang, "filesTab.detail.changeOf", {
            k: pos + 1,
            n: changes.length,
            path: shownPath(
              row.label,
              row.touches.some((touch) => touch.folder),
            ),
          })}
        </span>
        <button
          type="button"
          data-action="next-change"
          disabled={pos === changes.length - 1}
          onClick={go(pos + 1)}
        >
          {t(lang, "filesTab.detail.nextChange")}
        </button>
      </span>
    </div>
  );
}

/** The command as the call wrote it, line breaks kept, and its output below it. */
function commandText(events: readonly RunEvent[], call: FileCall): string {
  const e = events[call.callIndex];
  const view = e?.type === "tool_call" ? describeTool(e.name, e.input, undefined, false) : null;
  const command = view?.kind === "command" ? view.command : call.line;
  return call.output === null || call.output === "" ? `$ ${command}` : `$ ${command}\n\n${call.output}`;
}

function notes(props: FilesDetailProps, call: FileCall): JSX.Element[] {
  const { lang, onOpenPath, ledger } = props;
  const keys: [string, Record<string, string>?][] = [];
  if (call.status === "failed") keys.push(["filesTab.detail.failed"]);
  else if (call.status === "pending") keys.push(["filesTab.detail.pending"]);
  if (call.note === "no change") keys.push(["filesTab.detail.noChange"]);
  if (call.note === "no file named") keys.push(["filesTab.detail.noFileNamed"]);
  if (call.script !== null) {
    keys.push(["filesTab.detail.scriptRan", { script: shortenPath(call.script, ledger.workspace) }]);
    if (onOpenPath === null) keys.push(["filesTab.detail.noFolder"]);
  } else if (call.inline) keys.push(["filesTab.detail.inlineRan"]);
  return keys.map(([key, vars]) => (
    <p key={key} className="files-note">
      {t(lang, key, vars)}
    </p>
  ));
}

function touchBlock(props: FilesDetailProps, call: FileCall, touch: FileTouch, i: number): JSX.Element {
  const { lang, ledger } = props;
  const diff = diffOf(touch);
  const added = diff?.rows.filter((r) => r.sign === "+").length ?? 0;
  const removed = diff?.rows.filter((r) => r.sign === "-").length ?? 0;
  return (
    <div key={i} className="files-touch">
      <div className="files-detail__tools">
        {sourceTags(lang, touch.sources)}
        <span className="files-mono">
          {shownPath(shortenPath(touch.path, ledger.workspace), touch.folder)}
        </span>
        <span>{t(lang, `filesTab.kind.${touch.kind}`)}</span>
        {diff !== null && (
          <span className="files-mono">
            <span className="files-plus">+{added}</span>
            {removed > 0 && <span className="files-minus"> -{removed}</span>}
          </span>
        )}
        <span className="files-reason">{touch.reason}</span>
      </div>
      {diff !== null && (
        <div className="files-diff">
          <div className="files-diff__cap">{t(lang, captionKey(touch))}</div>
          {diff.pairs.map((rows, k) =>
            props.diffStyle === "split"
              ? splitTable(rows, `${call.callIndex}-${i}-${k}`)
              : unifiedTable(rows, k),
          )}
        </div>
      )}
    </div>
  );
}

function captionKey(touch: FileTouch): string {
  if (touch.replaced !== undefined)
    return touch.sources.includes("recorded") ? "filesTab.diff.replaced" : "filesTab.diff.substitution";
  if (touch.appended !== undefined) return "filesTab.diff.appended";
  return touch.kind === "overwrite" ? "filesTab.diff.overwritten" : "filesTab.diff.content";
}

// The diff.

interface DiffRow {
  sign: " " | "+" | "-";
  text: string;
}

/** The rows of a touch's text: one list per replaced pair, or one list of added lines. */
function diffOf(touch: FileTouch): { pairs: DiffRow[][]; rows: DiffRow[] } | null {
  let pairs: DiffRow[][];
  if (touch.replaced !== undefined && touch.replaced.length > 0)
    pairs = touch.replaced.map((pair) => lineDiff(linesOf(pair.old), linesOf(pair.new)));
  else if (touch.content !== undefined) pairs = [linesOf(touch.content).map(plus)];
  else if (touch.appended !== undefined) pairs = [linesOf(touch.appended).map(plus)];
  else return null;
  return { pairs, rows: pairs.flat() };
}

const plus = (text: string): DiffRow => ({ sign: "+", text });

/** A text's lines; a closing line break opens no empty last line. */
function linesOf(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\r?\n$/, "").split(/\r?\n/);
}

/** Above this many cells the table of the longest common run costs too much; the pair shows as removed and added. */
const LCS_CELLS = 250_000;

/** A line diff over the longest common run of lines. */
function lineDiff(a: readonly string[], b: readonly string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_CELLS) return [...a.map((text): DiffRow => ({ sign: "-", text })), ...b.map(plus)];
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ sign: " ", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) out.push({ sign: "-", text: a[i++] });
    else out.push(plus(b[j++]));
  }
  while (i < n) out.push({ sign: "-", text: a[i++] });
  while (j < m) out.push(plus(b[j++]));
  return out;
}

const ROW_CLASS = { " ": undefined, "+": "files-diff__add", "-": "files-diff__del" } as const;

function unifiedTable(rows: readonly DiffRow[], k: number): JSX.Element {
  return (
    <table key={k} className="files-diff__table">
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={ROW_CLASS[row.sign]}>
            <td className="files-diff__sign">{row.sign === " " ? "" : row.sign}</td>
            <td className="files-diff__text">{row.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Before | after: unchanged lines on both sides, each run of changes paired line by line. */
function splitTable(rows: readonly DiffRow[], key: string): JSX.Element {
  const lines: JSX.Element[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].sign === " ") {
      lines.push(
        <tr key={i}>
          <td className="files-diff__text">{rows[i].text}</td>
          <td className="files-diff__gap" />
          <td className="files-diff__text">{rows[i].text}</td>
        </tr>,
      );
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    const from = i;
    while (i < rows.length && rows[i].sign !== " ") (rows[i].sign === "-" ? dels : adds).push(rows[i++].text);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      lines.push(
        <tr key={`${from}-${k}`}>
          <td
            className={
              k < dels.length
                ? "files-diff__text files-diff__text--del"
                : "files-diff__text files-diff__text--none"
            }
          >
            {dels[k] ?? ""}
          </td>
          <td className="files-diff__gap" />
          <td
            className={
              k < adds.length
                ? "files-diff__text files-diff__text--add"
                : "files-diff__text files-diff__text--none"
            }
          >
            {adds[k] ?? ""}
          </td>
        </tr>,
      );
    }
  }
  return (
    <table key={key} className="files-diff__table files-diff__table--split">
      <tbody>{lines}</tbody>
    </table>
  );
}
