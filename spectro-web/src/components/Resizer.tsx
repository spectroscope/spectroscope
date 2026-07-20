// A vertical drag handle for the resizable panels. One affordance, two gestures:
// DRAG to resize the adjacent pane, CLICK (no meaningful move) to collapse/expand
// it. The parent owns the width math — onResize just reports the pointer x.

import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** A move under this many px is a click (collapse); above, a resize drag. */
const CLICK_DRAG_THRESHOLD_PX = 3;

export function Resizer(props: {
  /** True when the adjacent pane is collapsed (renders as an expand rail). */
  collapsed: boolean;
  /** Which way the expand chevron points while collapsed. */
  chevron: "left" | "right";
  /** Extra class (e.g. "sidebar-resizer" for the absolutely-positioned one). */
  className?: string;
  label: string;
  onResize: (clientX: number) => void;
  onToggle: () => void;
}) {
  const moved = useRef(false);
  const startX = useRef(0);
  const lang = useLang();

  const onMouseDown = (e: ReactMouseEvent): void => {
    e.preventDefault();
    moved.current = false;
    startX.current = e.clientX;

    const onMove = (ev: globalThis.MouseEvent): void => {
      if (Math.abs(ev.clientX - startX.current) > CLICK_DRAG_THRESHOLD_PX) moved.current = true;
      if (moved.current && !props.collapsed) props.onResize(ev.clientX);
    };
    const onUp = (): void => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing");
      if (!moved.current) props.onToggle(); // a click, not a drag → collapse/expand
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.classList.add("is-resizing");
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onToggle();
    }
  };

  return (
    <div
      className={`lab-resizer${props.collapsed ? " lab-resizer--collapsed" : ""}${props.className ? " " + props.className : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.collapsed
        ? t(lang, "rz.ariaExpand", { label: props.label })
        : t(lang, "rz.ariaHandle", { label: props.label })}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      title={props.collapsed ? t(lang, "rz.expand") : t(lang, "rz.handle")}
    >
      <span className="lab-resizer-chevron" aria-hidden="true">
        {props.collapsed ? (props.chevron === "right" ? "›" : "‹") : "⋮"}
      </span>
    </div>
  );
}
