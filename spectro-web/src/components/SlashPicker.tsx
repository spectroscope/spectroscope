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
//
// Card 554: the commands come from the list the server serves. Mounting the
// picker asks for it, and until it has arrived the commands section says so
// and offers no row (criterion 8h); the composer holds a slash draft as well.
// The rows come grouped, each with its aliases, and the playbook rows only in
// developer mode. A row that takes words is written into the draft. Of the
// rows that take none, /compact and /clear run from here as before; any other
// is written into the draft, and Enter on it whole is left to the composer,
// whose submit is the one door a command leaves through.
//
// Card 558: the skills are the session's own when it has sent its list
// (session_items): the workspace's, the picked playbook's and the user's,
// skills and commands alike, each under its effective name and with its
// source as a small label. The picker asks for the list the first time it
// opens without one, and shows the installed skills (GET /api/skills) until
// it is there. A new list replaces the old one, so a changed pick takes the
// old playbook's items out.

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { matchSkills, slashQueryAt, tokenInsert, type SkillOption } from "../state/slashCommands";
import { matchCommands, spellingsOf, type ChatCommandName } from "../state/chatCommands";
import { useSkills } from "../state/skillList";
import { slashItems, sourceLabel, wantsItems, type SessionItems } from "../state/sessionItems";
import { useCommandList, type CommandRow } from "../state/commandList";
import { useViewMode } from "../state/viewMode";
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
 * @param items     card 558: the session's items, or null while it has sent none
 * @param askItems  card 558: asks the session for its items; absent where there is no session
 * @returns the popover and the key handler the composer must call first
 */
export function useSlashPicker(
  draft: string,
  caret: number,
  enabled: boolean,
  onPick: (text: string, caret: number) => void,
  onCommand?: (command: ChatCommandName) => void,
  items: SessionItems | null = null,
  askItems?: () => void,
): SlashPicker {
  const lang = useLang();
  const at = enabled ? slashQueryAt(draft, caret) : null;
  const query = at === null ? null : at.query;
  // Asked for the first time a reader types a slash, and not before: somebody
  // who never uses this costs no request at all. Card 558: only while the
  // session has sent no list of its own.
  const installed = useSkills(query !== null && items === null);
  const sessionSkills = useMemo(() => (items === null ? null : slashItems(items)), [items]);
  const skills = sessionSkills ?? installed;
  // Card 558: the session's list is asked for once, when the picker opens
  // without one; a list that arrives clears the mark, so a new chat asks again.
  const askedItems = useRef(false);
  useEffect(() => {
    if (items !== null) {
      askedItems.current = false;
      return;
    }
    if (askItems !== undefined && wantsItems(query !== null, items, askedItems.current)) {
      askedItems.current = true;
      askItems();
    }
  }, [query, items, askItems]);
  const options = query === null ? [] : matchSkills(query, skills);
  // Card 554: asked for when the composer mounts, so it is here by the first slash.
  const { rows, status } = useCommandList();
  const mode = useViewMode();
  // Card 554, criterion 8h: a slash that opens the draft, with no list yet.
  const loading = at !== null && at.start === 0 && onCommand !== undefined && rows === null;
  // Card 471: the commands come first and share the one focus index with the
  // skills, so the arrows walk from the last command into the first skill.
  const commands: CommandRow[] =
    at === null || onCommand === undefined || rows === null
      ? []
      : matchCommands(at.query, at.start, rows, mode);
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

  /** Runs /compact or /clear; the composer empties the draft (card 471).
   *  Card 554: any other row is written into the draft, for the composer to send. */
  const run = (command: CommandRow): void => {
    if (onCommand === undefined) return;
    const name = runsHere(command);
    if (name === null) {
      complete(command);
      return;
    }
    onCommand(name);
    setDismissed(false);
    setIndex(0);
  };

  /** Writes a command into the draft without running it. A command only opens
   *  the draft, so it replaces everything up to the caret. Card 504: a command
   *  that takes words gets a space after it. */
  const complete = (command: CommandRow): void => {
    const spelling = `/${spellingsOf(command)[0]}`;
    const text = command.takesArgs ? `${spelling} ` : spelling;
    onPick(text + draft.slice(caret), text.length);
    setIndex(0);
  };

  /** Whether the draft is exactly one of the row's spellings. */
  const spelledOut = (command: CommandRow): boolean =>
    spellingsOf(command).some((spelling) => draft.trim() === `/${spelling}`);

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
      if (event.key === "Enter" && !activeCommand.takesArgs && spelledOut(activeCommand)) {
        // Card 554: a whole command other than /compact and /clear leaves
        // through the composer's submit, so the picker does not take the key.
        if (runsHere(activeCommand) === null) return false;
        event.preventDefault();
        run(activeCommand);
        return true;
      }
      event.preventDefault();
      complete(activeCommand);
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
  const skillSection = (commands.length === 0 && !loading) || options.length > 0;
  const grouped = new Set(commands.map((command) => command.group)).size > 1;

  const node = (
    <>
      <div className="wsg-pop slash-pop" role="dialog" aria-label={t(lang, "slash.title")} ref={popRef}>
        {(commands.length > 0 || loading) && (
          <>
            <div className="settings-label">{t(lang, "slash.commands")}</div>
            {loading ? (
              <p className="settings-note slash-loading" role="status">
                {t(lang, status === "failed" ? "slash.loadFailed" : "slash.loading")}
              </p>
            ) : (
              <ul className="slash-list" role="listbox" aria-label={t(lang, "slash.commands")}>
                {commands.map((command, at) => (
                  <Fragment key={command.id}>
                    {/* Card 554: a group's name above its first row, when more than one group is on offer. */}
                    {grouped && (at === 0 || commands[at - 1]?.group !== command.group) && (
                      <li className="slash-group" role="presentation">
                        {t(lang, `cmd.group.${command.group}`)}
                      </li>
                    )}
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={at === index}
                        className={`slash-row${at === index ? " slash-row--on" : ""}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setIndex(at)}
                        onClick={() => run(command)}
                      >
                        <span className="slash-name mono">{`/${spellingsOf(command)[0]}`}</span>
                        {command.aliases.map((alias) => (
                          <span key={alias} className="slash-alias mono">{`/${alias}`}</span>
                        ))}
                        <span className="slash-desc">{t(lang, `cmd.${command.id}.help`)}</span>
                      </button>
                    </li>
                  </Fragment>
                ))}
              </ul>
            )}
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
                    {/* Card 558: a session item names its source, on every row. */}
                    {skill.source === undefined ? null : (
                      <span className="wsg-scope-tag slash-src" data-source={skill.source}>
                        {sourceLabel(skill, lang)}
                      </span>
                    )}
                    {skill.kind === "command" && (
                      <span className="wsg-scope-tag slash-src" data-kind="command">
                        {t(lang, "slash.kind.command")}
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

/** Card 554: the frame-of-its-own command a row is, or null for a row the composer sends. */
function runsHere(command: CommandRow): ChatCommandName | null {
  return command.id === "compact" || command.id === "clear" ? command.id : null;
}
