// The web chat's commands (card 471): /compact and /clear. Card 504 adds
// /loop [interval] <prompt>, the one command that takes words after it.
// Card 554 reads every command from the core list the server serves
// (state/commandList.ts): /help, /skills and the playbook commands join, a
// command may have a second word (/playbook list) and aliases (/commands for
// /help, /playbook run for /run-with-playbook).
//
// A command is not a skill and not a prompt. A skill token rides inside a
// message and the server expands it for the model (card 247); a command is the
// whole draft, it is decided here on the client, and it leaves as its own
// socket frame or is answered on the page. Nothing about it ever reaches the
// model as text.
//
// The rule is deliberately narrow: the draft, trimmed, opens with a spelling
// of a command, and a command that takes no words is the whole draft. "please
// /clear the cache" and "/clear the cache" are prompts, so a sentence that
// happens to mention a command is sent as written.
//
// Before the list has arrived a draft that starts with a slash is held
// (criterion 8h): the composer keeps it and sends nothing, because it cannot
// yet tell a command from a prompt.
//
// Pure, so the suite pins it in node; the picker and the composer read it.

import type { ClientMessage } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { webCommands, type CommandRow } from "./commandList";
import type { ViewMode } from "./viewMode";

/** The two commands that leave as a frame of their own (card 471). */
export type ChatCommandName = "compact" | "clear";

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

/** Card 554: how a row is typed, without the slash: its name and second word, then its aliases. */
export function spellingsOf(row: CommandRow): string[] {
  return [row.sub === null ? row.name : `${row.name} ${row.sub}`, ...row.aliases];
}

/** Card 554: a draft read as a row of the list, and the words after the spelling. */
export interface SlashMatch {
  row: CommandRow;
  rest: string;
}

/**
 * Card 554: the web row a draft opens with. The longest spelling or alias the
 * draft starts with wins when the end of the draft, a space or a line break
 * follows it, the rule of CommandList.match in the core: "/playbook run x"
 * names run-with-playbook, "/playbook" alone the current playbook row. Only
 * the web's wired rows count, in every mode: typing works where the picker
 * does not list a row.
 *
 * @param draft the composer's text, untrimmed
 * @param rows  the command list
 * @returns the row and the trimmed rest, or null
 */
export function parseSlash(draft: string, rows: readonly CommandRow[]): SlashMatch | null {
  const text = draft.trim();
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  let best: SlashMatch | null = null;
  let bestLength = -1;
  for (const row of webCommands(rows)) {
    for (const spelling of spellingsOf(row)) {
      const hit = body === spelling || body.startsWith(`${spelling} `) || body.startsWith(`${spelling}\n`);
      if (hit && spelling.length > bestLength) {
        best = { row, rest: body.slice(spelling.length).trim() };
        bestLength = spelling.length;
      }
    }
  }
  return best;
}

/** The decisions card 471 and card 504 made: a command, a prompt, a loop or its stop. */
export type ComposerSubmit =
  | { kind: "command"; name: ChatCommandName }
  | { kind: "prompt"; text: string }
  | ({ kind: "loop" } & LoopDraft)
  | { kind: "loopStop" };

/**
 * Card 554: the composer's decision for one submit, against the command list.
 * `held` is criterion 8h: the list has not arrived and the draft starts with a
 * slash. The playbook kinds leave as frames of the session; help, skills and
 * the current, list and show rows are answered on the page.
 */
export type DraftDecision =
  | ComposerSubmit
  | { kind: "held" }
  | { kind: "help" }
  | { kind: "skills" }
  | { kind: "runPlaybook"; prompt: string }
  | { kind: "playbookCurrent" }
  | { kind: "playbookList" }
  | { kind: "playbookShow"; name: string }
  | { kind: "playbookUse"; name: string }
  | { kind: "runWorkflow"; name: string; input: string };

/**
 * Card 554: the ids of the rows the web knows how to run. Every wired web row
 * of the core list is one of them (chatCommands.test.ts reads the list).
 */
export const WEB_COMMAND_IDS = [
  "help",
  "compact",
  "clear",
  "loop",
  "run-with-playbook",
  "playbook-current",
  "playbook-list",
  "playbook-show",
  "playbook-use",
  "playbook-workflow",
  "skills",
] as const;

/** The decision for a row that takes no words: the row when the draft is the whole command, else a prompt. */
const WHOLE: Partial<Record<string, DraftDecision>> = {
  help: { kind: "help" },
  compact: { kind: "command", name: "compact" },
  clear: { kind: "command", name: "clear" },
  skills: { kind: "skills" },
  "playbook-current": { kind: "playbookCurrent" },
  "playbook-list": { kind: "playbookList" },
};

/**
 * Card 554: the composer's decision for one submit.
 *
 * @param draft the composer's text, untrimmed
 * @param rows  the command list, or null while it has not arrived
 * @returns the decision, or null for a blank draft
 */
