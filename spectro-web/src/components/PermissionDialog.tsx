// The serious moment: the run is paused server-side until a human decides.
// Deny is the safe default (initial focus, Esc). The scrim never closes the
// modal — a decision has to be deliberate. The input is shown in full: you
// approve what you see.
//
// "In full" is the load-bearing word. The payload arrives as JSON, and a JSON
// string escapes its newlines, so a shell command or a file body reaches this
// dialog as one endless line of visible \n. It is rendered here the way the tool
// card renders it — the shape as JSON, every multi-line field as its own
// labelled, highlighted block — because an unreadable payload does not stop
// anyone from clicking Allow. It only stops them from knowing what they allowed.
//
// Nothing is clipped, ever: the box is bounded and scrolls, the text is not. A
// trace can afford a truncated tail because the raw face is one click away; a
// gate cannot, because the answer is final and the tail is where a benign
// command turns.

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { AgentInfo, PendingPermission, ToolCard } from "../state/reducer";
import { describeTool, splitInput } from "./toolViews";
import { InputRegions } from "./ToolViewBody";
import { t } from "../i18n/i18n";
import type { Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The resource a call reaches for, and the dictionary key that labels it. */
export type GateSubject = { labelKey: string; text: string };

/**
 * What this call is about, in one line: a path, a URL, a server's tool, a skill.
 *
 * A gate is read under time pressure, so the target leads instead of hiding in
 * the payload. Only a resource NAME qualifies. A body never does: folding a
 * multi-line command onto one line joins its lines with spaces, and
 * `# keep the cache` + `rm -rf build` then reads as a comment — the payload
 * block below is the only place a command can be read as what it is.
 *
 * Exported for the tests, which pin it on its own.
 *
 * @param name  the tool's wire name
 * @param input the pending call's input, of any shape
 * @return the lead, or null when no single resource is named
 */
export function gateSubject(name: string, input: unknown): GateSubject | null {
  const view = describeTool(name, input, undefined, false);
  switch (view.kind) {
    case "file":
    case "write":
    case "edit":
      return { labelKey: "tv.file", text: view.path };
    case "listing":
      return { labelKey: "tv.listing", text: view.path };
    case "web":
      if (view.url !== null) return { labelKey: "tv.fetch", text: view.url };
      return view.query === null ? null : { labelKey: "tv.search", text: view.query };
    case "mcp":
      return { labelKey: "tv.mcp", text: `${view.server} · ${view.tool}` };
    case "skill":
      return { labelKey: "tv.skill", text: view.name };
    case "image":
      return view.source === null ? null : { labelKey: "tv.image", text: view.source };
    default:
      return null;
  }
}

/**
 * The command a shell call would run, when the payload keeps it on one line.
 *
 * <p>Card 382, criterion 6. A short command stays inside the JSON shape, where
 * it is read as a value among values; long or multi-line commands are already
 * lifted into a labelled block by {@link splitInput}, and lifting them twice
 * would print the same command above itself. So this returns a command only
 * when the payload did NOT lift it.</p>
 *
 * <p>It is a BLOCK and never the window's one-line lead: folding a multi-line
 * command onto one line joins its lines with spaces, which is the rule
 * {@link gateSubject} follows and keeps following.</p>
 *
 * @param name the tool's wire name
 * @param input the pending call's input, of any shape
 * @return the command verbatim, or null when there is none to add
 */
export function gateCommand(name: string, input: unknown): string | null {
  const view = describeTool(name, input, undefined, false);
  if (view.kind !== "command") return null;
  const lifted = splitInput(name, input).blocks.some((block) => block.key === "command");
  return lifted ? null : view.command;
}

/** Recorded outcomes shown in the window, newest first. */
export const GATE_HISTORY_MAX = 6;

/** What this session already decided, in the order a person read it last. */
export function GateHistory({ cards, lang }: { cards: Record<string, ToolCard>; lang: Lang }) {
  const decided = Object.values(cards)
    .filter((c) => c.permission === "allowed" || c.permission === "denied")
    .slice(-GATE_HISTORY_MAX)
    .reverse();
  if (decided.length === 0) return null;
  return (
    <div className="gate-history">
      <span className="gate-history-label mono">{t(lang, "gate.recorded")}</span>
      {decided.map((c) => (
        <span key={c.callId} className="gate-history-row mono">
          <span className={`gate-outcome gate-outcome--${c.permission}`}>
            {t(lang, c.permission === "allowed" ? "gate.histAllowed" : "gate.histDenied")}
          </span>
          {c.name}
          <span className="gate-history-agent">{c.agentId}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * What the Tab key may reach inside the window.
 *
 * <p>Exported because a trap that misses a control is invisible until the
 * control is first or last in the window, and then it is a skip nobody can
 * explain. The suite counts the nodes this selector reaches against the nodes
 * HTML makes focusable and demands the same number. The earlier selector,
 * `button, [tabindex="0"]`, reached 3 of 4: it missed the remember checkbox,
 * and the persist checkbox that appears beside it.</p>
 */
export const GATE_FOCUSABLE_SELECTOR = 'button, input, select, textarea, a[href], [tabindex="0"]';

/** The lead line, in the tool card's own vocabulary — a gate and the card that
 *  records it afterwards describe the same call in the same words. */
export function GateSubjectLine({ subject, lang }: { subject: GateSubject; lang: Lang }) {
  return (
    <div className="tv-region">
      <div className="tv-region-head">
        <span className="tv-label">{t(lang, subject.labelKey)}</span>
      </div>
      <div className="tv-path mono">{subject.text}</div>
    </div>
  );
}

export function PermissionDialog(props: {
  permission: PendingPermission;
  /** Position in the queue, 0-based; total open requests. */
  index: number;
  total: number;
  /** True only for a REAL (configured) workspace — a per-session temp folder
   *  has no project settings file to persist a rule into, so the "dauerhaft"
   *  checkbox stays hidden (behind a small hint) rather than offering a
   *  write that would 404. */
  workspaceConfigured: boolean;
  /** The session roster, so a child agent is named with its parent and its
   *  task instead of a raw id nobody can place. */
  agents?: readonly AgentInfo[];
  /** Where the call would land: the session's workspace. Null when nothing
   *  announced one yet, and then the line stays out rather than guessing. */
  workspacePath?: string | null;
  /** The session's tool cards — the recorded outcomes of earlier gates. */
  cards?: Record<string, ToolCard>;
  /** False for a FLEET gate: a remote node has no allowlist we control, so
   *  remember would be an inert control that looks like it did something. */
  allowRemember?: boolean;
  onDecide: (callId: string, allowed: boolean, opts?: { remember?: boolean; persist?: boolean }) => void;
}) {
  const { permission } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const lang = useLang();
  const subject = gateSubject(permission.name, permission.input);
  const command = gateCommand(permission.name, permission.input);
  const asker = props.agents?.find((a) => a.id === permission.agentId);
  const allowRemember = props.allowRemember !== false;

  // "Always allow" remembers for the session; "persist" (gated behind it) writes it
  // to the project's .spectro/settings.json. Only Allow carries the flags.
  const [remember, setRemember] = useState(false);
  const [persist, setPersist] = useState(false);

  const decide = (allowed: boolean): void =>
    props.onDecide(
      permission.callId,
      allowed,
      allowed ? { remember, persist: remember && persist } : undefined,
    );

  // Esc denies; Tab is trapped inside the dialog while the run is paused.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      decide(false);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(GATE_FOCUSABLE_SELECTOR);
    if (focusables === undefined || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={onKeyDown}>
      <div
        className="modal modal--gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        ref={dialogRef}
      >
        <div className="modal-head">
          <span className="eyebrow sand">Permission</span>
          {props.total > 1 && (
            <span className="queue-counter tabular">
              {t(lang, "perm.queue", { i: props.index + 1, n: props.total })}
            </span>
          )}
        </div>
        <h2 id="permission-title">
          <span className="mono">{permission.name}</span> {t(lang, "perm.wants")}
        </h2>
        {/* Who asked, as what it is. A raw id places nobody: a child is named
            with the agent that spawned it and the task it was handed, both of
            which the roster already carries. */}
        {permission.agentId !== "main" && (
          <p className="requested-by">
            <span className="perm-asker">{t(lang, "perm.by", { id: permission.agentId })}</span>
            {asker?.parentId != null && (
              <span className="perm-parent">{t(lang, "perm.parent", { id: asker.parentId })}</span>
            )}
            {asker !== undefined && asker.task !== "" && (
              <span className="perm-task">{t(lang, "perm.task", { task: asker.task })}</span>
            )}
          </p>
        )}
        {subject !== null && <GateSubjectLine subject={subject} lang={lang} />}
        {/* The command as its own block. A short one stays inside the JSON
            shape otherwise, where it is one value among values — and the shape
            is exactly what nobody reads under time pressure. */}
        {command !== null && (
          <div className="tv-region">
            <div className="tv-region-head">
              <span className="tv-label">{t(lang, "perm.command")}</span>
            </div>
            <pre className="tv-well mono perm-command">{command}</pre>
          </div>
        )}
        {/* Where it would land. The session's workspace, not a per-call path:
            nothing on the wire says a child ever runs against another folder,
            so this claims only what is known. */}
        {props.workspacePath != null && props.workspacePath !== "" && (
          <div className="tv-region">
            <div className="tv-region-head">
              <span className="tv-label">{t(lang, "perm.cwd")}</span>
            </div>
            <div className="tv-path mono">{props.workspacePath}</div>
          </div>
        )}
        {/* Focusable, because a payload that only scrolls with a mouse cannot be
            read to the end by a keyboard. Reachable by Tab, never the initial
            focus: that belongs to Deny, and arriving on the payload would put a
            bounded box between a person and the two buttons they came for. */}
        <div className="modal-input" tabIndex={0} aria-label={t(lang, "tv.input")}>
          <InputRegions
            label={t(lang, "tv.input")}
            name={permission.name}
            input={permission.input}
            lang={lang}
            clip={false}
          />
        </div>
        {allowRemember && (
          <div className="modal-remember">
            <label>
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => {
                  setRemember(e.target.checked);
                  if (!e.target.checked) setPersist(false);
                }}
              />{" "}
              {t(lang, "perm.always")} <span className="mono">{permission.name}</span>{" "}
              {t(lang, "perm.session")}
            </label>
            {remember && props.workspaceConfigured && (
              <label className="modal-remember-persist">
                <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />{" "}
                {t(lang, "perm.persist")}
              </label>
            )}
            {remember && !props.workspaceConfigured && (
              <p className="modal-remember-hint">{t(lang, "perm.noPersistHint")}</p>
            )}
          </div>
        )}
        {/* What this session decided before. The old bar carried it and the
            window did not; the window is the only surface now. */}
        {props.cards !== undefined && <GateHistory cards={props.cards} lang={lang} />}
        <div className="modal-actions">
          {/* Deny is the ghost button and carries the initial focus — the safe default. */}
          <button type="button" className="ghost" autoFocus onClick={() => decide(false)}>
            {t(lang, "perm.deny")}
          </button>
          <button type="button" className="soft-primary" onClick={() => decide(true)}>
            {t(lang, "perm.allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
