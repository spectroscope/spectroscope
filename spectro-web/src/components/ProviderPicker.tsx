// The header provider picker: the connection/provider chip is a button that opens
// a small popover to switch the LLM backend (anthropic / ollama / openai) and its
// model mid-session. Sends set_provider; the switch applies on the next prompt.
//
// The model field is a REAL dropdown (owner decision) fed by GET /api/models —
// Ollama lists its actually-installed models live, the cloud providers a curated
// set. The current model is always selectable even when the list doesn't carry
// it, "Eigenes Modell …" reveals a free-text input for anything newer than the
// curated list, and an EMPTY list (Ollama down, no key) falls back to free text.

import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "../transport/ws";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { PROVIDERS, modelFieldMode, pickModel } from "./providerPickerMode";

const CUSTOM = "__custom__";

export function ProviderPicker({
  provider,
  model: activeModel,
  status,
  providerStatus,
  onApply,
}: {
  provider: string;
  /** The current model, so the chip shows it and the form prefills the real one. */
  model?: string;
  status: ConnectionStatus;
  /** Per-provider onboarding status from /api/config: ready | needs-key | local.
   *  Drives the honest 'no key — add it to .env' message instead of a fake list. */
  providerStatus?: Record<string, string>;
  onApply: (provider: string, model: string) => void;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(provider);
  const [model, setModel] = useState("");
  const [custom, setCustom] = useState(false);
  const [models, setModels] = useState<string[]>([]); // per-provider list for the dropdown
  const ref = useRef<HTMLDivElement>(null);

  // Opening seeds the form from the active provider and the real current model.
  useEffect(() => {
    if (open) {
      setSel(provider);
      setModel(activeModel || "");
      setCustom(false);
    }
  }, [open, provider, activeModel]);

  // The model list follows the selected provider (Ollama: live installed models;
  // cloud: curated). An empty list keeps the free-text fallback.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch(`/api/models?provider=${encodeURIComponent(sel)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        const ms = list.filter((m) => typeof m === "string");
        setModels(ms);
        // A local backend's list is its real installed models: don't leave a
        // stale cross-provider model (e.g. opus after switching to ollama)
        // pinned at the top — snap to the first real one.
        const isLocal = providerStatus?.[sel] === "local";
        setModel((cur) => pickModel(cur, ms, isLocal));
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, [open, sel]);

  // Close on outside click / Escape.
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

  const dot = status === "open" ? "ok" : status === "connecting" ? "warn" : "error";

  const apply = (): void => {
    onApply(sel, model.trim());
    setOpen(false);
  };

  // The dropdown always carries the seeded/current model, even when the
  // fetched list doesn't — the selection must show reality, never lie.
  const options = model !== "" && !custom && !models.includes(model) ? [model, ...models] : models;
  const mode = modelFieldMode(sel, providerStatus, models);

  return (
    <div className="provider-picker" ref={ref}>
      <button
        type="button"
        className="provider-chip provider-chip--button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={t(lang, "pp.chipTitle")}
      >
        <span className={`dot ${dot}`} aria-hidden="true" />
        <span className="mono">{provider}</span>
        {activeModel && <span className="provider-chip-model mono">{activeModel}</span>}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="provider-caret">
          <path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="provider-pop" role="dialog" aria-label="LLM provider">
          <label className="provider-field">
            <span className="provider-field-label">{t(lang, "pp.provider")}</span>
            <select
              className="provider-select"
              value={sel}
              onChange={(e) => {
                setSel(e.target.value);
                setModel("");
                setCustom(false);
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="provider-field">
            <span className="provider-field-label">{t(lang, "pp.model")}</span>
            {mode === "needs-key" ? (
              // An API provider with no key: no fake model list — say what to do.
              <span className="provider-field-note provider-field-note--warn">
                {t(lang, "pp.needsKey")}
              </span>
            ) : mode === "list" ? (
              <select
                className="provider-select"
                value={custom ? CUSTOM : model}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) {
                    setCustom(true);
                    setModel("");
                  } else {
                    setCustom(false);
                    setModel(e.target.value);
                  }
                }}
              >
                {options.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={CUSTOM}>{t(lang, "pp.custom")}</option>
              </select>
            ) : (
              // No list (backend down, Ollama unreachable, no key): free text
              // stays — but SAY so, or the fallback reads as a broken picker.
              <>
                <input
                  className="provider-input"
                  type="text"
                  value={model}
                  placeholder={t(lang, "pp.keepPh")}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") apply();
                  }}
                />
                <span className="provider-field-note">
                  {t(lang, providerStatus?.[sel] === "local" ? "pp.localDown" : "pp.noList")}
                </span>
              </>
            )}
          </label>
          {custom && models.length > 0 && (
            <label className="provider-field">
              <input
                className="provider-input"
                type="text"
                autoFocus
                value={model}
                placeholder={t(lang, "pp.customPh")}
                onChange={(e) => setModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                }}
              />
            </label>
          )}
          <div className="provider-pop-foot">
            <button type="button" className="primary" onClick={apply}>
              {t(lang, "pp.switch")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
