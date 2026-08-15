// The three-dots disclosure-level menu (card 78 #4): normal | extended |
// thinking, one radio-style row each. It is mounted ONCE (Chat.tsx builds it
// above the composer branch) and rendered at the left of whichever bar is on
// screen, the live one or the archive one, because a stored session is read
// with these settings too. It used to be mounted twice; the second copy sat in
// a row floating over the first chat message, and that row is gone (owner,
// 2026-08-03: "das ist haesslich"). With it went the downward placement, so
// the popover no longer needs to be told which way to open.
//
// Popover mechanics (outside click, Escape, arrow keys) mirror ComposerGear;
// the wsg-* classes carry the look. State is the persisted store in
// state/disclosure.ts, so the composer twin of any future copy cannot disagree.

import { useEffect, useRef, useState } from "react";
import type { KeyboardEventHandler, ReactNode } from "react";
import { DISCLOSURE_LEVELS, setDisclosure, useDisclosure } from "../state/disclosure";
import { CHAT_WIDTHS, setChatWidth, useChatWidth } from "../state/chatWidth";
import { CHAT_VIEW_MODES, setChatView, useChatView } from "../state/chatView";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export interface DisclosureMenuProps {
  /** Card 243: the tools chips' fold-away home. The chat hands the SAME
   *  controls it renders in the action row (export, translation, the folder
   *  buttons); CSS shows exactly one of the two copies — the row above the
   *  composer container's fold threshold, this section below it
   *  (modal-composer.css owns the threshold). Absent on an empty chat, where
   *  the row itself withholds the tools. */
  fold?: ReactNode;
}

export function DisclosureMenu({ fold }: DisclosureMenuProps = {}) {
  const lang = useLang();
  const level = useDisclosure();
  const width = useChatWidth();
  const chatView = useChatView();
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
        <div className="wsg-pop disc-pop" role="dialog" aria-label={t(lang, "disc.title")}>
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

          {/* chat-v2 (PROTOTYPE): which reading of the transcript is on screen.
              It belongs in this menu and not in the tab bar, because the tab
              bar's entries are different FOLDS of the stream and this is a
              different reading of one of them. Default stays v1. */}
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "work.mode")}</span>
              <span className="wsg-proto">{t(lang, "work.proto")}</span>
            </div>
            <div className="wsg-modes" role="group" aria-label={t(lang, "work.mode")}>
              {CHAT_VIEW_MODES.map((m) => (
                <div
                  key={m}
                  role="menuitemradio"
                  aria-checked={chatView === m}
                  className={`wsg-mode-row${chatView === m ? " wsg-mode-row--active" : ""}`}
                  onClick={() => setChatView(m)}
                >
                  <span className="wsg-mode-marker" aria-hidden="true">
                    {chatView === m ? "›" : ""}
                  </span>
                  <span className="wsg-mode-body">
                    <span className="wsg-mode-name mono">{t(lang, `work.${m}`)}</span>
                    <span className="wsg-mode-hint">{t(lang, `work.${m}.hint`)}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Card 243: the folded tools. Hidden by default; the composer
              container's fold threshold shows it while hiding the row's copy
              (modal-composer.css) — never both at once. */}
          {fold !== undefined && (
            <div className="wsg-section disc-fold">
              <div className="wsg-section-head">
                <span>{t(lang, "chat.tools")}</span>
              </div>
              {fold}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
