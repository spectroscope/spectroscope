// Card 604: the timeline of the files tab. One row per explorer path and a row
// for the shell commands; each touch is a mark at its second, or at its call
// number when the recording has no clock (C12). Prompts are numbered on the
// axis. The tab's own cursor (C2) stands over the rows: it can be dragged, it
// dims what comes after it, and it never moves the session's stepper.
//
// The rows are drawn with HTML and percentages rather than an SVG measured in
// pixels, so the timeline needs no layout effect: a test renders it as it is.
// One element per touch, never one per event, and at most ROW_CAP path rows.

import type { JSX, PointerEvent } from "react";
import type { RunEvent } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { elapsedAt } from "../state/stepper";
import { cursorLimit, whenLabel, type Cursor } from "./cursor";
import { shownPath } from "./FilesExplorer";
import type { FileCall, FileLedger, FileRow, FileTouch, PromptMark } from "./fold";
import type { FilesSelection } from "./FilesView";
import type { TouchKind } from "./shell";

/** At most this many path rows are drawn; the explorer lists the rest. */
export const ROW_CAP = 30;

/** A place on the axis a drag can put the cursor on: a call or a prompt. */
interface Anchor {
  at: number; // event index
  pos: number;
}

export interface TimelineAxis {
  /** Seconds from the start of the run, or call numbers when the ledger has no clock. */
  timed: boolean;
  /** The axis runs from 0 to `end`; never 0. */
  end: number;
  /** Where each call of the ledger stands, by its event index. */
  callPos: ReadonlyMap<number, number>;
  /** Each call's 1-based number in the ledger, by its event index. */
  ordinals: ReadonlyMap<number, number>;
  /** The calls' event indexes, in order. */
  callIndexes: readonly number[];
  /** Calls and prompts in event order; their positions never go down. */
  anchors: readonly Anchor[];
  prompts: readonly { mark: PromptMark; pos: number }[];
  /** Where the axis is labelled. */
  steps: readonly number[];
}

const SECOND_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200,
];
const CALL_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
/** No more labels than this on the axis. */
const MAX_STEPS = 7;

/**
 * The axis of a ledger. With a clock, a call stands at its second; a call
 * without a stamp in an otherwise timed run stands where the last one before
 * it stood, so positions never run backwards. Without a clock, call k stands
 * at k and a prompt halfway between the calls around it.
 */
export function timelineAxis(ledger: FileLedger, events: readonly RunEvent[]): TimelineAxis {
  const callPos = new Map<number, number>();
  const ordinals = new Map<number, number>();
  const anchors: Anchor[] = [];
  const prompts: { mark: PromptMark; pos: number }[] = [];
  const { calls } = ledger;
  let c = 0;
  let p = 0;
  let last = 0;
  while (c < calls.length || p < ledger.prompts.length) {
    const call = calls[c];
    const prompt = ledger.prompts[p];
    if (prompt === undefined || (call !== undefined && call.callIndex < prompt.eventIndex)) {
      const pos = ledger.timed ? Math.max(last, call.t ?? last) : c + 1;
      callPos.set(call.callIndex, pos);
      ordinals.set(call.callIndex, c + 1);
      anchors.push({ at: call.callIndex, pos });
      last = pos;
      c++;
    } else {
      const pos = ledger.timed ? Math.max(last, prompt.t ?? last) : c + 0.5;
      prompts.push({ mark: prompt, pos });
      anchors.push({ at: prompt.eventIndex, pos });
      last = pos;
      p++;
    }
  }
  let end: number;
  if (ledger.timed) {
    const ms = elapsedAt(events, events.length - 1);
    end = Math.max(last, ms === null ? 0 : ms / 1000);
  } else end = calls.length + 1;
  if (!(end > 0)) end = 1;
  const span = ledger.timed ? end : calls.length;
  const table = ledger.timed ? SECOND_STEPS : CALL_STEPS;
  const step = table.find((s) => span / s <= MAX_STEPS) ?? table[table.length - 1];
  const steps: number[] = [];
  for (let k = ledger.timed ? 0 : 1; k * step <= span + 1e-9; k++) steps.push(k * step);
  const callIndexes = calls.map((call) => call.callIndex);
  return { timed: ledger.timed, end, callPos, ordinals, callIndexes, anchors, prompts, steps };
}

/** Where the cursor stands on the axis. */
export function cursorPos(axis: TimelineAxis, cursor: Cursor, events: readonly RunEvent[]): number {
  if (cursor.follow) return axis.end;
  const at = cursor.at;
  if (at < 0) return 0;
  if (axis.timed) {
    const ms = elapsedAt(events, at);
    if (ms !== null) return Math.min(axis.end, ms / 1000);
    const before = lastAnchorAtOrBefore(axis.anchors, (a) => a.at <= at);
    return before === null ? 0 : before.pos;
  }
  const k = callsAtOrBefore(axis, at);
  if (k === 0) return 0;
  return axis.callPos.get(at) ?? k + 0.5;
}

/** The cursor a drag to `pos` places: on the last call or prompt at or before it. */
export function placeAt(axis: TimelineAxis, pos: number): Cursor {
  const anchor = lastAnchorAtOrBefore(axis.anchors, (a) => a.pos <= pos);
  return { follow: false, at: anchor === null ? -1 : anchor.at };
}

