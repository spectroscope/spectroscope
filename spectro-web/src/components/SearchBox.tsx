// The find box: a small floating panel, top right of the view the reader is
// in. Query field, position readout, previous/next, close.
//
// It owns none of the searching. The store (state/search.ts) holds the query
// and which hit is current; each view finds its own matches and reports how
// many. This file is the one place the reader can TYPE into that store, plus
// the global chord that opens it.
//
// Two things it deliberately is not:
//   - it is not a modal. No backdrop, no focus trap, no aria-modal — the
//     reader keeps scrolling and clicking the page while it is open, which is
//     the entire point of searching the thing you are reading.
//   - it is not an error surface. A query that matches nothing says so in
//     words; the field itself stays neutral, because a half-typed word is not
//     a mistake to be flagged.

import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { closeSearch, getSearch, openSearch, setQuery, step, useSearch } from "../state/search";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** What the little counter has to say. Shape, not text: the component turns
 *  it into the localised string, the tests pin the decision. */
export type SearchReadout =
  { kind: "idle" } | { kind: "none" } | { kind: "at"; position: number; total: number };

/**
 * Decides what the readout reports for the current query and hit count.
 *
 * @param query the raw field content; blank means the reader has not asked
 *              anything yet, which is not the same as having found nothing
 * @param count how many hits the active view reported
 * @param index the current hit, 0-based, as the store holds it
 */
export function searchReadout(query: string, count: number, index: number): SearchReadout {
  if (query.trim() === "") return { kind: "idle" };
  if (count <= 0) return { kind: "none" };
  const at = Math.min(Math.max(index, 0), count - 1);
  return { kind: "at", position: at + 1, total: count };
}

/** The fields of a keydown this module actually reads. */
export interface FindChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Whether a keydown is the find chord for this platform.
 *
 * The platform split is not pedantry: on macOS Ctrl+F is the emacs binding
 * that moves the caret one character forward, alive in every text field on
 * the system. Claiming it there would break typing to gain nothing.
 *
 * @param e     the keydown
 * @param apple true on macOS/iOS, where the chord is Cmd+F rather than Ctrl+F
 */
export function isFindChord(e: FindChord, apple: boolean): boolean {
  if (e.key.toLowerCase() !== "f" || e.altKey) return false;
  return apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Whether a platform/user-agent string names an Apple platform. */
export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** What a keystroke inside the box means. */
export type SearchIntent = "next" | "prev" | "close" | null;

/**
 * Maps a keystroke in the box to its intent.
 *
 * @param e key, shift state, and whether an IME is mid-composition
 */
export function keyIntent(e: { key: string; shiftKey: boolean; isComposing?: boolean }): SearchIntent {
  if (e.key === "Escape") return "close";
  // An Enter that commits an IME candidate belongs to the word being typed.
  if (e.key !== "Enter" || e.isComposing === true) return null;
  return e.shiftKey ? "prev" : "next";
}

/** Anything that can carry the global keydown; window in production. */
export interface HotkeyTarget {
  addEventListener(type: string, listener: (event: unknown) => void, options?: { capture?: boolean }): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: { capture?: boolean },
  ): void;
}

// Set by the mounted box while it is open, so a second chord can re-focus the
// field that already exists instead of the handler racing React's render.
let focusOpenBox: (() => void) | null = null;

// Where focus was when the box opened. Escape hands it back; a reader who was
// in the composer must not have to hunt for their cursor afterwards.
let returnFocusTo: HTMLElement | null = null;

function rememberFocusOrigin(): void {
  if (returnFocusTo !== null || typeof document === "undefined") return;
  const active = document.activeElement;
  returnFocusTo = active instanceof HTMLElement ? active : null;
}

/** Reads the platform the browser admits to, across the two spellings. */
function platformText(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
}

let hotkeyTeardown: (() => void) | null = null;

/**
 * Attaches the global find chord and returns the detach.
 *
 * Installing twice hands back the first teardown rather than stacking a
 * second listener, so a remount cannot open two boxes on one keystroke —
 * the same contract as installBrowserLog.
 *
 * @param target where to listen; defaults to window, which is absent in tests
 * @param opts   apple: force the Cmd/Ctrl choice instead of sniffing
 * @return the teardown; calling it removes the listener
 */
