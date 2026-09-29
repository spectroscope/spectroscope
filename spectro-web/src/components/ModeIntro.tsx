// Card 455: the first screen of a first start. It asks for the window's view
// mode before the tutorial question, with every mode weighed the same (owner,
// 2026-09-29: neither is suggested). The choices are drawn from VIEW_MODES and
// each picture from the SURFACES table, so this file names no mode and keeps no
// list of surfaces of its own (the card 387 lesson in LevelingIntro.tsx).

import { useEffect, useRef, type KeyboardEvent } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { VIEW_TABS } from "../state/route";
import { SURFACES, isOpen, type SurfaceId } from "../state/surfaces";
import { VIEW_MODES, type ViewMode } from "../state/viewMode";

/**
 * Table entries the picture leaves out: a row in the chat's menu and a block of
 * the settings page have no place in a picture of the window.
 */
export const PICTURE_SKIPS: ReadonlySet<SurfaceId> = new Set<SurfaceId>(["liveTraceSwitch", "fleetSettings"]);

type Place = "main" | "tab" | "row" | "pill" | "dock" | "rail";

/**
 * Where a surface sits in the picture. The chat is the main pane, every other
 * tab a cell in the tab row, and anything the table adds that is none of the
 * named parts becomes a row in the rail.
 */
function placeOf(id: SurfaceId): Place {
  if (id === "chat") return "main";
  if ((VIEW_TABS as readonly string[]).includes(id)) return "tab";
  if (id === "tabRow") return "row";
  if (id === "leveling") return "pill";
  if (id === "dock") return "dock";
  return "rail";
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The picture's boxes, one per drawn surface, in table order. */
function layout(): { id: SurfaceId; place: Place; box: Box }[] {
  const ids = (Object.keys(SURFACES) as SurfaceId[]).filter((id) => !PICTURE_SKIPS.has(id));
  let rail = 0;
  let tab = 0;
  return ids.map((id) => {
    const place = placeOf(id);
    let box: Box;
    switch (place) {
      case "main":
        box = { x: 58, y: 32, w: 88, h: 80 };
        break;
      case "row":
        box = { x: 56, y: 17, w: 140, h: 10 };
        break;
      case "pill":
        box = { x: 176, y: 19.5, w: 16, h: 5 };
        break;
      case "dock":
        box = { x: 152, y: 32, w: 42, h: 80 };
        break;
      case "tab":
        box = { x: 60 + tab++ * 22, y: 19.5, w: 18, h: 5 };
        break;
      default:
        box = { x: 6, y: 20 + rail++ * 12, w: 40, h: 7 };
    }
    return { id, place, box };
  });
}

/** A schematic of the window in one mode: the surfaces it has filled, the others as dashed outlines. */
function ModePicture(props: { mode: ViewMode }) {
  return (
    <svg className="mode-intro__picture" viewBox="0 0 200 120" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="199" height="119" rx="6" fill="var(--bg)" stroke="var(--border-strong)" />
      <line x1="0" y1="14" x2="200" y2="14" stroke="var(--border)" />
      <line x1="52" y1="14" x2="52" y2="120" stroke="var(--border)" />
      {/* The learn and light switch, where the header draws it. */}
      <rect x="162" y="4.5" width="30" height="5" rx="2.5" fill="var(--sand)" stroke="none" />
      {layout().map(({ id, place, box }) => {
        const present = isOpen(id, props.mode, false);
        const radius = place === "pill" ? 2.5 : 2;
        return (
          <rect
            key={id}
            data-surface={id}
            data-present={String(present)}
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            rx={radius}
            fill={
              present
                ? place === "main" || place === "row"
                  ? "var(--surface)"
                  : "var(--accent-soft)"
                : "none"
            }
            stroke={present ? "var(--accent)" : "var(--border-strong)"}
            strokeDasharray={present ? undefined : "2 2"}
          />
        );
      })}
    </svg>
  );
}

export function ModeIntro(props: { onChoose: (mode: ViewMode) => void }) {
  const lang = useLang();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  // Tab and Shift+Tab stay among the choices while the screen is up.
  const keepFocus = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "Tab" || !dialog.current) return;
    const picks = [...dialog.current.querySelectorAll<HTMLButtonElement>("button.mode-intro__pick")];
    if (picks.length === 0) return;
    const at = picks.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey ? (at <= 0 ? picks.length - 1 : at - 1) : at === picks.length - 1 ? 0 : at + 1;
    e.preventDefault();
    picks[next].focus();
  };

  return (
    <div className="mode-intro-scrim">
      <div
        className="mode-intro"
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "mode.intro.title")}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={keepFocus}
      >
        <h2 className="mode-intro__title">{t(lang, "mode.intro.title")}</h2>
        <p className="mode-intro__lead">{t(lang, "mode.intro.lead")}</p>
        <div className="mode-intro__choice">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              data-mode={mode}
              className="mode-intro__pick"
              onClick={() => props.onChoose(mode)}
            >
              <ModePicture mode={mode} />
              <span className="mode-intro__pick-name mono">{t(lang, `mode.intro.${mode}.name`)}</span>
              <span className="mode-intro__pick-body">{t(lang, `mode.intro.${mode}.body`)}</span>
              <span className="mode-intro__pick-switch">{t(lang, `mode.intro.${mode}.switch`)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
