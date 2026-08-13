// The hooks settings block's pure half (card 195).
//
// The same rule AllowlistSettings and WebSearchSettings obey: this file does NOT
// decide anything the runner decides. HookConfig defaults an unset matcher to
// "*", HookRunner defaults an unset timeout to ten seconds, and GET
// /api/settings/hooks reads both out. A default worked out a second time here
// would print the wrong number the day one of them moved, and a hooks page that
// disagrees with the runner is worse than no page.
//
// What lives here is what the page genuinely owns: turning four form fields into
// the object the settings file holds, adding or removing one element of an
// array, and choosing which sentence describes an entry.
//
// THE ONE THING THIS FILE EXISTS TO GET RIGHT: what goes BACK. The read-out
// answers a resolved view — matcher "*" for a hook whose file entry has none,
// an effective timeout for one that set none. Writing that view back would
// persist both: a removal of one hook would quietly pin another hook's defaults
// into the file, and the file would stop following the runner.
//
// AND THE ONE THE REVIEW ADDED: which of the listed hooks actually RUN. `hooks`
// is a whole-block field — the highest layer that sets it replaces every layer
// below, they do not add up — so a page that lists the scopes and leaves the
// reader to add them up can state the wrong guards with full confidence. The
// server folds the list and names the layer it came from; the functions below
// read that answer out, and decide nothing about it.

/** One hook as the SERVER read it — mirrors SettingsController#reading. */
export interface HookEntry {
  /** "pre_tool_use" or "post_tool_use". */
  event: string;
  /** The glob the runner will actually match with — defaulted to "*". */
  matcher: string;
  /** What the file itself says, or null when it names no matcher. */
  rawMatcher: string | null;
  /** The command, verbatim as the settings file holds it. */
  command: string;
  /** The rule that will replace this command where the RUN records it, or "" for
   *  none. A forecast, not a censorship: the command above is the real one. */
  redactionRule: string;
  /** What the file says, or null when it sets no timeout. */
  timeoutSeconds: number | null;
  /** The budget the hook will actually run under. */
  effectiveTimeoutSeconds: number;
}

/** Which settings layer's hook block a run loads, and which it silences.
 *  Read straight out of the core's provenance map — never derived here. */
export interface HooksOrigin {
  /** The layer whose hooks are in force, or "defaults" when none set any. */
  winner: string;
  /** The layers that set hooks and were replaced whole, highest first. */
  shadowed: string[];
}

/** GET /api/settings/hooks, verbatim — see SettingsController#hooks. */
export interface HooksView {
  /** The tier this capability carries, from the gate's own enum. */
  tier: string;
  /** What an unset timeout resolves to, from the runner's own constant. */
  defaultTimeoutSeconds: number;
  /** The events a hook may name, from the record that validates them. */
  events: string[];
  /** Per settings layer, that layer's own hooks. */
  scopes: Record<string, HookEntry[]>;
  /** The folded list a run would actually load. */
  effective: HookEntry[];
  /** Where that folded list came from, and what it replaced. */
  origin: HooksOrigin;
  /** The session this answer was resolved for, or null for the machine-wide
   *  answer — the workspace layers only join the chain when a session names them. */
  session: string | null;
  /** The workspace whose scopes joined, or null. */
  workspace: string | null;
  files: Record<string, string>;
}

/** One hook as the FILE holds it — every field the settings schema knows and
 *  nothing the server derived. This is the shape that is written back. */
export interface HookWrite {
  event: string;
  matcher?: string;
  command: string;
  timeoutSeconds?: number;
}

/**
 * The hooks a run would actually load — the folded list, never the scopes
 * added together.
 *
 * @param view the read-out, or null before it lands
 * @returns the entries in force, in the order the runner walks them
 */
export function inForce(view: HooksView | null): HookEntry[] {
  return view?.effective ?? [];
}

/**
 * Which layer's block is in force, and which layers it replaced whole.
 *
 * @param view the read-out, or null before it lands
 * @returns the provenance the server answered, or the nobody-set-any case
 */
export function hooksOrigin(view: HooksView | null): HooksOrigin {
  const origin = view?.origin;
  if (origin === undefined || origin === null) return { winner: "defaults", shadowed: [] };
  return { winner: origin.winner, shadowed: origin.shadowed ?? [] };
}

/**
 * Whether a listed scope's entries are the ones that run.
 *
 * The judgement a reader acts on. "Your settings" listing a guard that cannot
 * fire is worse than not listing it, because the reader now believes they have
 * a guard they do not have.
 *
 * @param view the read-out, or null before it lands
 * @param scope the settings layer whose list is on screen
 * @returns true when this layer won the whole-block merge
 */
export function scopeIsInForce(view: HooksView | null, scope: string): boolean {
  return hooksOrigin(view).winner === scope;
}

/**
 * Which sentence describes the REACH of the answer on screen.
 *
 * Without a session id the workspace layers never join the chain, so the answer
 * is machine-wide — and a page saying "this is what runs" over a list that has
 * not seen the running session's own settings is the exact wrong claim. Two
 * sentences, one per case, chosen here rather than guessed at the call site.
 *
 * @param view the read-out, or null before it lands
 * @returns the dict key of the clause that says what this answer covers
 */
