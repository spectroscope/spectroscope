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
// an effective timeout for one that set none, an empty command for one whose
// command was redacted. Writing that view back would persist all three: a
// removal of one hook would quietly pin another hook's defaults into the file,
// and a hook whose command looked like a credential would come back disarmed.

/** One hook as the SERVER read it — mirrors SettingsController#reading. */
export interface HookEntry {
  /** "pre_tool_use" or "post_tool_use". */
  event: string;
  /** The glob the runner will actually match with — defaulted to "*". */
  matcher: string;
  /** What the file itself says, or null when it names no matcher. */
  rawMatcher: string | null;
  /** The command, or "" when a credential shape made it unrecordable. */
  command: string;
  /** Which redaction rule hid the command, or "" when nothing did. */
  redactedBy: string;
  /** What the file says, or null when it sets no timeout. */
  timeoutSeconds: number | null;
  /** The budget the hook will actually run under. */
  effectiveTimeoutSeconds: number;
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
 * The entries of one scope, as the settings file holds them.
 *
 * @param view the read-out, or null before it lands
 * @param scope the settings layer to write back
 * @returns the writable array, or null when this scope holds a hook whose
 *          command the server would not show — writing that array back would
 *          replace a real command with an empty string, which is a hook
 *          disarmed by the act of opening its own settings page
 */
export function rawHooks(view: HooksView | null, scope: string): HookWrite[] | null {
  const entries = view?.scopes[scope] ?? [];
  if (entries.some((entry) => entry.redactedBy !== "")) return null;
  return entries.map((entry) => {
    // Key ORDER is the write order, and this is a file a person opens: event,
    // then what it matches, then what it runs, then how long it may take.
    const out: HookWrite = { event: entry.event, command: entry.command };
    if (entry.rawMatcher !== null && entry.rawMatcher !== "") out.matcher = entry.rawMatcher;
    if (entry.timeoutSeconds !== null) out.timeoutSeconds = entry.timeoutSeconds;
    return out;
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
  const out: HookWrite = { event, command: cmd };
  const glob = matcher.trim();
  if (glob !== "") out.matcher = glob;
  // The core treats null and non-positive alike (timeoutOrDefault), so a 0 or a
  // -1 in the file would say something the runner does not mean.
  const seconds = Number(timeout.trim());
  if (Number.isInteger(seconds) && seconds > 0) out.timeoutSeconds = seconds;
  return out;
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
