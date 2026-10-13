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
// Card 587 adds /graph (old names /codegraph and /graphify) with build,
// update, show, ask and help; the page runs them (state/graphCommand.ts).
//
// Card 588, fix round: command words are read in any case, by the parse, the
// offer and the template alike; the words after them keep the case typed.
//
// Before the list has arrived a draft that starts with a slash is held
// (criterion 8h): the composer keeps it and sends nothing, because it cannot
// yet tell a command from a prompt.
//
// Pure, so the suite pins it in node; the picker and the composer read it.

import type { ClientMessage } from "../events";
import { t, type Lang } from "../i18n/i18n";
import { helpOf, webCommands, type CommandRow } from "./commandList";
import { pairSafeCut } from "../pairSafeCut";
import type { Picks } from "./playbookPicks";
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
const LOOP_STOP = /^\/loop\s+stop$/i;
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
 * does not list a row. Card 588, fix round: the spellings match in any case
 * here, where the core and the terminal still match them as written.
 *
 * @param draft the composer's text, untrimmed
 * @param rows  the command list
 * @returns the row and the trimmed rest, or null
 */
export function parseSlash(draft: string, rows: readonly CommandRow[]): SlashMatch | null {
  const text = draft.trim();
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  const lower = body.toLowerCase();
  let best: SlashMatch | null = null;
  let bestLength = -1;
  for (const row of webCommands(rows)) {
    for (const spelling of spellingsOf(row)) {
      const hit = lower === spelling || lower.startsWith(`${spelling} `) || lower.startsWith(`${spelling}\n`);
      if (hit && spelling.length > bestLength) {
        best = { row, rest: body.slice(spelling.length).trim() };
        bestLength = spelling.length;
      }
    }
  }
  return best;
}

/** Card 587: what /graph does: its five subcommands. */
export type GraphAction = "build" | "update" | "show" | "ask" | "help";

/** Card 587: the subcommands, in the order of the list. */
export const GRAPH_ACTIONS: readonly GraphAction[] = ["build", "update", "show", "ask", "help"];

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
  | { kind: "runWorkflow"; name: string; input: string }
  | { kind: "graph"; action: GraphAction; question: string };

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
  "graph",
  "graph-build",
  "graph-update",
  "graph-show",
  "graph-ask",
  "graph-help",
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
    // Card 587: an old name reaches the parent row, so the parent reads its
    // subcommand from the rest; the sub rows carry theirs.
    case "graph":
      return graphDecision(rest === "" ? "help" : rest, text);
    case "graph-build":
    case "graph-update":
    case "graph-show":
    case "graph-help":
    case "graph-ask":
      return graphDecision(`${row.id.slice("graph-".length)} ${rest}`.trim(), text);
    default: {
      const whole = WHOLE[row.id];
      return whole !== undefined && rest === "" ? whole : { kind: "prompt", text };
    }
  }
}

/**
 * Card 587: the decision for the words after /graph: a subcommand, the
 * question after ask, or the prompt the draft is when a subcommand that takes
 * no words is followed by some (card 471's rule) or no subcommand is named.
 *
 * @param words the subcommand and what follows it, trimmed
 * @param text  the whole draft, trimmed, for the prompt
 */
function graphDecision(words: string, text: string): DraftDecision {
  const space = words.search(/\s/);
  const sub = space < 0 ? words : words.slice(0, space);
  const after = space < 0 ? "" : words.slice(space).trim();
  const action = GRAPH_ACTIONS.find((a) => a === sub.toLowerCase());
  if (action === undefined) return { kind: "prompt", text };
  if (action === "ask") return { kind: "graph", action, question: after };
  return after === "" ? { kind: "graph", action, question: "" } : { kind: "prompt", text };
}

/** Card 588: what the picker offers for a draft at the caret. */
export interface CommandOffer {
  /** The rows to pick from, grouped in the list's order of groups, the exact one first in its group. */
  rows: CommandRow[];
  /** The row whose words are being typed, for its template; null while a command is still being picked. */
  writing: CommandRow | null;
}

/** A command word as the list spells it; a skill name with a colon is none. */
const WORD = /^[a-z0-9-]*$/;

/** The words of a spelling: one, or the name and the second word. */
const wordsOf = (spelling: string): string[] => spelling.split(" ");

/**
 * Card 588: what the picker offers for the draft up to the caret.
 *
 * Only a slash that opens the draft offers commands: a command is the whole
 * message. While the first word is typed, one row per command whose one-word
 * spelling starts with it (a subcommand only through a one-word alias of its
 * own, such as /run-workflow, and never on a bare slash). Once the first word
 * names a command, its subcommands follow it, the command first: on the name
 * itself, after its space, and narrowed by the second word. A two-word alias
 * (/playbook run) counts as a subcommand of its first word, and an old name
 * (/codegraph) reaches the subcommands of the command it names. Past the
 * command's words no row is offered, and `writing` names the command whose
 * words are being typed, so the picker can show its template.
 *
 * Fix round: a pick writes over the text before the caret, so rows are
 * offered only where nothing but blanks follows the caret. With the caret
 * inside a draft, `writing` names the command the whole draft spells and no
 * row is offered, so Enter stays the composer's.
 *
 * @param draft the composer's text
 * @param caret the caret position inside it
 * @param rows  the command list
 * @param mode  the window's mode; the developer rows only in developer
 * @returns the offer, or null when the draft up to the caret is no command
 */
