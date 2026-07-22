// Shared brain of the provider chooser, used by BOTH the header picker
// (ProviderPicker) and the Settings "session defaults" section. It carries the
// good parts once: a REAL model list from GET /api/models, an honest needs-key
// affordance, the local-backend model snap, and the "custom model …" escape
// hatch. The two hosts differ only in how they treat a missing key —
//   - Settings ("inline"): paste the key right here, saved to ~/.spectro/.env.
//   - Header picker ("link"): no key entry — a pointer to the real Settings.
// so the key write lives in exactly one place (owner decision).

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { modelFieldMode, pickModel, type ModelFieldMode } from "./providerPickerMode";

/** Sentinel option that reveals the free-text "custom model" input. */
const CUSTOM = "__custom__";

/**
 * Fetch a provider's model list from /api/models and derive the field mode.
 * A LOCAL backend's list is authoritative, so `autoPick` snaps a stale
 * cross-provider selection (e.g. opus carried over to ollama) to the first real
 * model — the header picker wants that; Settings does not (it must never write a
 * default the operator didn't choose). Refetches whenever the provider changes.
 */
export function useProviderModels(
  provider: string,
  providerStatus: Record<string, string> | undefined,
  opts: { model: string; onModelChange: (m: string) => void; autoPick: boolean },
): { models: string[]; mode: ModelFieldMode } {
  const { model, onModelChange, autoPick } = opts;
  const [models, setModels] = useState<string[]>([]);

  // The fetch resolves AFTER the host may have re-seeded `model` (the header
  // picker sets the current model in a separate effect on open). Reading these
  // from the render closure would snap against a stale (often empty) model and
  // clobber the real current one — so read them fresh from a ref at resolve time.
  const latest = useRef({ model, onModelChange, autoPick, providerStatus });
  latest.current = { model, onModelChange, autoPick, providerStatus };

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    let alive = true;
    fetch(`/api/models?provider=${encodeURIComponent(provider)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive || !Array.isArray(list)) return;
        const ms = list.filter((m) => typeof m === "string");
        setModels(ms);
        const { model: cur, onModelChange: change, autoPick: snap, providerStatus: status } = latest.current;
        if (snap) {
          const picked = pickModel(cur, ms, status?.[provider] === "local");
          if (picked !== cur) change(picked);
        }
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
    // provider drives the fetch; model/callbacks are read fresh from `latest` so a
    // snap can't loop back into another fetch and can't act on a stale model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return { models, mode: modelFieldMode(provider, providerStatus, models) };
}

/**
 * The model control: a real dropdown when the list is known, free text when it
 * isn't, and — when an API provider has no key — either an inline key entry or a
 * pointer to Settings, per `keyAffordance`. `custom` is owned locally so the
 * "custom model …" input can appear without lifting UI state into the host.
 */
export function ModelField({
  provider,
  models,
  mode,
  model,
  onModelChange,
  providerStatus,
  keyAffordance,
  onKeySaved,
  onOpenSettings,
  onEnter,
}: {
  provider: string;
  models: string[];
  mode: ModelFieldMode;
  model: string;
  onModelChange: (m: string) => void;
  providerStatus?: Record<string, string>;
  keyAffordance: "inline" | "link";
  onKeySaved?: () => void;
  onOpenSettings?: () => void;
  onEnter?: () => void;
}) {
  const lang = useLang();
  const [custom, setCustom] = useState(false);

  // Switching provider clears the custom-input mode — the previous provider's
  // free-text entry must not linger over the new provider's real list.
  useEffect(() => {
    setCustom(false);
  }, [provider]);

  if (mode === "needs-key") {
    return keyAffordance === "inline" ? (
      <KeyInput provider={provider} onSaved={onKeySaved} />
    ) : (
      <NeedsKeyLink onOpenSettings={onOpenSettings} />
    );
  }

  if (mode === "list") {
    // The seeded/current model is always selectable, even when the fetched list
    // doesn't carry it — the selection must show reality, never lie.
    const options = model !== "" && !custom && !models.includes(model) ? [model, ...models] : models;
    return (
      <>
        <select
          className="provider-select"
          value={custom ? CUSTOM : model}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
              onModelChange("");
            } else {
              setCustom(false);
              onModelChange(e.target.value);
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
        {custom && (
          <input
            className="provider-input"
            type="text"
            autoFocus
            value={model}
            placeholder={t(lang, "pp.customPh")}
            onChange={(e) => onModelChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onEnter?.();
            }}
          />
        )}
      </>
    );
  }

  // freetext: no list (backend down / unreachable) — free text, honestly labelled.
  return (
    <>
      <input
        className="provider-input"
        type="text"
        value={model}
        placeholder={t(lang, "pp.keepPh")}
        onChange={(e) => onModelChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter?.();
        }}
      />
      <span className="provider-field-note">
        {t(lang, providerStatus?.[provider] === "local" ? "pp.localDown" : "pp.noList")}
      </span>
    </>
  );
}

/** The needs-key affordance for the header picker: no key entry here — the key
 *  write lives only in Settings, so this points there. */
function NeedsKeyLink({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const lang = useLang();
  return (
    <div className="pp-keyinput">
      <span className="provider-field-note provider-field-note--warn">{t(lang, "pp.needsKey")}</span>
      <button type="button" className="provider-settings-link" onClick={onOpenSettings}>
        {t(lang, "pp.setInSettings")}
      </button>
    </div>
  );
}

/** Paste an API key and save it to ~/.spectro/.env (0600) via the local-origin
 *  endpoint. Masked; the value only ever leaves as the POST body. On success the
 *  host re-reads /api/config so the provider flips needs-key → ready — no
 *  restart, a new chat uses it. Lives here so Settings owns the one key write. */
export function KeyInput({ provider, onSaved }: { provider: string; onSaved?: () => void }) {
  const lang = useLang();
  const de = lang === "de";
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "ok" | "err">("idle");

  const save = async (): Promise<void> => {
    if (key.trim() === "") return;
    setState("saving");
    try {
      const res = await fetch("/api/onboarding/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key: key.trim() }),
      });
      if (res.ok) {
        setState("ok");
        setKey("");
        onSaved?.();
      } else {
        setState("err");
      }
    } catch {
      setState("err");
    }
  };

  return (
    <div className="pp-keyinput">
      <span className="provider-field-note provider-field-note--warn">{t(lang, "pp.needsKey")}</span>
      <div className="pp-keyrow">
        <input
          className="provider-input"
          type="password"
          autoComplete="off"
          value={key}
          placeholder={de ? "api-key hier einfügen" : "paste your api key"}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button
          type="button"
          className="primary pp-keysave"
          disabled={state === "saving" || key.trim() === ""}
          onClick={() => void save()}
        >
          {t(lang, state === "saving" ? "pp.keySaving" : "pp.keySave")}
        </button>
      </div>
      {state === "ok" && <span className="provider-field-note">{t(lang, "pp.keySaved")}</span>}
      {state === "err" && (
        <span className="provider-field-note provider-field-note--warn">{t(lang, "pp.keyErr")}</span>
      )}
    </div>
  );
}
