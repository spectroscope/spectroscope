// The three-dots disclosure-level menu (card 78 #4): normal | extended |
// thinking, one radio-style row each. Lives twice — top-right corner of the
// chat (opens downward) and left of the composer toolbox (opens upward).
// Both instances drive the same persisted store (state/disclosure.ts), so
// they can never disagree. Popover mechanics (outside click, Escape, arrow
// keys) mirror ComposerGear; the wsg-* classes carry the look.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEventHandler } from "react";
import { DISCLOSURE_LEVELS, setDisclosure, useDisclosure } from "../state/disclosure";
import { CHAT_WIDTHS, setChatWidth, useChatWidth } from "../state/chatWidth";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export function DisclosureMenu({ placement }: { placement: "up" | "down" }) {
  const lang = useLang();
  const level = useDisclosure();
  const width = useChatWidth();
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keyboard focus starts on the active level each time the menu opens — and
  // the list itself takes focus, so the arrow keys work immediately (a menu
  // button that opens without moving focus strands keyboard users).
  useEffect(() => {
    if (!open) return;
    const at = DISCLOSURE_LEVELS.findIndex((l) => l === level);
    setFocusIdx(at < 0 ? 0 : at);
    listRef.current?.focus();
  }, [open, level]);

  // Close on outside click / Escape — same mechanics as ComposerGear.
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

  const choose = (next: (typeof DISCLOSURE_LEVELS)[number]): void => {
    setDisclosure(next);
    setOpen(false);
  };

  const onListKeyDown: KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(DISCLOSURE_LEVELS.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = DISCLOSURE_LEVELS[focusIdx];
      if (picked !== undefined) choose(picked);
    }
  };

  return (
    <div className="wsg-anchor disc-anchor" ref={ref}>
      <button
        type="button"
        className="icon-button attach-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t(lang, "disc.title")}
        title={t(lang, "disc.title")}
        onClick={() => setOpen((o) => !o)}
      >
        {/* A vertical three-dots kebab — the menu affordance, no emoji. */}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="8" cy="13" r="1.3" />
        </svg>
      </button>

      {open && (
        <div
          className={`wsg-pop disc-pop${placement === "down" ? " disc-pop--down" : ""}`}
          role="dialog"
          aria-label={t(lang, "disc.title")}
        >
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "disc.title")}</span>
            </div>
            <div
              className="wsg-modes"
              role="menu"
              aria-label={t(lang, "disc.title")}
              tabIndex={0}
              ref={listRef}
              onKeyDown={onListKeyDown}
            >
              {DISCLOSURE_LEVELS.map((l, i) => (
                <div
                  key={l}
                  role="menuitemradio"
                  aria-checked={level === l}
                  className={`wsg-mode-row${i === focusIdx ? " wsg-mode-row--focus" : ""}${level === l ? " wsg-mode-row--active" : ""}`}
                  onMouseEnter={() => setFocusIdx(i)}
                  onClick={() => choose(l)}
                >
                  <span className="wsg-mode-marker" aria-hidden="true">
                    {level === l ? "›" : ""}
                  </span>
                  <span className="wsg-mode-body">
                    <span className="wsg-mode-name mono">{l}</span>
                    <span className="wsg-mode-hint">{t(lang, `disc.${l}.hint`)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Owner 2026-07-25: the reading width lives in the same menu — how
              wide the text column may run, not a forced width. */}
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "width.title")}</span>
            </div>
            <div className="wsg-modes" role="group" aria-label={t(lang, "width.title")}>
              {CHAT_WIDTHS.map((w) => (
                <div
                  key={w}
                  role="menuitemradio"
                  aria-checked={width === w}
                  className={`wsg-mode-row${width === w ? " wsg-mode-row--active" : ""}`}
                  onClick={() => setChatWidth(w)}
                >
                  <span className="wsg-mode-marker" aria-hidden="true">
                    {width === w ? "\u203A" : ""}
                  </span>
                  <span className="wsg-mode-body">
                    <span className="wsg-mode-name mono">{t(lang, `width.${w}`)}</span>
                    <span className="wsg-mode-hint">{t(lang, `width.${w}.hint`)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
