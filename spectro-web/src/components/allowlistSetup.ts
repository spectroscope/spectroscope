// The allowlist settings block's pure half (card 199).
//
// The one rule this file obeys above all others, the same one WebSearchSettings
// obeys: it does NOT decide anything the gate decides. The tier map ships in the
// jar, Allowlist parses the entry grammar, and GET /api/settings/allowlist reads
// both out. A tier resolved a second time in TypeScript would drift from the
// gate the moment either changed, and a permission page that disagrees with the
// gate is worse than no page at all.
//
// What lives here is what the page genuinely owns: composing the string a user's
// three form fields add up to, and adding or removing one line of an array.

/** One entry as the server read it — mirrors Allowlist.EntryReading. */
export interface AllowlistEntry {
  /** The line exactly as it stands in the settings file. */
  raw: string;
  /** The tool name, or the family prefix when `wildcard`. */
  tool: string;
  /** Whether the entry covers a family rather than one name. */
  wildcard: boolean;
  /** The entry's CEILING as a tier name, or null when the entry is inert. */
  tier: string | null;
  /** The tier the NAMED tool actually holds; null for a wildcard. */
  toolTier: string | null;
  /** The guarded value prefix, or null when the entry has none. */
  valuePrefix: string | null;
  /** Why the entry approves nothing, or null when it is usable. */
  inertBecause: string | null;
}

/** GET /api/settings/allowlist, verbatim — see SettingsController#allowlist. */
export interface AllowlistView {
  schemaVersion: number;
  /** The shipped map's version — shown so a reader can tell which release rated these tools. */
  mapVersion: string;
  /** The tier names the gate knows, in blast-radius order. */
  tiers: string[];
  /** Per settings layer, that layer's own entries. */
  scopes: Record<string, AllowlistEntry[]>;
  /** The folded list every gate decision is actually measured against. */
  effective: AllowlistEntry[];
  files: Record<string, string>;
}

/** The separator between the tool segment and the tier qualifier — mirrors
 *  Allowlist.TIER_MARK. Written once here so the composer below and the tests
 *  cannot disagree about it. */
export const TIER_MARK = "#";

/**
 * The entry string a tool name, a tier and an optional value prefix add up to.
 *
 * The tier is always written out, even for a read entry. Card 199 lets an
 * unqualified entry mean "read", but a form that silently relies on that
 * default produces lines whose meaning a reader has to know a rule to work out
 * — and this is a permissions file. Every line this page writes says what it
 * means.
 *
 * @param tool the tool name, or a family prefix ending in "*"
 * @param tier one of the tier names the server answered
 * @param valuePrefix the guarded value the call must start with, or ""
 * @returns the entry to append to autoApprove, or "" when there is nothing to write
 */
export function composeEntry(tool: string, tier: string, valuePrefix: string): string {
  const name = tool.trim();
  const value = valuePrefix.trim();
  if (name === "" || tier === "") return "";
  const head = `${name}${TIER_MARK}${tier}`;
  return value === "" ? head : `${head}:${value}${value.endsWith("*") ? "" : "*"}`;
}

/**
 * The array to write back after adding one entry. A duplicate is not appended:
 * two identical lines approve exactly what one approves, and the second one is
 * only ever confusing.
 *
 * @param current the scope's own entries
 * @param entry the composed entry
 * @returns the array to PUT, or null when there is nothing to write
 */
export function withEntry(current: string[], entry: string): string[] | null {
  if (entry === "" || current.includes(entry)) return null;
  return [...current, entry];
}

/**
 * The array to write back after removing one entry — by exact line, because two
 * entries can differ only in their value prefix and removing the wrong one is a
 * silent widening or a silent narrowing.
 *
 * @param current the scope's own entries
 * @param entry the line to drop
 * @returns the array to PUT, or null when the line was not there
 */
export function withoutEntry(current: string[], entry: string): string[] | null {
  if (!current.includes(entry)) return null;
  return current.filter((line) => line !== entry);
}

/**
 * How one entry should be described in one clause. Returns a dict KEY, never a
 * sentence: this page is bilingual and the server's own wording is not.
 *
 * @param entry the entry as the server read it
 * @returns the dict key of the clause that describes it
 */
export function entryReadingKey(entry: AllowlistEntry): string {
  if (entry.inertBecause !== null) return "set.alInert";
  if (entry.wildcard) return "set.alFamily";
  if (entry.valuePrefix !== null) return "set.alScoped";
  return "set.alExact";
}

/**
 * Whether an entry approves something wider than the tool it names would
 * suggest — the one judgement this page is allowed to make, because it is not a
 * judgement about the gate but about what a reader should look at twice.
 *
 * An eval-execute entry is the one worth flagging: it is what a prompt-injected
 * page would ask a user to paste, and after the one-time migration it is also
 * what a long-forgotten legacy entry may have become.
 *
 * @param entry the entry as the server read it
 * @returns true when the entry approves code execution
 */
export function approvesExecution(entry: AllowlistEntry): boolean {
  return entry.tier === "eval-execute";
}

/** The entries of one scope as raw strings, in file order. */
export function rawEntries(view: AllowlistView | null, scope: string): string[] {
  return (view?.scopes[scope] ?? []).map((entry) => entry.raw);
}
