// Card 604: the operations of the files tab. The view `operations` draws every
// call the agent chips leave on as a table row: when it ran (seconds, or its
// number when the session has no clock), the prompt it belongs to, its agent
// when there is more than one, what it did, its call line, the files it touched
// with their sources, and its tool. The view `all` draws the same rows as a
// compact list beside the detail, narrowed to the selected file. A press
// selects the call; rows after the tab's cursor are dimmed. A failed call
// names no file.

import type { CSSProperties, JSX } from "react";
import { agentAccent } from "../format";
import { t, type Lang } from "../i18n/i18n";
import { shortenPath } from "../lab/fileTree";
import { whenLabel } from "./cursor";
import { shownPath, sourceTags } from "./FilesExplorer";
import { KIND_CLASS } from "./FilesTimeline";
import type { FileCall, FileLedger, FileRow, PromptMark } from "./fold";
import type { FilesSelection } from "./FilesView";
import type { TouchKind } from "./shell";

export interface FilesOperationsProps {
  lang: Lang;
  ledger: FileLedger;
  /** The calls after the agent chips, in event order. */
  calls: readonly FileCall[];
  /** Each call's 1-based number in the ledger, by its event index. */
  ordinals: ReadonlyMap<number, number>;
  /** The cursor's last event index; a row after it is dimmed. */
  limit: number;
  selection: FilesSelection;
  /** True when more than one agent made file calls: rows then name their agent. */
  agents: boolean;
  onPick: (callIndex: number) => void;
}

/** The compact list also names the selected file, and can let it go. */
export interface FilesOpListProps extends FilesOperationsProps {
  rows: readonly FileRow[];
  /** Clears the selected file, so the list shows every call again. */
  onShowAll: () => void;
}

/**
 * The number of the prompt a call belongs to: the last prompt before the call,
 * or null for a call before any prompt.
 */
export function promptOf(prompts: readonly PromptMark[], callIndex: number): number | null {
  let lo = 0;
  let hi = prompts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prompts[mid].eventIndex < callIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : prompts[lo - 1].n;
}

