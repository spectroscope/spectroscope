// The composer gear (settings-productization Task 16): a compact, Claude-
// Code-style popover on the composer row — the three permission modes as a
// keyboard-navigable text list (always live via set_permission_mode; also
// persisted to the workspace's project settings file once a real workspace
// is pinned) and, only for a pinned workspace, the project scope's
// always-allow rules with add AND delete. All the decisions (what's pinned,
// what the rules are, how the list mutates) live in the pure workspaceGear.ts
// module — this file only wires DOM events (open/close, fetch-on-open,
// keyboard nav) to them, the same split as ProviderPicker/voiceButton.
//
// Task 17 adds two more pinned-only sections on the same popover: per-field
// machine-LOCAL overrides (settings.local.json — add/remove, client-side
// type coercion first, the server's 400 as the second net) and raw-JSON
// editors for the PROJECT scope's mcpServers/hooks blocks (parseBlockJson as
// the first net, same server-400 second net). Every error surfaces inline in
// the popup itself — there is no toast system.
//
// Named ComposerGear rather than WorkspaceGear to keep the file distinct
// from workspaceGear.ts — the two would differ only by their leading
// letter's case, which tsc's cross-platform-safety check (TS1261/1149)
// flatly refuses even though this machine's case-insensitive filesystem
// tolerates it.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEventHandler } from "react";
import type { ClientMessage } from "../events";
import type { WorkspaceInfo } from "../state/reducer";
import { fetchSettings, putSettings, type SettingsView } from "../state/serverSettings";
import {
  buildGearModel,
  MODES,
  overridableFields,
  parseBlockJson,
  parseLocalOverrideValue,
  rulesWith,
  rulesWithout,
} from "./workspaceGear";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** Renders a local-override row's raw value for the popover. Every value
 *  this UI itself ever writes is already the primitive `parseLocalOverrideValue`
 *  produced (string/number/boolean); the object/array branch is a defensive
 *  fallback for a settings.local.json edited by hand outside this popover. */
function formatOverrideValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

