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
// Everything else lives in fileTree.ts, which is pure and bitten branch by
// branch. This file is words and pixels.

import { useMemo } from "react";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { agentDirectory, agentTagColor, type AgentDirectory } from "./agentDirectory";
import { fileFootprint, shortenPath, type FileTouch } from "./fileTree";
import { workspaceBasename } from "../workspace/paths";

/** The worker badges for one side of a touch, in the directory's own order so
 *  w1 is always listed before w2. */
function Badges(props: { ids: ReadonlySet<string>; dir: AgentDirectory; label: string }) {
  const { ids, dir, label } = props;
  if (ids.size === 0) return null;
  const tags = [...dir]
    .filter(([id]) => ids.has(id))
    .map(([, handle]) => handle.tag)
    // An id the directory never named still gets shown — as itself, rather
    // than dropped, because a touch by an unknown agent is still a touch.
    .concat([...ids].filter((id) => !dir.has(id)));
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
  dir: AgentDirectory;
  root: string | null;
  lang: ReturnType<typeof useLang>;
  onOpen?: (touch: FileTouch) => void;
}) {
  const { touch, dir, root, lang, onOpen } = props;
  // The full path stays in the title: shortening is for reading, never for
  // hiding where a file actually is.
  const shown = touch.pattern ? touch.path : shortenPath(touch.path, root);
  return (
    <li className="lab-files-row">
      <button
        type="button"
        className="lab-files-open"
        title={touch.pattern ? t(lang, "lab.files.pattern") : touch.path}
        onClick={onOpen === undefined ? undefined : () => onOpen(touch)}
      >
        <span className={`lab-files-path mono${touch.pattern ? " lab-files-path--pattern" : ""}`}>
          {shown}
        </span>
        <span className="lab-files-sides">
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
  const dir = useMemo(() => agentDirectory(applied), [applied]);
  const root = workspaceRoot ?? null;
  const onFocusEvent = props.onFocusEvent;

  const open =
    onFocusEvent === undefined
      ? undefined
      : (touch: FileTouch): void => {
          const ev = touch.firstEvent;
          const agentId = typeof (ev as { agentId?: unknown }).agentId === "string"
            ? (ev as { agentId: string }).agentId
            : "";
          onFocusEvent(agentId, ev);
        };

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
          <p className="lab-files-count tabular">
            {fp.touches.length === 1
              ? t(lang, "lab.files.countOne")
              : t(lang, "lab.files.count", { n: fp.touches.length })}
          </p>
          <ul className="lab-files-list">
            {fp.touches.map((touch) => (
              <Row key={touch.path} touch={touch} dir={dir} root={root} lang={lang} onOpen={open} />
            ))}
          </ul>
        </>
      )}
      {/* Shown beside a full list too: what the list cannot see is a fact about
          the list, not only about an empty one. */}
      {shellNote !== null && fp.touches.length > 0 && <p className="lab-files-note">{shellNote}</p>}
      {root !== null && fp.touches.length > 0 && (
        <p className="lab-files-note">
          {t(lang, "lab.files.rootNote", { root: workspaceBasename(root) })}
        </p>
      )}
    </div>
  );
}