/** How many calls stand at or before event index `at`. */
function callsAtOrBefore(axis: TimelineAxis, at: number): number {
  const list = axis.callIndexes;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bisection over anchors whose test is true for a prefix. */
function lastAnchorAtOrBefore(anchors: readonly Anchor[], ok: (a: Anchor) => boolean): Anchor | null {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(anchors[mid])) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : anchors[lo - 1];
}

/** The mark colour of a touch kind; the stylesheet maps each to a files alias. */
const KIND_CLASS: Record<TouchKind, string> = {
  create: "create",
  change: "change",
  overwrite: "change",
  write: "change",
  append: "change",
  delete: "delete",
  read: "read",
  unknown: "unknown",
};

export interface FilesTimelineProps {
  lang: Lang;
  ledger: FileLedger;
  events: readonly RunEvent[];
  axis: TimelineAxis;
  /** The explorer's rows, after the agent chips. */
  rows: readonly FileRow[];
  /** The calls after the agent chips, in event order. */
  calls: readonly FileCall[];
  cursor: Cursor;
  playing: boolean;
  selection: FilesSelection;
  /** A press on a mark: its call, and its path (null on the shell row). */
  onPick: (callIndex: number, path: string | null) => void;
  onSelectRow: (row: FileRow) => void;
  /** A drag on the rows. */
  onCursor: (cursor: Cursor) => void;
  onPlay: () => void;
  /** Back to following the end of the run. */
  onFollow: () => void;
}

