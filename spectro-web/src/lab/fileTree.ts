// Card 301B: the file footprint — which paths this run touched, in what order,
// and by which agent.
//
// THE GAP THIS CLOSES. The canon has a live workspace browser, and it answers a
// different question: what is on disk NOW, in the folder this session is
// pointed at. It answers nothing at all for an imported or replayed run, where
// there is no live folder to walk. Nowhere does anything fold the run's own
// stream into "who touched what". This module does, and only that.
//
// THE ALIASING IS THE WHOLE JOB. One disk touch is spelled two ways depending
// on where the stream came from — a native run says read_file/write_file/
// list_dir, an imported Claude Code transcript says Read/Write/Edit/MultiEdit/
// Glob — and the path itself hides under three different keys. The grammar for
// that already existed in TWO places (labScene's advanceLoop and toolViews'
// firstStr) and must not become three: the tool-name sets are IMPORTED from
// labScene rather than copied, so the map's disk station and this tree can
// never disagree about what a disk touch is.
//
// SHELL WORK IS INVISIBLE HERE, AND THAT IS RECORDED RATHER THAN HIDDEN. An
// agent that writes through `run_command`/`Bash` leaves a command string and no
// path, so no honest fold can put it on the tree. A thin tree therefore has two
// very different meanings — "this run barely touched disk" and "this run worked
// through the shell" — and `shellCalls` is what lets a reader tell them apart.
// Without that number a quiet panel is a lie.

import type { RunEvent } from "../events";
import { elapsedAt, stepBoundaries, stepOfEvent } from "../state/stepper";
import { CC_DISK_READ, CC_DISK_WRITE, DISK_TOOLS, SHELL_TOOLS } from "./labScene";
import { workspaceBasename } from "../workspace/paths";

/** One path the run touched, and everyone who touched it. */
export interface FileTouch {
  /** The string exactly as the tool named it. NEVER rewritten — the wire is
   *  evidence; shortening for display is the panel's job and reversible. */
  path: string;
  /** True when this is a Glob PATTERN rather than a file. A pattern is a real
   *  disk touch (dropping it would make the tree thinner than the run was) but
   *  it names a search, not a file, and a reader must be able to see which. */
  pattern: boolean;
  /** Agent ids that read it. */
  readers: ReadonlySet<string>;
  /** Agent ids that wrote it. */
  writers: ReadonlySet<string>;
  /** The first tool_call that touched it — the way into the trace. */
  firstEvent: RunEvent;
  /** That event's index in the prefix handed in, so a caller can seek to it
   *  in the scrub cursor's own coordinates without searching again. */
  firstIndex: number;
}

export interface FileFootprint {
  /** One entry per distinct path, in order of FIRST touch. Order is the point:
   *  it is the only record of the sequence the run worked in. */
  touches: FileTouch[];
  /** How many shell calls the prefix carries. See the note at the top: this is
   *  the size of what this fold cannot see. */
  shellCalls: number;
}