export function decideDraft(draft: string, rows: readonly CommandRow[] | null): DraftDecision | null {
  const text = draft.trim();
  if (text === "") return null;
  if (rows === null) return text.startsWith("/") ? { kind: "held" } : { kind: "prompt", text };
  const match = parseSlash(draft, rows);
  if (match === null) return { kind: "prompt", text };
  const { row, rest } = match;
  switch (row.id) {
    case "loop": {
      // Fix round 1: /loop stop ends the loop, as the REPL reads it.
      if (LOOP_STOP.test(text)) return { kind: "loopStop" };
      const loop = parseLoop(text.replace(/^\/\S+/, "/loop"));
      return loop === null ? { kind: "prompt", text } : { kind: "loop", ...loop };
    }
    case "run-with-playbook":
      return { kind: "runPlaybook", prompt: rest };
    case "playbook-use":
      return { kind: "playbookUse", name: rest };
    // Integrator decision a: /playbook show [name], any registered playbook.
    case "playbook-show":
      return { kind: "playbookShow", name: rest };
    case "playbook-workflow": {
      const space = rest.search(/\s/);
      return space < 0
        ? { kind: "runWorkflow", name: rest, input: "" }
        : { kind: "runWorkflow", name: rest.slice(0, space), input: rest.slice(space).trim() };
    }
    default: {
      const whole = WHOLE[row.id];
      return whole !== undefined && rest === "" ? whole : { kind: "prompt", text };
    }
  }
}

/**
 * Card 554: the rows a slash query offers in the picker.
 *
 * Only a slash that opens the draft offers any: a command is the whole
 * message, so offering one in the middle of a sentence would offer something
 * that, once picked, is a prompt. A row is offered when one of its spellings
 * starts with the query; the rows come grouped in the list's order of groups,
 * and inside a group a row the query spells out exactly comes first.
 *
 * @param query   the text after the slash, any case
 * @param slashAt where the slash stands in the draft
 * @param rows    the command list
 * @param mode    the window's mode; the developer rows only in developer
 * @returns the rows to offer
 */
export function matchCommands(
  query: string,
  slashAt: number,
  rows: readonly CommandRow[],
  mode: ViewMode,
): CommandRow[] {
  if (slashAt !== 0) return [];
  const needle = query.toLowerCase();
  const shown = webCommands(rows, mode).filter((row) => spellingsOf(row).some((s) => s.startsWith(needle)));
  const groups = [...new Set(shown.map((row) => row.group))];
  const exact = (row: CommandRow): number => (spellingsOf(row).includes(needle) ? 0 : 1);
  return groups.flatMap((group) =>
    shown
      .map((row, at) => ({ row, at }))
      .filter(({ row }) => row.group === group)
      .sort((a, b) => exact(a.row) - exact(b.row) || a.at - b.at)
      .map(({ row }) => row),
  );
}

/**
 * The socket frame /compact or /clear leaves as.
 *
 * @param name the command
 * @returns its client frame; never a user_message
 */
export function commandFrame(name: ChatCommandName): ClientMessage {
  return name === "compact" ? { type: "compact_context" } : { type: "clear_context" };
}

/**
 * Card 554: /run-with-playbook asks the server for the start sheet. Without a
 * folder the server takes the session's pick, else the folder pinned for the
 * workspace, else refuses with the way to pick one.
 *
 * @param prompt the words after the command; the server refuses an empty one with the usage
 * @param dir    a playbook folder, only when one was chosen for this start
 */
export function confirmPlaybookFrame(prompt: string, dir?: string): ClientMessage {
  return dir === undefined ? { type: "confirm_playbook", prompt } : { type: "confirm_playbook", prompt, dir };
}

/**
 * Card 554: Start on the sheet. The hash is the one the sheet showed; the
 * server reads the folder again and refuses a mismatch.
 */
export function startPlaybookFrame(dir: string, hash: string, prompt: string): ClientMessage {
  return { type: "start_playbook", dir, hash, prompt };
}

/**
 * Card 554: a workflow of the session's playbook, by the file name below
 * workflows/ without its extension; it runs at once (owner answer 2).
 */
export function startWorkflowFrame(name: string, input: string, lang: Lang, dir?: string): ClientMessage {
  return dir === undefined
    ? { type: "start_workflow", name, input, lang }
    : { type: "start_workflow", name, input, lang, dir };
}

/** Card 554: the playbook picked for the session, or null to withdraw the pick. */
export function setPlaybookFrame(dir: string | null): ClientMessage {
  return { type: "set_playbook", dir };
}

/**
 * Card 554, integrator decision b: "No playbook" for the session. Unlike a
 * withdrawn pick, the folder pinned for the workspace does not stand in, and
 * /run-with-playbook is refused.
 */
export function noPlaybookFrame(): ClientMessage {
  return { type: "set_playbook", dir: null, none: true };
}

/**
 * Card 554: what /help answers, on the page: every row of the web chat,
 * grouped under its group's name, each line the spellings and the help in
 * the page's language. Integrator decision c: outside developer mode the
 * developer rows are listed too, under their group marked "developer mode";
 * only the picker keeps them to developer mode.
 *
 * @param rows the command list
 * @param lang the page's language
 * @param mode the window's mode
 * @returns the text of one info line, its lines joined by line breaks
 */
export function helpText(rows: readonly CommandRow[], lang: Lang, mode: ViewMode): string {
  const shown = webCommands(rows);
  const lines = [t(lang, "cmd.helpTitle")];
  for (const group of [...new Set(shown.map((row) => row.group))]) {
    const inGroup = shown.filter((r) => r.group === group);
    // A group with a developer row is marked as a whole; today the playbook
    // group is the only one, and all its rows are developer rows.
    const marked = mode !== "developer" && inGroup.some((r) => r.developerOnly);
    const name = t(lang, `cmd.group.${group}`);
    lines.push("", marked ? t(lang, "cmd.devMark", { group: name }) : name);
    for (const row of inGroup) {
      const names = spellingsOf(row)
        .map((s) => `/${s}`)
        .join(", ");
      lines.push(`${names}: ${t(lang, `cmd.${row.id}.help`)}`);
    }
  }
  return lines.join("\n");
}