export function FilesTimeline(props: FilesTimelineProps): JSX.Element {
  const { lang, axis, rows, cursor, selection } = props;
  const limit = cursorLimit(cursor, props.events);
  const pct = (pos: number): string => `${(pos / axis.end) * 100}%`;
  const drawn = rows.slice(0, ROW_CAP);
  const picked = selection.path === null ? undefined : rows.find((row) => row.path === selection.path);
  if (picked !== undefined && !drawn.includes(picked)) drawn.push(picked);
  const more = rows.length - drawn.length;
  const shellCalls = props.calls.filter((call) => call.shell);

  const whenOf = (callIndex: number, seconds: number | null): string =>
    whenLabel(lang, seconds, axis.ordinals.get(callIndex) ?? 0);

  const mark = (
    key: string,
    touch: FileTouch | null,
    call: FileCall,
    path: string,
    kind: string,
    sources: readonly string[],
  ): JSX.Element => {
    const classes = ["files-tl__mark", `files-tl__mark--${kind}`];
    if (sources.includes("model")) classes.push("files-tl__mark--model");
    else if (!sources.includes("recorded")) classes.push("files-tl__mark--probable");
    if (call.callIndex > limit) classes.push("files-tl__mark--after");
    if (selection.call === call.callIndex && (touch === null || selection.path === path))
      classes.push("files-tl__mark--sel");
    const what =
      touch === null
        ? `$ ${clip(call.line, 160)}`
        : `${t(lang, `filesTab.kind.${touch.kind}`)} ${touch.written} (${sources
            .map((s) => t(lang, `filesTab.source.${s}`))
            .join(" · ")})`;
    const title = `${whenOf(call.callIndex, call.t)} · ${call.agentId} · ${what}`;
    return (
      <button
        key={key}
        type="button"
        tabIndex={-1}
        className={classes.join(" ")}
        style={{ left: pct(axis.callPos.get(call.callIndex) ?? 0) }}
        data-call={call.callIndex}
        data-file={path}
        title={title}
        aria-label={title}
        onClick={() => props.onPick(call.callIndex, path === "" ? null : path)}
      />
    );
  };

  const fromPointer = (e: PointerEvent<HTMLDivElement>): Cursor => {
    const box = e.currentTarget.getBoundingClientRect();
    const f = box.width > 0 ? Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) : 1;
    return placeAt(axis, f * axis.end);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button > 0) return;
    // A press on a mark selects its call; the drag starts anywhere else.
    if ((e.target as Element | null)?.closest?.("[data-call]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    props.onCursor(fromPointer(e));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) props.onCursor(fromPointer(e));
  };

  return (
    <section className="files-timeline" aria-label={t(lang, "filesTab.timeline.aria")}>
      <div className="files-tl__head">
        <button type="button" className="files-tl__btn" data-action="play" onClick={props.onPlay}>
          {t(lang, props.playing ? "filesTab.timeline.pause" : "filesTab.timeline.play")}
        </button>
        <button
          type="button"
          className="files-tl__btn"
          data-action="cursor-end"
          aria-pressed={cursor.follow}
          title={t(lang, "filesTab.timeline.endTitle")}
          onClick={props.onFollow}
        >
          {t(lang, "filesTab.timeline.end")}
        </button>
        <span>
          {t(lang, "filesTab.timeline.cursor")}{" "}
          <span className="files-tl__readout files-mono">{readout(lang, axis, cursor, props.events)}</span>
        </span>
        {!axis.timed && <span className="files-tl__unit">{t(lang, "filesTab.timeline.axisCalls")}</span>}
        <span className="files-tl__legend">
          <span>
            <i className="files-tl__key files-tl__key--create" />
            {t(lang, "filesTab.timeline.legendCreate")}
          </span>
          <span>
            <i className="files-tl__key files-tl__key--change" />
            {t(lang, "filesTab.timeline.legendChange")}
          </span>
          <span>
            <i className="files-tl__key files-tl__key--read" />
            {t(lang, "filesTab.timeline.legendRead")}
          </span>
          <span>
            <i className="files-tl__key files-tl__key--probable" />
            {t(lang, "filesTab.timeline.legendProbable")}
          </span>
          <span>
            <i className="files-tl__key files-tl__key--model" />
            {t(lang, "filesTab.timeline.legendModel")}
          </span>
        </span>
      </div>
      <div className="files-tl__body">
        <div className="files-tl__labels">
          <div className="files-tl__corner" />
          {drawn.map((row, i) => (
            <button
              key={row.path}
              type="button"
              tabIndex={-1}
              className={lane(
                "files-tl__label",
                i,
                row.path === selection.path ? "files-tl__label--sel" : null,
              )}
              title={row.path}
              onClick={() => props.onSelectRow(row)}
            >
              {tail(
                shownPath(
                  row.label,
                  row.touches.some((touch) => touch.folder),
                ),
              )}
            </button>
          ))}
          <div className={lane("files-tl__label", drawn.length, "files-tl__label--shell")}>
            {t(lang, "filesTab.timeline.shell")}
          </div>
        </div>
        <div className="files-tl__plot" onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
          <div className="files-tl__axis">
            {axis.steps.map((s) => (
              <span key={s} className="files-tl__step" style={{ left: pct(s) }}>
                {axis.timed
                  ? t(lang, "filesTab.timeline.step", {
                      s: s.toLocaleString(lang, { maximumFractionDigits: 1 }),
                    })
                  : s.toLocaleString(lang)}
              </span>
            ))}
          </div>
          {axis.steps.map((s) => (
            <span key={`grid-${s}`} className="files-tl__grid" style={{ left: pct(s) }} aria-hidden="true" />
          ))}
          {axis.prompts.map(({ mark: prompt, pos }) => (
            <span
              key={`prompt-${prompt.n}`}
              className={
                prompt.eventIndex > limit ? "files-tl__prompt files-tl__prompt--after" : "files-tl__prompt"
              }
              style={{ left: pct(pos) }}
              data-prompt={prompt.n}
              title={t(lang, "filesTab.timeline.prompt", {
                n: prompt.n,
                text: clip(firstLine(prompt.text), 120),
              })}
            >
              {prompt.n}
            </span>
          ))}
          {drawn.map((row, i) => (
            <div key={row.path} className={lane("files-tl__row", i, null)} data-path={row.path}>
              {row.touches.map((touch, i) =>
                mark(
                  `${touch.callIndex}-${i}`,
                  touch,
                  callOf(props.ledger, axis, touch.callIndex),
                  row.path,
                  KIND_CLASS[touch.kind],
                  touch.sources,
                ),
              )}
            </div>
          ))}
          <div className={lane("files-tl__row", drawn.length, "files-tl__row--shell")} data-row="shell">
            {shellCalls.map((call) => mark(String(call.callIndex), null, call, "", "shell", ["probable"]))}
          </div>
          <span
            className="files-tl__cursor"
            style={{ left: pct(cursorPos(axis, cursor, props.events)) }}
            aria-hidden="true"
          />
        </div>
      </div>
      {more > 0 && (
        <p className="files-tl__more">
          {t(lang, more === 1 ? "filesTab.timeline.moreOne" : "filesTab.timeline.more", { n: more })}
        </p>
      )}
    </section>
  );
}

/** What the cursor reads: its second or call, or the end of the run while it follows. */
function readout(lang: Lang, axis: TimelineAxis, cursor: Cursor, events: readonly RunEvent[]): string {
  if (cursor.follow) {
    return axis.timed
      ? t(lang, "filesTab.timeline.followEnd", { when: whenLabel(lang, axis.end, 0) })
      : t(lang, "filesTab.timeline.endOfRun");
  }
  if (axis.timed) return whenLabel(lang, cursorPos(axis, cursor, events), 0);
  const k = callsAtOrBefore(axis, cursor.at);
  return k === 0 ? t(lang, "filesTab.timeline.beforeFirst") : t(lang, "filesTab.callNumber", { n: k });
}

/** A row's classes: every second row is shaded, in the label column and the plot alike. */
function lane(base: string, i: number, extra: string | null): string {
  return [base, i % 2 === 1 ? "files-tl__shade" : null, extra].filter((c) => c !== null).join(" ");
}

function callOf(ledger: FileLedger, axis: TimelineAxis, callIndex: number): FileCall {
  return ledger.calls[(axis.ordinals.get(callIndex) ?? 1) - 1];
}

/** A long label keeps its end, where the file name is. */
function tail(label: string): string {
  const MAX = 34;
  return label.length <= MAX ? label : `…${label.slice(label.length - MAX + 1)}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0] ?? "";
