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
import { setLiveTraceWanted, useLiveTraceWanted } from "../state/liveTrace";
import { dismissesMenu, MODAL_LAYER } from "./menuDismiss";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export interface DisclosureMenuProps {
  /** The session tools' home (card 243, sole home since card 255): export, the
   *  translation trigger, the folder buttons. The chat builds them once and
   *  hands the same nodes to its action row and to this section; the row's copy
   *  is suppressed at every width (modal-composer.css), so this is the copy a
   *  reader reaches. Absent on an empty chat, where the chat has no tools to
   *  hand over — a section head over nothing is worse than no section. */
  fold?: ReactNode;
}

export function DisclosureMenu({ fold }: DisclosureMenuProps = {}) {
  const lang = useLang();
  const level = useDisclosure();
  const width = useChatWidth();
  const chatView = useChatView();
  const liveTrace = useLiveTraceWanted();
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

  // Close on outside click / Escape — same mechanics as ComposerGear, plus the
  // modal question card 255 had to add: the tools section opens sheets, and
  // TranslatePanel portals its sheet to the body, so every press in it is
  // "outside" this anchor. Closing here unmounts the section, the sheet with
  // it, and the press never becomes a click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const press = {
        inAnchor: ref.current !== null && ref.current.contains(target),
        inModal: target !== null && target.closest(MODAL_LAYER) !== null,
      };
      if (dismissesMenu(press)) setOpen(false);
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
          {/* The session tools. Card 243 showed this section only below the
              composer column's 500px threshold and put it last, under four
              reading settings; card 255 dropped the threshold and made it the
              only home export and translation have, so it moved to the top.
              Measured at 1440x900 while it still sat last: the popover caps at
              480px against 828px of content, and the section's box started
              333px below the visible edge — a home nobody reaches without
              scrolling a menu that shows no sign of holding one. */}
          {fold !== undefined && (
            <div className="wsg-section disc-fold">
              <div className="wsg-section-head">
                <span>{t(lang, "chat.tools")}</span>
              </div>
              {fold}
            </div>
          )}

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

          {/* Card 246: the live-trace switch ("das spart speicher"). OFF stops
              the CLIENT retention only — the JSONL recording and the OTLP
              export are server-side and keep running; the hint says so. */}
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "trace.live.title")}</span>
            </div>
            <div className="wsg-modes" role="group" aria-label={t(lang, "trace.live.title")}>
              <div
                role="menuitemcheckbox"
                aria-checked={liveTrace}
                className={`wsg-mode-row${liveTrace ? " wsg-mode-row--active" : ""}`}
                onClick={() => setLiveTraceWanted(!liveTrace)}
              >
                <span className="wsg-mode-marker" aria-hidden="true">
                  {liveTrace ? "›" : ""}
                </span>
                <span className="wsg-mode-body">
                  <span className="wsg-mode-name mono">
                    {t(lang, liveTrace ? "trace.live.on" : "trace.live.off")}
                  </span>
                  <span className="wsg-mode-hint">{t(lang, "trace.live.hint")}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
