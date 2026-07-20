// Collapsible reasoning panel above an assistant answer. Collapsed by default;
// while the model is still thinking the header pulses ("thinking…") — that IS
// the live indicator, no separate element. Once settled it shows a char count.

import { useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function ThinkingDisclosure(props: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  const lang = useLang();
  return (
    <div className={`thinking${props.active ? " thinking--active" : ""}`}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          className="thinking-glyph"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {/* A simple thought/brain glyph — no emoji. */}
          <path d="M10 2.6a3 3 0 0 1 2.5 4.5A2.6 2.6 0 0 1 11 12a3 3 0 0 1-6 0 2.6 2.6 0 0 1-1.5-4.9A3 3 0 0 1 6 2.6a2.4 2.4 0 0 1 4 0Z" />
          <path d="M8 4.5v7" />
        </svg>
        <span className="thinking-label">Thinking</span>
        {props.active ? (
          <span className="thinking-live">
            <span className="thinking-dot" aria-hidden="true" />
            {t(lang, "chat.thinkingLive")}
          </span>
        ) : (
          <span className="thinking-meta tabular">{t(lang, "chat.chars", { n: props.text.length })}</span>
        )}
        <svg
          className={`thinking-caret${open ? " thinking-caret--open" : ""}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      {open && <div className="thinking-body">{props.text}</div>}
    </div>
  );
}
