// First-run onboarding — a one-time info sheet shown when a fresh install has no
// backend ready yet. It does not configure anything (settings stay a config/env
// decision); it just tells a newcomer the zero-cost local paths (ollama, LM
// Studio, llama.cpp) and how to add a cloud key to .env, so the very first screen is not
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
          {props.free ? (de ? "kostenlos, lokal" : "free, local") : de ? "braucht einen key" : "needs a key"}
        </span>
      </div>
      <p className="ob-opt-body">{props.body}</p>
    </li>
  );
}

export function Onboarding(props: {
  open: boolean;
  onClose: () => void;
  /** "start with the built-in model": closes the sheet and opens the local
   *  chooser — the zero-install path a newcomer should meet first. */
  onStartLocal?: () => void;
  /** Card 193: the reader whose local backend runs on another machine —
   *  closes the sheet and opens Settings at the session defaults, where the
   *  address field sits beside the provider. */
  onOpenSettings?: () => void;
}) {
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
          <span className="km-title">
            {de ? "willkommen — wähl ein backend" : "welcome — pick a backend"}
          </span>
          <button
            type="button"
            className="km-close"
            onClick={props.onClose}
            aria-label={de ? "schließen" : "close"}
          >
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
            badge="built-in"
            free
            title={de ? "nichts installieren" : "install nothing"}
            body={
              de ? (
                <>
                  spectroscope bringt einen eigenen Weg mit: ein Modell aussuchen, herunterladen, fertig — es
                  läuft komplett auf dieser Maschine, ohne Key und ohne Konto. Die Desktop-App bringt alles
                  mit; beim Server-Jar sagt dir die Auswahl, falls noch <code>llama.cpp</code> fehlt.{" "}
                  {props.onStartLocal && (
                    <button type="button" className="ob-opt-cta" onClick={props.onStartLocal}>
                      Modell wählen …
                    </button>
                  )}
                </>
              ) : (
                <>
                  spectroscope carries its own path: pick a model, download it, done — it runs entirely on
                  this machine, with no key and no account. The desktop app brings everything it needs; with
                  the server jar the chooser tells you if <code>llama.cpp</code> is still missing.{" "}
                  {props.onStartLocal && (
                    <button type="button" className="ob-opt-cta" onClick={props.onStartLocal}>
                      Choose a model …
                    </button>
                  )}
                </>
              )
            }
          />
          <Option
            badge="ollama"
            free
            title={de ? "lokal, kostenlos" : "local, free"}
            body={
              de ? (
                <>
                  installier{" "}
                  <a href="https://ollama.com" target="_blank" rel="noreferrer">
                    ollama
                  </a>
                  , dann <code>ollama pull qwen3</code> (oder ein anderes Modell). spectroscope spricht mit
                  ihm auf <code>:11434</code>.
                </>
              ) : (
                <>
                  install{" "}
                  <a href="https://ollama.com" target="_blank" rel="noreferrer">
                    ollama
                  </a>
                  , then <code>ollama pull qwen3</code> (or any model). spectroscope talks to it on{" "}
                  <code>:11434</code>.
                </>
              )
            }
          />
          <Option
            badge="lmstudio"
            free
            title="LM Studio"
            body={
              de ? (
                <>
                  lad{" "}
                  <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">
                    LM Studio
                  </a>
                  , lade ein Modell, starte den Server (<code>:1234</code>) und wähl oben den Anbieter{" "}
                  <code>lmstudio</code>.
                </>
              ) : (
                <>
                  download{" "}
                  <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">
                    LM Studio
                  </a>
                  , load a model, start its server (<code>:1234</code>), then pick provider{" "}
                  <code>lmstudio</code> in the header.
                </>
              )
            }
          />
          <Option
            badge="llamacpp"
            free
            title="llama.cpp"
            body={
              de ? (
                <>
                  hol dir{" "}
                  <a href="https://github.com/ggml-org/llama.cpp" target="_blank" rel="noreferrer">
                    llama.cpp
                  </a>
                  , starte <code>llama-server -m dein-modell.gguf</code> (Port <code>:8080</code>) und wähl
                  oben den Anbieter <code>llamacpp</code>. Er bedient genau das Modell, mit dem er gestartet
                  wurde — der Name oben ist eine Beschriftung, keine Auswahl.
                </>
              ) : (
                <>
                  get{" "}
                  <a href="https://github.com/ggml-org/llama.cpp" target="_blank" rel="noreferrer">
                    llama.cpp
                  </a>
                  , run <code>llama-server -m your-model.gguf</code> (it listens on <code>:8080</code>), then
                  pick provider <code>llamacpp</code> in the header. It serves the one model it was started
                  with — the name above is a label, not a chooser.
                </>
              )
            }
          />
          <Option
            badge="cloud"
            free={false}
            title={de ? "anthropic · openai · openrouter" : "anthropic · openai · openrouter"}
            body={
              de ? (
                <>
                  trag deinen Key in eine <code>.env</code> neben spectroscope:{" "}
                  <code>ANTHROPIC_API_KEY=…</code> (oder <code>OPENAI_API_KEY</code> /{" "}
                  <code>OPENROUTER_API_KEY</code>) und starte neu.
                </>
              ) : (
                <>
                  add your key to a <code>.env</code> next to spectroscope: <code>ANTHROPIC_API_KEY=…</code>{" "}
                  (or <code>OPENAI_API_KEY</code> / <code>OPENROUTER_API_KEY</code>), then restart.
                </>
              )
            }
          />
        </ul>

        {/* Card 193: the first-run reader with the GPU box across the room is
            exactly the person the local options just spoke to — say where the
            address goes before they conclude "local machine only". Card 312
            added a third backend with an address of its own; a sentence that
            names two of three sends the third reader away. */}
        {props.onOpenSettings && (
          <p className="ob-remote">
            {de ? (
              <>
                ollama, LM Studio oder llama.cpp laufen auf einer anderen Maschine? trag die Adresse in den{" "}
                <button type="button" className="ob-opt-cta" onClick={props.onOpenSettings}>
                  Einstellungen
                </button>{" "}
                ein — das Feld liegt direkt neben dem Anbieter.
              </>
            ) : (
              <>
                ollama, LM Studio or llama.cpp running on another machine? put its address in{" "}
                <button type="button" className="ob-opt-cta" onClick={props.onOpenSettings}>
                  settings
                </button>{" "}
                — the field sits right beside the provider.
              </>
            )}
          </p>
        )}

        <div className="ob-foot">
          <p className="ob-foot-note">
            {de
              ? "du kannst das jederzeit oben am Anbieter-Chip ändern."
              : "you can change this any time from the provider chip in the header."}
          </p>
          <button type="button" className="soft-primary" onClick={props.onClose}>
            {de ? "los geht's" : "got it"}
          </button>
        </div>
      </div>
    </div>
  );
}
