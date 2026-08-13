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

import { useEffect, useRef, useState } from "react";
import { DESIGNS, applyAndSaveDesign, useDesignPrefs } from "../state/designPrefs";
import type { SettingsSection } from "../state/route";
import { SttSettings } from "./SttSettings";
import { FleetSettings } from "./FleetSettings";
import { t, type Lang } from "../i18n/i18n";
import { imageModelOptions } from "./imageModels";
import { PROVIDERS } from "./providerPickerMode";
import { addressSpecFor } from "./providerAddress";
import { ModelField, useProviderModels } from "./providerModelField";
import { settingsMayAutoPick } from "./settingsModelPolicy";
import { ReasoningControl } from "./ReasoningControl";
import { setLang, useLang } from "../state/lang";
import { McpSettings, SkillsSettings } from "./SkillsMcpSettings";
import { WebSearchSettings } from "./WebSearchSettings";
import { AllowlistSettings } from "./AllowlistSettings";
import { HooksSettings } from "./HooksSettings";
import type { Leveling } from "../state/useLeveling";
import {
  fetchSettings,
  putSettings,
  originLabel,
  textFieldPatch,
  type SettingsView,
} from "../state/serverSettings";
import { CopyButton } from "./CopyButton";
import { dockerOffer, type DockerStatus } from "./dockerOffer";
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
function DraftInput({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
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

/**
 * The Docker line under the OTLP fields (card 137). Renders one sentence for
 * one state, and nothing at all until the probe has answered — an operator who
 * never wanted Langfuse should not meet a greyed placeholder about containers.
 *
 * This does not belong in the doctor panel: the doctor answers "is spectroscope
 * healthy", and Docker's absence is not a spectroscope fault.
 */
function DockerOfferBlock({ status, lang }: { status: DockerStatus | null; lang: Lang }) {
  const offer = dockerOffer(status);
  if (offer.kind === "unknown") return null;
  return (
    <div className="settings-docker">
      <p className="settings-note">{t(lang, offer.messageKey)}</p>
      {/* The one outbound idiom in this codebase. The desktop shell turns an
          http(s) anchor into shell.openExternal, so this needs no desktop
          change to open in the operator's real browser. */}
      {offer.href ? (
        <p className="settings-note">
          <a href={offer.href} target="_blank" rel="noreferrer noopener">
            {t(lang, "set.dockerInstall")}
          </a>
        </p>
      ) : null}
      {status?.detail && offer.kind === "start" ? (
        <p className="settings-note settings-docker-detail">
          <code>{status.detail}</code>
        </p>
      ) : null}
      {offer.command ? (
        <>
          <pre className="settings-docker-cmd">
            <code>{offer.command}</code>
          </pre>
          <CopyButton text={() => offer.command ?? ""} label={t(lang, "set.langfuseCommand")} />
          <p className="settings-note">{t(lang, "set.langfuseCost")}</p>
        </>
      ) : null}
    </div>
  );
}

/** How long the "saved" confirmation flashes after any change. */
const SAVED_FLASH_MS = 1400;

const IMAGE_PROVIDERS = ["gemini", "openai"] as const;
const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

/** The DOM anchor of a settings section — one id per address the route
 *  vocabulary knows (#/settings/{section}, card 131). */
export function sectionAnchorId(section: SettingsSection): string {
  return `settings-sec-${section}`;
}

export function SettingsPanel({
  open,
  onClose,
  section,
  providerStatus,
  providerAddress,
  onKeySaved,
  onAddressSaved,
  leveling,
  onShowLocalNotice,
}: {
  open: boolean;
  onClose: () => void;
  /** The section a #/settings/{section} deep link named, scrolled into view
   *  once its block exists. null opens the page at its top. */
  section?: SettingsSection | null;
  /** The deliberate way back to the built-in model's one-time notice (card
   *  144): every exit of that sheet dismisses it for good, so this is the only
   *  door left. Opens the sheet over the app (settings folds away first). */
  onShowLocalNotice?: () => void;
  /** The app's one leveling state. Passed in rather than re-hooked here: a second
   *  instance would have its own snapshot, and a mode switched in this panel would
   *  leave the tabs behind it still locked until a reload. */
  leveling?: Leveling;
  /** Per-provider onboarding status from /api/config: ready | needs-key | local.
   *  Drives the model chooser's honest needs-key affordance (same as the picker). */
  providerStatus?: Record<string, string>;
  /** Card 193: the address each local-model provider would dial, from
   *  /api/config — shown to the unreachable note so it names what was tried. */
  providerAddress?: Record<string, string>;
  /** After a key is saved to ~/.spectro/.env, re-read /api/config so the provider
   *  flips needs-key → ready. */
  onKeySaved?: () => void;
  /** Card 193: after an address commit, re-read /api/config so the named
   *  address (providerAddress) is the fresh one, not the one just replaced. */
  onAddressSaved?: () => void;
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
  // Whether Docker is usable here (card 137) — null until the probe answers,
  // and null forever on a server that does not carry the route.
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  // Card 121: whether the operator changed the provider in THIS panel session.
  // The model auto-pick persists through putSettings, so it may only follow a
  // real gesture — opening the panel (click or deep link) rearms to "looking",
  // under which the chooser must write nothing.
  const [providerTouched, setProviderTouched] = useState(false);
  // Card 193: bumped after every address commit so the model probe re-runs —
  // its fetch is keyed on provider + status, and an address changes neither.
  const [probeEpoch, setProbeEpoch] = useState(0);

  // Re-fetch the resolved view each time the page opens (other surfaces — the
  // header picker, the Files tab's own folder pick — may have changed the
  // underlying settings files since the last open).
  useEffect(() => {
    if (!open) return;
    setLoadFailed(false);
    setSaveError(null);
    setProviderTouched(false);
    setLegacy(readLegacyLocalStorage());
    fetchSettings()
      .then(setView)
      .catch(() => setLoadFailed(true));
  }, [open]);

  // Docker detection (card 137). Read-only, once per open, and it must never
  // be able to break the page: a server too old to know the route answers 404,
  // which lands in the catch and leaves the block silent rather than shouting.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setDocker(null);
    fetch("/api/docker/status")
      .then((res) => (res.ok ? (res.json() as Promise<DockerStatus>) : null))
      .then((status) => {
        if (live) setDocker(status);
      })
      .catch(() => {
        if (live) setDocker(null);
      });
    return () => {
      live = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Deep link #/settings/{section} (card 131): scroll the named block into
  // view once it exists — the server-backed sections render only after the
  // settings fetch lands (and the leveling block after its snapshot), so this
  // retries per render until the anchor is in the DOM, then stops. It only
  // LOOKS: a deep-linked open writes nothing, the card-121 guard holds for
  // every opener.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || section == null) {
      scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === section) return;
    const anchor = document.getElementById(sectionAnchorId(section));
    if (anchor) {
      anchor.scrollIntoView({ block: "start" });
      scrolledFor.current = section;
    }
  });

  // Shared model list for the session-defaults chooser — the SAME real
  // /api/models list and needs-key logic as the header picker. The local-model
  // snap (a cloud model like opus makes no sense as ollama's default) persists,
  // so it is gated on a gesture: only after the operator changed the provider
  // in this panel may the resolve write — opening the page writes nothing
  // (card 121; the panel used to flip a configured model on open). Guarded on
  // `open` so a closed panel makes no request. Must sit above the early return
  // (hook order).
  const settingsProvider = open && view ? String(view.effective.provider ?? "") : "";
  const settingsModel = view ? String(view.effective.model ?? "") : "";
  const { models: settingsModels, mode: settingsModelMode } = useProviderModels(
    settingsProvider,
    providerStatus,
    {
      model: settingsModel,
      // Quiet background persist for the auto-snap (no "saved" flash) — and a
      // self-contained writer, since saveUser is defined below the early return.
      onModelChange: (m) =>
        void putSettings("user", { model: m === "" ? null : m })
          .then(setView)
          .catch(() => {}),
      autoPick: settingsMayAutoPick(providerTouched ? "gesture" : "open"),
      probeEpoch,
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
   *  shows that message instead of touching the last-known-good view.
   *
   *  Returns the settled promise so a caller that has follow-up work can wait
   *  for the write instead of guessing at a delay — the Web search block reads
   *  the tier back, and the server resolves that tier from the settings file
   *  this patch is writing. Every other call site ignores the value, exactly as
   *  before. */
  const saveUser = (patch: Record<string, unknown>): Promise<void> =>
    putSettings("user", patch)
      .then((fresh) => {
        setView(fresh);
        setSaveError(null);
        flash();
      })
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));

  /** Card 193: an address write is a saveUser plus two follow-ups — the model
   *  probe re-runs against the new endpoint (probe epoch), and /api/config is
   *  re-read so the unreachable note names the fresh address. Bumped only
   *  after the PUT landed: the server-side probe reads the settings file, so
   *  a probe fired before the write would test the address just replaced. */
  const saveAddress = (patch: Record<string, unknown>): void => {
    putSettings("user", patch)
      .then((fresh) => {
        setView(fresh);
        setSaveError(null);
        flash();
        setProbeEpoch((n) => n + 1);
        onAddressSaved?.();
      })
      .catch((e: unknown) => setSaveError(e instanceof Error ? e.message : String(e)));
  };

  /** The address block of the SELECTED provider (card 193): ollama and
   *  lmstudio each own a field; every other provider hides it. */
  const addressSpec = view ? addressSpecFor(String(view.effective.provider ?? "")) : null;

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
          <button
            type="button"
            className="icon-button"
            aria-label={t(lang, "common.close")}
            onClick={onClose}
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
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
          <div className="settings-label" id={sectionAnchorId("design")}>
            {t(lang, "set.secDesign")}
          </div>
          <div className="design-picker" role="radiogroup" aria-labelledby={sectionAnchorId("design")}>
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
          <div className="settings-label" id={sectionAnchorId("language")}>
            {t(lang, "set.secLanguage")}
          </div>
          <div className="settings-seg" role="radiogroup" aria-label={t(lang, "set.secLanguage")}>
            <button
              type="button"
              role="radio"
              aria-checked={lang === "de"}
              className={`settings-seg-option${lang === "de" ? " settings-seg-option--active" : ""}`}
              onClick={() => {
                setLang("de");
                flash();
              }}
            >
              Deutsch
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={lang === "en"}
              className={`settings-seg-option${lang === "en" ? " settings-seg-option--active" : ""}`}
              onClick={() => {
                setLang("en");
                flash();
              }}
            >
              English
            </button>
          </div>

          {loadFailed && (
            <p className="settings-note settings-error" aria-live="polite">
              {t(lang, "set.loadError")}
            </p>
          )}
          {saveError && (
            <p className="settings-note settings-error" aria-live="polite">
              {saveError}
            </p>
          )}

          {view && (
            <>
              {/* ---- Session defaults — server-backed (Task 13) ---- */}
              <div className="settings-label" id={sectionAnchorId("session")}>
                {t(lang, "set.secSession")}
              </div>
              <p className="settings-note">{t(lang, "set.sessionHint")}</p>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>{t(lang, "set.provider")}</span>
                  <select
                    className="provider-select"
                    value={String(view.effective.provider ?? "")}
                    onChange={(e) => {
                      // The gesture that unlocks the model auto-snap (card 121):
                      // the operator chose a provider, so filling its model is
                      // completing their choice, not overriding their config.
                      setProviderTouched(true);
                      saveUser({ provider: e.target.value, model: null });
                    }}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <OriginRow
                    view={view}
                    field="provider"
                    lang={lang}
                    onReset={() => saveUser({ provider: null })}
                  />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.model")}</span>
                  <ModelField
                    provider={String(view.effective.provider ?? "")}
                    models={settingsModels}
                    mode={settingsModelMode}
                    model={settingsModel}
                    onModelChange={(m) => saveUser({ model: m === "" ? null : m })}
                    providerStatus={providerStatus}
                    providerAddress={providerAddress}
                    keyAffordance="inline"
                    onKeySaved={onKeySaved}
                    markAbsent
                  />
                  {settingsModelMode !== "needs-key" && (
                    <OriginRow
                      view={view}
                      field="model"
                      lang={lang}
                      onReset={() => saveUser({ model: null })}
                    />
                  )}
                </label>
                {/* Card 193: the address beside the provider that needs it —
                    ollama and lmstudio each carry their OWN field with their
                    OWN preset as placeholder; other providers hide it. The
                    key includes the effective value so a reset or an external
                    change refreshes the uncontrolled input's default. */}
                {addressSpec && (
                  <label className="settings-field">
                    <span>{t(lang, "set.address")}</span>
                    <input
                      key={`${addressSpec.field}:${String(view.effective[addressSpec.field] ?? "")}`}
                      type="text"
                      placeholder={addressSpec.preset}
                      defaultValue={String(view.effective[addressSpec.field] ?? "")}
                      onBlur={(e) => {
                        const patch = textFieldPatch(
                          addressSpec.field,
                          e.target.value,
                          String(view.effective[addressSpec.field] ?? ""),
                        );
                        if (patch) saveAddress(patch);
                      }}
                    />
                    <span className="provider-field-note">{t(lang, "set.addressHint")}</span>
                    <OriginRow
                      view={view}
                      field={addressSpec.field}
                      lang={lang}
                      onReset={() => saveAddress({ [addressSpec.field]: null })}
                    />
                  </label>
                )}
                {/* Card 88: the same capability-driven seg as the header
                    picker — one shared component, one truth. Not a server
                    settings field (the choice is per model, browser-kept),
                    hence no OriginRow. */}
                {settingsModel !== "" && (
                  <div className="settings-field">
                    <span>{t(lang, "rc.settingsLabel")}</span>
                    <ReasoningControl
                      provider={String(view.effective.provider ?? "")}
                      model={settingsModel}
                      showNone
                    />
                    <span className="provider-field-note">{t(lang, "rc.settingsNote")}</span>
                  </div>
                )}
                <label className="settings-field">
                  <span>{t(lang, "set.thinking")}</span>
                  <select
                    value={view.effective.thinking ? "on" : "off"}
                    onChange={(e) => saveUser({ thinking: e.target.value === "on" })}
                  >
                    <option value="on">{t(lang, "set.on")}</option>
                    <option value="off">{t(lang, "set.off")}</option>
                  </select>
                  <OriginRow
                    view={view}
                    field="thinking"
                    lang={lang}
                    onReset={() => saveUser({ thinking: null })}
                  />
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
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <OriginRow
                    view={view}
                    field="imageProvider"
                    lang={lang}
                    onReset={() => saveUser({ imageProvider: null })}
                  />
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
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <OriginRow
                    view={view}
                    field="imageModel"
                    lang={lang}
                    onReset={() => saveUser({ imageModel: null })}
                  />
                </label>
              </div>

              {/* ---- Leveling: how much of the ladder is doing work here ---- */}
              {leveling?.snapshot && (
                <>
                  <div className="settings-label" id={sectionAnchorId("leveling")}>
                    {t(lang, "leveling.settings.title")}
                  </div>
                  <div className="settings-grid">
                    <label className="settings-field">
                      <span>{t(lang, "leveling.settings.mode")}</span>
                      <select
                        value={leveling.snapshot.mode}
                        onChange={(e) =>
                          void leveling.setMode(e.target.value as "ladder" | "checklist" | "off")
                        }
                      >
                        <option value="ladder">{t(lang, "leveling.settings.mode.ladder")}</option>
                        <option value="checklist">{t(lang, "leveling.settings.mode.checklist")}</option>
                        <option value="off">{t(lang, "leveling.settings.mode.off")}</option>
                      </select>
                    </label>
                    <label className="settings-field">
                      <span>{t(lang, "leveling.settings.reset")}</span>
                      <button
                        type="button"
                        className="lvl-open-all"
                        onClick={() => {
                          if (window.confirm(t(lang, "leveling.settings.reset.confirm"))) {
                            void leveling.reset();
                          }
                        }}
                      >
                        {t(lang, "leveling.settings.reset")}
                      </button>
                    </label>
                  </div>
                </>
              )}

              {/* ---- Fleet: the two switches that were env-only (owner ask) ---- */}
              <FleetSettings anchorId={sectionAnchorId("fleet")} />

              {/* ---- Speech to text: what it needs, and the half we may fetch ---- */}
              <SttSettings anchorId={sectionAnchorId("stt")} onSave={saveUser} />

              {/* ---- Observability: the OTLP exporter (Langfuse, Jaeger, …) ---- */}
              <div className="settings-label" id={sectionAnchorId("observability")}>
                {t(lang, "set.secObservability")}
              </div>
              <p className="settings-note">{t(lang, "set.otlpHint")}</p>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>{t(lang, "set.otlpEndpoint")}</span>
                  <input
                    type="text"
                    placeholder="http://localhost:3000/api/public/otel"
                    defaultValue={String(view.effective.otlpEndpoint ?? "")}
                    onBlur={(e) => {
                      const patch = textFieldPatch(
                        "otlpEndpoint",
                        e.target.value,
                        String(view.effective.otlpEndpoint ?? ""),
                      );
                      if (patch) saveUser(patch);
                    }}
                  />
                  <OriginRow
                    view={view}
                    field="otlpEndpoint"
                    lang={lang}
                    onReset={() => saveUser({ otlpEndpoint: null })}
                  />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.otlpAuth")}</span>
                  {/* Blur alone must not write. This field is prefilled from the
                      env layer, which reads ~/.spectro/.env, the 0600 file
                      install.sh puts the pk:sk pair in. An unconditional save
                      would copy that credential into settings.json on a click
                      through the field, and the user layer outranks env, so the
                      next install.sh rotation could never take effect. */}
                  <input
                    type="text"
                    placeholder="pk-lf-… : sk-lf-…"
                    defaultValue={String(view.effective.otlpBasicAuth ?? "")}
                    onBlur={(e) => {
                      const patch = textFieldPatch(
                        "otlpBasicAuth",
                        e.target.value,
                        String(view.effective.otlpBasicAuth ?? ""),
                      );
                      if (patch) saveUser(patch);
                    }}
                  />
                  <OriginRow
                    view={view}
                    field="otlpBasicAuth"
                    lang={lang}
                    onReset={() => saveUser({ otlpBasicAuth: null })}
                  />
                </label>
              </div>

              {/* ---- Docker, read only (card 137) ----------------------------
                  Where the endpoint above comes from, for an operator who has
                  no Langfuse yet. Three states and a silent fourth: nothing is
                  rendered until the probe answers, and a server without the
                  route stays silent forever. spectroscope starts nothing here
                  — it prints a command and the operator runs it. */}
              <DockerOfferBlock status={docker} lang={lang} />

              {/* ---- Web search: the three real tiers, and the one nobody
                  chose (card 203). The block renders what the server's ONE
                  resolver decided; it does not re-derive the tier here. ---- */}
              <WebSearchSettings
                anchorId={sectionAnchorId("websearch")}
                searxngUrl={String(view.effective.searxngUrl ?? "")}
                onSave={saveUser}
                originRow={
                  <OriginRow
                    view={view}
                    field="searxngUrl"
                    lang={lang}
                    onReset={() => saveUser({ searxngUrl: null })}
                  />
                }
              />

              {/* ---- The auto-approve allowlist (card 199). What runs without
                  asking, every entry with the tier it carries. The block reads
                  GET /api/settings/allowlist and renders it; the gate's own
                  parser and the shipped tier map decide, never this page. ---- */}
              <AllowlistSettings anchorId={sectionAnchorId("allowlist")} onSave={saveUser} />

              {/* ---- The net fence (card 199). Browser-class tools take their
                  address from model output; the private world is refused, and
                  loopback costs this one deliberate gesture. ---- */}
              <div className="settings-label" id={sectionAnchorId("netfence")}>
                {t(lang, "set.secNetFence")}
              </div>
              <p className="settings-note">{t(lang, "set.netFenceHint")}</p>
              <p className="settings-note">{t(lang, "set.netFenceBrowserNote")}</p>
              <div className="settings-toggles">
                <Switch
                  label={t(lang, "set.allowLocalhost")}
                  checked={view.effective.allowLocalhost === true}
                  onChange={(v) => void saveUser({ allowLocalhost: v })}
                />
              </div>
              <p className="settings-note">{t(lang, "set.allowLocalhostNote")}</p>
              <OriginRow
                view={view}
                field="allowLocalhost"
                lang={lang}
                onReset={() => saveUser({ allowLocalhost: null })}
              />

              {/* ---- The shell hooks (card 195). The engine has run these for
                  months with no screen anywhere, so the one feature that can
                  stop an agent was configured in a file nobody was pointed at.
                  The block reads GET /api/settings/hooks and renders it; the
                  runner's own defaults decide, never this page. ---- */}
              <HooksSettings anchorId={sectionAnchorId("hooks")} onSave={saveUser} />

              {/* ---- Workspace default — server-backed (Task 13) ---- */}
              <div className="settings-label" id={sectionAnchorId("workspace")}>
                {t(lang, "set.secWorkspace")}
              </div>
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
                <OriginRow
                  view={view}
                  field="workspace"
                  lang={lang}
                  onReset={() => saveUser({ workspace: null })}
                  resetTitle={t(lang, "set.wsResetToEnv")}
                />
                <button
                  type="button"
                  className="ghost settings-forget"
                  onClick={() => void pickDefaultWorkspace()}
                >
                  {t(lang, "set.pick")}
                </button>
              </div>
              <p className="settings-note">{t(lang, "set.wsApplies")}</p>

              {/* ---- Operator logging — editable (Task 13) ---- */}
              <div className="settings-label" id={sectionAnchorId("logging")}>
                {t(lang, "set.secLogging")}
              </div>
              <label className="settings-field">
                <span>{t(lang, "set.logLevel")}</span>
                <select
                  value={String(view.effective.logLevel ?? "info")}
                  onChange={(e) => saveUser({ logLevel: e.target.value })}
                >
                  {LOG_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <OriginRow
                  view={view}
                  field="logLevel"
                  lang={lang}
                  onReset={() => saveUser({ logLevel: null })}
                />
              </label>
              <p className="settings-note">{t(lang, "set.logHint")}</p>
              <p className="settings-note">{t(lang, "set.logApplies")}</p>

              {/* ---- Machine — new in this task: browse_page/image/STT paths ---- */}
              <div className="settings-label" id={sectionAnchorId("machine")}>
                {t(lang, "set.machine")}
              </div>
              <p className="settings-note">{t(lang, "set.machineHint")}</p>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>{t(lang, "set.chrome")}</span>
                  <DraftInput
                    value={String(view.effective.chromeBinary ?? "")}
                    onCommit={(v) => saveUser({ chromeBinary: v === "" ? null : v })}
                  />
                  <OriginRow
                    view={view}
                    field="chromeBinary"
                    lang={lang}
                    onReset={() => saveUser({ chromeBinary: null })}
                  />
                </label>
                <label className="settings-field">
                  <span>{t(lang, "set.sttModel")}</span>
                  <DraftInput
                    value={String(view.effective.sttModel ?? "")}
                    onCommit={(v) => saveUser({ sttModel: v === "" ? null : v })}
                  />
                  <OriginRow
                    view={view}
                    field="sttModel"
                    lang={lang}
                    onReset={() => saveUser({ sttModel: null })}
                  />
                </label>
              </div>
            </>
          )}

          {/* ---- The built-in model's one-time notice (card 144) ----
              Every way out of that sheet dismisses it for good, so a reader
              who wants it back must be able to ask for it deliberately. */}
          {onShowLocalNotice && (
            <>
              <div className="settings-label">{t(lang, "set.secLocalNotice")}</div>
              <p className="settings-note">{t(lang, "set.localNoticeHint")}</p>
              <div className="settings-ws">
                <button type="button" className="ghost" onClick={onShowLocalNotice}>
                  {t(lang, "set.localNoticeShow")}
                </button>
              </div>
            </>
          )}

          {/* ---- Skills + MCP managers (card 90) ---- */}
          <SkillsSettings />
          <McpSettings />
        </div>
      </section>
    </div>
  );
}
