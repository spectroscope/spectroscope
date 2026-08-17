// Typing `/` in the composer completes an installed skill (card 183).
//
// The rules live in state/slashCommands.ts, which is pure and pinned in node;
// this is the popover over them and the keys that drive it. It is a HOOK rather
// than a component wrapping the textarea, because the composer owns its own
// Enter and the picker has to get first refusal on it without the textarea
// changing hands.
//
// Nothing here invents a wire verb. Picking splices a /token into the draft
// (card 247) — several per message, anywhere in the text — and the reader
// sends it, or edits it first, or deletes it. The server appends the named
// skills' instructions for the model; doing the invocation visibly is what
// lets somebody disagree with the completion before it reaches the agent.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { matchSkills, slashQueryAt, tokenInsert, type SkillOption } from "../state/slashCommands";
import { useSkills } from "../state/skillList";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

export interface SlashPicker {
  /** The popover, or null when nothing is being completed. */
  node: ReactNode;
  /** First refusal on a key. True means the picker consumed it. */
  handleKey: (event: KeyboardEvent) => boolean;
}

/**
 * The composer's slash completion.
 *
 * @param draft   the composer's text
 * @param caret   the caret position inside it — the token being spelled lives there
 * @param enabled false where completing makes no sense (an archive, a replay)
 * @param onPick  hands back the new draft and where the caret lands in it
 * @returns the popover and the key handler the composer must call first
 */
export function useSlashPicker(
  draft: string,
  caret: number,
  enabled: boolean,
  onPick: (text: string, caret: number) => void,
): SlashPicker {
  const lang = useLang();
  const at = enabled ? slashQueryAt(draft, caret) : null;
  const query = at === null ? null : at.query;
  // Asked for the first time a reader types a slash, and not before: somebody
  // who never uses this costs no request at all.
  const skills = useSkills(query !== null);
  const options = query === null ? [] : matchSkills(query, skills);

  const [index, setIndex] = useState(0);
  // Esc closes the list and LEAVES the slash where it was typed, so the reader
  // can write a message that happens to start with one.
  //
  // It stays closed until the draft stops being a command at all. Keying this
  // on the query instead was tried and is worse: typing one more character
  // reopened the list, so Esc meant almost nothing, and deleting back to the
  // dismissed query closed it again — the same draft behaving two ways
  // depending on which side it was approached from. Found by walking it.
  const [dismissed, setDismissed] = useState(false);
  const lastQuery = useRef<string | null>(null);
  useEffect(() => {
    if (lastQuery.current !== query) {
      lastQuery.current = query;
      setIndex(0);
      if (query === null) setDismissed(false);
    }
  }, [query]);

  const open = query !== null && !dismissed;
  const active = options[index];

  const pick = (skill: SkillOption): void => {
    if (at === null) return;
    const picked = tokenInsert(draft, at, caret, skill);
    onPick(picked.text, picked.caret);
    setDismissed(false);
    setIndex(0);
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (options.length === 0) {
      // Nothing to pick, so Enter is not the picker's business: the composer
      // is a text box and "/nonsense" is text somebody typed.
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + step + options.length) % options.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (active === undefined) return false;
      event.preventDefault();
      pick(active);
      return true;
    }
    return false;
  };

  if (!open) {
    return { node: null, handleKey };
  }

  const node = (
    <div className="wsg-pop slash-pop" role="dialog" aria-label={t(lang, "slash.title")}>
      <div className="settings-label">{t(lang, "slash.title")}</div>
      {options.length === 0 ? (
        <p className="settings-note">
          {skills.length === 0 ? t(lang, "slash.empty") : t(lang, "slash.none", { query: query ?? "" })}
        </p>
      ) : (
        <ul className="slash-list" role="listbox" aria-label={t(lang, "slash.title")}>
          {options.map((skill, at) => (
            <li key={skill.name}>
              <button
                type="button"
                role="option"
                aria-selected={at === index}
                className={`slash-row${at === index ? " slash-row--on" : ""}`}
                // The pointer must not take focus off the textarea, or the
                // composer loses the caret the pick is about to write into.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setIndex(at)}
                onClick={() => pick(skill)}
              >
                <span className="slash-name mono">{skill.name}</span>
                <span className="slash-desc" title={skill.description}>
                  {skill.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="settings-note slash-hint">{t(lang, "slash.hint")}</p>
    </div>
  );
  return { node, handleKey };
}
