// Collapsible reasoning panel above an assistant answer. Collapsed by default
// on level "normal"; the disclosure level (card 78 #4) opens it by default on
// "extended" and "thinking" — a manual click on THIS card overrides the level
// until the card unmounts, and a level switch re-defaults untouched cards.
// While the model is still thinking the header pulses ("thinking…") — that IS
// the live indicator, no separate element. Once settled it shows a char count.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { defaultOpen, useDisclosure } from "../state/disclosure";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { beacon } from "../state/levelingBeacon";
import { isReaderScrollKey, keyPull, onScrollbar, touchPull, wheelPull } from "../state/scrollPin";
import { followsTheText, thinkingFollow } from "../state/thinkingFollow";

export function ThinkingDisclosure(props: { text: string; active: boolean }) {
  const level = useDisclosure();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? defaultOpen(level, "thinking");
  const lang = useLang();

  // Card 78 #5: while the block is OPEN and still STREAMING, the body follows
  // the live edge (the owner's "nach 20 Zeilen essig": the box has a ceiling
  // and used to just stop there). Card 400: who moved the body decides, by the
  // transcript's rule (state/thinkingFollow.ts on top of state/scrollPin.ts).
  // A reader's wheel, touch, press or scrolling key is heard as a gesture; a
  // scroll event with no gesture behind it is this component's own jump and
  // leaves the follow as it is.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [follow] = useState(() => thinkingFollow(() => performance.now()));

  const handleScroll = (): void => {
    const el = bodyRef.current;
    if (el !== null) follow.scrolled(el);
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    follow.gesture(e.currentTarget, wheelPull(e.deltaY));
  };
  /** Where the finger was at the last touchmove, so the next one has a direction. */
  const lastTouchY = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>): void => {
    lastTouchY.current = e.touches[0]?.clientY ?? null;
    follow.gesture(e.currentTarget, "unknown");
  };
  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>): void => {
    const y = e.touches[0]?.clientY ?? null;
    const from = lastTouchY.current;
    lastTouchY.current = y;
    follow.gesture(e.currentTarget, from === null || y === null ? "unknown" : touchPull(y - from));
  };
  /** Whether the reader's last press landed in this body: the keys scroll the
   *  box the last press sits in, and the body takes no focus of its own. */
  const pressedInside = useRef(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    pressedInside.current = true;
    const grabbed = onScrollbar(e.clientX, el.getBoundingClientRect().left, el.clientWidth);
    follow.gesture(el, grabbed ? "grab" : "unknown");
  };

  // The keys, while the follow matters: a press elsewhere hands them back, and
  // a press from before the stream started does not count.
  useEffect(() => {
    if (!open || !props.active) return;
    pressedInside.current = false;
    const onDown = (e: PointerEvent): void => {
      const el = bodyRef.current;
      if (el === null || !(e.target instanceof Node) || !el.contains(e.target)) pressedInside.current = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      const el = bodyRef.current;
      if (el === null || !pressedInside.current) return;
      const target = e.target as HTMLElement | null;
      // A key aimed at a focused control (a button, the composer) scrolls
      // nothing here, as Chat's own key rule reads it for the transcript.
      const aimed = target === null || target === document.body || el.contains(target);
      const inEditable =
        target !== null && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
      if (aimed && isReaderScrollKey(e.key, inEditable)) follow.gesture(el, keyPull(e.key));
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, props.active, follow]);

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
    follow.opened(el);
  }, [open, props.active, follow]);

  // Follow growth while streaming, and on the change that ends the stream.
  // Instant, no smooth (no scroll jitter). A layout effect, as Chat's follow
  // is since card 399: the jump lands before the browser paints the new lines.
  const wasActive = useRef(false);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const answered = followsTheText({ open, active: props.active, wasActive: wasActive.current });
    wasActive.current = props.active;
    if (!answered || el === null) return;
    follow.grew(el);
  }, [props.text, open, props.active, follow]);

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
        <div
          className="thinking-body"
          ref={bodyRef}
          onScroll={handleScroll}
          onWheel={onWheel}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onPointerDown={onPointerDown}
        >
          {props.text}
        </div>
      )}
    </div>
  );
}
