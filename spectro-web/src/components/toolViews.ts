// The structured tool view (card 94): a tool call is not two JSON blobs, it is
// a SHAPE — a file being read, an edit, a listing, a command in a terminal, a
// decision put to a person.
// This module names that shape; the card renders it. Pure and DOM-free, so the
// mapping is unit-tested while the pixels stay in ToolCard.
//
// Honesty rule: a tool whose input does not carry the fields the shape needs
// falls back to `generic` (the raw pair). We never render an empty pretty card
// over a payload we did not understand — the model can send anything.

import { hlLangForFence, hlLangForPath, tokenize, type HlLang } from "../workspace/highlight";
import { formatDuration, formatTokens } from "../format";

/** One tool call, described as what it actually is. */
export type ToolView =
  | { kind: "file"; path: string; range: string | null; body: string; lineCount: number }
  | { kind: "write"; path: string; content: string; result: string }
  | { kind: "edit"; path: string; before: string; after: string; result: string }
  | { kind: "listing"; path: string; entries: string[] }
  | { kind: "matches"; pattern: string; path: string | null; lines: string[] }
  | { kind: "command"; command: string; output: string; failed: boolean }
  | { kind: "image"; source: string | null; prompt: string | null; preview: string | null; result: string }
  | { kind: "skill"; name: string; body: string }
  | { kind: "mcp"; server: string; tool: string; input: unknown; output: string }
  | { kind: "agents"; children: SpawnedAgent[]; result: string }
  | { kind: "plan"; steps: PlanRow[] }
  | { kind: "task"; op: TaskOp; rows: TaskRow[]; wrote: Wrote; result: string }
  | { kind: "question"; questions: AskedQuestion[] }
  | { kind: "web"; url: string | null; query: string | null; body: string }
  | {
      kind: "workflow";
      name: string | null;
      description: string | null;
      phases: string[];
      script: string | null;
      scriptPath: string | null;
      args: unknown;
      stage: WorkflowStage;
      run: WorkflowRun | null;
      result: string;
    }
  | { kind: "generic"; input: unknown; output: string };

/** One child of a fan-out. `label` is the short headline some vocabularies send
 *  next to the full task (Claude Code's `description`); null when there is none. */
export type SpawnedAgent = { type: string; task: string; label: string | null };

/** One plan step. `status` stays the English wire value (or null when the call
 *  omitted it) — the chrome translates, the data does not. */
export type PlanRow = { text: string; status: string | null };

/** What a call did to the task list. The verb is the view's own heading, and it
 *  is the only thing that separates the three: all of them describe tasks. */
export type TaskOp = "create" | "update" | "list";

/**
 * One task, as far as ONE call knew it. Every field but the id is null or empty
 * when this call did not carry it, and that asymmetry is the shape rather than a
 * gap in it: a creation knows a description and no state, a status update knows
 * a state and no words, a roster line knows both and no description. Nothing is
 * carried over from a neighbouring call, because a tool card describes its own
 * call and the list it belongs to is not in the payload.
 *
 * `status` stays the wire value (`in_progress`, `completed`); the chrome
 * translates it, the record does not.
 */
export type TaskRow = {
  id: string | null;
  subject: string | null;
  description: string | null;
  status: string | null;
  blockedBy: string[];
};

/**
 * What an update's result said it wrote:
 *   named    it listed the fields it changed
 *   nothing  it confirmed the update and listed NO field — the call set a value
 *            the task already had, so nothing moved. Twice in 434 observed
 *            updates, and the only case where the outcome contradicts the input
 *   silent   there is no result yet, or it is worded in a way this cannot read
 *            (an error). Also every creation and every listing, neither of which
 *            reports fields at all
 *
 * The fields themselves are not carried. When the result names them they repeat
 * what the row already shows — the new subject, the new state, the dependency —
 * so a list of their names underneath would be a second, worse copy. What is
 * worth a reader's eye is only the case where the result named none.
 */
export type Wrote = "named" | "nothing" | "silent";

/** One choice offered for a question. `chosen` is only ever true when the result
 *  named this label EXACTLY: the mark is a claim about what a person picked, and
 *  a near miss is not one. `preview` is the multi-line sample some options carry
 *  under their description. */
export type QuestionOption = {
  label: string;
  description: string | null;
  preview: string | null;
  chosen: boolean;
};

/**
 * How to read a question's `answer`:
 *   option     the answer names labels, and those options carry `chosen`
 *   text       a reply of the person's own words; no option matched
 *   dismissed  the question was closed without choosing
 *   none       nothing came back for this question
 *
 * `none` is not the same as an empty answer, and it is not the same as no
 * question: a call can be interrupted, and a question that was asked and left
 * hanging has to read that way.
 */
export type Answered = "option" | "text" | "dismissed" | "none";

/** One question of an ask, with its options and what became of it. */
export type AskedQuestion = {
  header: string | null;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
  /** The answer worded as the result worded it; null exactly when `answered`
   *  is "none". */
  answer: string | null;
  answered: Answered;
};

/** The first of several string fields that is present — the same value travels
 *  under different names depending on which agent wrote the session
 *  (spectroscope says `path`, a VS Code export says `filePath`). */
function firstStr(input: unknown, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = str(input, key);
    if (value !== null) return value;
  }
  return null;
}

