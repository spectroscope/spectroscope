// The header provider picker: the connection/provider chip is a button that opens
// a small popover to switch the LLM backend (anthropic / ollama / openai / …) and
// its model mid-session. Sends set_provider; the switch applies on the next prompt.
//
// The model field is a REAL dropdown (owner decision) fed by GET /api/models —
// see providerModelField.tsx for the shared brain. When a provider needs a key,
// this picker does NOT take one: the key write lives only in Settings, so it
// points there instead (owner decision).

import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "../transport/ws";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { PROVIDERS } from "./providerPickerMode";
import { ModelField, useProviderModels } from "./providerModelField";

export function ProviderPicker({
  provider,
  model: activeModel,
  status,
  providerStatus,
  onApply,
  onOpenSettings,
}: {
  provider: string;
  /** The current model, so the chip shows it and the form prefills the real one. */
  model?: string;
  status: ConnectionStatus;
  /** Per-provider onboarding status from /api/config: ready | needs-key | local.
   *  Drives the honest 'no key' affordance instead of a fake list. */
  providerStatus?: Record<string, string>;
  onApply: (provider: string, model: string) => void;
  /** Open the Settings panel — the needs-key affordance points there, since the
   *  key write lives only in Settings. */
  onOpenSettings?: () => void;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(provider);
  const [model, setModel] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // Opening seeds the form from the active provider and the real current model.
  useEffect(() => {
    if (open) {
      setSel(provider);
      setModel(activeModel || "");
    }
  }, [open, provider, activeModel]);

  // Shared model list + field mode; autoPick snaps a stale local model.
  const { models, mode } = useProviderModels(open ? sel : "", providerStatus, {
    model,
    onModelChange: setModel,
    autoPick: true,
  });

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
            <ModelField
              provider={sel}
              models={models}
              mode={mode}
              model={model}
              onModelChange={setModel}
              providerStatus={providerStatus}
              keyAffordance="link"
              onOpenSettings={() => {
                setOpen(false);
                onOpenSettings?.();
              }}
              onEnter={apply}
            />
          </label>
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
