// Break a chained shell command before each `&&`, so it can be read.
//
// The owner, looking at a tool card: "kannst du bei einem tool call einfach
// immer vor einem && einen zeilenumbruch machen? weil das passiert ja am ende
// und man kann das dann besser lesen."
//
// He is right about how common it is. Measured over 4,553 Bash cards in
// ~/.claude/projects: 3,515 of them — 77% — carry `&&` or `||`, and the long
// ones are a paragraph of shell wrapped by the browser at whatever column the
// card happens to be, so the steps of a five-part command have no visual edge at
// all. One break per operator gives every step its own line.
//
// WHY THIS IS NOT A `split("&&")`. An `&&` is only an operator when the shell
// would read it as one, and in this corpus it very often would not:
//
//   - inside single quotes, where nothing is special;
//   - inside double quotes, where a backslash still escapes;
//   - inside a heredoc body — 767 of the measured commands have one, and this
//     session's own transcripts are full of `python3 - <<'PY' … PY`, whose
//     bodies are Python and JSON, not shell;
//   - inside `$( … )`, where the operator belongs to the inner command.
//
// A break in any of those places does not just look wrong: it shows the reader a
// command that is not the command that ran. So this walks the string once and
// only breaks where the shell itself would see an operator.
//
// The command is NOT rewritten anywhere it is stored, searched or exported as
// data — this is a display transform, applied by the two renderers that draw the
// COMMAND block, and the record keeps its own bytes.

/** Where a break may go, and what it precedes. */
const OPERATORS = ["&&", "||"] as const;

/**
 * The chained command, one operator per line.
 *
 * `||` breaks too, though the owner named only `&&`. They are the same kind of
 * joint and his own example ends `… && git rev-parse --abbrev-ref HEAD || echo
 * "WORKTREE NOT FOUND"` — breaking every `&&` and leaving that one glued would
 * read as a bug rather than a decision.
 *
 * A command that is already multi-line keeps every newline it had. A command
 * with no operator is returned unchanged, byte for byte.
 *
 * @param command the command as the record holds it
 * @returns the same command with a newline before each top-level `&&` / `||`
 */
export function breakShellChain(command: string): string {
  if (command === "") return command;

  let out = "";
  let i = 0;
  // Quote state. Only one can be open at a time — a `"` inside `'…'` is a
  // literal quote character and vice versa, which is exactly why this is a
  // single mode rather than two booleans.
  let quote: "'" | '"' | null = null;
  // `$( … )` and `( … )` nesting. An operator in there joins the INNER command.
  let depth = 0;
  // The heredoc we are inside, or waiting for. `pending` is set when `<<WORD` is
  // read and becomes `body` at the next newline, because the rest of THAT line
  // is still ordinary shell: `cat <<'EOF' > f && echo done` is legal.
  let pendingHeredoc: string | null = null;
  let inHeredoc: string | null = null;
  let atLineStart = true;

  while (i < command.length) {
    const c = command[i];

    // ---- inside a heredoc body: nothing is shell until the terminator line --
    if (inHeredoc !== null) {
      if (atLineStart) {
        const eol = command.indexOf("\n", i);
        const line = command.slice(i, eol === -1 ? command.length : eol);
        // The terminator is the word alone on its line; `<<-` allows leading
        // tabs, and trailing whitespace is tolerated by every shell in practice.
        if (line.trim() === inHeredoc) inHeredoc = null;
      }
      out += c;
      atLineStart = c === "\n";
      i++;
      continue;
    }

    // ---- escapes ----------------------------------------------------------
    if (c === "\\" && quote !== "'") {
      out += c + (command[i + 1] ?? "");
      atLineStart = false;
      i += 2;
      continue;
    }

    // ---- quotes -----------------------------------------------------------
    if (quote !== null) {
      out += c;
      if (c === quote) quote = null;
      atLineStart = false;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      atLineStart = false;
      i++;
      continue;
    }

    // ---- a heredoc opener -------------------------------------------------
    if (c === "<" && command[i + 1] === "<") {
      const word = heredocWord(command, i);
      if (word !== null) {
        pendingHeredoc = word.word;
        out += command.slice(i, word.end);
        atLineStart = false;
        i = word.end;
        continue;
      }
    }

    // ---- nesting ----------------------------------------------------------
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;

    // ---- the break --------------------------------------------------------
    if (depth === 0 && !atLineStart) {
      const op = OPERATORS.find((o) => command.startsWith(o, i));
      // Not `&&&` or `|||`, and not the `|` of a pipe: startsWith("||") already
      // excludes a single `|`, and a third character of the same kind means the
      // shell is reading something else.
      if (op !== undefined && command[i + 2] !== c) {
        // Never two newlines: a command that already broke its own line here
        // keeps its shape.
        if (!out.endsWith("\n")) out += "\n";
        out += op;
        i += op.length;
        atLineStart = false;
        continue;
      }
    }

    out += c;
    if (c === "\n") {
      atLineStart = true;
      if (pendingHeredoc !== null) {
        inHeredoc = pendingHeredoc;
        pendingHeredoc = null;
      }
    } else if (c !== " " && c !== "\t") {
      atLineStart = false;
    }
    i++;
  }
  return out;
}

/**
 * The heredoc terminator a `<<` introduces, and where its opener ends.
 *
 * Handles `<<WORD`, `<<-WORD`, `<<'WORD'` and `<<"WORD"`. Not `<<<` — that is a
 * here-STRING, whose body is the rest of the word and never a block.
 *
 * @param s the whole command
 * @param at the index of the first `<`
 * @returns the terminator and the index just past the opener, or null
 */
function heredocWord(s: string, at: number): { word: string; end: number } | null {
  let i = at + 2;
  if (s[i] === "<") return null; // `<<<`, a here-string
  if (s[i] === "-") i++;
  while (s[i] === " " || s[i] === "\t") i++;
  const q = s[i] === "'" || s[i] === '"' ? s[i] : null;
  if (q !== null) i++;
  const start = i;
  while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++;
  const word = s.slice(start, i);
  if (word === "") return null;
  if (q !== null) {
    if (s[i] !== q) return null; // unterminated: not an opener we understand
    i++;
  }
  return { word, end: i };
}
