// The shell hooks, as a settings block a user can act on (card 195).
//
// Owner, 2026-08-12: "und wir brauchen noch hooks settings page."
//
// Before this block, the one feature that can stop an agent from doing something
// lived in a settings file with no screen anywhere: no way to see what was set,
// no way to set one, and no way to tell "no hooks are configured" apart from
// "hooks are not a thing in this product". The house rule that absence must be
// readable applies to configuration too, and this is the surface for it.
//
// WHAT THIS BLOCK IS CAREFUL NOT TO CLAIM. Measured before it was written:
//
//   - A hook takes effect for the NEXT session. The server resolves the hook
//     list once, in SessionConnection.buildAgentOnce, and the runner then lives
//     for the whole socket — so a session already open keeps the hooks it
//     started with. The block says that, in the same "applies to" idiom the
//     workspace and log-level sections use, rather than promising "no restart".
//   - A pre_tool_use hook runs BEFORE the permission gate. That is not a
//     footnote: it is arbitrary shell that executes without ever being asked
//     about, which is why the tier the server answers is spelled out here.
//   - A command whose text carries a credential shape comes back redacted, and
//     THEN this scope becomes read-only. Writing the array back would replace
//     the real command with the empty string the server sent — a hook disarmed
//     by the act of opening its own settings page.
//
// It decides nothing. GET /api/settings/hooks resolves the defaults through the
// core's own record and the runner's own constant; this file renders the answer.
// Writes go through the ordinary PUT /api/settings/user, the same single
// validated path every other field on this page uses.

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  composeHook,
  hookReadingKey,
  rawHooks,
  runsBeforeTheGate,
  timeoutNoteKey,
  withHook,
  withoutHook,
  type HookEntry,
  type HooksView,
} from "./hooksSetup";

/** One listed hook. `onRemove` is absent for a scope this page may not write. */
function HookRow({ entry, onRemove }: { entry: HookEntry; onRemove?: () => void }) {
  const lang = useLang();
  return (
    <li className="al-row" data-testid="hook-entry">
      <code className="al-raw">
        {entry.redactedBy === "" ? entry.command : t(lang, "set.hkRedacted", { rule: entry.redactedBy })}
      </code>
      <span className="al-tags">
        <span className="origin-badge">{entry.event}</span>
        <span className="origin-badge">{entry.matcher}</span>
        <span className="origin-badge">
          {t(lang, timeoutNoteKey(entry), { sec: String(entry.effectiveTimeoutSeconds) })}
        </span>
        {runsBeforeTheGate(entry) ? (
          <span className="settings-note settings-note--warn settings-note--inline">
            {t(lang, "set.hkBeforeGate")}
          </span>
        ) : null}
      </span>
      <span className="settings-note settings-note--inline">{t(lang, hookReadingKey(entry))}</span>
      {onRemove ? (
        <button type="button" className="soft-primary al-remove" onClick={onRemove}>
          {t(lang, "set.hkRemove")}
        </button>
      ) : null}
    </li>
  );
}

