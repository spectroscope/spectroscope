// The auto-approve allowlist, as a settings block a user can act on (card 199).
//
// Before this block the allowlist lived in a settings file and had no screen at
// all: the only way to learn what a running agent was allowed to do without
// asking was to open ~/.spectro/settings.json and know the entry grammar.
//
// The block exists for a sharper reason than convenience. Card 199's one-time
// migration deliberately leaves every existing exact-name entry approving
// exactly what it approved — turning that into a prompt storm is what produces
// a blanket approval, which is the thing the card is about. The exact-name hole
// therefore stays open, and it stays open for precisely the entry an injected
// page would tell a user to paste. What is bought against it is VISIBILITY:
// every entry listed with the tier it now carries, the ones that run code said
// out loud, and the map version that rated them. This page is that surface.
//
// It decides nothing. GET /api/settings/allowlist reads the entries out through
// the gate's OWN parser and the shipped tier map; this file renders the answer.
// A tier worked out a second time in TypeScript would drift from the gate the
// moment either changed, and a permissions page that disagrees with the gate is
// worse than no page.

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  approvesExecution,
  composeEntry,
  entryReadingKey,
  rawEntries,
  withEntry,
  withoutEntry,
  type AllowlistEntry,
  type AllowlistView,
} from "./allowlistSetup";

/** One listed entry. `onRemove` is absent for a scope this page may not write. */
function EntryRow({ entry, onRemove }: { entry: AllowlistEntry; onRemove?: () => void }) {
  const lang = useLang();
  const runsCode = approvesExecution(entry);
  return (
    <li className="al-row" data-testid="allowlist-entry">
      <code className="al-raw">{entry.raw}</code>
      <span className="al-tags">
        {entry.tier ? <span className="origin-badge">{entry.tier}</span> : null}
        {entry.toolTier && entry.toolTier !== entry.tier ? (
          <span className="origin-badge">
            {t(lang, "set.alToolTier")}: {entry.toolTier}
          </span>
        ) : null}
        {runsCode ? (
          <span className="settings-note settings-note--warn settings-note--inline">
            {t(lang, "set.alExecWarn")}
          </span>
        ) : null}
      </span>
      <span className="settings-note settings-note--inline">{t(lang, entryReadingKey(entry))}</span>
      {onRemove ? (
        <button type="button" className="soft-primary al-remove" onClick={onRemove}>
          {t(lang, "set.alRemove")}
        </button>
      ) : null}
    </li>
  );
}

export function AllowlistSettings({
  anchorId,
  session,
  onSave,
}: {
  anchorId: string;
  /** The session whose workspace scopes join the read; absent for the process view. */
  session?: string | null;
  /** Writes one settings key into the USER scope — the same single validated
   *  write path every other field on this page uses. There is deliberately no
   *  second write endpoint for permissions. */
  onSave: (patch: Record<string, unknown>) => void | Promise<unknown>;
}) {
  const lang = useLang();
  const [view, setView] = useState<AllowlistView | null>(null);
  const [failed, setFailed] = useState(false);
  const [tool, setTool] = useState("");
  const [tier, setTier] = useState("read");
  const [prefix, setPrefix] = useState("");

  const load = useCallback(async () => {
    try {
      const url = session
        ? `/api/settings/allowlist?session=${encodeURIComponent(session)}`
        : "/api/settings/allowlist";
      const res = await fetch(url);
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setView((await res.json()) as AllowlistView);
      setFailed(false);
    } catch {
      setFailed(true); // an older server has no such route; the block says so rather than lying
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every write goes through the settings PUT and then re-reads: the tiers in
  // the list come from the file the write just produced, never from what this
  // page assumed the write would do.
  const commit = async (next: string[]): Promise<void> => {
    await onSave({ autoApprove: next });
    await load();
  };

  const add = (): void => {
    const composed = composeEntry(tool, tier, prefix);
    const next = withEntry(rawEntries(view, "user"), composed);
    if (next === null) return;
    setTool("");
    setPrefix("");
    void commit(next);
  };

  const userEntries = view?.scopes.user ?? [];
  const otherScopes = Object.entries(view?.scopes ?? {}).filter(([scope]) => scope !== "user");
  const pendingRunsCode = tier === "eval-execute";

  return (
    <>
      <div className="settings-label" id={anchorId}>
        {t(lang, "set.secAllowlist")}
      </div>
      <p className="settings-note">{t(lang, "set.alHint")}</p>
      {failed && <p className="settings-note settings-note--warn">{t(lang, "set.alLoadFailed")}</p>}
      {view && (
        <p className="settings-note" data-testid="allowlist-map-version">
          {t(lang, "set.alMapVersion", { ver: view.mapVersion })}
        </p>
      )}

      {/* ---- What this machine's own settings approve, and may change ---- */}
      <p className="settings-note">{t(lang, "set.alScopeUser")}</p>
      {userEntries.length === 0 ? (
        <p className="settings-note">{t(lang, "set.alEmpty")}</p>
      ) : (
        <ul className="al-list">
          {userEntries.map((entry) => (
            <EntryRow
              key={entry.raw}
              entry={entry}
              onRemove={() => {
                const next = withoutEntry(rawEntries(view, "user"), entry.raw);
                if (next !== null) void commit(next);
              }}
            />
          ))}
        </ul>
      )}

      {/* ---- The other layers: shown because an entry a reader cannot see is
          an entry a reader cannot weigh, read-only because this page writes
          one scope. ---- */}
      {otherScopes.map(([scope, entries]) => (
        <div key={scope}>
          <p className="settings-note">{t(lang, "set.alScopeOther", { scope })}</p>
          <ul className="al-list">
            {entries.map((entry) => (
              <EntryRow key={`${scope}:${entry.raw}`} entry={entry} />
            ))}
          </ul>
        </div>
      ))}

      {/* ---- Adding one. The tier is a choice, never a default that happens
          to you: the form writes the tier out even when it is read. ---- */}
      <div className="settings-grid">
        <label className="settings-field">
          <span>{t(lang, "set.alTool")}</span>
          <input
            type="text"
            placeholder="mcp__playwright__*"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
          />
        </label>
        <label className="settings-field">
          <span>{t(lang, "set.alTier")}</span>
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            {(view?.tiers ?? ["read", "write", "eval-execute"]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-field">
          <span>{t(lang, "set.alPrefix")}</span>
          <input
            type="text"
            placeholder="git status"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </label>
      </div>
      {pendingRunsCode && <p className="settings-note settings-note--warn">{t(lang, "set.alAddExecNote")}</p>}
      <button
        type="button"
        className="soft-primary"
        disabled={composeEntry(tool, tier, prefix) === ""}
        onClick={add}
      >
        {t(lang, "set.alAdd")}
      </button>
    </>
  );
}
