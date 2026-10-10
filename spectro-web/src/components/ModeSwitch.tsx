// Card 430: the header's switch between the modes (card 481 adds developer as
// the third). A radio group: Tab reaches the checked one, an arrow moves to the
// next or previous one and chooses it, and Enter or Space chooses the one that
// has the focus. The words are the mode words in both languages (owner call 2);
// the tooltip in the reader's language says what the mode shows or turns off.

import { useRef } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { VIEW_MODES, setViewMode, useViewMode, type ViewMode } from "../state/viewMode";

/**
 * The mode a key chooses on a focused radio, or null for a key the switch
 * leaves alone. Right and Down move to the next mode of VIEW_MODES, Left and Up
 * to the previous one, wrapping at both ends as a radio group does; Enter and
 * Space choose the focused one.
 *
 * @param key     the key's `KeyboardEvent.key`
 * @param focused the mode of the radio that has the focus
 */
export function modeForKey(key: string, focused: ViewMode): ViewMode | null {
  const at = VIEW_MODES.indexOf(focused);
  const count = VIEW_MODES.length;
  if (key === "ArrowRight" || key === "ArrowDown") return VIEW_MODES[(at + 1) % count];
  if (key === "ArrowLeft" || key === "ArrowUp") return VIEW_MODES[(at - 1 + count) % count];
  if (key === "Enter" || key === " ") return focused;
  return null;
}

export function ModeSwitch() {
  const lang = useLang();
  const mode = useViewMode();
  const buttons = useRef<Partial<Record<ViewMode, HTMLButtonElement | null>>>({});

  return (
    <div className="mode-switch" role="radiogroup" aria-label={t(lang, "hdr.mode.label")}>
      {VIEW_MODES.map((option) => (
        <button
          key={option}
          ref={(el) => {
            buttons.current[option] = el;
          }}
          type="button"
          role="radio"
          aria-checked={mode === option}
          tabIndex={mode === option ? 0 : -1}
          className={`mode-switch__option mono${mode === option ? " mode-switch__option--on" : ""}`}
          title={t(lang, `hdr.mode.${option}Title`)}
          onClick={() => setViewMode(option)}
          onKeyDown={(e) => {
            const next = modeForKey(e.key, option);
            if (next === null) return;
            e.preventDefault();
            setViewMode(next);
            buttons.current[next]?.focus();
          }}
        >
          {t(lang, `hdr.mode.${option}`)}
        </button>
      ))}
    </div>
  );
}
