// Card 301B: the file footprint panel.
//
// THE EMPTY STATE IS THE LOAD-BEARING PART. The canon's agents reach for
// `run_command` far more than a recorded corpus does, and a shell write leaves
// a command and no path — so a run can do a great deal of work to a great many
// files and produce a completely empty tree. A panel that showed nothing and
// said nothing would be read as broken, or worse, as proof that the run touched
// no files. So the count of shell calls is rendered EVERY time it is non-zero:
// beside a full list as "and this much you cannot see here", and instead of an
// empty list as "this run worked through the shell".
//
// THE ROW SAYS WHEN (card 309B). The fold has always ordered the touches by
// FIRST contact and its own doc calls that order "the only record of the
// sequence the run worked in" — and nothing on the row said so, which left the
// order legible only to somebody who had read the module. Each row now carries
// the coarse STEP of its first touch: the transport's own unit, from the
// transport's own rule, so the two surfaces cannot name different steps for one
// moment. The elapsed time appears beside it only where the recording carried
// timestamps, and is absent — never zeroed — everywhere else.
//
// Everything else lives in fileTree.ts, which is pure and bitten branch by
// branch. This file is words and pixels.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { agentDirectory, agentTagColor, type AgentDirectory } from "./agentDirectory";
import { fileFootprint, shortenPath, touchMoments, type FileTouch, type TouchMoment } from "./fileTree";
import { clockLabel } from "../state/stepper";
import { workspaceBasename } from "../workspace/paths";

/**
 * The worker badges for one side of a touch, in the directory's own order so
 * w1 is always listed before w2.
 *
 * THE DIRECTORY IS THE ONLY SOURCE OF A NAME HERE. A fallback used to append
 * `[...ids].filter((id) => !dir.has(id))` — every id the directory did not
 * hold, printed as itself. It was unreachable and it was dangerous, which is a
 * bad pair: unreachable because both folds read the SAME prefix and a tool_call
 * names its agent, so an agent that touched a file has a handle by
 * construction (fileTree.test.ts holds that premise, in case the directory's
 * creation rule ever narrows); dangerous because it was the one place in this
 * panel that would have put a raw `toolu_…` on a screen, which is the exact
 * thing card 298 built the directory to stop.
 */
function Badges(props: { ids: ReadonlySet<string>; dir: AgentDirectory; label: string }) {
  const { ids, dir, label } = props;
  if (ids.size === 0) return null;
  const tags = [...dir].filter(([id]) => ids.has(id)).map(([, handle]) => handle.tag);
  return (
    <span className="lab-files-side">
      <span className="lab-files-side-label">{label}</span>
      {tags.map((tag) => (
        <span key={tag} className="lab-files-badge mono" style={{ color: agentTagColor(tag) }}>
          {tag}
        </span>
      ))}
    </span>
  );
}

function Row(props: {
  touch: FileTouch;
  /** When this path was first touched. */
  moment: TouchMoment;
  dir: AgentDirectory;
  root: string | null;
  lang: ReturnType<typeof useLang>;
  onOpen?: (touch: FileTouch) => void;
}) {
  const { touch, moment, dir, root, lang, onOpen } = props;
  // The full path stays in the title: shortening is for reading, never for
  // hiding where a file actually is.
  const shown = touch.pattern ? touch.path : shortenPath(touch.path, root);
  return (
    <li className="lab-files-row">
      <button
        type="button"
        className="lab-files-open"
        title={touch.pattern ? t(lang, "lab.files.pattern") : touch.path}
        /* No focus seam handed in, no navigation. Same rule as the handover
           rows: a row that cannot open the trace does not pretend it can. */
        disabled={onOpen === undefined}
        onClick={onOpen === undefined ? undefined : () => onOpen(touch)}
      >
        <span className={`lab-files-path mono${touch.pattern ? " lab-files-path--pattern" : ""}`}>
          {shown}
        </span>
        <span className="lab-files-sides">
          <span className="lab-files-when mono tabular">
            {t(lang, "lab.stepN", { n: moment.step })}
            {/* Nothing at all where the run kept no clock: a 0:00 here would
                say when a file was touched, which no recording measured. */}
            {moment.elapsedMs === null ? "" : ` · ${clockLabel(moment.elapsedMs)}`}
          </span>
          <Badges ids={touch.writers} dir={dir} label={t(lang, "lab.files.writtenBy")} />
          <Badges ids={touch.readers} dir={dir} label={t(lang, "lab.files.readBy")} />
        </span>
      </button>
    </li>
  );
}