export function HooksSettings({
  anchorId,
  session,
  onSave,
}: {
  anchorId: string;
  /** The session whose workspace scopes join the read; absent for the process view. */
  session?: string | null;
  /** Writes one settings key into the USER scope — the same single validated
   *  write path every other field on this page uses. There is deliberately no
   *  second write endpoint for a list of commands this product executes. */
  onSave: (patch: Record<string, unknown>) => void | Promise<unknown>;
}) {
  const lang = useLang();
  const [view, setView] = useState<HooksView | null>(null);
  const [failed, setFailed] = useState(false);
  const [event, setEvent] = useState("pre_tool_use");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutField] = useState("");

  const load = useCallback(async () => {
    try {
      const url = session
        ? `/api/settings/hooks?session=${encodeURIComponent(session)}`
        : "/api/settings/hooks";
      const res = await fetch(url);
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setView((await res.json()) as HooksView);
      setFailed(false);
    } catch {
      setFailed(true); // an older server has no such route; the block says so rather than lying
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every write goes through the settings PUT and then re-reads: what the list
  // shows comes from the file the write just produced, never from what this page
  // assumed the write would do.
  const commit = async (next: unknown[]): Promise<void> => {
    await onSave({ hooks: next });
    await load();
  };

  const userEntries = view?.scopes.user ?? [];
  const writable = rawHooks(view, "user");
  const otherScopes = Object.entries(view?.scopes ?? {}).filter(([scope]) => scope !== "user");
  const pending = composeHook(event, matcher, command, timeout);

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secHooks")}
      </div>
      <p className="settings-note">{t(lang, "set.hkHint")}</p>
      {failed && <p className="settings-note settings-note--warn">{t(lang, "set.hkLoadFailed")}</p>}
      {view && (
        <p className="settings-note settings-note--warn" data-testid="hooks-tier">
          <span className="origin-badge">{view.tier}</span> {t(lang, "set.hkTierNote")}
        </p>
      )}

      {/* ---- What this machine's own settings run, and may change ---- */}
      <p className="settings-note">{t(lang, "set.hkScopeUser")}</p>
      {userEntries.length === 0 ? (
        <p className="settings-note" data-testid="hooks-empty">
          {t(lang, "set.hkEmpty")}
        </p>
      ) : (
        <ul className="al-list">
          {userEntries.map((entry, index) => (
            <HookRow
              key={`${entry.event}:${index}`}
              entry={entry}
              onRemove={
                writable === null
                  ? undefined
                  : () => {
                      const next = withoutHook(writable, index);
                      if (next !== null) void commit(next);
                    }
              }
            />
          ))}
        </ul>
      )}
      {/* A scope this page cannot write back says so. Silently dropping the
          remove button would look like a rendering bug. */}
      {userEntries.length > 0 && writable === null && (
        <p className="settings-note settings-note--warn">{t(lang, "set.hkReadOnlyRedacted")}</p>
      )}

      {/* ---- The other layers: shown because a hook a reader cannot see is a
          command a reader cannot weigh, read-only because this page writes
          one scope. ---- */}
      {otherScopes.map(([scope, entries]) => (
        <div key={scope}>
          <p className="settings-note">{t(lang, "set.hkScopeOther", { scope })}</p>
          <ul className="al-list">
            {entries.map((entry, index) => (
              <HookRow key={`${scope}:${entry.event}:${index}`} entry={entry} />
            ))}
          </ul>
        </div>
      ))}

      {/* ---- Adding one. The command is shown exactly as it will run, in a
          monospace field, before it runs — the permission gate's own contract,
          and no quieter for a thing that executes ahead of the gate. ---- */}
      <div className="settings-grid">
        <label className="settings-field">
          <span>{t(lang, "set.hkEvent")}</span>
          <select value={event} onChange={(e) => setEvent(e.target.value)}>
            {(view?.events ?? ["pre_tool_use", "post_tool_use"]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>{t(lang, "set.hkMatcher")}</span>
          <input
            type="text"
            placeholder="run_command"
            value={matcher}
            onChange={(e) => setMatcher(e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>{t(lang, "set.hkCommand")}</span>
          <input
            className="hk-command"
            type="text"
            placeholder="~/.spectro/hooks/guard.sh"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>{t(lang, "set.hkTimeout", { sec: String(view?.defaultTimeoutSeconds ?? "") })}</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder={String(view?.defaultTimeoutSeconds ?? "")}
            value={timeout}
            onChange={(e) => setTimeoutField(e.target.value)}
          />
        </label>
      </div>

      {/* What is about to be written, spelled out. The gate shows the operator
          the exact call before it runs; a form that adds a command which will
          run before that gate owes at least the same. */}
      {pending !== null && (
        <p className="settings-note" data-testid="hooks-preview">
          {t(lang, "set.hkPreview")}{" "}
          <code className="al-raw">{`${pending.event} ${pending.matcher ?? "*"} → ${pending.command}`}</code>
        </p>
      )}
      <button
        type="button"
        className="soft-primary"
        disabled={pending === null || writable === null}
        onClick={() => {
          const next = withHook(writable ?? [], pending);
          if (next === null) return;
          setMatcher("");
          setCommand("");
          setTimeoutField("");
          void commit(next);
        }}
      >
        {t(lang, "set.hkAdd")}
      </button>
      <p className="settings-note">{t(lang, "set.hkApplies")}</p>
      <p className="settings-note">{t(lang, "set.hkFailOpen")}</p>
    </>
  );
}
