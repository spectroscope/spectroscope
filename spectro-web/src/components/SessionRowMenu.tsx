// Card 445: the three-dots button at the right end of a stored session row and
// the menu it opens (pin, rename, suggest a title, delete).
//
// The menu is portalled to the body. The rail is a size container
// (`container: sidebar / inline-size` in sidebar.css), and a container is the
// containing block of its fixed descendants, so a fixed menu inside the rail
// would be placed against the rail and cut by its scroll box. In the body it
// is placed against the window, next to the button that opened it.
//
// Keyboard: Enter, Space or ArrowDown on the button opens the menu with the
// first item focused, ArrowUp with the last; the arrows, Home and End move;
// Enter or Space picks; Escape closes and puts focus back on the button; Tab
// closes and lets focus move on. A press outside, a scroll or a resize closes
// it too (menuDismiss.ts is the rule for what counts as outside).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { t, type Lang } from "../i18n/i18n";
import { dismissesMenu, MODAL_LAYER } from "./menuDismiss";
import { menuKeyStep, type RowMenuEntry, type RowMenuItemId } from "./rowMenuItems";

/** Room kept between the menu and the window's edge, in px. */
const EDGE = 8;
/** Gap between the button and the menu, in px. */
const GAP = 4;

/**
 * The open menu's items. Drawn by {@link SessionRowMenu} inside the portal,
 * and exported so its markup is tested without one.
 */
export function RowMenuList(props: {
  lang: Lang;
  items: RowMenuEntry[];
  /** The item with keyboard focus. */
  focus: number;
  onPick: (id: RowMenuItemId) => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  itemRef?: (index: number, el: HTMLButtonElement | null) => void;
  label?: string;
}) {
  const { lang, items } = props;
  return (
    <div className="row-menu-list" role="menu" aria-label={props.label} onKeyDown={props.onKeyDown}>
      {items.map((item, i) => (
        <div key={item.id} role="none">
          {item.danger && <div className="row-menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            ref={(el) => props.itemRef?.(i, el)}
            tabIndex={i === props.focus ? 0 : -1}
            className={`row-menu-item${item.danger ? " row-menu-item--danger" : ""}`}
            aria-disabled={item.disabled ? true : undefined}
            title={item.hintKey !== undefined ? t(lang, item.hintKey) : undefined}
            onClick={() => {
              if (!item.disabled) props.onPick(item.id);
            }}
          >
            {t(lang, item.labelKey)}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Where the open menu sits, in window coordinates. */
interface Place {
  top: number;
  left: number;
}

export function SessionRowMenu(props: {
  lang: Lang;
  /** The row's title, for the button's name ("Actions for …"). */
  title: string;
  items: RowMenuEntry[];
  onPick: (id: RowMenuItemId) => void;
}) {
  const { lang, items } = props;
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(0);
  const [place, setPlace] = useState<Place | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const openAt = (index: number): void => {
    setFocus(index);
    setPlace(null);
    setOpen(true);
  };
  const close = (giveBackFocus: boolean): void => {
    setOpen(false);
    if (giveBackFocus) buttonRef.current?.focus();
  };

  // Below the button, right edges aligned; above it when the window has no
  // room below. Measured after the menu is drawn, so its real height counts.
  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (button === undefined || menu === undefined) return;
    let top = button.bottom + GAP;
    if (top + menu.height > window.innerHeight - EDGE) top = Math.max(EDGE, button.top - GAP - menu.height);
    const left = Math.min(Math.max(EDGE, button.right - menu.width), window.innerWidth - menu.width - EDGE);
    setPlace({ top, left });
  }, [open]);

  useEffect(() => {
    if (open && place !== null) itemRefs.current[focus]?.focus();
  }, [open, place, focus]);

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null): boolean => {
      const node = target instanceof Node ? target : null;
      return (
        node !== null &&
        ((buttonRef.current?.contains(node) ?? false) || (menuRef.current?.contains(node) ?? false))
      );
    };
    const onDown = (e: MouseEvent): void => {
      const element = e.target instanceof Element ? e.target : null;
      const press = {
        inAnchor: inside(e.target),
        inModal: element !== null && element.closest(MODAL_LAYER) !== null,
      };
      if (dismissesMenu(press)) setOpen(false);
    };
    const onScroll = (e: Event): void => {
      if (!inside(e.target)) setOpen(false);
    };
    const onResize = (): void => setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = menuKeyStep(e.key, focus, items.length);
    if (step === null) return;
    if (step === "leave") {
      close(false);
      return;
    }
    e.preventDefault();
    if (step === "close") close(true);
    else setFocus(step);
  };

  const onButtonKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openAt(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(items.length - 1);
    }
  };

  const label = t(lang, "sess.menu.button", { title: props.title });
  return (
    <>
      <button
        type="button"
        className="session-menu-btn"
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onButtonKey}
      >
        {/* The vertical three dots, the same glyph the chat's menu wears. */}
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="3" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="8" cy="13" r="1.3" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            className="row-menu-pop"
            ref={menuRef}
            style={
              place === null
                ? { top: 0, left: 0, visibility: "hidden" }
                : { top: place.top, left: place.left }
            }
          >
            <RowMenuList
              lang={lang}
              items={items}
              focus={focus}
              label={label}
              onKeyDown={onMenuKey}
              itemRef={(i, el) => {
                itemRefs.current[i] = el;
              }}
              onPick={(id) => {
                close(false);
                props.onPick(id);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
