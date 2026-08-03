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
import type { PendingPermission } from "../state/reducer";
import { describeTool } from "./toolViews";
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
 * Shared by both gate surfaces (this modal and the fleet bar) so the same
 * request never leads with two different subjects.
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
  onDecide: (callId: string, allowed: boolean, opts?: { remember?: boolean; persist?: boolean }) => void;
}) {
  const { permission } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const lang = useLang();
  const subject = gateSubject(permission.name, permission.input);

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
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
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
        {permission.agentId !== "main" && (
          <p className="requested-by">{t(lang, "perm.by", { id: permission.agentId })}</p>
        )}
        {subject !== null && <GateSubjectLine subject={subject} lang={lang} />}
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
            {t(lang, "perm.always")} <span className="mono">{permission.name}</span> {t(lang, "perm.session")}
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