/** Read a string field out of an event's (untrusted) tool input. */
function inputStr(input: unknown, key: string): string | null {
  if (input === null || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/**
 * The path a disk call names, under whichever of its three spellings it used.
 *
 * The same order toolViews' `firstStr(input, "path", "filePath", "file_path")`
 * uses, for the same reason: an import spells it file_path, a native call
 * spells it path, and a hand-built stream has been seen to spell it filePath.
 */
function pathOf(input: unknown): string | null {
  return nonBlank(inputStr(input, "path") ?? inputStr(input, "filePath") ?? inputStr(input, "file_path"));
}

/** Trim, and treat a string of blanks as no string at all. ONE place: a second
 *  emptiness check at the call site would make neither of them load-bearing,
 *  and an unbitten branch is how a guard rots without a test going red. */
function nonBlank(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Fold the run into its file footprint.
 *
 * @param events the run's events
 * @param upto   how many of them to read — the scrub cursor. Absent = all.
 *   `fileFootprint(e, k)` is exactly `fileFootprint(e.slice(0, k))`.
 */
export function fileFootprint(events: readonly RunEvent[], upto?: number): FileFootprint {
  const prefix = upto === undefined ? events : events.slice(0, Math.max(0, upto));

  const byPath = new Map<string, { touch: FileTouch; readers: Set<string>; writers: Set<string> }>();
  let shellCalls = 0;

  prefix.forEach((e, at) => {
    if (e.type !== "tool_call") return;
    const name = e.name;

    if (SHELL_TOOLS.has(name)) {
      shellCalls += 1;
      return;
    }

    const native = DISK_TOOLS.has(name);
    const ccRead = CC_DISK_READ.has(name);
    const ccWrite = CC_DISK_WRITE.has(name);
    if (!native && !ccRead && !ccWrite) return;

    // A Glob names a PATTERN and no file. Its pattern is still the only thing
    // it touched, so it goes on the tree marked as what it is.
    const isGlob = name === "Glob";
    const key = isGlob ? nonBlank(inputStr(e.input, "pattern")) : pathOf(e.input);
    if (key === null) return;

    // Only write_file among the native verbs writes; list_dir and read_file
    // read. On the imported side the set the name is in decides.
    const writes = native ? name === "write_file" : ccWrite;

    let entry = byPath.get(key);
    if (entry === undefined) {
      const readers = new Set<string>();
      const writers = new Set<string>();
      entry = {
        readers,
        writers,
        touch: { path: key, pattern: isGlob, readers, writers, firstEvent: e, firstIndex: at },
      };
      byPath.set(key, entry);
    }
    (writes ? entry.writers : entry.readers).add(e.agentId);
  });

  return { touches: [...byPath.values()].map((v) => v.touch), shellCalls };
}

// ---------------------------------------------------------------------------
// Card 309B: WHEN a path was first touched.
//
// The order above is load-bearing and was invisible. `touches` is ordered by
// first contact and the doc calls that "the only record of the sequence the run
// worked in" — but the panel printed a list with nothing on it that said when,
// so the order read as arbitrary to anyone who had not opened this file. The
// row now carries the moment.
//
// THE STEP IS THE UNIT, and it is the transport's own: `stepOfEvent` is the
// same rule a scrub tick is placed by, imported rather than copied, so the
// number on a file row and the number in the step counter cannot drift apart.
//
// THE CLOCK IS OPTIONAL AND STAYS OPTIONAL. Coarse steps are counted; time is
// only measured where the recording carried stamps. An import without them gets
// the step and no time at all — a "0:00" would be a statement about when a run
// touched a file that nothing measured. `elapsedAt` is imported for the same
// reason `stepOfEvent` is: it is the reading `runClock` already does of the
// wire's optional stamp, and a private copy here would let this panel and the
// transport disagree about whether a run had a clock.
// ---------------------------------------------------------------------------

/** When one touch happened, in the coordinates the transport counts in. */
export interface TouchMoment {
  /** The coarse step that SHOWS the first touch — the first boundary past it. */
  step: number;
  /** Milliseconds from the run's first stamped event to this one, or null when
   *  either end carries no readable stamp. Null is the honest answer, not a
   *  zero. */
  elapsedMs: number | null;
}

/**
 * When each touch happened.
 *
 * @param events the prefix the footprint was folded from — `firstIndex` indexes
 *   into exactly this array, so handing in a different stream would number the
 *   rows against a run they did not come from
 * @param touches that footprint's touches, in its own order
 * @return one entry per touch, in the same order
 */
export function touchMoments(events: readonly RunEvent[], touches: readonly FileTouch[]): TouchMoment[] {
  const boundaries = stepBoundaries(events);
  return touches.map((touch) => ({
    step: stepOfEvent(boundaries, touch.firstIndex),
    elapsedMs: elapsedAt(events, touch.firstIndex),
  }));
}

/**
 * The path as a person should read it: relative to the workspace the canon
 * actually knows, or untouched when it is not inside it.
 *
 * NO MARKER IS HARDCODED. The root is the one the run reported (WorkspaceInfo
 * over the socket); when there is none — every import, every replay — the path
 * passes through whole. Shortening against a guessed marker would silently
 * relabel a file that lives somewhere else entirely.
 */
export function shortenPath(path: string, root?: string | null): string {
  if (root === null || root === undefined) return path;
  // A root of "" or of nothing but slashes is no root: pass the path through.
  const base = root.replace(/\/+$/, "");
  if (base === "") return path;
  if (path === base) return workspaceBasename(base);
  // The separator is required: "/w/project2" is NOT inside "/w/proj".
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}
