// spectro doctor, the web face: a calibration/status screen in the reference-
// lamp spirit — sober check rows, one per subsystem, each with its measured
// value. Mirrors the CLI's doctor where the browser can see: server API,
// socket, LLM backend, session store, settings scopes. Opens as a page over
// the app (same pattern as the settings page), re-probes on every open.

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "../transport/ws";
import type { ProviderInfo } from "../state/reducer";
import { fetchSettings, type SettingsView } from "../state/serverSettings";
import type { SessionMeta } from "../events";
import { LogPane } from "./LogPane";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

type Verdict = "ok" | "warn" | "error";

interface Check {
  key: string;
  verdict: Verdict;
  value: string;
}

export function DoctorPanel(props: {
  open: boolean;
  onClose: () => void;
  status: ConnectionStatus;
  providerInfo: ProviderInfo | null;
  permissionMode: string;
}) {
  const lang = useLang();
  const [config, setConfig] = useState<{ provider?: string; model?: string } | null | "failed">(null);
  const [settings, setSettings] = useState<SettingsView | null | "failed">(null);
  const [sessions, setSessions] = useState<number | null | "failed">(null);
  const [otlp, setOtlp] = useState<
    { configured: boolean; ok?: boolean; endpoint?: string; message?: string } | null | "failed"
  >(null);

  const { open, onClose } = props;

  // Re-probe on every open — doctor measures, it never caches.
  useEffect(() => {
    if (!open) return;
    setConfig(null);
    setSettings(null);
    setSessions(null);
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c) => setConfig(c as { provider?: string; model?: string }))
      .catch(() => setConfig("failed"));
    fetchSettings()
      .then(setSettings)
      .catch(() => setSettings("failed"));
    fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((list) => setSessions((list as SessionMeta[]).length))
      .catch(() => setSessions("failed"));
    setOtlp(null);
    fetch("/api/otlp/probe")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((p) => setOtlp(p as { configured: boolean; ok?: boolean; endpoint?: string; message?: string }))
      .catch(() => setOtlp("failed"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!props.open) return null;

  const pending = (v: unknown): boolean => v === null;
  const checks: Check[] = [
    {
      key: "doc.otlp",
      verdict:
        otlp === "failed"
          ? "error"
          : otlp === null || !otlp.configured
            ? "warn"
            : otlp.ok === true
              ? "ok"
              : "error",
      value:
        otlp === "failed"
          ? t(lang, "doc.unreachable")
          : otlp === null
            ? "…"
            : !otlp.configured
              ? t(lang, "doc.otlpOff")
              : otlp.ok === true
                ? `${t(lang, "doc.otlpOk")} · ${otlp.endpoint ?? ""}`
                : `${otlp.message ?? "?"} · ${otlp.endpoint ?? ""}`,
    },
    {
      key: "doc.api",
      verdict: config === "failed" ? "error" : "ok",
      value:
        config === "failed"
          ? t(lang, "doc.unreachable")
          : config === null
            ? "…"
            : `${config.provider ?? "?"}${config.model ? ` · ${config.model}` : ""}`,
    },
    {
      key: "doc.socket",
      verdict: props.status === "open" ? "ok" : props.status === "connecting" ? "warn" : "error",
      value: t(lang, `doc.socket.${props.status}`),
    },
    {
      key: "doc.backend",
      verdict: props.providerInfo === null ? "warn" : "ok",
      value:
        props.providerInfo === null
          ? t(lang, "doc.backendNone")
          : `${props.providerInfo.provider} · ${props.providerInfo.model || "?"} @ ${props.providerInfo.host || "?"}`,
    },
    {
      key: "doc.sessions",
      verdict: sessions === "failed" ? "error" : "ok",
      value:
        sessions === "failed"
          ? t(lang, "doc.unreachable")
          : sessions === null
            ? "…"
            : t(lang, "doc.sessionsN", { n: sessions }),
    },
    {
      key: "doc.workspace",
      verdict: settings === "failed" ? "error" : "ok",
      value:
        settings === "failed"
          ? t(lang, "doc.unreachable")
          : settings === null
            ? "…"
            : settings.effective.workspace
              ? String(settings.effective.workspace)
              : t(lang, "doc.wsTemp"),
    },
    {
      key: "doc.logging",
      verdict: "ok",
      value: settings !== null && settings !== "failed" ? String(settings.effective.logLevel ?? "info") : "…",
    },
    {
      key: "doc.mode",
      verdict: props.permissionMode === "auto" ? "warn" : "ok",
      value: props.permissionMode,
    },
  ];

  const loading = pending(config) || pending(settings) || pending(sessions);
  const healthy = !loading && checks.every((c) => c.verdict !== "error");

  return (
    <div className="settings-scrim" onClick={props.onClose}>
      <section
        className="settings-page doctor-page"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "doc.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <span className="explain-kicker mono">{t(lang, "doc.kicker")}</span>
          <span className="settings-hint mono" aria-live="polite">
            {loading ? "…" : healthy ? t(lang, "doc.healthy") : t(lang, "doc.unhealthy")}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={t(lang, "common.close")}
            onClick={props.onClose}
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
          <p className="doctor-lede">{t(lang, "doc.lede")}</p>
          <ul className="doctor-list">
            {checks.map((c) => (
              <li key={c.key} className="doctor-row">
                <span className={`dot ${c.verdict}`} aria-hidden="true" />
                <span className="doctor-label">{t(lang, c.key)}</span>
                <span className="doctor-value mono" title={c.value}>
                  {c.value}
                </span>
              </li>
            ))}
          </ul>
          {/* The live server log (card 85): tail + delta polls, WARN/ERROR
              tinted, follow-bottom while tailing. */}
          <LogPane />
          <p className="doctor-cli mono">$ spectro doctor</p>
          <p className="doctor-cli-hint">{t(lang, "doc.cliHint")}</p>
        </div>
      </section>
    </div>
  );
}
