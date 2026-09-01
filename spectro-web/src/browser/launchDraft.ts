// What the operator typed, and the one function that turns it into an entry
// (card 352, criterion 2).
//
// SEPARATE FROM THE COMPONENT on purpose. The argument splitting is the only
// piece of judgement on this road, and this folder's suites render static
// markup rather than driving events — a rule living inside an onChange handler
// could not be measured at all. Here it is a pure function with its own cases.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: validate. `LaunchWriter` owns what
// this product will and will not author — a name that can be addressed, an
// entry that names something to run or somewhere to attach, a port a socket can
// hold, no control characters — and it refuses the WHOLE write rather than half
// of it. A second opinion here is the two-hand-lists arrangement this
// repository has been bitten by twice: the two would drift, and which refusal
// the operator met would depend on which road he came in by. So a draft with
// nothing in it becomes an entry with nothing in it, travels, and comes back as
// the writer's own sentence.

/** One launch entry as the wire and the file both spell it (card 202). */
export interface NewLaunchEntry {
  name: string;
  /** The program to run, or null for an entry that only attaches. */
  runtimeExecutable: string | null;
  runtimeArgs: string[];
  /** The port to wait on, or null. */
  port: number | null;
  /** The address to attach to, or null. */
  url: string | null;
}

/** The form's fields, all strings — an input has nothing else to give. */
export interface LaunchDraft {
  name: string;
  command: string;
  /** One argument per LINE. See `entryFromDraft`. */
  args: string;
  port: string;
  url: string;
}

/** A form nobody has typed into yet. */
export const EMPTY_DRAFT: LaunchDraft = { name: "", command: "", args: "", port: "", url: "" };

/**
 * The draft as an entry.
 *
 * ONE ARGUMENT PER LINE, and that is the whole reason this is a function rather
 * than five reads of five inputs. `--message hello world` is one argument that
 * carries spaces; a splitter on whitespace makes it three. Quoting rules are
 * what `LaunchEntry.commandLine()` exists to undo on the other side, and a form
 * has no business re-opening them — a line break is unambiguous and needs no
 * escape.
 *
 * A blank field means ABSENT, never empty. `""` for an executable would make an
 * attach entry look like a broken command entry, and a port of 0 is a claim the
 * writer would refuse with a sentence about a number the operator never typed.
 *
 * @param draft what the operator typed
 * @returns the entry to send, unjudged
 */
export function entryFromDraft(draft: LaunchDraft): NewLaunchEntry {
  const port = Number.parseInt(draft.port.trim(), 10);
  return {
    name: draft.name.trim(),
    runtimeExecutable: blankAsNull(draft.command),
    runtimeArgs: draft.args
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    port: Number.isNaN(port) ? null : port,
    url: blankAsNull(draft.url),
  };
}

/** A trimmed field, or null when the operator left it empty. */
function blankAsNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