export function installSearchHotkey(target?: HotkeyTarget | null, opts?: { apple?: boolean }): () => void {
  if (hotkeyTeardown !== null) return hotkeyTeardown;
  const on = target ?? (typeof window === "undefined" ? null : (window as unknown as HotkeyTarget));
  if (on === null) {
    const noop = (): void => {};
    hotkeyTeardown = noop;
    return noop;
  }
  const apple = opts?.apple ?? isApplePlatform(platformText());

  const onKeyDown = (event: unknown): void => {
    const e = event as FindChord & { preventDefault?: () => void };
    if (!isFindChord(e, apple)) return;
    // Without this the browser's own find bar opens over ours and searches a
    // DOM full of virtualised, collapsed and off-screen text.
    e.preventDefault?.();
    if (getSearch().open) {
      focusOpenBox?.();
      return;
    }
    rememberFocusOrigin();
    openSearch();
  };

  // Capture, so a view that stops propagation on its own keydowns cannot
  // swallow the chord and leave the reader with no find at all.
  on.addEventListener("keydown", onKeyDown, { capture: true });
  const off = (): void => {
    on.removeEventListener("keydown", onKeyDown, { capture: true });
    if (hotkeyTeardown === off) hotkeyTeardown = null;
  };
  hotkeyTeardown = off;
  return off;
}

export function SearchBox() {
  const lang = useLang();
  const { open, query, count, index } = useSearch();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    rememberFocusOrigin(); // still true here: nothing has taken focus yet
    const focus = (): void => {
      const el = inputRef.current;
      if (el === null) return;
      el.focus();
      // Selected, not cleared: reopening on a previous query lets the reader
      // either step through it again or type straight over it.
      el.select();
    };
    focus();
    focusOpenBox = focus;
    return () => {
      if (focusOpenBox === focus) focusOpenBox = null;
      const origin = returnFocusTo;
      returnFocusTo = null;
      // Hand focus back only on a real close, and only if nothing else has
      // claimed it — the reader may have clicked into the page, and yanking
      // them back would be the focus trap this box refuses to be.
      if (origin === null || getSearch().open) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      const loose = active === null || active === document.body;
      if (loose && origin.isConnected) origin.focus();
    };
  }, [open]);

  if (!open) return null;

  const readout = searchReadout(query, count, index);
  const noHits = readout.kind !== "at";

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const intent = keyIntent({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing });
    if (intent === null) return;
    e.preventDefault();
    // Escape stops here rather than reaching the app's global handler, which
    // would also close the keymap sheet and the level drawer behind us.
    e.stopPropagation();
    if (intent === "close") closeSearch();
    else step(intent === "next" ? 1 : -1);
  };

  return (
    <div className="search-box" role="search" aria-label={t(lang, "search.title")} onKeyDown={onKeyDown}>
      <svg
        className="search-box__glyph"
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="4" />
        <path d="M10 10l3.5 3.5" />
      </svg>

      <input
        ref={inputRef}
        type="text"
        className="search-box__input"
        value={query}
        placeholder={t(lang, "search.placeholder")}
        aria-label={t(lang, "search.title")}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />

      <span
        className={`search-box__readout${readout.kind === "none" ? " search-box__readout--none" : ""}`}
        aria-live="polite"
        {...(readout.kind === "at"
          ? { "aria-label": t(lang, "search.of", { n: readout.position, total: readout.total }) }
          : {})}
      >
        {readout.kind === "at" ? `${readout.position} / ${readout.total}` : ""}
        {readout.kind === "none" ? t(lang, "search.noMatches") : ""}
      </span>

      <button
        type="button"
        className="icon-button search-box__nav"
        disabled={noHits}
        aria-label={t(lang, "search.prev")}
        title={t(lang, "search.prev")}
        onClick={() => step(-1)}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 10l4-4 4 4" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-button search-box__nav"
        disabled={noHits}
        aria-label={t(lang, "search.next")}
        title={t(lang, "search.next")}
        onClick={() => step(1)}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      <button
        type="button"
        className="icon-button search-box__nav"
        aria-label={t(lang, "common.close")}
        title={t(lang, "common.close")}
        onClick={() => closeSearch()}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