export function FilesOperations(props: FilesOperationsProps): JSX.Element {
  const { lang, ledger, agents } = props;
  return (
    <div className="files-panel files-ops">
      <div className="files-panel__head">
        {t(lang, "filesTab.ops.title")}
        <span className="files-panel__meta">
          {t(lang, ledger.timed ? "filesTab.ops.seconds" : "filesTab.ops.calls")}
        </span>
      </div>
      <div className="files-ops__wrap">
        <table className="files-ops__table">
          <thead>
            <tr>
              <th>{t(lang, ledger.timed ? "filesTab.ops.col.time" : "filesTab.ops.col.number")}</th>
              <th>{t(lang, "filesTab.ops.col.prompt")}</th>
              {agents && <th>{t(lang, "filesTab.ops.col.agent")}</th>}
              <th>{t(lang, "filesTab.ops.col.operation")}</th>
              <th>{t(lang, "filesTab.ops.col.call")}</th>
              <th>{t(lang, "filesTab.ops.col.files")}</th>
              <th className="files-hide-narrow">{t(lang, "filesTab.ops.col.tool")}</th>
            </tr>
          </thead>
          <tbody>
            {props.calls.map((call) => (
              <tr
                key={call.callIndex}
                className={rowClass("files-ops__row", props, call)}
                data-op={call.callIndex}
                onClick={() => props.onPick(call.callIndex)}
              >
                <td className="files-ops__t">{when(props, call)}</td>
                <td className="files-ops__p">{promptOf(ledger.prompts, call.callIndex) ?? ""}</td>
                {agents && <td className="files-ops__agent">{agentTag(call.agentId)}</td>}
                <td className="files-ops__op">{operation(lang, call)}</td>
                <td className="files-ops__line">{callLine(call)}</td>
                <td className="files-ops__files">{files(lang, ledger, call)}</td>
                <td className="files-ops__tool files-hide-narrow">{call.tool}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FilesOpList(props: FilesOpListProps): JSX.Element {
  const { lang, ledger, selection } = props;
  const path = selection.path;
  const calls =
    path === null
      ? props.calls
      : props.calls.filter((call) => call.touches.some((touch) => touch.path === path));
  const row = path === null ? undefined : props.rows.find((one) => one.path === path);
  const label =
    path === null
      ? t(lang, "filesTab.ops.allFiles")
      : row !== undefined
        ? shownPath(
            row.label,
            row.touches.some((touch) => touch.folder),
          )
        : shortenPath(path, ledger.workspace);
  return (
    <div className="files-panel files-oplist">
      <div className="files-panel__head">
        {t(lang, "filesTab.ops.title")}
        <span className="files-panel__meta">{`${label} · ${calls.length}`}</span>
        {path !== null && (
          <button
            type="button"
            className="files-link files-panel__link"
            data-action="all-calls"
            onClick={props.onShowAll}
          >
            {t(lang, "filesTab.ops.allCalls")}
          </button>
        )}
      </div>
      <div className="files-panel__body">
        {calls.length === 0 ? (
          <p className="files-placeholder">{t(lang, "filesTab.ops.none")}</p>
        ) : (
          calls.map((call) => (
            <button
              key={call.callIndex}
              type="button"
              className={rowClass("files-op", props, call)}
              data-op={call.callIndex}
              onClick={() => props.onPick(call.callIndex)}
            >
              <span className="files-op__t">{when(props, call)}</span>
              <span className="files-op__what">
                {operation(lang, call)}
                {props.agents && agentTag(call.agentId)}
              </span>
              <span className="files-op__line">{callLine(call)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// The cells both forms share.

function rowClass(base: string, props: FilesOperationsProps, call: FileCall): string {
  const classes = [base];
  if (props.selection.call === call.callIndex) classes.push(`${base}--sel`);
  if (call.callIndex > props.limit) classes.push(`${base}--after`);
  if (call.status === "failed") classes.push(`${base}--failed`);
  return classes.join(" ");
}

function when(props: FilesOperationsProps, call: FileCall): string {
  return whenLabel(props.lang, props.ledger.timed ? call.t : null, props.ordinals.get(call.callIndex) ?? 0);
}

/** What a call did: its touch kinds in the order they first appear, or why it touched nothing. */
function operation(lang: Lang, call: FileCall): JSX.Element[] {
  if (call.status === "failed") {
    return [
      <span key="failed" className="files-kind files-kind--failed">
        {t(lang, "filesTab.ops.failed")}
      </span>,
    ];
  }
  if (call.touches.length === 0) {
    const key =
      call.note === "no change"
        ? "filesTab.ops.noChange"
        : call.note === "no file named"
          ? "filesTab.ops.noFileNamed"
          : null;
    return key === null
      ? []
      : [
          <span key="note" className="files-kind files-kind--none">
            {t(lang, key)}
          </span>,
        ];
  }
  const kinds: TouchKind[] = [];
  for (const touch of call.touches) if (!kinds.includes(touch.kind)) kinds.push(touch.kind);
  return kinds.map((kind) => (
    <span key={kind} className={`files-kind files-kind--${KIND_CLASS[kind]}`}>
      {t(lang, `filesTab.kind.${kind}`)}
    </span>
  ));
}

function agentTag(agentId: string): JSX.Element {
  return (
    <span className="files-agent" style={{ "--files-agent": agentAccent(agentId) } as CSSProperties}>
      <span className="files-agent__dot" aria-hidden="true" />
      {agentId}
    </span>
  );
}

const callLine = (call: FileCall): string => (call.shell ? `$ ${call.line}` : call.line);

/** Each file a call touched, with its sources and what happened to it; a failed call has none. */
function files(lang: Lang, ledger: FileLedger, call: FileCall): JSX.Element[] {
  if (call.status === "failed") return [];
  return call.touches.map((touch, i) => (
    <span key={i} className="files-ops__fx">
      {sourceTags(lang, touch.sources)}{" "}
      <span className="files-mono">{shownPath(shortenPath(touch.path, ledger.workspace), touch.folder)}</span>{" "}
      {t(lang, `filesTab.kind.${touch.kind}`)}
    </span>
  ));
}
