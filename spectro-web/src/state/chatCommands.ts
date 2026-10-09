// The web chat's commands (card 471): /compact and /clear.
//
// A command is not a skill and not a prompt. A skill token rides inside a
// message and the server expands it for the model (card 247); a command is the
// whole draft, it is decided here on the client, and it leaves as its own
// socket frame. Nothing about it ever reaches the model as text.
//
// The rule is deliberately narrow: the draft, trimmed, must be exactly one of
// the commands. "please /clear the cache" and "/clear the cache" are prompts,
// so a sentence that happens to mention a command is sent as written.
//
// Pure, so the suite pins it in node; the picker and the composer read it.

import type { ClientMessage } from "../events";

export type ChatCommandName = "compact" | "clear";

/** One command as the picker lists it. */
export interface ChatCommand {
  name: ChatCommandName;
  /** The dict key of its one-line help. */
  helpKey: string;
}

/** The commands, in the order the picker lists them. */
export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: "compact", helpKey: "cmd.compact.help" },
  { name: "clear", helpKey: "cmd.clear.help" },
];

/**
 * The command a whole draft is, or null when it is a prompt.
 *
 * @param draft the composer's text, untrimmed
 * @returns the command's name, or null
 */
export function parseCommand(draft: string): ChatCommandName | null {
  const text = draft.trim();
  for (const command of CHAT_COMMANDS) {
    if (text === `/${command.name}`) return command.name;
  }
  return null;
}

/** What a submit of the draft sends: a command, a prompt, or nothing. */
export type ComposerSubmit = { kind: "command"; name: ChatCommandName } | { kind: "prompt"; text: string };

/**
 * The composer's decision for one submit.
 *
 * @param draft the composer's text, untrimmed
 * @returns the command, the trimmed prompt, or null for a blank draft
 */
export function composerSubmit(draft: string): ComposerSubmit | null {
  const command = parseCommand(draft);
  if (command !== null) return { kind: "command", name: command };
  const text = draft.trim();
  return text === "" ? null : { kind: "prompt", text };
}

/**
 * The commands a slash query offers.
 *
 * Only a slash that opens the draft offers any: a command is the whole
 * message, so offering one in the middle of a sentence would offer something
 * that, once picked, is a prompt.
 *
 * @param query     the text after the slash, any case
 * @param slashAt   where the slash stands in the draft
 * @returns the commands whose name starts with the query, in list order
 */
export function matchCommands(query: string, slashAt: number): ChatCommand[] {
  if (slashAt !== 0) return [];
  const needle = query.toLowerCase();
  return CHAT_COMMANDS.filter((command) => command.name.startsWith(needle));
}

/**
 * The socket frame a command leaves as.
 *
 * @param name the command
 * @returns its client frame; never a user_message
 */
export function commandFrame(name: ChatCommandName): ClientMessage {
  return name === "compact" ? { type: "compact_context" } : { type: "clear_context" };
}
