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
//
// Card 471 puts the chat's two commands above the skills, /compact and /clear,
// when the slash opens the draft and the host hands in a command callback. A
// command leaves through that callback as its own frame. A click on a command
// row runs it. Enter runs it only when the draft already spells it out; on a
// partial name ("/" or "/cl") Enter writes the highlighted command into the
// draft, as Tab does, so a slash and a stray Enter cannot start a model call
// that rewrites the history (card 471, review round).

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { matchSkills, slashQueryAt, tokenInsert, type SkillOption } from "../state/slashCommands";
import { matchCommands, parseCommand, type ChatCommand, type ChatCommandName } from "../state/chatCommands";
import { useSkills } from "../state/skillList";
import { SLASH_TIP_W, SlashTip, slashTipBox, slashTipView, type SlashTipBox } from "./SlashTip";
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
 * @param onCommand runs a command (card 471); absent, the picker offers skills only
 * @returns the popover and the key handler the composer must call first
 */
export function useSlashPicker(
  draft: string,
  caret: number,
  enabled: boolean,
  onPick: (text: string, caret: number) => void,
  onCommand?: (command: ChatCommandName) => void,
): SlashPicker {
  const lang = useLang();
  const at = enabled ? slashQueryAt(draft, caret) : null;
  const query = at === null ? null : at.query;
  // Asked for the first time a reader types a slash, and not before: somebody
  // who never uses this costs no request at all.
  const skills = useSkills(query !== null);
  const options = query === null ? [] : matchSkills(query, skills);
  // Card 471: the commands come first and share the one focus index with the
  // skills, so the arrows walk from the last command into the first skill.
  const commands: ChatCommand[] =
    at === null || onCommand === undefined ? [] : matchCommands(at.query, at.start);
  const rowCount = commands.length + options.length;

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
  const activeCommand = index < commands.length ? commands[index] : undefined;
  const active = index < commands.length ? undefined : options[index - commands.length];

  // Card 253: where the description popover hangs, from the room there actually
  // is. It starts on the right — the side the card's screenshot shows, and the
  // side every window with room ends up on anyway — and the measurement below
  // corrects it. Starting at null instead would cost a first frame without the
  // box for the common case, to spare the rare one a flip nobody can see.
  const popRef = useRef<HTMLDivElement>(null);
  const [tipBox, setTipBox] = useState<SlashTipBox | null>({ side: "right", width: SLASH_TIP_W });
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    if (pop === null) return;
    const measure = (): void => {
      const box = pop.getBoundingClientRect();
      setTipBox(slashTipBox({ popLeft: box.left, popRight: box.right, viewportWidth: window.innerWidth }));
    };
    // Once immediately, because an observer is not a measurement: in a window
    // that never renders a frame nothing is delivered at all, and the first
    // opening is exactly when the answer is needed.
    measure();
    // Two watchers, for two independent movements. Dragging the dock resizes the
    // composer column without touching the window, and resizing the window moves
    // the room without touching the column once it is at its 860px cap.
    const observer = new ResizeObserver(measure);
    observer.observe(pop);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  const tipView = activeCommand !== undefined ? null : slashTipView(options, index - commands.length);
  const tip = tipView === null || tipBox === null ? null : <SlashTip view={tipView} box={tipBox} />;

  const pick = (skill: SkillOption): void => {
    if (at === null) return;
    const picked = tokenInsert(draft, at, caret, skill);
    onPick(picked.text, picked.caret);
    setDismissed(false);
    setIndex(0);
  };

  /** Runs a command; the composer empties the draft (card 471). */
  const run = (command: ChatCommand): void => {
    if (onCommand === undefined) return;
    onCommand(command.name);
    setDismissed(false);
    setIndex(0);
  };

  /** Writes a command into the draft without running it. A command only opens
   *  the draft, so it replaces everything up to the caret. */
  const complete = (command: ChatCommand): void => {
    const text = `/${command.name}`;
    onPick(text + draft.slice(caret), text.length);
    setIndex(0);
  };

  const handleKey = (event: KeyboardEvent): boolean => {
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (rowCount === 0) {
      // Nothing to pick, so Enter is not the picker's business: the composer
      // is a text box and "/nonsense" is text somebody typed.
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + step + rowCount) % rowCount);
      return true;
    }
    if (activeCommand !== undefined && (event.key === "Enter" || event.key === "Tab")) {
      event.preventDefault();
      if (event.key === "Enter" && parseCommand(draft) === activeCommand.name) run(activeCommand);
      else complete(activeCommand);
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

  // Card 471: with commands on offer, a skill section that has nothing to show
  // steps aside instead of saying "no skill matches" under a command that does.
  const skillSection = commands.length === 0 || options.length > 0;

  const node = (
    <>
      <div className="wsg-pop slash-pop" role="dialog" aria-label={t(lang, "slash.title")} ref={popRef}>
        {commands.length > 0 && (
          <>
            <div className="settings-label">{t(lang, "slash.commands")}</div>
            <ul className="slash-list" role="listbox" aria-label={t(lang, "slash.commands")}>
              {commands.map((command, at) => (
                <li key={command.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={at === index}
                    className={`slash-row${at === index ? " slash-row--on" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setIndex(at)}
                    onClick={() => run(command)}
                  >
                    <span className="slash-name mono">{`/${command.name}`}</span>
                    <span className="slash-desc">{t(lang, command.helpKey)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {skillSection && <div className="settings-label">{t(lang, "slash.title")}</div>}
        {!skillSection ? null : options.length === 0 ? (
          <p className="settings-note">
            {skills.length === 0 ? t(lang, "slash.empty") : t(lang, "slash.none", { query: query ?? "" })}
          </p>
        ) : (
          <ul className="slash-list" role="listbox" aria-label={t(lang, "slash.title")}>
            {options.map((skill, skillAt) => {
              const at = commands.length + skillAt;
              return (
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
                    {/* The pack is not decoration: it is half the name the agent
                        calls. It shows on every packed row, not only where a name
                        collides, because a label that comes and goes moves the
                        layout under somebody who is still typing. */}
                    {skill.pack === null ? null : (
                      <span className="wsg-scope-tag" title={t(lang, "slash.namespace")}>
                        {skill.pack}
                      </span>
                    )}
                    <span className="slash-desc" title={skill.description}>
                      {skill.description}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="settings-note slash-hint">{t(lang, "slash.hint")}</p>
      </div>
      {/* A SIBLING of the list, never a child: .wsg-pop scrolls (overflow-y),
          and a box that hangs out of a scrolling box is clipped by it — the
          rule .plus-sub in workspace-gear.css documents the same trap. */}
      {tip}
    </>
  );
  return { node, handleKey };
}
