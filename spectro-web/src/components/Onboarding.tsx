// First-run onboarding — a one-time info sheet shown when a fresh install has no
// backend ready yet. It does not configure anything (settings stay a config/env
// decision); it just tells a newcomer the two zero-cost local paths (ollama, LM
// Studio) and how to add a cloud key to .env, so the very first screen is not
// "Opus is selected and nothing works". Modelled on the keymap overlay: same
// km-backdrop / km-panel, Esc / × / backdrop to close. Bilingual, tokens only.

import type { ReactNode } from "react";
import { useLang } from "../state/lang";

/** One backend option row. */
function Option(props: { badge: string; free: boolean; title: string; body: ReactNode }) {
  const de = useLang() === "de";
  return (
    <li className="ob-opt">
      <div className="ob-opt-head">
        <span className="ob-opt-badge mono">{props.badge}</span>
        <span className="ob-opt-title">{props.title}</span>
        <span className={`ob-opt-tag${props.free ? " ob-opt-tag--free" : ""}`}>
          {props.free ? (de ? "kostenlos, lokal" : "free, local") : (de ? "braucht einen key" : "needs a key")}
        </span>
      </div>
      <p className="ob-opt-body">{props.body}</p>
    </li>
  );
}

export function Onboarding(props: { open: boolean; onClose: () => void }) {
  const de = useLang() === "de";
  if (!props.open) return null;
  return (
    <div className="km-backdrop" onClick={props.onClose} role="presentation">
      <div
        className="km-panel ob-panel"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "erste schritte" : "getting started"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="km-head">
          <span className="km-title">{de ? "willkommen — wähl ein backend" : "welcome — pick a backend"}</span>
          <button type="button" className="km-close" onClick={props.onClose} aria-label={de ? "schließen" : "close"}>
            ×
          </button>
        </div>

        <p className="ob-intro">
          {de
            ? "spectroscope spricht mit einem LLM — such dir eins aus. Die lokalen sind kostenlos, die Cloud-Anbieter brauchen einen API-Key."
            : "spectroscope talks to an LLM — choose one. The local backends are free; the cloud ones need an API key."}
        </p>

        <ul className="ob-opts">
          <Option
            badge="ollama"
            free
            title={de ? "lokal, kostenlos" : "local, free"}
            body={
              de ? (
                <>installier <a href="https://ollama.com" target="_blank" rel="noreferrer">ollama</a>, dann <code>ollama pull qwen3</code> (oder ein anderes Modell). spectroscope spricht mit ihm auf <code>:11434</code>.</>
              ) : (
                <>install <a href="https://ollama.com" target="_blank" rel="noreferrer">ollama</a>, then <code>ollama pull qwen3</code> (or any model). spectroscope talks to it on <code>:11434</code>.</>
              )
            }
          />
          <Option
            badge="lmstudio"
            free
            title="LM Studio"
            body={
              de ? (
                <>lad <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">LM Studio</a>, lade ein Modell, starte den Server (<code>:1234</code>) und wähl oben den Anbieter <code>lmstudio</code>.</>
              ) : (
                <>download <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">LM Studio</a>, load a model, start its server (<code>:1234</code>), then pick provider <code>lmstudio</code> in the header.</>
              )
            }
          />
          <Option
            badge="cloud"
            free={false}
            title={de ? "anthropic · openai · openrouter" : "anthropic · openai · openrouter"}
            body={
              de ? (
                <>trag deinen Key in eine <code>.env</code> neben spectroscope: <code>ANTHROPIC_API_KEY=…</code> (oder <code>OPENAI_API_KEY</code> / <code>OPENROUTER_API_KEY</code>) und starte neu.</>
              ) : (
                <>add your key to a <code>.env</code> next to spectroscope: <code>ANTHROPIC_API_KEY=…</code> (or <code>OPENAI_API_KEY</code> / <code>OPENROUTER_API_KEY</code>), then restart.</>
              )
            }
          />
        </ul>

        <div className="ob-foot">
          <p className="ob-foot-note">
            {de
              ? "du kannst das jederzeit oben am Anbieter-Chip ändern."
              : "you can change this any time from the provider chip in the header."}
          </p>
          <button type="button" className="primary" onClick={props.onClose}>
            {de ? "los geht's" : "got it"}
          </button>
        </div>
      </div>
    </div>
  );
}
