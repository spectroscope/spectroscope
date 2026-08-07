// Completing a skill by typing `/` in the composer (card 183).
//
// The whole feature rests on one thing being true: a skill is INSTRUCTIONS in
// the system prompt, not a callable. There is no wire verb to invent here and
// no hidden payload to send. Picking one writes an ordinary sentence into the
// composer naming the skill, and the reader reads it, edits it, and presses
// send like any other message. That is the honest spelling, and it is also the
// only one that survives the reader disagreeing with the completion.
//
// Everything in this file is pure so the suite can drive it in node; the
// popover that uses it is markup over these three functions.

import { t, type Lang } from "../i18n/i18n";

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

/**
 * The query a draft is spelling, or null when the draft is not a command.
 *
 * Two rules, and the second is the one that matters. The slash must be the
 * FIRST character, because hijacking a mid-sentence slash would make "and/or"
 * impossible to type. And the moment any whitespace appears the draft has
 * stopped being a pick and become a sentence: "/humanize this paragraph" is
 * somebody writing, not somebody choosing.
 *
 * @param draft the composer's whole text
 * @returns the text after the slash, or null
 */
export function slashQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null;
  const rest = draft.slice(1);
  return /\s/.test(rest) ? null : rest;
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
 * What picking a skill writes into the composer.
 *
 * It ends in a space on purpose: the cursor lands after it and the reader
 * carries straight on with what they actually wanted, which is the sentence
 * the agent needs anyway. The skill is named exactly as the agent knows it,
 * namespace included, so the name in the message and the name in the system
 * prompt are the same string.
 *
 * @param skill the picked skill
 * @param lang  the reader's language
 * @returns the text to put in the composer
 */
export function invocationFor(skill: SkillOption, lang: Lang): string {
  return t(lang, "slash.invocation", { skill: skill.name }) + " ";
}
