// Completing a skill by typing `/` in the composer (card 183; card 247 made
// it a token).
//
// A skill is INSTRUCTIONS, not a callable — there is still no wire verb here.
// Picking one now writes a /token into the draft, several per message if the
// reader likes, and the SERVER appends the named skills' instructions to the
// prompt the model reads (SkillInvocations.java); the message itself stays the
// reader's own words. The token is visible, editable and deletable, which is
// what survives the reader disagreeing with the completion.
//
// Everything in this file is pure so the suite can drive it in node; the
// popover that uses it is markup over these three functions.

/** One installed skill, as `GET /api/skills` lists it. */
export interface SkillOption {
  /** As the agent knows it: `<pack>:<skill>` for a catalogue install, bare otherwise. */
  name: string;
  /** The skill's own folder, which is the half a reader remembers. */
  folder: string;
  /** The pack it came from, null for a skill installed at the top level. */
  pack: string | null;
  description: string;
  disabled: boolean;
}

/** A command being spelled at the caret: the text after the slash, and where
 *  the slash stands in the draft. */
export interface SlashQueryAt {
  query: string;
  start: number;
}

/** The skill-name charset, shared with the token shape in skillTokens.ts. */
const NAME_CHAR = /[\p{L}\p{N}_:-]/u;

/**
 * The query the CARET is spelling, or null (card 247: several tokens, anywhere
 * in the text — the old whole-draft rule is the start-of-text special case).
 *
 * Two rules survive from the old reading. A slash glued to a word is prose —
 * "and/or" and "/tmp/x" stay typable. And the moment the caret leaves the
 * token (a space, a click elsewhere), the draft at that spot has stopped being
 * a pick: "/humanize this paragraph" is somebody writing, not choosing.
 *
 * @param draft the composer's whole text
 * @param caret the caret position inside it
 * @returns the query and the slash's index, or null
 */
export function slashQueryAt(draft: string, caret: number): SlashQueryAt | null {
  let at = caret;
  while (at > 0 && NAME_CHAR.test(draft[at - 1])) at--;
  if (at === 0 || draft[at - 1] !== "/") return null;
  const slashAt = at - 1;
  const before = slashAt === 0 ? "" : draft[slashAt - 1];
  if (before !== "" && (NAME_CHAR.test(before) || before === "/")) return null;
  return { query: draft.slice(at, caret), start: slashAt };
}

/** Where a query hit: the front of a name ranks above the middle of one. */
const STARTS = 0;
const CONTAINS = 1;

/**
 * The skills a query offers, best first.
 *
 * A packed skill answers to three spellings — its full name, its folder and its
 * pack — because nobody types the pack first. If `brain` did not reach
 * `superpowers:brainstorming`, the namespace would have made this feature worse
 * than it was without one.
 *
 * Disabled skills are absent rather than greyed: the list is what the agent can
 * currently do, and offering something the system prompt was never told about
 * is a lie the reader has no way to see.
 *
 * @param query the text after the slash, any case
 * @param skills every installed skill
 * @returns the matches, ranked then alphabetical
 */
export function matchSkills(query: string, skills: readonly SkillOption[]): SkillOption[] {
  const needle = query.toLowerCase();
  const ranked: { rank: number; skill: SkillOption }[] = [];
  for (const skill of skills) {
    if (skill.disabled) continue;
    if (needle === "") {
      ranked.push({ rank: STARTS, skill });
      continue;
    }
    const rank = rankOf(needle, skill);
    if (rank !== null) ranked.push({ rank, skill });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name));
  return ranked.map((r) => r.skill);
}

function rankOf(needle: string, skill: SkillOption): number | null {
  const spellings = [skill.name, skill.folder, skill.pack ?? ""].map((s) => s.toLowerCase());
  if (spellings.some((s) => s !== "" && s.startsWith(needle))) return STARTS;
  if (spellings.some((s) => s !== "" && s.includes(needle))) return CONTAINS;
  return null;
}

/**
 * What picking a skill does to the draft (card 247): the token spliced over
 * the query — slash kept, the agent's exact name, a space after so the caret
 * carries straight on mid-sentence. The token stays visible and editable; the
 * server appends the skill's instructions for the model when it is sent.
 *
 * @param draft the composer's whole text
 * @param at    the query being spelled, from {@link slashQueryAt}
 * @param caret the caret position at pick time
 * @param skill the picked skill
 * @returns the new draft and where the caret lands in it
 */
export function tokenInsert(
  draft: string,
  at: SlashQueryAt,
  caret: number,
  skill: SkillOption,
): { text: string; caret: number } {
  const rest = draft.slice(caret);
  // Mid-sentence the space is already there; only a token at the seam of the
  // text earns its own, so completing never doubles the whitespace.
  const pad = /^\s/.test(rest) ? "" : " ";
  const token = `/${skill.name}${pad}`;
  return {
    text: draft.slice(0, at.start) + token + rest,
    caret: at.start + token.length + (pad === "" ? 1 : 0),
  };
}