export function FileFootprint(props: {
  applied: RunEvent[];
  /** The workspace the canon knows, when there is one. Absent for every import
   *  and every replay — and then no path is shortened at all. */
  workspaceRoot?: string | null;
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const lang = useLang();
  const { applied, workspaceRoot } = props;
  const fp = useMemo(() => fileFootprint(applied), [applied]);
  const moments = useMemo(() => touchMoments(applied, fp.touches), [applied, fp]);
  const dir = useMemo(() => agentDirectory(applied), [applied]);
  const root = workspaceRoot ?? null;
  const onFocusEvent = props.onFocusEvent;

  const open =
    onFocusEvent === undefined
      ? undefined
      : (touch: FileTouch): void => {
          const ev = touch.firstEvent;
          const agentId =
            typeof (ev as { agentId?: unknown }).agentId === "string"
              ? (ev as { agentId: string }).agentId
              : "";
          onFocusEvent(agentId, ev);
        };

  // The count says "paths", so it counts paths. A Glob row belongs on the list
  // — dropping it would make the tree thinner than the run was — but this panel
  // italicises it and its tooltip calls it "not a file", and a number that
  // swept it in contradicted both, on screen, at the same time. Patterns are
  // therefore counted beside the paths, in their own words.
  const files = fp.touches.filter((touch) => !touch.pattern).length;
  const patterns = fp.touches.length - files;
  const countLine = [
    files === 0
      ? null
      : files === 1
        ? t(lang, "lab.files.countOne")
        : t(lang, "lab.files.count", { n: files }),
    patterns === 0
      ? null
      : patterns === 1
        ? t(lang, "lab.files.patternsOne")
        : t(lang, "lab.files.patterns", { n: patterns }),
  ].filter((s): s is string => s !== null);

  const shellNote =
    fp.shellCalls === 0
      ? null
      : fp.shellCalls === 1
        ? t(lang, "lab.files.shellNoteOne")
        : t(lang, "lab.files.shellNote", { n: fp.shellCalls });

  return (
    <div className="lab-files">
      <p className="lab-files-hint">{t(lang, "lab.files.hint")}</p>
      {fp.touches.length === 0 ? (
        /* The two very different silences, told apart. */
        <p className="lab-files-empty">
          {fp.shellCalls > 0 ? t(lang, "lab.files.emptyShell") : t(lang, "lab.files.empty")}
        </p>
      ) : (
        <>
          <p className="lab-files-count tabular">{countLine.join(" · ")}</p>
          {/* The order was always the point and was never said out loud. */}
          <p className="lab-files-note">{t(lang, "lab.files.order")}</p>
          <ul className="lab-files-list">
            {fp.touches.map((touch, i) => (
              <Row
                key={touch.path}
                touch={touch}
                moment={moments[i]}
                dir={dir}
                root={root}
                lang={lang}
                onOpen={open}
              />
            ))}
          </ul>
        </>
      )}
      {/* Shown beside a full list too: what the list cannot see is a fact about
          the list, not only about an empty one. */}
      {shellNote !== null && fp.touches.length > 0 && <p className="lab-files-note">{shellNote}</p>}
      {root !== null && fp.touches.length > 0 && (
        <p className="lab-files-note">{t(lang, "lab.files.rootNote", { root: workspaceBasename(root) })}</p>
      )}
    </div>
  );
}