export function ComposerGear({
  workspaceInfo,
  permissionMode,
  sendClient,
}: {
  /** This session's workspace announcement (the socket-only workspace_info
   *  frame) — null before it arrives. */
  workspaceInfo: WorkspaceInfo | null;
  /** The LIVE mode (state.permissionMode) — wire truth, always wins over
   *  whatever the settings file says. */
  permissionMode: string;
  sendClient: (msg: ClientMessage) => boolean;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Local overrides (Task 17): the "+ override" affordance's own field/value
  // draft, independent of the rules-list draft above.
  const [localField, setLocalField] = useState<string>(overridableFields()[0] ?? "");
  const [localValue, setLocalValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  // MCP servers / hooks JSON editors (Task 17): collapsed by default, one
  // draft + error per block. Seeded below, directly inside the fetch-on-open
  // effect's own success/failure handlers rather than via a SEPARATE effect
  // watching `view` — that would race: `view` only reflects a fresh fetch
  // once ITS OWN state update has flushed into a later render, so on a
  // REOPEN (view still holding the previous session's stale value the
  // instant `open` flips true) a `view`-watching effect seeds from that
  // stale value first and never gets a second chance once the real fetch
  // lands. Seeding from the promise's own resolved value has no such race,
  // and naturally fires exactly once per open (this effect's deps don't
  // change again while the popover stays open).
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpDraft, setMcpDraft] = useState("");
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [hooksDraft, setHooksDraft] = useState("");
  const [hooksError, setHooksError] = useState<string | null>(null);

  const sessionId = workspaceInfo?.sessionId;
  const model = buildGearModel(view, workspaceInfo, permissionMode);

  // Fetch the project-scope view fresh on every open — another tab or the
  // Settings page may have changed the file since the last time. An
  // unpinned session's fetch 404s (SettingsController: "a session with
  // neither a pin nor a configured workspace answers 404"); caught into the
  // same view=null model as "still loading" — the pinned/unpinned split
  // itself comes from workspaceInfo.configured, not from this fetch. The
  // MCP/hooks drafts clear to their blank default the instant the popover
  // opens (same fast-clear-then-refill beat as `model.rules`, which already
  // reads as [] the moment `view` goes null) and refill once the fetch
  // settles — success with the real blocks, failure with the same blanks.
  useEffect(() => {
    if (!open) return;
    setView(null);
    setMcpDraft(JSON.stringify({}, null, 2));
    setHooksDraft(JSON.stringify([], null, 2));
    // A fresh open starts with a clean slate — any error belonged to an
    // action from a previous open (or long ago in this one) and would
    // otherwise linger, misleadingly, on content the user hasn't touched yet;
    // same for the add-row's half-typed field/value draft.
    setLocalField(overridableFields()[0] ?? "");
    setLocalValue("");
    setLocalError(null);
    setMcpError(null);
    setHooksError(null);
    if (sessionId === undefined) return;
    let alive = true;
    fetchSettings(sessionId)
      .then((v) => {
        if (!alive) return;
        setView(v);
        setMcpDraft(JSON.stringify(v.layers.project?.mcpServers ?? {}, null, 2));
        setHooksDraft(JSON.stringify(v.layers.project?.hooks ?? [], null, 2));
      })
      .catch(() => {
        if (alive) setView(null);
      });
    return () => {
      alive = false;
    };
  }, [open, sessionId]);

  // Keyboard focus starts on the current mode each time the popover opens
  // (and re-syncs if the mode changes under it, e.g. right after a switch
  // the server just confirmed).
  useEffect(() => {
    if (!open) return;
    const at = MODES.findIndex((m) => m.id === model.mode);
    setFocusIdx(at < 0 ? 0 : at);
    // model.mode is derived from the permissionMode prop each render; only
    // the mode value itself (and open) should re-trigger this sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, model.mode]);

  // Close on outside click / Escape — same mechanics as ProviderPicker's
  // .provider-pop.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Mode selection is ALWAYS live (works even for an unpinned session that
  // cannot persist it); it's only written to the project file when pinned.
  const chooseMode = (mode: string): void => {
    sendClient({ type: "set_permission_mode", mode });
    if (model.pinned && sessionId !== undefined) {
      putSettings("project", { permissionMode: mode }, sessionId)
        .then(setView)
        .catch(() => {});
    }
  };

  const onListKeyDown: KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(MODES.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = MODES[focusIdx];
      if (picked !== undefined) chooseMode(picked.id);
    }
  };

  const removeRule = (rule: string): void => {
    if (sessionId === undefined) return;
    putSettings("project", { autoApprove: rulesWithout(model.rules, rule) }, sessionId)
      .then(setView)
      .catch(() => {});
  };

  const addRule = (): void => {
    if (sessionId === undefined) return;
    const next = rulesWith(model.rules, draft);
    if (next === model.rules) return; // blank or duplicate: nothing to persist
    putSettings("project", { autoApprove: next }, sessionId)
      .then(setView)
      .catch(() => {});
    setDraft("");
  };

  /** Reads a readable message off a rejected `putSettings` call — its own
   *  errors are always real `Error`s (its `readableError` helper), but this
   *  stays defensive against anything else reaching the catch. */
  const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // Local overrides (Task 17): per-field rows on the machine-local file, with
  // add/remove going straight through PUT /api/settings/local. A remove sends
  // a null-valued patch (SettingsWriter's own "null removes the key" rule);
  // an add is validated client-side first (parseLocalOverrideValue) so a
  // typo shows an inline error instead of silently deleting the field (see
  // that function's doc) — the server's own 400 is still the second net for
  // anything the client-side check missed (e.g. an unknown provider name).
  const localFields = model.view?.layers.local ?? {};

  const removeLocalOverride = (field: string): void => {
    if (sessionId === undefined) return;
    putSettings("local", { [field]: null }, sessionId)
      .then((v) => {
        setView(v);
        setLocalError(null);
      })
      .catch((e: unknown) => setLocalError(errorMessage(e)));
  };

  const addLocalOverride = (): void => {
    if (sessionId === undefined) return;
    const parsed = parseLocalOverrideValue(localField, localValue);
    if (!parsed.ok) {
      setLocalError(parsed.error);
      return;
    }
    putSettings("local", { [localField]: parsed.value }, sessionId)
      .then((v) => {
        setView(v);
        setLocalValue("");
        setLocalError(null);
      })
      .catch((e: unknown) => setLocalError(errorMessage(e)));
  };

  // MCP servers / hooks JSON editors (Task 17): a raw textarea per block,
  // parsed client-side first (parseBlockJson — the first net, a JSON syntax
  // error), then PUT to the PROJECT scope (the server's schema check, e.g. a
  // malformed server entry, is the second net; its 400 message shows inline
  // exactly like the local-override errors above).
  const saveMcpServers = (): void => {
    if (sessionId === undefined) return;
    const parsed = parseBlockJson(mcpDraft);
    if (!parsed.ok) {
      setMcpError(parsed.error);
      return;
    }
    putSettings("project", { mcpServers: parsed.value }, sessionId)
      .then((v) => {
        setView(v);
        setMcpError(null);
      })
      .catch((e: unknown) => setMcpError(errorMessage(e)));
  };

  const saveHooks = (): void => {
    if (sessionId === undefined) return;
    const parsed = parseBlockJson(hooksDraft);
    if (!parsed.ok) {
      setHooksError(parsed.error);
      return;
    }
    putSettings("project", { hooks: parsed.value }, sessionId)
      .then((v) => {
        setView(v);
        setHooksError(null);
      })
      .catch((e: unknown) => setHooksError(errorMessage(e)));
  };

  return (
    <div className="wsg-anchor" ref={ref}>
      <button
        type="button"
        className="icon-button attach-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t(lang, "wsg.title")}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div className="wsg-pop" role="dialog" aria-label={t(lang, "wsg.header")}>
          <div className="wsg-head">
            <span className="wsg-head-title">
              {model.workspaceName !== "" ? `${model.workspaceName} — ` : ""}
              {t(lang, "wsg.header")}
            </span>
          </div>

          {!model.pinned && <p className="wsg-hint">{t(lang, "wsg.unpinned")}</p>}

          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "wsg.modeTitle")}</span>
            </div>
            <div
              className="wsg-modes"
              role="listbox"
              aria-label={t(lang, "wsg.modeTitle")}
              tabIndex={0}
              onKeyDown={onListKeyDown}
            >
              {MODES.map((m, i) => (
                <div
                  key={m.id}
                  role="option"
                  aria-selected={model.mode === m.id}
                  className={`wsg-mode-row${i === focusIdx ? " wsg-mode-row--focus" : ""}${model.mode === m.id ? " wsg-mode-row--active" : ""}`}
                  onMouseEnter={() => setFocusIdx(i)}
                  onClick={() => chooseMode(m.id)}
                >
                  <span className="wsg-mode-marker" aria-hidden="true">
                    {model.mode === m.id ? "›" : ""}
                  </span>
                  <span className="wsg-mode-body">
                    <span className="wsg-mode-name mono">{m.id}</span>
                    <span className="wsg-mode-hint">{t(lang, `wsg.mode.${m.id}.hint`)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {model.pinned && (
            <div className="wsg-section">
              <div className="wsg-section-head">
                <span>{t(lang, "wsg.rules.title")}</span>
                <span className="wsg-scope-tag">{t(lang, "wsg.rules.scope")}</span>
              </div>
              {model.rules.length === 0 ? (
                <p className="wsg-empty">{t(lang, "wsg.rules.empty")}</p>
              ) : (
                <ul className="wsg-rules">
                  {model.rules.map((rule) => (
                    <li key={rule} className="wsg-rule-row">
                      <span className="mono wsg-rule-text" title={rule}>
                        {rule}
                      </span>
                      <button
                        type="button"
                        className="wsg-rule-del"
                        aria-label={t(lang, "wsg.rules.removeAria", { rule })}
                        onClick={() => removeRule(rule)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="wsg-rule-add">
                <input
                  type="text"
                  className="wsg-rule-input"
                  value={draft}
                  placeholder={t(lang, "wsg.rules.addPh")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addRule();
                    }
                  }}
                />
              </div>
            </div>
          )}

          {model.pinned && (
            <div className="wsg-section">
              <div className="wsg-section-head">
                <span>{t(lang, "wsg.local.title")}</span>
                <span className="wsg-scope-tag">{t(lang, "wsg.local.scope")}</span>
              </div>
              {Object.keys(localFields).length === 0 ? (
                <p className="wsg-empty">{t(lang, "wsg.local.empty")}</p>
              ) : (
                <ul className="wsg-rules">
                  {Object.entries(localFields).map(([field, value]) => (
                    <li key={field} className="wsg-rule-row">
                      <span className="mono wsg-rule-text" title={`${field}: ${formatOverrideValue(value)}`}>
                        {field}: {formatOverrideValue(value)}
                      </span>
                      <button
                        type="button"
                        className="wsg-rule-del"
                        aria-label={t(lang, "wsg.local.removeAria", { field })}
                        onClick={() => removeLocalOverride(field)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="wsg-local-add">
                <select
                  className="wsg-local-field-select mono"
                  aria-label={t(lang, "wsg.local.fieldAria")}
                  value={localField}
                  onChange={(e) => {
                    setLocalField(e.target.value);
                    setLocalError(null);
                  }}
                >
                  {overridableFields().map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="wsg-local-value-input mono"
                  value={localValue}
                  placeholder={t(lang, "wsg.local.valuePh")}
                  onChange={(e) => {
                    setLocalValue(e.target.value);
                    setLocalError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addLocalOverride();
                    }
                  }}
                />
                <button type="button" className="ghost wsg-local-add-btn" onClick={addLocalOverride}>
                  {t(lang, "wsg.local.add")}
                </button>
              </div>
              {localError !== null && <p className="settings-error wsg-inline-error">{localError}</p>}
            </div>
          )}

          {model.pinned && (
            <div className="wsg-section">
              <button
                type="button"
                className="wsg-json-toggle"
                aria-expanded={mcpOpen}
                onClick={() => setMcpOpen((o) => !o)}
              >
                <span>{t(lang, "wsg.json.mcpTitle")}</span>
                <span className="wsg-scope-tag">{t(lang, "wsg.json.scope")}</span>
                <span className="wsg-json-caret" aria-hidden="true">
                  {mcpOpen ? "▾" : "▸"}
                </span>
              </button>
              {mcpOpen && (
                <div className="wsg-json-block">
                  <textarea
                    className="wsg-json-textarea mono"
                    aria-label={t(lang, "wsg.json.mcpTitle")}
                    value={mcpDraft}
                    rows={8}
                    spellCheck={false}
                    onChange={(e) => {
                      setMcpDraft(e.target.value);
                      setMcpError(null);
                    }}
                  />
                  {mcpError !== null && <p className="settings-error wsg-inline-error">{mcpError}</p>}
                  <div className="wsg-json-actions">
                    <button type="button" className="ghost wsg-json-save" onClick={saveMcpServers}>
                      {t(lang, "wsg.json.save")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {model.pinned && (
            <div className="wsg-section">
              <button
                type="button"
                className="wsg-json-toggle"
                aria-expanded={hooksOpen}
                onClick={() => setHooksOpen((o) => !o)}
              >
                <span>{t(lang, "wsg.json.hooksTitle")}</span>
                <span className="wsg-scope-tag">{t(lang, "wsg.json.scope")}</span>
                <span className="wsg-json-caret" aria-hidden="true">
                  {hooksOpen ? "▾" : "▸"}
                </span>
              </button>
              {hooksOpen && (
                <div className="wsg-json-block">
                  <textarea
                    className="wsg-json-textarea mono"
                    aria-label={t(lang, "wsg.json.hooksTitle")}
                    value={hooksDraft}
                    rows={8}
                    spellCheck={false}
                    onChange={(e) => {
                      setHooksDraft(e.target.value);
                      setHooksError(null);
                    }}
                  />
                  {hooksError !== null && <p className="settings-error wsg-inline-error">{hooksError}</p>}
                  <div className="wsg-json-actions">
                    <button type="button" className="ghost wsg-json-save" onClick={saveHooks}>
                      {t(lang, "wsg.json.save")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
