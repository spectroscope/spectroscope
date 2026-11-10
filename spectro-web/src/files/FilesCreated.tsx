// Card 604: the created view of the files tab. One card per file the run
// created, which is every explorer row with the letter A. A write whose result
// does not say the file was new ("existence not recorded") is no creation. The
// card shows what the creating call wrote, as added lines, when the session
// has it; then that call, and a link into the diff view with the file
// selected. A card whose call comes after the tab's cursor is dimmed.

import type { CSSProperties, JSX } from "react";
import { agentAccent } from "../format";
import { t, type Lang } from "../i18n/i18n";
import { whenLabel } from "./cursor";
import { addedLines, linesOf } from "./FilesDetail";
import { CHANGE_KINDS, shownPath, sourceTags } from "./FilesExplorer";
import type { FileLedger, FileRow, FileTouch } from "./fold";
import { toolOf } from "./label";

export interface FilesCreatedProps {
  lang: Lang;
  ledger: FileLedger;
  /** The explorer's rows, after the agent chips. */
  rows: readonly FileRow[];
  /** Each call's 1-based number in the ledger, by its event index. */
  ordinals: ReadonlyMap<number, number>;
  /** The cursor's last event index; a card whose call comes after it is dimmed. */
  limit: number;
  onShowInDiff: (callIndex: number, path: string) => void;
}

/** The created files, in explorer order, each with the touch that created it. */
export function createdFiles(rows: readonly FileRow[]): { row: FileRow; touch: FileTouch }[] {
  const out: { row: FileRow; touch: FileTouch }[] = [];
  for (const row of rows) {
    if (row.letter !== "A") continue;
    // The letter A says the row's first change is a create.
    const touch = row.touches.find((one) => CHANGE_KINDS.has(one.kind));
    if (touch !== undefined) out.push({ row, touch });
  }
  return out;
}

export function FilesCreated(props: FilesCreatedProps): JSX.Element {
  const { lang } = props;
  const created = createdFiles(props.rows);
  if (created.length === 0) {
    return (
      <div className="files-stage">
        <p className="files-placeholder">{t(lang, "filesTab.created.none")}</p>
      </div>
    );
  }
  return (
    <div className="files-stage files-created">
      {created.map(({ row, touch }) => card(props, row, touch))}
    </div>
  );
}

function card(props: FilesCreatedProps, row: FileRow, touch: FileTouch): JSX.Element {
  const { lang, ledger } = props;
  const ordinal = props.ordinals.get(touch.callIndex) ?? 0;
  const call = ledger.calls[ordinal - 1];
  const later = new Set(
    row.touches
      .filter((one) => CHANGE_KINDS.has(one.kind) && one.callIndex !== touch.callIndex)
      .map((one) => one.callIndex),
  ).size;
  const lines = touch.content === undefined ? null : linesOf(touch.content).length;
  const facts: string[] = [];
  if (lines !== null)
    facts.push(t(lang, lines === 1 ? "filesTab.created.linesOne" : "filesTab.created.lines", { n: lines }));
  if (later > 0)
    facts.push(t(lang, later === 1 ? "filesTab.created.laterOne" : "filesTab.created.later", { n: later }));
  return (
    <div
      key={row.path}
      className={
        touch.callIndex > props.limit ? "files-panel files-card files-card--after" : "files-panel files-card"
      }
      data-path={row.path}
    >
      <div className="files-card__head" title={row.path}>
        {shownPath(row.label, [touch])}
      </div>
      <div className="files-card__meta">
        {sourceTags(lang, touch.sources)}
        <span
          className="files-agent"
          style={{ "--files-agent": agentAccent(touch.agentId) } as CSSProperties}
        >
          <span className="files-agent__dot" aria-hidden="true" />
          {touch.agentId}
        </span>
        <span>
          {whenLabel(lang, touch.t, ordinal)}
          {call !== undefined && (
            <>
              {" · "}
              <span className="files-mono">{toolOf(lang, call)}</span>
            </>
          )}
          {facts.map((fact) => ` · ${fact}`).join("")}
        </span>
        <button
          type="button"
          className="files-link files-card__link"
          data-action="show-in-diff"
          onClick={() => props.onShowInDiff(touch.callIndex, row.path)}
        >
          {t(lang, "filesTab.created.showInDiff")}
        </button>
      </div>
      {touch.content !== undefined ? (
        <div className="files-diff files-card__body">{addedLines(touch.content)}</div>
      ) : (
        <p className="files-note files-card__none">{t(lang, "filesTab.created.noContent")}</p>
      )}
    </div>
  );
}
