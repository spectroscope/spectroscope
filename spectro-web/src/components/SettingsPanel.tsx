// The settings PAGE (owner request): one place for everything that used to be
// scattered — design + effects (the old drawer), the UI language, the
// server-backed defaults (provider/model, thinking, image backend), the
// default workspace and the operator-log level, plus — new in this task — a
// "Maschine" subsection for the browse_page Chrome binary, the image-model
// override and the local STT model path.
//
// Design/effects/language stay browser-local (localStorage, untouched by this
// task). Everything else now reads/writes the settings-productization API
// (GET/PUT /api/settings — Task 13's serverSettings client): every field
// shows WHERE its value comes from (an origin badge — env, user settings,
// launch dir, flags, or "Default") and, only when the USER scope actually
// set it, a small "↺" to fall back to whatever the layer below resolves to.
//
// Persistence contract (owner decision) continues unchanged: EVERY control
// saves immediately, no separate Save button — free-text fields commit on
// blur rather than per keystroke (a PUT per character would both spam the
// network and risk out-of-order writes racing each other), every select
// commits on the discrete choice itself.

import { useEffect, useState } from "react";
import { DESIGNS, applyAndSaveDesign, useDesignPrefs } from "../state/designPrefs";
import { t, type Lang } from "../i18n/i18n";
import { imageModelOptions } from "./imageModels";
import { PROVIDERS } from "./providerPickerMode";
import { ModelField, useProviderModels } from "./providerModelField";
import { setLang, useLang } from "../state/lang";
import {
  fetchSettings,
  putSettings,
  originLabel,
  type SettingsView,
} from "../state/serverSettings";
import { clearLegacyLocalStorage, readLegacyLocalStorage, type LegacyDefaults } from "../state/graduation";

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`fx-switch${checked ? " fx-switch--on" : ""}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="fx-switch-label">{label}</span>
      <span className="fx-switch-track" aria-hidden="true">
        <span className="fx-switch-knob" />
      </span>
    </button>
  );
}

/** A field's provenance badge, plus a "reset to the layer below" affordance
 *  shown only when the USER scope actually set this field — there is nothing
 *  to fall back FROM otherwise, so the button stays hidden rather than
 *  writing a no-op patch. */
function OriginRow({
  view,
  field,
  lang,
  onReset,
  resetTitle,
}: {
  view: SettingsView;
  field: string;
  lang: Lang;
  onReset: () => void;
  resetTitle?: string;
}) {
  const resettable = view.layers.user?.[field] !== undefined;
  const title = resetTitle ?? t(lang, "set.reset");
  return (
    <span className="origin-row">
      <span className="origin-badge">{originLabel(view.origins[field], lang)}</span>
      {resettable && (
        <button type="button" className="origin-reset" title={title} aria-label={title} onClick={onReset}>
          ↺
        </button>
      )}
    </span>
  );
}

/** A free-text setting: buffers keystrokes locally and commits on blur (or
 *  Enter) instead of on every keystroke — committing per character would
 *  fire a PUT per key and risk two in-flight writes resolving out of order.
 *  Resyncs its draft whenever the server-resolved value changes under it
 *  (e.g. a reset elsewhere in the page refreshed the view). */
function DraftInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed !== value) onCommit(trimmed);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
}

/** How long the "saved" confirmation flashes after any change. */
const SAVED_FLASH_MS = 1400;

const IMAGE_PROVIDERS = ["gemini", "openai"] as const;
const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

export function SettingsPanel({
  open,
  onClose,
  providerStatus,
  onKeySaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Per-provider onboarding status from /api/config: ready | needs-key | local.
   *  Drives the model chooser's honest needs-key affordance (same as the picker). */
  providerStatus?: Record<string, string>;
  /** After a key is saved to ~/.spectro/.env, re-read /api/config so the provider
   *  flips needs-key → ready. */
  onKeySaved?: () => void;
}) {
  const { prefs } = useDesignPrefs();
  const lang = useLang();
  const [savedFlash, setSavedFlash] = useState(false);
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // One-shot graduation offer: a browser that still carries the retired
  // sessionDefaults/lastWorkspace localStorage state gets a chance to adopt
  // it into the user settings (or discard it) — checked fresh each open.
  const [legacy, setLegacy] = useState<LegacyDefaults | null>(null);

  // Re-fetch the resolved view each time the page opens (other surfaces — the
  // header picker, the Files tab's own folder pick — may have changed the
  // underlying settings files since the last open).
  useEffect(() => {
    if (!open) return;
    setLoadFailed(false);
    setSaveError(null);
    setLegacy(readLegacyLocalStorage());
    fetchSettings()
      .then(setView)
      .catch(() => setLoadFailed(true));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Shared model list for the session-defaults chooser — the SAME real
  // /api/models list, needs-key logic AND local-model snap as the header picker.
  // autoPick snaps a non-installed model on a LOCAL backend to a real one (a
  // cloud model like opus makes no sense as ollama's default), so picking ollama
  // never leaves a stale opus behind; cloud providers are never second-guessed.
  // Guarded on `open` so a closed panel makes no request. Must sit above the
  // early return (hook order).
  const settingsProvider = open && view ? String(view.effective.provider ?? "") : "";
  const settingsModel = view ? String(view.effective.model ?? "") : "";
  const { models: settingsModels, mode: settingsModelMode } = useProviderModels(
    settingsProvider,
    providerStatus,
    {
      model: settingsModel,
      // Quiet background persist for the auto-snap (no "saved" flash) — and a
      // self-contained writer, since saveUser is defined below the early return.
      onModelChange: (m) => void putSettings("user", { model: m === "" ? null : m }).then(setView).catch(() => {}),
      autoPick: true,
    },
  );

  if (!open) return null;

  const flash = (): void => {
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS);
  };

  /** Every write on this page goes through the user scope — a flat patch,
   *  `null` removing a key. Refreshes the view and flashes "saved" on
   *  success; a rejected patch (a 400 with the server's validation message)
   *  shows that message instead of touching the last-known-good view. */
  const saveUser = (patch: Record<string, unknown>): void => {
    putSettings("user", patch)
      .then((fresh) => {
        setView(fresh);
        setSaveError(null);
        flash();
      })
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));
  };

  /** Adopts the browser's legacy localStorage state into the user settings —
   *  one patch with every remembered field at once. Only clears the legacy
   *  keys once the write actually lands; a rejected patch leaves the banner
   *  up (and the old state in place) so the user can retry. */
  const applyLegacy = (): void => {
    if (legacy === null) return;
    putSettings("user", { ...legacy })
      .then((fresh) => {
        setView(fresh);
        clearLegacyLocalStorage();
        setLegacy(null);
        flash();
      })
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));
  };

  /** Discards the browser's legacy state without touching the server. */
  const discardLegacy = (): void => {
    clearLegacyLocalStorage();
    setLegacy(null);
  };

  // The per-session picker (App.tsx) opens the SAME native dialog to pin a
  // running session's workspace over the socket; this one writes the picked
  // folder into the USER settings as the default for every FUTURE session.
  const pickDefaultWorkspace = async (): Promise<void> => {
    try {
      const res = await fetch("/api/pick-workspace", { method: "POST" });
      if (res.status !== 200) return; // 204 cancel, 409 busy, 501 no dialog
      const body = (await res.json()) as { path?: string };
      if (body.path) saveUser({ workspace: body.path });
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const activeHasParticles = DESIGNS.find((d) => d.id === prefs.design)?.particles ?? false;

  return (
    <div className="settings-scrim" onClick={onClose}>
      <section
        className="settings-page"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "set.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <span className="eyebrow sand">{t(lang, "set.title")}</span>
          <span className="settings-hint" aria-live="polite">
            {savedFlash ? t(lang, "set.saved") : ""}
          </span>
          <button type="button" className="icon-button" aria-label={t(lang, "common.close")} onClick={onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="settings-body">
          {/* ---- One-shot graduation banner: adopt or discard whatever the
              retired localStorage stores still carry ---- */}
          {legacy && (
            <div className="settings-ws" role="status">
              <span className="settings-note">{t(lang, "set.gradTitle")}</span>
              <button type="button" className="ghost" onClick={applyLegacy}>
                {t(lang, "set.gradApply")}
              </button>
              <button type="button" className="ghost" onClick={discardLegacy}>
                {t(lang, "set.gradDiscard")}
              </button>
            </div>
          )}

          {/* ---- Design — auto-saves on selection (owner decision) ---- */}
          <div className="settings-label" id="skin-label">{t(lang, "set.secDesign")}</div>
          <div className="design-picker" role="radiogroup" aria-labelledby="skin-label">
            {DESIGNS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={prefs.design === d.id}
                className={`design-option${prefs.design === d.id ? " design-option--active" : ""}`}
                onClick={() => {
                  applyAndSaveDesign({ design: d.id });
                  flash();
                }}
              >
                <span className="design-swatch" style={{ background: d.bg }}>
                  <span className="design-swatch-dot" style={{ background: d.accent }} />
                </span>
                <span className="design-meta">
                  <span className="design-name">{d.label}</span>
                  <span className="design-sub">{d.sub}</span>
                </span>
                {d.particles && <span className="design-tag">{t(lang, "set.particleTag")}</span>}
              </button>
            ))}
          </div>

          <div className="settings-toggles">
            <Switch
              label={t(lang, "set.scrollFx")}
              checked={prefs.scroll}
              onChange={(v) => {
                applyAndSaveDesign({ scroll: v });
                flash();
              }}
            />
            <Switch
              label={t(lang, "set.particleFx")}
              checked={prefs.particles}
              onChange={(v) => {
                applyAndSaveDesign({ particles: v });
                flash();
              }}
            />
            {prefs.particles && !activeHasParticles && (
              <p className="settings-note">{t(lang, "set.noSignature")}</p>
            )}
          </div>

          {/* ---- Language ---- */}
          <div className="settings-label">{t(lang, "set.secLanguage")}</div>
          <div className="settings-seg" role="radiogroup" aria-label={t(lang, "set.secLanguage")}>
            <button
              type="button"
              role="radio"
              aria-checked={lang === "de"}
              className={`settings-seg-option${lang === "de" ? " settings-seg-option--active" : ""}`}
              onClick={() => { setLang("de"); flash(); }}
            >
              Deutsch
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={lang === "en"}
              className={`settings-seg-option${lang === "en" ? " settings-seg-option--active" : ""}`}
              onClick={() => { setLang("en"); flash(); }}
            >
              English
            </button>
          </div>

          {loadFailed && <p className="settings-note settings-error" aria-live="polite">{t(lang, "set.loadError")}</p>}
          {saveError && <p className="settings-note settings-error" aria-live="polite">{saveError}</p>}

          {view && (
            <>
              {/* ---- Session defaults — server-backed (Task 13) ---- */}
              <div className="settings-label">{t(lang, "set.secSession")}</div>
              <p className="settings-note">{t(lang, "set.sessionHint")}</p>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>{t(lang, "set.provider")}</span>
                  <select
                    className="provider-select"
                    value={String(view.effective.provider ?? "")}
                    onChange={(e) => saveUser({ provider: e.target.value, model: null })}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <OriginRow view={view} field="provider" lang={lang}
                    onReset={() => saveUser({ provider: null })} />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.model")}</span>
                  <ModelField
                    provider={String(view.effective.provider ?? "")}
                    models={settingsModels}
                    mode={settingsModelMode}
                    model={String(view.effective.model ?? "")}
                    onModelChange={(m) => saveUser({ model: m === "" ? null : m })}
                    providerStatus={providerStatus}
                    keyAffordance="inline"
                    onKeySaved={onKeySaved}
                  />
                  {settingsModelMode !== "needs-key" && (
                    <OriginRow view={view} field="model" lang={lang}
                      onReset={() => saveUser({ model: null })} />
                  )}
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.thinking")}</span>
                  <select
                    value={view.effective.thinking ? "on" : "off"}
                    onChange={(e) => saveUser({ thinking: e.target.value === "on" })}
                  >
                    <option value="on">{t(lang, "set.on")}</option>
                    <option value="off">{t(lang, "set.off")}</option>
                  </select>
                  <OriginRow view={view} field="thinking" lang={lang}
                    onReset={() => saveUser({ thinking: null })} />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.imageBackend")}</span>
                  <select
                    value={String(view.effective.imageProvider ?? "")}
                    onChange={(e) =>
                      // switching backend drops a stale cross-provider model
                      // (a gemini model would 404 against openai's endpoint).
                      saveUser({ imageProvider: e.target.value, imageModel: null })
                    }
                  >
                    {IMAGE_PROVIDERS.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                  <OriginRow view={view} field="imageProvider" lang={lang}
                    onReset={() => saveUser({ imageProvider: null })} />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.imageModel")}</span>
                  <select
                    value={String(view.effective.imageModel ?? "")}
                    onChange={(e) => saveUser({ imageModel: e.target.value === "" ? null : e.target.value })}
                  >
                    <option value="">{t(lang, "set.imageModelAuto")}</option>
                    {imageModelOptions(
                      String(view.effective.imageProvider ?? "gemini"),
                      String(view.effective.imageModel ?? ""),
                    ).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <OriginRow view={view} field="imageModel" lang={lang}
                    onReset={() => saveUser({ imageModel: null })} />
                </label>
              </div>

              {/* ---- Workspace default — server-backed (Task 13) ---- */}
              <div className="settings-label">{t(lang, "set.secWorkspace")}</div>
              {view.effective.workspace ? (
                <div className="settings-ws">
                  <code className="settings-ws-path" title={String(view.effective.workspace)}>
                    {String(view.effective.workspace)}
                  </code>
                </div>
              ) : (
                <p className="settings-note">{t(lang, "set.wsNone")}</p>
              )}
              <div className="settings-ws">
                <OriginRow view={view} field="workspace" lang={lang}
                  onReset={() => saveUser({ workspace: null })}
                  resetTitle={t(lang, "set.wsResetToEnv")} />
                <button type="button" className="ghost settings-forget" onClick={() => void pickDefaultWorkspace()}>
                  {t(lang, "set.pick")}
                </button>
              </div>
              <p className="settings-note">{t(lang, "set.wsApplies")}</p>

              {/* ---- Operator logging — editable (Task 13) ---- */}
              <div className="settings-label">{t(lang, "set.secLogging")}</div>
              <label className="settings-field">
                <span>{t(lang, "set.logLevel")}</span>
                <select
                  value={String(view.effective.logLevel ?? "info")}
                  onChange={(e) => saveUser({ logLevel: e.target.value })}
                >
                  {LOG_LEVELS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <OriginRow view={view} field="logLevel" lang={lang}
                  onReset={() => saveUser({ logLevel: null })} />
              </label>
              <p className="settings-note">{t(lang, "set.logHint")}</p>
              <p className="settings-note">{t(lang, "set.logApplies")}</p>

              {/* ---- Machine — new in this task: browse_page/image/STT paths ---- */}
              <div className="settings-label">{t(lang, "set.machine")}</div>
              <p className="settings-note">{t(lang, "set.machineHint")}</p>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>{t(lang, "set.chrome")}</span>
                  <DraftInput
                    value={String(view.effective.chromeBinary ?? "")}
                    onCommit={(v) => saveUser({ chromeBinary: v === "" ? null : v })}
                  />
                  <OriginRow view={view} field="chromeBinary" lang={lang}
                    onReset={() => saveUser({ chromeBinary: null })} />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.sttModel")}</span>
                  <DraftInput
                    value={String(view.effective.sttModel ?? "")}
                    onCommit={(v) => saveUser({ sttModel: v === "" ? null : v })}
                  />
                  <OriginRow view={view} field="sttModel" lang={lang}
                    onReset={() => saveUser({ sttModel: null })} />
                </label>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