/** A string field of the input object, or null when absent/not a string. */
function str(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** A number field of the input object, or null. */
function num(input: unknown, key: string): number | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

/** Non-empty lines of a tool output — listings and searches are line-shaped. */
function lines(output: string): string[] {
  return output.split("\n").filter((l) => l.trim() !== "");
}

/** The array under the first of several keys, or null when none holds one. */
function arr(input: unknown, ...keys: string[]): unknown[] | null {
  if (typeof input !== "object" || input === null) return null;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Server and tool of a composed MCP name, splitting on the FIRST and SECOND
 * `__` only — a tool is free to carry underscores, single or double, in its own
 * name (`mcp__ccd_session__mark_chapter`, `mcp__srv__a__b`).
 *
 * @param name the tool's wire name
 * @return the two halves, or null when either is missing or empty
 */
function splitMcp(name: string): { server: string; tool: string } | null {
  const PREFIX = "mcp__";
  if (!name.startsWith(PREFIX)) return null;
  const sep = name.indexOf("__", PREFIX.length);
  if (sep < 0) return null;
  const server = name.slice(PREFIX.length, sep);
  const tool = name.slice(sep + 2);
  if (server === "" || tool === "") return null;
  return { server, tool };
}

/** A bundled demo asset (a scripted scenario's image), app-served as-is. */
const DEMO_PREFIX = "/demo/";

/** The image store's file-name contract, mirrored from the server's
 *  SessionsController.IMAGE_NAME — the endpoint answers 400 for anything else. */
const STORED_IMAGE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

/**
 * The path only when the browser can actually fetch it as an image.
 *
 * GET /api/images/{file} serves the content-addressed store and nothing else,
 * so a workspace file (view_image's usual argument) has no URL at all. Handing
 * one to an <img> would fire a guaranteed 400 and then blame the placeholder,
 * which reads as "the file is gone" instead of "this was never servable".
 *
 * @param path the path a tool named, as it named it
 * @return the same path when it is fetchable, else null
 */
function previewable(path: string | null): string | null {
  if (path === null) return null;
  if (path.startsWith(DEMO_PREFIX)) return path;
  const file = path.slice(path.lastIndexOf("/") + 1);
  return STORED_IMAGE.test(file) ? path : null;
}

/** generate_image's summary line names the file it stored. Anchored on the
 *  full known prefix so a reworded or failed result yields null rather than a
 *  wrong path: the value is read out of the output, never reconstructed. */
const GENERATED_PATH = /^Image generated with .*?\)?: (\S+) \(/;

/** The stored blob path of a finished generation, or null. */
function generatedPath(output: string): string | null {
  return GENERATED_PATH.exec(output)?.[1] ?? null;
}

/**
 * One fan-out child from an entry that carries a type and a task under any of
 * the known vocabularies.
 *
 * @param entry one `agents[]` element, or the whole input for the single-child tools
 * @return the child, or null when either half is missing (the caller then falls back)
 */
function spawnedAgent(entry: unknown): SpawnedAgent | null {
  const type = firstStr(entry, "type", "subagent_type");
  const task = firstStr(entry, "task", "prompt");
  if (type === null || task === null) return null;
  return { type, task, label: str(entry, "description") };
}

/**
 * One plan row from a step object of either vocabulary (`text` for update_plan,
 * `content` for TodoWrite).
 *
 * @param entry one element of the steps/todos array
 * @return the row, or null when it carries no text
 */
function planRow(entry: unknown): PlanRow | null {
  const text = firstStr(entry, "text", "content");
  if (text === null) return null;
  return { text, status: str(entry, "status") };
}

/** `Task #3 created successfully: <subject>` — all 256 observed creations. The
 *  input never carries an id, so this line is the only place one exists; anchored
 *  on the full known wording so an error yields null rather than a wrong number. */
const TASK_CREATED = /^Task #(\d+) created successfully: /;

/** `Updated task #3 status` / `Updated task #3 subject, description` — and, when
 *  the value asked for was already the value there, `Updated task #3 ` with the
 *  list empty. Anchored at both ends: a result that is not this sentence is an
 *  error, and an error must not be read as a confirmation. */
const TASK_UPDATED = /^Updated task #(\d+) ?(.*)$/;

/** `#3 [in_progress] Logo-Set + Favicon` — one line of a printed roster. */
const TASK_ROW = /^#(\d+) \[([^\]]+)\] (.+)$/;

/**
 * A printed roster as rows.
 *
 * All or nothing, the rule the plan and the question already follow: one line
 * that does not parse would misstate the list's LENGTH as much as its content,
 * and a roster is read for both. A differently worded listing therefore falls
 * back to the raw pair instead of arriving one task short — which matters here,
 * because the corpus carries a single TaskList call and this wording is all the
 * evidence there is that it is the wording.
 *
 * @param out the tool result ("" while the call is still open)
 * @return the rows in printed order, or null when any line is not one
 */
function rosterRows(out: string): TaskRow[] | null {
  const rows: TaskRow[] = [];
  for (const line of lines(out)) {
    const m = TASK_ROW.exec(line);
    if (m === null) return null;
    rows.push({ id: m[1], subject: m[3], description: null, status: m[2], blockedBy: [] });
  }
  return rows;
}

/** The answer wording for a question that was closed without choosing. The
 *  harness writes the refusal INTO the answer slot, so without recognising it a
 *  dismissal would render as a reply that says "do not proceed". */
const DISMISSED = "[User dismissed";

/** The result echoes the chosen option's own preview after the answer's closing
 *  quote. Cut there before looking for that quote: a preview is arbitrary text
 *  and may carry quotes that would otherwise pass for the answer's end. */
const PREVIEW_ECHO = '" selected preview:';

/** `"<question>"="` — where one question's answer begins in the result. */
const answerAnchor = (question: string): string => `"${question}"="`;

/**
 * Each question's answer, read out of the single line of prose a finished ask
 * returns: a lead-in, then `"question"="answer"` pairs, then a closing
 * instruction.
 *
 * The questions are located by their OWN text, which the input already carries
 * exactly. Nothing here parses a question out of the prose, because both halves
 * are free text: a real question reads `the new "run a fleet" section` and a real
 * answer is a paragraph with commas and quotes in it, so any regex over the
 * sentence splits in the wrong place. An answer therefore ends where the NEXT
 * located question begins, whatever order the result lists them in — and a
 * question whose anchor is absent stays unanswered rather than borrowing its
 * neighbour's answer.
 *
 * @param questions the question texts, in the order the input listed them
 * @param out       the tool result ("" while the call is still open)
 * @return one answer per question, null where the result carries none
 */
function answersFor(questions: string[], out: string): (string | null)[] {
  const at = questions.map((q) => out.indexOf(answerAnchor(q)));
  const starts = at.filter((i) => i >= 0).sort((a, b) => a - b);
  return questions.map((q, i) => {
    const from = at[i];
    if (from < 0) return null;
    const head = from + answerAnchor(q).length;
    const region = out.slice(head, starts.find((s) => s > from) ?? out.length);
    const echo = region.indexOf(PREVIEW_ECHO);
    const body = echo < 0 ? region : region.slice(0, echo + 1);
    // The LAST quote, not the first: an answer is allowed to quote something.
    const close = body.lastIndexOf('"');
    return close < 0 ? body : body.slice(0, close);
  });
}

/**
 * The labels an answer names, or null when it does not name labels.
 *
 * Consumed label-first rather than split on the separator, because labels
 * contain commas themselves ("Ja, deployen", "Ehrlich formulieren, 100 später")
 * — splitting would turn one choice into two that match nothing. Longest label
 * first, so a label that starts with another still wins its own text.
 *
 * @param answer the answer text, trimmed
 * @param labels every label offered for this question
 * @return the named labels in the order the answer listed them, or null
 */
function labelRun(answer: string, labels: string[]): string[] | null {
  const byLength = labels.filter((l) => l !== "").sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let rest = answer;
  for (;;) {
    const hit = byLength.find((l) => rest === l || rest.startsWith(`${l},`));
    if (hit === undefined) return null;
    out.push(hit);
    if (rest === hit) return out;
    rest = rest.slice(hit.length + 1).trimStart();
  }
}

/** One offered choice, written either as a bare label or as an object. */
function questionOption(entry: unknown): QuestionOption | null {
  if (typeof entry === "string") {
    return entry === "" ? null : { label: entry, description: null, preview: null, chosen: false };
  }
  const label = str(entry, "label");
  if (label === null) return null;
  return { label, description: str(entry, "description"), preview: str(entry, "preview"), chosen: false };
}

/** Whether an object's key holds `true` — `multiSelect` is absent as often as
 *  it is false, and absent means single choice. */
function flag(input: unknown, key: string): boolean {
  if (typeof input !== "object" || input === null) return false;
  return (input as Record<string, unknown>)[key] === true;
}

/**
 * One question with its options, and its answer resolved against them.
 *
 * @param entry  one `questions[]` element
 * @param answer the answer read out of the result, or null when there was none
 * @return the question, or null when it has no text or an unreadable option
 */
function askedQuestion(entry: unknown, answer: string | null): AskedQuestion | null {
  const question = str(entry, "question");
  const raw = arr(entry, "options");
  if (question === null || raw === null || raw.length === 0) return null;
  const options = raw.map(questionOption);
  // One unreadable option would misstate what was on offer.
  if (options.some((o) => o === null)) return null;
  const offered = options as QuestionOption[];
  const base = {
    header: str(entry, "header"),
    question,
    multiSelect: flag(entry, "multiSelect"),
    options: offered,
  };
  if (answer === null) return { ...base, answer: null, answered: "none" };
  const trimmed = answer.trim();
  if (trimmed.startsWith(DISMISSED)) return { ...base, answer: trimmed, answered: "dismissed" };
  const named = labelRun(
    trimmed,
    offered.map((o) => o.label),
  );
  // A single-choice question whose answer reads as two labels is not a choice
  // it offered, so it stays the person's own words.
  if (named === null || (named.length > 1 && !base.multiSelect)) {
    return { ...base, answer: trimmed, answered: "text" };
  }
  const chosen = new Set(named);
  return {
    ...base,
    options: offered.map((o) => (chosen.has(o.label) ? { ...o, chosen: true } : o)),
    answer: trimmed,
    answered: "option",
  };
}

/** The raw value under a key, or undefined — the one reader that does not care
 *  what type it finds (an `args` bag is whatever the workflow declared). */
function field(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  return (input as Record<string, unknown>)[key];
}

/** One multi-line string field, lifted out of an input object to be rendered
 *  with real line breaks. `lang` is null unless the language is INFERABLE. */
export type TextBlock = { key: string; text: string; lang: HlLang | null };

/** An input object split into the shape a reader scans and the text they read. */
export type InputSplit = { shape: unknown; blocks: TextBlock[] };

/** Lines of a lifted field, ignoring a single trailing newline — a file ending
 *  in a break has as many lines as its last non-empty one. */
function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

/** Keys whose value is a shell command under every vocabulary the sessions
 *  actually carry (Bash, run_command, run_in_terminal, Monitor). */
const SHELL_KEYS = new Set(["command", "cmd"]);

/** Keys that hold a file's body, whose language comes from the file's NAME. */
const FILE_BODY_KEYS = new Set([
  "content",
  "body",
  "text",
  "code",
  "new_string",
  "newString",
  "old_string",
  "oldString",
]);

/** Keys whose value IS the thing a tool acts on, and the only fields a language
 *  read out of the tool's NAME may colour. A tool named for a language still
 *  carries prose beside its payload — an explanation, a description — and
 *  colouring that as code would be a claim about the wrong field. */
const OPERAND_KEYS = new Set(["text", "code", "script", "source", "snippet", "expression", "query"]);

/**
 * Language words a tool NAME may be trusted to declare.
 *
 * An allowlist rather than the fence table, which is where the conservatism
 * lives. That table also claims words that are ordinary in a tool's name:
 * `console` (shell) would paint `read_console_messages`, `less` (css) any
 * paging tool, `go` (go) every `go_to_page`, and `set`/`view`/`node` sit in
 * several vocabularies at once. Under-colouring costs a reader nothing; a block
 * painted as the wrong language reads as a lie about the code.
 *
 * The cost of the allowlist is that a newly registered language needs a line
 * here before a tool name can select it. Each entry is resolved through the
 * fence table, so a word for a language that is not registered yields plain.
 */
const NAME_LANGS = [
  "javascript",
  "typescript",
  "python",
  "sql",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "rust",
  "golang",
  "csharp",
  "php",
  "bash",
  "zsh",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "markdown",
];

/**
 * The language a tool's own name declares, or null.
 *
 * `mcp__Claude_Browser__javascript_tool` sends its script as `text` with no
 * language field and no sibling path, so the name is the only evidence the call
 * contains — and it is good evidence, because the tool half names the
 * operation. Only that half is read: a server's name describes a product, and
 * `Claude_Browser` says nothing about what any one payload holds.
 *
 * @param name the tool's wire name
 * @return the tokenizer language, or null when the name names none
 */
function langFromToolName(name: string): HlLang | null {
  const own = splitMcp(name)?.tool ?? name;
  for (const part of own.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (NAME_LANGS.includes(part)) {
      const hit = hlLangForFence(part);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * The language of one lifted field, or null when nothing in the call says.
 *
 * Order matters, strongest evidence first: a language the tool named itself, a
 * key whose meaning is fixed across tools, the file the value belongs to, and
 * only then the tool's own name. Everything else renders plain — a block
 * coloured as the wrong language reads as a lie about the code, which is worse
 * than reading as text.
 *
 * @param name  the tool's wire name
 * @param key   the field being lifted
 * @param input the whole input object (siblings carry the evidence)
 * @return the tokenizer language, or null to render plain
 */
function blockLang(name: string, key: string, input: unknown): HlLang | null {
  const declared = firstStr(input, "language", "lang");
  if (declared !== null) {
    const fenced = hlLangForFence(declared);
    if (fenced !== null) return fenced;
  }
  if (SHELL_KEYS.has(key)) return "shell";
  // The Workflow tool's contract: `script` is an ES module.
  if (name === "Workflow" && (key === "script" || key === "code")) return "javascript";
  if (FILE_BODY_KEYS.has(key)) {
    const path = firstStr(input, "path", "filePath", "file_path", "scriptPath");
    const fromPath = path === null ? null : hlLangForPath(path);
    if (fromPath !== null) return fromPath;
  }
  return OPERAND_KEYS.has(key) ? langFromToolName(name) : null;
}

/**
 * Split an input object into a JSON shape plus one block per multi-line string.
 *
 * JSON.stringify escapes newlines, so a single field carrying code or prose
 * turns the whole payload into one logical line of visible `\n`. Scalars and
 * one-line strings stay in the object (the shape is what makes a payload
 * legible at a glance); every multi-line string moves to its own block and
 * leaves a reference behind, so nothing is dropped and nothing is duplicated.
 *
 * Top level only. A lifted value's label is its key, and a nested field's key
 * says nothing about where it sat once the value is out of the tree.
 *
 * @param name  the tool's wire name (some keys mean different things per tool)
 * @param input the call's input, of any shape
 * @return the shape to print as JSON and the blocks to render as text
 */
/**
 * A one-line program, given the line breaks it never had.
 *
 * Minified code and code typed straight into a tool argument arrive as a single
 * line, so the well renders one endless string that wraps wherever the box ends.
 * This breaks it where a reader would: after a statement, after an opening
 * brace, before a closing one, with the depth carried as indentation.
 *
 * THE HAZARD, and why this reads tokens rather than characters: a semicolon or
 * a brace inside a string literal is DATA, and breaking there rewrites the
 * program. `tokenize` already tells strings and comments apart from code for
 * the highlighter, so only `plain` tokens are ever cut, and everything else is
 * copied through untouched. That is the same rule the source pane learned the
 * hard way: prettifying is allowed to change what a thing LOOKS like, never
 * what it says.
 *
 * Returns the input unchanged when the language is unknown, because a break
 * placed by guesswork is worse than a long line.
 */
export function breakOneLiner(src: string, lang: HlLang | null): string {
  if (lang === null || src.includes("\n")) return src;
  const out: string[] = [];
  let depth = 0;
  const pad = (): string => "  ".repeat(Math.max(0, depth));
  for (const tok of tokenize(src, lang)) {
    if (tok.cls !== "plain") {
      out.push(tok.text);
      continue;
    }
    for (const ch of tok.text) {
      if (ch === "}") {
        depth -= 1;
        out.push("\n" + pad() + ch);
      } else if (ch === "{") {
        depth += 1;
        out.push(ch + "\n" + pad());
      } else if (ch === ";") {
        out.push(ch + "\n" + pad());
      } else {
        out.push(ch);
      }
    }
  }
  // The breaks above leave a run of spaces wherever the source already had one,
  // and a trailing pad on the last line. Neither is part of the program.
  return out
    .join("")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Beyond this a single line stops being a value a reader scans and starts
 *  being a body they read. Measured against the shapes that prompted it: an
 *  MCP browser script runs 300 to 900 characters, a real one-line argument
 *  ("ls -la", a path, a query) is well under a hundred. */
const ONE_LINE_BODY_CHARS = 120;

export function splitInput(name: string, input: unknown): InputSplit {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { shape: input, blocks: [] };
  }
  const shape: Record<string, unknown> = {};
  const blocks: TextBlock[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string") {
      shape[key] = value;
      continue;
    }
    const lang = blockLang(name, key, input);
    // Two ways to earn a well: real line breaks, or enough code on one line
    // that leaving it in the shape hides it. The second needs a language,
    // because "long" alone would lift prose and a base64 blob as well.
    const lifted = value.includes("\n") || (lang !== null && value.length > ONE_LINE_BODY_CHARS);
    if (!lifted) {
      shape[key] = value;
      continue;
    }
    const text = breakOneLiner(value, lang);
    const n = lineCount(value);
    shape[key] = `... (${n} line${n === 1 ? "" : "s"} below)`;
    blocks.push({ key, text, lang });
  }
  return { shape, blocks };
}

/**
 * How far a launch got.
 *
 *   pending   the call has not returned; nothing was launched yet
 *   failed    the call came back as an error, so no run exists to wait for
 *   launched  it started and no outcome ever joined: still running, or abandoned
 *   done      the outcome is here, in `run`
 *
 * `launched` is the state this whole extension exists for. A workflow tool
 * result is a RECEIPT — it says the run was accepted and that a notification
 * will follow, and that notification is a separate message that lands minutes or
 * hours later, or never. Drawn without this distinction, a run that died at the
 * spend limit and a run nobody ever heard back from both read as complete.
 */
export type WorkflowStage = "pending" | "failed" | "launched" | "done";

/** One agent that did not return, as the outcome named it.
 *  `label` is the notification's own word for it (`fix:geometry`), `phase` the
 *  phase of the meta literal that label points at, and null when it points at
 *  none — a guess about where an agent sat would be a claim about the script. */
export type WorkflowFailure = { label: string | null; phase: string | null; reason: string };

/**
 * What became of a launch.
 *
 * Every counter is nullable, and that is the honesty: a number the outcome did
 * not report is UNKNOWN, not zero. Nought agents in error and no report of the
 * error count are opposite readings of the same card.
 */
export type WorkflowRun = {
  /** The wire word ("completed", "failed") — the chrome translates, not this. */
  status: string;
  agents: number | null;
  done: number | null;
  errors: number | null;
  skipped: number | null;
  empty: number | null;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  /** In the order the outcome listed them. Empty is not proof of a clean run:
   *  `errors` can be non-zero with nothing named. */
  failures: WorkflowFailure[];
  /** What the run returned. Arbitrarily long — the renderers place it last. */
  result: string;
};

/** The header a workflow script carries about itself. */
type WorkflowMeta = { name: string | null; description: string | null; phases: string[] };

const NO_META: WorkflowMeta = { name: null, description: null, phases: [] };

/** `export const meta = {` — with an optional type annotation, since the same
 *  literal is written in TypeScript too. */
const META_HEAD = /(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+meta[ \t]*(?::[^={]{0,80})?=[ \t]*\{/;

/** How far the scan will read looking for the literal's closing brace. A script
 *  is arbitrarily long and the header is at its top; without a bound a script
 *  with an unbalanced brace would be walked end to end on every render. */
const META_MAX = 8000;

/** One quoted literal's value under `key`, at the top level of the object text. */
const metaField = (flat: string, key: string): string | null => {
  const re = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`);
  const m = re.exec(flat);
  return m === null ? null : unquote(m[2]);
};

const ESCAPES: Record<string, string> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  "`": "`",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** A code-point escape, in all three spellings JavaScript allows. */
const CODEPOINT = /^(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2})$/;

/** A source literal is not JSON (it may be single-quoted or a template), so the
 *  escapes are undone by hand. An unknown escape keeps its own character rather
 *  than vanishing — dropping the backslash is the safe read, because the only
 *  loss is one character of punctuation in a heading. */
function unquote(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, esc: string) =>
    CODEPOINT.test(esc)
      ? String.fromCodePoint(Number.parseInt(esc.replace(/[ux{}]/g, ""), 16))
      : (ESCAPES[esc] ?? esc),
  );
}

/** The index just past a string literal that opens at `open`. A quote that never
 *  closes ends at the line break (`'`/`"`) or at the end of the text. */
function endOfString(text: string, open: number): number {
  const quote = text[open];
  const spansLines = quote === "`";
  let i = open + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (!spansLines && c === "\n") return i;
    i++;
  }
  return text.length;
}

/** The index just past a comment that opens at `open`. */
function endOfComment(text: string, open: number): number {
  if (text[open + 1] === "/") {
    const nl = text.indexOf("\n", open);
    return nl < 0 ? text.length : nl;
  }
  const close = text.indexOf("*/", open + 2);
  return close < 0 ? text.length : close + 2;
}

/**
 * The text inside the `meta` object literal, or null.
 *
 * A depth scan, never `eval` and never `new Function`: the script is a document
 * here, and the tool's contract that meta is a pure literal is a promise about
 * the scripts we WRITE, not about the ones we are handed.
 *
 * @param script the workflow source
 * @return the object's inner text, or null when it is absent or unbalanced
 */
function metaBody(script: string): string | null {
  const head = META_HEAD.exec(script);
  if (head === null) return null;
  const open = head.index + head[0].length - 1;
  const limit = Math.min(script.length, open + META_MAX);
  let depth = 0;
  let i = open;
  while (i < limit) {
    const c = script[i];
    if (c === "/" && (script[i + 1] === "/" || script[i + 1] === "*")) {
      i = endOfComment(script, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = endOfString(script, i);
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return script.slice(open + 1, i);
    }
    i++;
  }
  return null;
}

/** A `phases:` key waiting for its array — matched against the flattened text
 *  built so far, so it can only ever be the object's OWN key. */
const PHASES_KEY = /(?:^|[,{\s])phases\s*:\s*$/;

/**
 * The object's own top-level text, with every nested span emptied out, plus the
 * text inside its `phases` array.
 *
 * Flattening is what keeps a phase's own `name:` from being read as the
 * workflow's: after this, a field regex can only match a key of the object
 * itself, whatever order the literal lists things in.
 *
 * @param body the meta object's inner text
 * @return the flattened top level and the phases array's contents (or null)
 */
function scanMeta(body: string): { flat: string; phases: string | null } {
  let flat = "";
  let phases: string | null = null;
  let depth = 0;
  let start = -1;
  let isPhases = false;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "/" && (body[i + 1] === "/" || body[i + 1] === "*")) {
      i = endOfComment(body, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfString(body, i);
      if (depth === 0) flat += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      if (depth === 1) {
        start = i + 1;
        isPhases = PHASES_KEY.test(flat);
        flat += c;
      }
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (depth === 1) {
        if (isPhases && phases === null) phases = body.slice(start, i);
        flat += c;
      }
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) flat += c;
    i++;
  }
  return { flat, phases };
}

/** Every quoted literal in a stretch of array text, in order. */
function quotedList(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) out.push(unquote(m[2]));
  return out;
}

/** The named values of one key across a stretch of array text, in order. */
function keyedList(text: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:^|[,{\\s])${key}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`, "g");
  for (const m of text.matchAll(re)) out.push(unquote(m[2]));
  return out;
}

/**
 * The phase names of a `phases: [...]` array, written either way: bare strings,
 * or objects that carry a name of their own.
 *
 * One label per phase, so the count under the heading is the number of phases
 * and not the number of strings someone wrote inside them.
 *
 * @param text the array's inner text
 * @return the names in order, empty when none can be read
 */
function phaseNames(text: string): string[] {
  if (!text.includes("{")) return quotedList(text);
  for (const key of ["name", "id", "label", "title"]) {
    const named = keyedList(text, key);
    if (named.length > 0) return named;
  }
  return [];
}

/**
 * What a workflow script says about itself.
 *
 * @param script the workflow source
 * @return the header, or all-nulls when there is no readable meta
 */
function workflowMeta(script: string): WorkflowMeta {
  const body = metaBody(script);
  if (body === null) return NO_META;
  const { flat, phases } = scanMeta(body);
  return {
    name: metaField(flat, "name"),
    description: metaField(flat, "description"),
    phases: phases === null ? [] : phaseNames(phases),
  };
}

// THE JOIN, AND WHY IT ARRIVES HERE AS TEXT.
//
// A Workflow call reaches a transcript as three separate things: the `tool_use`
// that launches it, a `tool_result` RECEIPT naming a task id, and — much later,
// as an ordinary user message — a `<task-notification>` block carrying what
// happened. Only the importer can pair the first with the third, and it hands
// the pair down the one channel a tool result already has: it appends a
// flattened section to the receipt's own text (claudeCode.ts, outcomeSection).
// Nothing about the event shape changes, and a session exported and read back
// keeps its outcome. What is read back here is that section.

/** The line above each outcome the importer joined on: `--- task <id> ---`, or
 *  `--- task <id> · <status> ---` once the task reported an ending. */
const SECTION = /^--- task (\S+)(?: · ([^\n]*?))? ---$/gm;

/** The status the importer writes when a launch promised an outcome and the
 *  transcript ended before one came. The join is text, so this phrase is the one
 *  place the two modules have to agree by hand — a card that misread it would
 *  present an abandoned run as a finished one, which is the whole point. */
const UNFINISHED = "no result by the end of the transcript";

/**
 * The flattened fields of one section, and which occurrence of each is real.
 *
 * `false` means take the FIRST line that opens the field, `true` the LAST. The
 * asymmetry is the hazard: `result` holds an agent's own words, and an agent
 * writing about workflows will write a line beginning `failures:` inside it. The
 * notification's own order puts `result` before everything below it, so a quote
 * of a later field can only ever appear BEFORE that field's real line — the last
 * one wins for those, the first for the ones the result cannot precede.
 *
 * A field with no entry here is not a delimiter and merges into its neighbour.
 * That costs a reader nothing: the raw face carries the section verbatim.
 */
const OUTCOME_FIELDS: [string, boolean][] = [
  ["output-file", false],
  ["summary", false],
  ["event", false],
  ["result", false],
  ["diagnostics", true],
  ["failures", true],
  ["usage", true],
];

/** One `agent_count=11` counter of the flattened usage line. */
const COUNTER = /([a-z_]+)=(-?\d+)/g;

/** `[fix:geometry] failed: <reason>` — the shape every failure line carries.
 *  The verb is optional so a differently worded line keeps its reason instead of
 *  being dropped for not matching. */
const FAILURE_LINE = /^\[([^\]]*)\]\s*(?:failed\s*:\s*)?(.*)$/;

/** The line-start index of the first or last `<label>: ` in a section, or -1. */
function fieldAt(section: string, label: string, last: boolean): number {
  const re = new RegExp(`^${label}: `, "gm");
  let at = -1;
  for (let m = re.exec(section); m !== null; m = re.exec(section)) {
    at = m.index;
    if (!last) break;
  }
  return at;
}

/**
 * One section's fields, by label.
 *
 * The values are delimited by each OTHER, so a multi-line value keeps its own
 * line breaks — the importer writes `result: {…}` and lets the rest of the value
 * fall below unprefixed, and `failures:` carries one dead agent per line.
 *
 * @param section the text below one `--- task … ---` header
 * @return the fields this section carries
 */
function outcomeFields(section: string): Map<string, string> {
  const anchors = OUTCOME_FIELDS.map(([label, last]) => ({ label, at: fieldAt(section, label, last) }))
    .filter((a) => a.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out = new Map<string, string>();
  anchors.forEach((a, i) => {
    const end = anchors[i + 1]?.at ?? section.length;
    out.set(a.label, section.slice(a.at + a.label.length + 2, end).trim());
  });
  return out;
}

/** The phase a failure label points at, or null. The label is `<phase>` or
 *  `<phase>:<agent>`, and the engine slugs the phase's own spelling — so the
 *  match is case-insensitive, and it must be UNIQUE: two phases a label could
 *  mean is not evidence for either. */
function phaseFor(label: string, phases: string[]): string | null {
  const head = label.split(":")[0].trim().toLowerCase();
  if (head === "") return null;
  const hits = phases.filter((p) => p.trim().toLowerCase() === head);
  return hits.length === 1 ? hits[0] : null;
}

/** One line of the failures block. A line with no bracket keeps its whole text
 *  as the reason: an unreadable failure is still a failure. */
function workflowFailure(line: string, phases: string[]): WorkflowFailure {
  const m = FAILURE_LINE.exec(line);
  if (m === null || m[1].trim() === "") return { label: null, phase: null, reason: line.trim() };
  const label = m[1].trim();
  return { label, phase: phaseFor(label, phases), reason: m[2].trim() };
}

/** One joined section: where it starts, and what its header claimed. */
type Section = { at: number; body: number; status: string };

/** Every outcome section of a tool result, in the order they were joined on. */
function sections(out: string): Section[] {
  const found: Section[] = [];
  SECTION.lastIndex = 0;
  for (let m = SECTION.exec(out); m !== null; m = SECTION.exec(out)) {
    found.push({ at: m.index, body: m.index + m[0].length, status: m[2] ?? "" });
  }
  return found;
}

/**
 * What became of a launch, or null when nothing came back.
 *
 * The LAST section is the outcome, because a task can report progress before it
 * reports an ending and each report is joined on in arrival order. A last
 * section that is the unfinished marker is not an outcome at all: it is the
 * importer saying the transcript ran out first.
 *
 * @param out    the tool result, receipt and sections together
 * @param phases the phase names of the meta literal, to place the failures
 * @return the run, or null when the result carries no ending
 */
function workflowRun(out: string, phases: string[]): WorkflowRun | null {
  const last = sections(out).at(-1);
  if (last === undefined || last.status === "" || last.status === UNFINISHED) return null;
  const fields = outcomeFields(out.slice(last.body));
  const counters = new Map<string, number>();
  for (const m of (fields.get("usage") ?? "").matchAll(COUNTER)) counters.set(m[1], Number(m[2]));
  const count = (key: string): number | null => counters.get(key) ?? null;
  const failures = fields.get("failures") ?? "";
  return {
    status: last.status,
    agents: count("agent_count"),
    done: count("agents_done"),
    errors: count("agents_error"),
    skipped: count("agents_skipped"),
    empty: count("agents_empty_result"),
    tokens: count("subagent_tokens"),
    toolUses: count("tool_uses"),
    durationMs: count("duration_ms"),
    failures: failures
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => workflowFailure(line, phases)),
    result: fields.get("result") ?? "",
  };
}

/** One number of the headline row. `key` is a stable token each renderer maps to
 *  its own word, `value` is already in the app's own format, and `bad` marks the
 *  ones that are losses. */
export type RunStat = {
  key: "agents" | "failed" | "skipped" | "empty" | "tokens" | "tools" | "elapsed";
  value: string;
  bad: boolean;
};

/** The agents cell: done of total, or whichever half was reported. */
function agentsValue(run: WorkflowRun): string | null {
  if (run.done !== null && run.agents !== null) return `${run.done} / ${run.agents}`;
  if (run.agents !== null) return String(run.agents);
  return run.done === null ? null : String(run.done);
}

/**
 * The headline numbers of a finished run, in reading order.
 *
 * Shared by both renderers so WHICH numbers show, and in what order, is one
 * decision — the markup is theirs, the selection is not. A counter the outcome
 * never reported is left out rather than printed as zero, and a loss appears
 * only when there was one, so the row stays short on a clean run and grows
 * exactly where something went wrong.
 */
export function runStats(run: WorkflowRun): RunStat[] {
  const stats: RunStat[] = [];
  const agents = agentsValue(run);
  if (agents !== null) stats.push({ key: "agents", value: agents, bad: false });
  const loss = ([key, n]: ["failed" | "skipped" | "empty", number | null]) => {
    if (n !== null && n > 0) stats.push({ key, value: String(n), bad: true });
  };
  loss(["failed", run.errors]);
  loss(["skipped", run.skipped]);
  loss(["empty", run.empty]);
  if (run.tokens !== null) stats.push({ key: "tokens", value: formatTokens(run.tokens), bad: false });
  if (run.toolUses !== null) stats.push({ key: "tools", value: String(run.toolUses), bad: false });
  if (run.durationMs !== null) {
    stats.push({ key: "elapsed", value: formatDuration(run.durationMs), bad: false });
  }
  return stats;
}

/**
 * Describe one tool call as its real shape.
 *
 * @param name    the tool's wire name
 * @param input   the call's input object (whatever the model sent)
 * @param output  the tool result, or undefined while the call is still pending
 * @param isError whether the result came back as an error
 * @return the view the card renders; `generic` whenever the shape is unclear
 */
export function describeTool(
  name: string,
  input: unknown,
  output: string | undefined,
  isError: boolean,
): ToolView {
  const out = output ?? "";
  const generic: ToolView = { kind: "generic", input, output: out };

  switch (name) {
    case "Read":
    case "read_file":
    case "view_file": {
      const path = firstStr(input, "path", "filePath", "file_path");
      if (path === null) return generic;
      const offset = num(input, "offset");
      const limit = num(input, "limit");
      const range =
        offset !== null
          ? limit !== null
            ? `lines ${offset}–${offset + limit - 1}`
            : `from line ${offset}`
          : null;
      return { kind: "file", path, range, body: out, lineCount: out === "" ? 0 : out.split("\n").length };
    }

    case "Write":
    case "create_file":
    case "write_file": {
      const path = firstStr(input, "path", "filePath", "file_path");
      const content = str(input, "content");
      if (path === null || content === null) return generic;
      return { kind: "write", path, content, result: out };
    }

    case "Edit":
    case "replace_string_in_file":
    case "edit_file": {
      const path = firstStr(input, "path", "filePath", "file_path");
      // The tool's wire names; both snake and camel are tolerated because the
      // model has been seen to send either.
      const before = str(input, "old_string") ?? str(input, "oldString");
      const after = str(input, "new_string") ?? str(input, "newString");
      if (path === null || before === null || after === null) return generic;
      return { kind: "edit", path, before, after, result: out };
    }

    case "list_dir": {
      const path = str(input, "path");
      if (path === null) return generic;
      return { kind: "listing", path, entries: lines(out) };
    }

    case "Glob":
    case "Grep":
    case "glob":
    case "grep":
    case "grep_search":
    case "file_search": {
      // A VS Code export says `query` and `includePattern` for the same two
      // fields. semantic_search is deliberately absent: its result is ranked
      // excerpts, and counting their lines would report a hit count the tool
      // never gave.
      const pattern = firstStr(input, "pattern", "query");
      if (pattern === null) return generic;
      const path = firstStr(input, "path", "includePattern");
      return { kind: "matches", pattern, path, lines: lines(out) };
    }

    case "Bash":
    case "run_in_terminal":
    case "run_command":
    case "Monitor": {
      // Monitor waits on a shell loop, so its stop condition is inside the
      // command rather than beside it in a field of its own.
      const command = str(input, "command");
      if (command === null) return generic;
      return { kind: "command", command, output: out, failed: isError };
    }

    case "view_image": {
      const path = firstStr(input, "path", "filePath", "file_path");
      if (path === null) return generic;
      return { kind: "image", source: path, prompt: null, preview: previewable(path), result: out };
    }

    case "generate_image": {
      const prompt = str(input, "prompt");
      if (prompt === null) return generic;
      const source = generatedPath(out);
      return { kind: "image", source, prompt, preview: previewable(source), result: out };
    }

    case "Skill":
    case "use_skill": {
      const skill = firstStr(input, "name", "skill");
      if (skill === null) return generic;
      return { kind: "skill", name: skill, body: out };
    }

    case "spawn_agent":
    case "Task":
    case "Agent": {
      const child = spawnedAgent(input);
      if (child === null) return generic;
      return { kind: "agents", children: [child], result: out };
    }

    case "spawn_agents": {
      const batch = arr(input, "agents");
      if (batch === null || batch.length === 0) return generic;
      const children = batch.map(spawnedAgent);
      // One unreadable entry would misstate the fan-out's width.
      if (children.some((child) => child === null)) return generic;
      return { kind: "agents", children: children as SpawnedAgent[], result: out };
    }

    case "update_plan":
    case "TodoWrite": {
      const rows = arr(input, "steps", "todos");
      if (rows === null || rows.length === 0) return generic;
      const steps = rows.map(planRow);
      // A blank row would misreport the plan's length as much as its content.
      if (steps.some((step) => step === null)) return generic;
      return { kind: "plan", steps: steps as PlanRow[] };
    }

    // The task list. Three verbs on one noun, so one shape with one row
    // renderer — and deliberately NOT the plan above, which is where these
    // landed the first time somebody looked: `planRow` reads only `text`, so a
    // creation would arrive stripped of the description that is its whole
    // substance, and 418 of 434 updates carry no text at all, which would draw a
    // step labelled "1".
    //
    // The other Task* verbs are a DIFFERENT NOUN and stay generic. TaskStop and
    // TaskOutput act on a spawned run: their id is an opaque slug (`wfsbmqs31`),
    // their key is `task_id` rather than `taskId`, and they carry no subject,
    // state or description. Drawn as a row, that slug would sit where a reader
    // has learnt to find `#3`. TaskGet has no call in the corpus at all, so
    // there is nothing observed to build a shape on.
    case "TaskCreate": {
      const subject = str(input, "subject");
      if (subject === null) return generic;
      const id = TASK_CREATED.exec(out)?.[1] ?? null;
      return {
        kind: "task",
        op: "create",
        rows: [{ id, subject, description: str(input, "description"), status: null, blockedBy: [] }],
        wrote: "silent",
        // The line names the id and echoes the subject, so once the id is read
        // there is nothing in it the row does not already show. Anything else —
        // an error — is kept whole rather than swallowed by a pretty card.
        result: id === null ? out : "",
      };
    }

    case "TaskUpdate": {
      const asked = str(input, "taskId");
      if (asked === null) return generic;
      const deps = arr(input, "addBlockedBy") ?? [];
      // A half-read dependency list would name the wrong tasks as blockers.
      if (!deps.every((d) => typeof d === "string")) return generic;
      const done = TASK_UPDATED.exec(out);
      const changed = done === null ? [] : done[2].split(",").filter((f) => f.trim() !== "");
      return {
        kind: "task",
        op: "update",
        rows: [
          {
            // The result's number over the input's: the input says which task was
            // aimed at, the result says which one answered.
            id: done?.[1] ?? asked,
            subject: str(input, "subject"),
            description: str(input, "description"),
            status: str(input, "status"),
            blockedBy: deps as string[],
          },
        ],
        wrote: done === null ? "silent" : changed.length === 0 ? "nothing" : "named",
        result: done === null ? out : "",
      };
    }

    case "TaskList": {
      // Nothing to guard on the input — a listing takes no arguments — so the
      // result is the whole evidence, and it is read strictly.
      const rows = rosterRows(out);
      if (rows === null) return generic;
      return { kind: "task", op: "list", rows, wrote: "silent", result: "" };
    }

    case "AskUserQuestion": {
      // The answers travel in the RESULT, as prose. A `__unparsedToolInput`
      // payload has no `questions` at all and lands in generic on purpose: it
      // holds the model's raw JSON as a string BECAUSE it failed to parse, so
      // the call errored and nobody was ever shown a question. Unwrapping the
      // string would lay out a decision that never happened.
      const raw = arr(input, "questions");
      if (raw === null || raw.length === 0) return generic;
      const texts = raw.map((entry) => str(entry, "question") ?? "");
      const answers = answersFor(texts, out);
      const questions = raw.map((entry, i) => askedQuestion(entry, answers[i]));
      // One unreadable question would misstate what was asked.
      if (questions.some((q) => q === null)) return generic;
      return { kind: "question", questions: questions as AskedQuestion[] };
    }

    case "web_fetch":
    case "WebFetch":
    case "browse_page":
    case "web_search":
    case "WebSearch": {
      const url = str(input, "url");
      const query = str(input, "query");
      if (url === null && query === null) return generic;
      return { kind: "web", url, query, body: out };
    }

    case "Workflow": {
      // Three ways in: the script inline, a saved workflow by name, or a file.
      // The meta only exists in the first — the other two are a reference to a
      // script this card never sees, and inventing a header for them would be
      // describing content that is not here.
      const script = str(input, "script");
      const scriptPath = firstStr(input, "scriptPath", "script_path");
      const saved = str(input, "name");
      if (script === null && scriptPath === null && saved === null) return generic;
      const meta = script === null ? NO_META : workflowMeta(script);
      // The result is the launch RECEIPT; the outcome is what the importer
      // joined under it. Split them at the first section, so the receipt does
      // not carry the whole outcome a second time as its own text.
      const run = workflowRun(out, meta.phases);
      const joined = sections(out)[0]?.at ?? -1;
      return {
        kind: "workflow",
        name: meta.name ?? saved,
        description: meta.description,
        phases: meta.phases,
        script,
        scriptPath,
        args: field(input, "args"),
        stage: run !== null ? "done" : out === "" ? "pending" : isError ? "failed" : "launched",
        run,
        result: joined < 0 ? out : out.slice(0, joined).trimEnd(),
      };
    }

    default: {
      const mcp = splitMcp(name);
      // Only the NAME is understood here: every MCP server owns its own input
      // schema, so the payload travels on unread rather than half-guessed.
      if (mcp !== null) return { kind: "mcp", server: mcp.server, tool: mcp.tool, input, output: out };
      return generic;
    }
  }
}
