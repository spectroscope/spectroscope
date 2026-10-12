// The web chat's commands (card 471): /compact and /clear. Card 504 adds
// /loop [interval] <prompt>, the one command that takes words after it.
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
  name: ChatCommandName | "loop";
  /** The dict key of its one-line help. */
  helpKey: string;
  /** Card 504: true for a command that takes words; the picker writes it into the draft instead of running it. */
  takesArgs?: boolean;
}

/** The commands, in the order the picker lists them. */
export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: "compact", helpKey: "cmd.compact.help" },
  { name: "clear", helpKey: "cmd.clear.help" },
  { name: "loop", helpKey: "cmd.loop.help", takesArgs: true },
];

/** Card 504: a /loop draft: a leading interval, or null for a self paced loop, and the prompt. */
export interface LoopDraft {
  intervalSeconds: number | null;
  prompt: string;
}

const LOOP = /^\/loop(?:\s+([\s\S]*))?$/;
const INTERVAL = /^(\d{1,7})([smhd])(?:\s+([\s\S]*))?$/;
const LOOP_STOP = /^\/loop\s+stop$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Card 504: the /loop a whole draft is, or null when it is no /loop. The
 * same rule as the REPL's LoopCommand: a leading token of digits and one of
 * s, m, h or d is the interval. An empty prompt still parses; the server
 * answers it with the usage line.
 *
 * @param draft the composer's text, untrimmed
 * @returns the loop, or null
 */
export function parseLoop(draft: string): LoopDraft | null {
  const m = LOOP.exec(draft.trim());
  if (m === null) return null;
  const rest = (m[1] ?? "").trim();
  const interval = INTERVAL.exec(rest);
  if (interval !== null) {
    return {
      intervalSeconds: Number(interval[1]) * (UNIT_SECONDS[interval[2]] ?? 1),
      prompt: (interval[3] ?? "").trim(),
    };
  }
  return { intervalSeconds: null, prompt: rest };
}

/**
 * Card 504: the frame a /loop leaves as.
 *
 * @param loop the parsed draft
 * @returns its set_loop frame; the interval only when one was given
 */
export function loopFrame(loop: LoopDraft): ClientMessage {
  return loop.intervalSeconds === null
    ? { type: "set_loop", action: "start", prompt: loop.prompt }
    : { type: "set_loop", action: "start", prompt: loop.prompt, intervalSeconds: loop.intervalSeconds };
}

/**
 * Card 504, fix round 1: the frame /loop stop leaves as.
 *
 * @returns the set_loop frame that ends the session's loop
 */
export function loopStopFrame(): ClientMessage {
  return { type: "set_loop", action: "stop" };
}

/**
 * The command a whole draft is, or null when it is a prompt.
 *
 * @param draft the composer's text, untrimmed
 * @returns the command's name, or null
 */
export function parseCommand(draft: string): ChatCommandName | null {
  const text = draft.trim();
  for (const command of CHAT_COMMANDS) {
    if (command.takesArgs) continue;
    if (text === `/${command.name}`) return command.name as ChatCommandName;
  }
  return null;
}

/** What a submit of the draft sends: a command, a prompt, or nothing. */
export type ComposerSubmit =
  | { kind: "command"; name: ChatCommandName }
  | { kind: "prompt"; text: string }
  | ({ kind: "loop" } & LoopDraft)
  | { kind: "loopStop" };

/**
 * The composer's decision for one submit.
 *
 * @param draft the composer's text, untrimmed
 * @returns the command, the trimmed prompt, or null for a blank draft
 */
export function composerSubmit(draft: string): ComposerSubmit | null {
  const command = parseCommand(draft);
  if (command !== null) return { kind: "command", name: command };
  // Fix round 1: /loop stop ends the loop, as the REPL reads it.
  if (LOOP_STOP.test(draft.trim())) return { kind: "loopStop" };
  const loop = parseLoop(draft);
  if (loop !== null) return { kind: "loop", ...loop };
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