export function reachKey(view: HooksView | null): string {
  return view?.session ? "set.hkReachSession" : "set.hkReachProcess";
}

/**
 * The entries of one scope, as the settings file holds them.
 *
 * The command travels back VERBATIM. It used to come back "" for a command that
 * tripped a redaction rule, and this function then refused to write the whole
 * scope — which turned one ordinary email address in one notify hook into a
 * permanently read-only page, while GET /api/settings shipped the same bytes to
 * the same browser anyway. The rule now rides beside the command as a forecast
 * of what the RUN will hide, and the write path is never disarmed by it.
 *
 * @param view the read-out, or null before it lands
 * @param scope the settings layer to write back
 * @returns the writable array — empty for a scope that configured nothing
 */
export function rawHooks(view: HooksView | null, scope: string): HookWrite[] {
  const entries = view?.scopes[scope] ?? [];
  return entries.map((entry) => {
    // Key ORDER is the write order, and this is a file a person opens: event,
    // then what it matches, then what it runs, then how long it may take. The
    // review measured this comment against code that wrote event, command,
    // matcher — a comment describing an order its own file did not have. Written
    // as one literal with conditional spreads, because insertion order is the
    // thing being got right and a later assignment appends.
    const matcher = entry.rawMatcher !== null && entry.rawMatcher !== "" ? entry.rawMatcher : null;
    return {
      event: entry.event,
      ...(matcher === null ? {} : { matcher }),
      command: entry.command,
      ...(entry.timeoutSeconds === null ? {} : { timeoutSeconds: entry.timeoutSeconds }),
    };
  });
}

/**
 * The object the form's four fields add up to.
 *
 * A blank matcher and a blank timeout are OMITTED rather than written as "*" and
 * 10. Both are runner defaults, and a file that spells them out stops following
 * the runner the moment either moves — which is the drift this whole card is
 * about, written into the operator's own settings.
 *
 * @param event the phase, one of the events the server answered
 * @param matcher the tool-name glob, or "" for every tool
 * @param command the shell string spectroscope will run
 * @param timeout the per-hook budget in seconds, as typed
 * @returns the hook to append, or null when there is nothing to write
 */
export function composeHook(
  event: string,
  matcher: string,
  command: string,
  timeout: string,
): HookWrite | null {
  const cmd = command.trim();
  if (event === "" || cmd === "") return null;
  const glob = matcher.trim();
  // The core treats null and non-positive alike (timeoutOrDefault), so a 0 or a
  // -1 in the file would say something the runner does not mean.
  const seconds = Number(timeout.trim());
  const own = Number.isInteger(seconds) && seconds > 0;
  return {
    event,
    ...(glob === "" ? {} : { matcher: glob }),
    command: cmd,
    ...(own ? { timeoutSeconds: seconds } : {}),
  };
}

/**
 * The array to write back after adding one hook.
 *
 * Appended, never sorted or deduped: the runner walks the list in order and the
 * first block wins, so position is meaning here in a way it is not for the
 * allowlist. Two identical hooks are also legitimate — they run twice.
 *
 * @param current the scope's own hooks
 * @param hook the composed hook
 * @returns the array to PUT, or null when there is nothing to write
 */
export function withHook(current: HookWrite[], hook: HookWrite | null): HookWrite[] | null {
  if (hook === null) return null;
  return [...current, hook];
}

/**
 * The array to write back after removing one hook, BY POSITION.
 *
 * By position and not by value, for the reason above: two entries may be
 * identical, and removing "the one that matches" would then remove the wrong
 * one silently.
 *
 * @param current the scope's own hooks
 * @param index which element to drop
 * @returns the array to PUT, or null when the index names nothing
 */
export function withoutHook(current: HookWrite[], index: number): HookWrite[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
  return current.filter((_, i) => i !== index);
}

/**
 * How one hook should be described in one clause. Returns a dict KEY, never a
 * sentence: this page is bilingual and the server's own wording is not.
 *
 * @param entry the hook as the server read it
 * @returns the dict key of the clause that describes it
 */
export function hookReadingKey(entry: HookEntry): string {
  return entry.event === "pre_tool_use" ? "set.hkPre" : "set.hkPost";
}

/**
 * Whether the timeout on screen is this hook's own or the runner's.
 *
 * Worth a clause of its own: the same number means two different things, and an
 * operator who wants to change it needs to know which entry to edit.
 *
 * @param entry the hook as the server read it
 * @returns the dict key of the clause that describes the timeout
 */
export function timeoutNoteKey(entry: HookEntry): string {
  return entry.timeoutSeconds === null ? "set.hkTimeoutInherited" : "set.hkTimeoutOwn";
}

/**
 * Whether this hook runs AHEAD of the permission gate — the one judgement this
 * file makes, and it is about what a reader should look at twice rather than
 * about what the runner does.
 *
 * A post_tool_use hook cannot stop anything: its exit code is ignored by design.
 * A pre_tool_use one runs before the gate and can refuse a call outright, which
 * also means it is the one that executes without ever being asked about.
 *
 * @param entry the hook as the server read it
 * @returns true when the hook runs before the gate
 */
export function runsBeforeTheGate(entry: HookEntry): boolean {
  return entry.event === "pre_tool_use";
}