export function offerCommands(
  draft: string,
  caret: number,
  rows: readonly CommandRow[],
  mode: ViewMode,
): CommandOffer | null {
  const text = pairSafeCut(draft, caret);
  if (!text.startsWith("/") || /[\r\n\t]/.test(text)) return null;
  const shown = webCommands(rows, mode);
  if (draft.slice(caret).trim() !== "") {
    return { rows: [], writing: writingOf(`${draft.trim().slice(1).replace(/\s+/g, " ")} `, shown) };
  }
  const words = text.slice(1).toLowerCase().split(" ");
  const first = words[0] ?? "";
  if (words.length === 1) {
    if (!WORD.test(first)) return { rows: [], writing: null };
    const own = shown.filter((row) =>
      spellingsOf(row).some(
        (s) => wordsOf(s).length === 1 && s.startsWith(first) && (row.sub === null || first !== ""),
      ),
    );
    const parent = parentOf(first, shown);
    return {
      rows: grouped(parent === null ? own : [...own, ...subsOf(parent, first, "", shown)], first),
      writing: null,
    };
  }
  if (words.length === 2 && WORD.test(first) && WORD.test(words[1] ?? "")) {
    const second = words[1] ?? "";
    const parent = parentOf(first, shown);
    if (parent !== null) {
      const subs = subsOf(parent, first, second, shown);
      if (subs.length > 0) {
        return {
          rows: grouped(second === "" ? [parent, ...subs] : subs, `${first} ${second}`),
          writing: null,
        };
      }
    }
  }
  return { rows: [], writing: writingOf(text.slice(1), shown) };
}

/**
 * Card 588, round 2: whether the first word of a draft names a command, by a
 * row's name or the first word of an alias, in any case and in every mode, as
 * the composer reads it. Inside such a draft the picker writes nothing over
 * that word, so Enter sends the draft.
 *
 * @param draft the composer's text
 * @param rows  the command list
 * @returns true when the draft opens with a slash and a command's first word
 */
export function opensWithCommand(draft: string, rows: readonly CommandRow[]): boolean {
  const text = draft.trimStart();
  if (!text.startsWith("/")) return false;
  const first = (text.slice(1).split(/\s/)[0] ?? "").toLowerCase();
  if (first === "") return false;
  return webCommands(rows).some((row) => spellingsOf(row).some((spelling) => wordsOf(spelling)[0] === first));
}

/** The row without a second word that a first word names, by its name or a one-word alias. */
function parentOf(first: string, shown: readonly CommandRow[]): CommandRow | null {
  return (
    shown.find(
      (row) => row.sub === null && spellingsOf(row).some((s) => wordsOf(s).length === 1 && s === first),
    ) ?? null
  );
}

/** The rows spelled with two words under a parent, by its name or the word typed for it. */
function subsOf(
  parent: CommandRow,
  typed: string,
  second: string,
  shown: readonly CommandRow[],
): CommandRow[] {
  return shown.filter((row) =>
    spellingsOf(row).some((s) => {
      const [w1, w2] = wordsOf(s);
      return w2 !== undefined && (w1 === parent.name || w1 === typed) && w2.startsWith(second);
    }),
  );
}

/**
 * The row whose words a draft past the picking types: its longest spelling
 * followed by a space, in any case. A parent reached by an old name hands on
 * to its subcommand when the next word names one (/codegraph ask names
 * /graph ask).
 */
function writingOf(typed: string, shown: readonly CommandRow[]): CommandRow | null {
  const body = typed.toLowerCase();
  let best: CommandRow | null = null;
  let bestLength = -1;
  for (const row of shown) {
    for (const spelling of spellingsOf(row)) {
      if (body.startsWith(`${spelling} `) && spelling.length > bestLength) {
        best = row;
        bestLength = spelling.length;
      }
    }
  }
  if (best !== null && best.sub === null) {
    const rest = body.slice(bestLength + 1);
    const space = rest.indexOf(" ");
    const named = space > 0 ? rest.slice(0, space) : null;
    const parent = best;
    const child = named === null ? undefined : shown.find((r) => r.name === parent.name && r.sub === named);
    if (child !== undefined) return child;
  }
  return best;
}

/** The rows once each, grouped in the order the groups first appear, the one spelled exactly first in its group. */
function grouped(rows: readonly CommandRow[], typed: string): CommandRow[] {
  const once = [...new Set(rows)];
  const groups = [...new Set(once.map((row) => row.group))];
  const exact = (row: CommandRow): number => (spellingsOf(row).includes(typed) ? 0 : 1);
  return groups.flatMap((group) =>
    once
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
 *
 * Card 584: the models picked per step in the sheet, for this run only; the
 * field is left out when nothing was picked. The server checks them again.
 * The second fix round adds ask, the id the server's refusal of this start
 * answers with.
 */
export function startPlaybookFrame(
  dir: string,
  hash: string,
  prompt: string,
  picks: Picks = {},
  ask?: string,
): ClientMessage {
  return {
    type: "start_playbook",
    dir,
    hash,
    prompt,
    ...(Object.keys(picks).length === 0 ? {} : { picks }),
    ...(ask === undefined ? {} : { ask }),
  };
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

/**
 * Card 587: /graph ask on the session's own socket. The server checks the
 * folder's graph and runs the question with a line for the graph tool.
 */
export function graphAskFrame(question: string): ClientMessage {
  return { type: "graph_ask", question };
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
      lines.push(`${names}: ${helpOf(row, lang)}`);
    }
  }
  return lines.join("\n");
}
