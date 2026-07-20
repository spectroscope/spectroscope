// The app header, extracted from App.tsx (clean-code night job): sidebar
// toggle, eyebrow + title, and the right-side control cluster (gallery,
// right panel, thinking, language, design drawer, provider picker/chip,
// context ring, stop). Pure presentation — every piece of state stays in
// App and arrives as props; the component only knows how the header looks.

import { ContextRing } from "./ContextRing";
import { ProviderPicker } from "./ProviderPicker";
import type { ConnectionStatus } from "../transport/ws";
import type { UiState } from "../state/reducer";
import { t } from "../i18n/i18n";
import { toggleLang, useLang } from "../state/lang";

/** Shown as the provider chip until a real provider name is known. */
const FALLBACK_PROVIDER_LABEL = "spectroscope";

export function AppHeader(props: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** null = the live view; a replay id switches the eyebrow (scenario vs archive). */
  replayId: string | null;
  /** True while the live view continues a stored session (resume). */
  resumed?: boolean;
  title: string;
  /** Gallery: the toggle appears only once images exist (calm header). */
  imageCount: number;
  imagesOpen: boolean;
  onToggleImages: () => void;
  /** The right panel toggle shows only on the chat tab. */
  showPanelToggle: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  thinking: boolean;
  onToggleThinking: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  doctorOpen: boolean;
  onToggleDoctor: () => void;
  /** Live: the interactive picker. Replay: a static chip with the view's provider. */
  viewingLive: boolean;
  provider?: string;
  model?: string;
  archiveProvider?: string;
  status: ConnectionStatus;
  onApplyProvider: (provider: string, model: string) => void;
  /** Context gauge — appears with the first usage event of the view. */
  lastInputTokens: number;
  context: UiState["context"];
  running: boolean;
  onAbort: () => void;
}) {
  const lang = useLang();

  return (
    <header className="header">
      <button
        type="button"
        className="icon-button"
        aria-label={props.sidebarOpen ? t(lang, "hdr.sidebarHide") : t(lang, "hdr.sidebarShow")}
        aria-expanded={props.sidebarOpen}
        onClick={props.onToggleSidebar}
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
          <path d="M2 4h12M2 8h12M2 12h12" />
        </svg>
      </button>

      {props.replayId !== null && (
        <span className="eyebrow sand">
          {t(lang, props.replayId.startsWith("scenario:") ? "hdr.scenario" : "hdr.archive")}
        </span>
      )}
      {props.replayId === null && props.resumed === true && (
        <span className="eyebrow sand">{t(lang, "hdr.resumed")}</span>
      )}
      <h1 className="header-title" title={props.title}>
        {props.title}
      </h1>

      {props.imageCount > 0 && (
        <button
          type="button"
          className="icon-button image-toggle"
          aria-label={props.imagesOpen ? t(lang, "hdr.imagesHide") : t(lang, "hdr.imagesShow")}
          aria-expanded={props.imagesOpen}
          onClick={props.onToggleImages}
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
            <path d="M2 11l3.5-3 2.5 2 3-2.5 3 2.5" />
          </svg>
          <span className="image-toggle-count tabular" aria-hidden="true">
            {props.imageCount}
          </span>
        </button>
      )}

      {props.showPanelToggle && (
        <button
          type="button"
          className={`icon-button${props.panelOpen ? " icon-button--on" : ""}`}
          aria-label={props.panelOpen ? t(lang, "hdr.panelHide") : t(lang, "hdr.panelToggle")}
          aria-expanded={props.panelOpen}
          onClick={props.onTogglePanel}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M10 3v10" />
          </svg>
        </button>
      )}

      {/* Reasoning visibility toggle — Coral when on. */}
      <button
        type="button"
        className={`thinking-toggle${props.thinking ? " thinking-toggle--on" : ""}`}
        role="switch"
        aria-checked={props.thinking}
        aria-label={t(lang, "hdr.thinkingAria")}
        onClick={props.onToggleThinking}
      >
        <span className="thinking-toggle-label">Thinking</span>
        <span className="thinking-toggle-track" aria-hidden="true">
          <span className="thinking-toggle-knob" />
        </span>
      </button>

      {/* UI language toggle — chrome only; chats keep their own language. */}
      <button
        type="button"
        className="lang-toggle mono"
        title={t(lang, "hdr.langTitle")}
        aria-label={t(lang, "hdr.langTitle")}
        onClick={toggleLang}
      >
        {lang.toUpperCase()}
      </button>

      {/* spectro doctor — the calibration/status page. Reference-lamp glyph:
          a source dot with its emission lines. */}
      <button
        type="button"
        className={`icon-button${props.doctorOpen ? " icon-button--on" : ""}`}
        aria-label={t(lang, "hdr.doctor")}
        title={t(lang, "hdr.doctor")}
        aria-expanded={props.doctorOpen}
        onClick={props.onToggleDoctor}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="5" cy="8" r="2.2" />
          <path d="M10 4.5v7M12.5 6v4M15 7v2" />
        </svg>
      </button>

      {/* Design switcher — opens the skin/effects drawer. */}
      <button
        type="button"
        className={`icon-button${props.settingsOpen ? " icon-button--on" : ""}`}
        aria-label={t(lang, "hdr.settings")}
        aria-expanded={props.settingsOpen}
        onClick={props.onToggleSettings}
      >
        {/* A real GEAR — the button opens the settings PAGE now; the old sun
            icon read as a theme toggle and nobody found the settings. */}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {props.viewingLive ? (
        <ProviderPicker
          provider={props.provider ?? FALLBACK_PROVIDER_LABEL}
          model={props.model ?? ""}
          status={props.status}
          onApply={props.onApplyProvider}
        />
      ) : (
        <span className="provider-chip">
          <span
            className={`dot ${props.status === "open" ? "ok" : props.status === "connecting" ? "warn" : "error"}`}
            aria-hidden="true"
          />
          <span className="mono">{props.archiveProvider ?? FALLBACK_PROVIDER_LABEL}</span>
          {props.model && <span className="provider-chip-model mono">{props.model}</span>}
        </span>
      )}

      {props.lastInputTokens > 0 && (
        <ContextRing lastInputTokens={props.lastInputTokens} context={props.context} />
      )}

      {props.viewingLive && props.running && (
        <button type="button" className="stop" onClick={props.onAbort}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
          </svg>
          Stop
        </button>
      )}
    </header>
  );
}
