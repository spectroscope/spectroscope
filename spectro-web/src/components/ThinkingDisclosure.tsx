// Collapsible reasoning panel above an assistant answer. Collapsed by default
// on level "normal"; the disclosure level (card 78 #4) opens it by default on
// "extended" and "thinking" — a manual click on THIS card overrides the level
// until the card unmounts, and a level switch re-defaults untouched cards.
// While the model is still thinking the header pulses ("thinking…") — that IS
// the live indicator, no separate element. Once settled it shows a char count.

import { useEffect, useRef, useState } from "react";
import { defaultOpen, useDisclosure } from "../state/disclosure";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { beacon } from "../state/levelingBeacon";

/** This close to the body's bottom edge counts as "following the stream". */
const FOLLOW_PIN_THRESHOLD_PX = 32;

export function ThinkingDisclosure(props: { text: string; active: boolean }) {
  const level = useDisclosure();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? defaultOpen(level, "thinking");
  const lang = useLang();

  // Card 78 #5: while the block is OPEN and still STREAMING, the body follows
  // the live edge (the owner's "nach 20 Zeilen essig" — the box is 240 px and
  // used to just stop). Same pinning as the chat scroll: the position decides,
  // recomputed on every scroll event — a programmatic jump lands at the bottom
  // and stays pinned, a reader scrolling up releases it, returning re-engages.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const handleScroll = (): void => {
    const el = bodyRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PIN_THRESHOLD_PX;
  };

  // Opened mid-stream: start at the live edge (a settled block opens at the
  // top for reading — only the active stream jumps). Guarded on the OPEN
  // transition alone: an interleaved stream flipping back to thinking must
  // not yank a reader who scrolled up during the answer segment (review
  // find F6) — scrolling back to the bottom re-engages the follow instead.
  const prevOpen = useRef(false);
  useEffect(() => {
    const el = bodyRef.current;
    const justOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (!justOpened || !props.active || el === null) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [open, props.active]);

  // Follow growth while streaming — instant, no smooth (no scroll jitter).
  useEffect(() => {
    const el = bodyRef.current;
    if (!open || !props.active || !pinnedRef.current || el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [props.text, open, props.active]);

  return (
    <div className={`thinking${props.active ? " thinking--active" : ""}`}>
      <button
        type="button"
        className="thinking-head"
        aria-expanded={open}
        onClick={() => {
          setManual(!open);
          // Expanding is the act the ladder watches; collapsing again is not.
          if (!open) beacon("disclosure");
        }}
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
      {open && (
        <div className="thinking-body" ref={bodyRef} onScroll={handleScroll}>
          {props.text}
        </div>
      )}
    </div>
  );
}
