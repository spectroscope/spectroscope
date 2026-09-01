// Card 357: the numbers that govern a run, as the settings room reads them.
//
// THE ONE THING THIS MODULE DOES NOT DO IS NAME A CONSTANT. Not one field
// name, value, unit or reason is written here — the whole list arrives from
// `GET /api/governing-numbers`, which answers a registry generated from
// `spectro-core`'s source tree and held to it by GoverningNumbersDriftTest. A
// table of the constants typed in TypeScript would rot before the next release,
// and this house found that exact defect — a hand-list guarded by a test that
// types the same hand-list — three times in one card (312) and again in 314.
//
// What IS written here is the VOCABULARY: the kinds and the units, as unions.
// Those are the Java enums' own constants and nothing else, which
// `governingNumbers.drift.test.ts` reads out of Governs.java and holds this
// file to — so a ninth kind cannot ship with the room silently dropping it.

/** Whether an operator can change a number, and if not, why not — the
 *  constants of `Governs.Kind`, in the order the room draws them. */
export const GOVERNING_KINDS = [
  "SETTABLE",
  "MODEL_CHOICE",
  "LOOKS_SETTABLE",
  "UNEXAMINED",
  "FOREIGN_CONTRACT",
  "FIXED",
  "ALIAS",
  "PLUMBING",
] as const;
export type GoverningKind = (typeof GOVERNING_KINDS)[number];

/** The kinds that do not govern a run — `Governs.Kind#governs()` on this side
 *  of the wire. Held to the Java predicate by the drift test beside this file,
 *  so "what counts as governing" keeps having exactly one definition. */
export const NOT_GOVERNING_KINDS: readonly GoverningKind[] = ["ALIAS", "PLUMBING"];

/** What a number counts — the constants of `Governs.Unit`. */
export const GOVERNING_UNITS = [
  "TURNS",
  "TOKENS",
  "CHARACTERS",
  "BYTES",
  "MILLISECONDS",
  "SECONDS",
  "COUNT",
  "PERCENT",
  "PIXELS",
  "LINES",
  "RATIO",
  "NONE",
] as const;
export type GoverningUnit = (typeof GOVERNING_UNITS)[number];

/** One entry of the registry, exactly as `GoverningNumber` serialises it. */
export interface GoverningNumber {
  /** The declaring class, fully qualified. */
  owner: string;
  /** The constant's name. */
  field: string;
  /** Its live value, decimal, read off the field itself. */
  value: string;
  /** The initializer as the source writes it — `64L * 1024 * 1024` stays
   *  readable as arithmetic rather than collapsing to a digit soup. */
  expression: string;
  /** Whether an operator can change it, and if not, why not. */
  kind: GoverningKind;
  /** What it counts. */
  unit: GoverningUnit;
  /** The settings key that overrides it; empty unless the kind is SETTABLE. */
  key: string;
  /** The javadoc standing above the constant, flattened to text. Paragraphs
   *  are separated by a blank line. */
  explanation: string;
}

/** Whether a number governs a run. One definition, mirrored from the Java
 *  predicate and pinned to it. */
export function governs(kind: GoverningKind): boolean {
  return !NOT_GOVERNING_KINDS.includes(kind);
}

/** The class without its package — the group heading the room shows. */
export function ownerSimpleName(owner: string): string {
  const at = owner.lastIndexOf(".");
  return at < 0 ? owner : owner.slice(at + 1);
}

/** The i18n key of a kind's label. Written here so the room never spells a
 *  kind inline, and so the drift test can demand a label for every constant
 *  of the enum instead of for the ones somebody remembered. */
export function governingKindLabelKey(kind: GoverningKind): string {
  return `set.gnKind.${kind}`;
}

/** The i18n key of a kind's one-line meaning — what "looks settable" MEANS,
 *  which is the sentence that stops the page repeating the audit mistake it
 *  exists to expose. */
export function governingKindWhyKey(kind: GoverningKind): string {
  return `set.gnWhy.${kind}`;
}

/** The i18n key of a unit's label. */
export function governingUnitLabelKey(unit: GoverningUnit): string {
  return `set.gnUnit.${unit}`;
}

// Named BYTES_PER_* on purpose: `MIB` and `GIB` are themselves constants in
// the registry, and the guard that proves this file keeps no copy of the list
// works by substring. A helper that happens to share a constant's name would
// have made that guard unusable for the one collision that matters.
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * A second reading of a value for the units where the decimal is unreadable:
 * 1800000 milliseconds is a number nobody can see 30 minutes in, and this card
 * is about being able to see. Returns null when the plain value already says
 * it — no parenthesis that repeats the number beside it.
 *
 * @param number the entry
 * @return the friendlier reading, or null
 */
export function readableValue(number: GoverningNumber): string | null {
  const n = Number(number.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (number.unit === "BYTES") {
    if (n >= BYTES_PER_GIB && n % BYTES_PER_GIB === 0) return `${n / BYTES_PER_GIB} GiB`;
    if (n >= BYTES_PER_MIB && n % BYTES_PER_MIB === 0) return `${n / BYTES_PER_MIB} MiB`;
    if (n >= BYTES_PER_KIB && n % BYTES_PER_KIB === 0) return `${n / BYTES_PER_KIB} KiB`;
    return null;
  }
  if (number.unit === "MILLISECONDS") {
    const seconds = n / MS_PER_SECOND;
    if (seconds >= SECONDS_PER_MINUTE && seconds % SECONDS_PER_MINUTE === 0) {
      return `${seconds / SECONDS_PER_MINUTE} min`;
    }
    if (n >= MS_PER_SECOND && n % MS_PER_SECOND === 0) return `${seconds} s`;
    return null;
  }
  if (number.unit === "SECONDS") {
    if (n >= SECONDS_PER_MINUTE && n % SECONDS_PER_MINUTE === 0) {
      return `${n / SECONDS_PER_MINUTE} min`;
    }
    return null;
  }
  return null;
}

/**
 * The entries a filter box shows. Matches the constant, its class, its key and
 * its reason — an operator who met a limit is searching for the WORDS of the
 * error, not for a Java identifier they have never seen.
 *
 * @param numbers the registry
 * @param query   what was typed; blank shows everything
 * @return the matching entries, in registry order
 */
export function filterGoverningNumbers(
  numbers: readonly GoverningNumber[],
  query: string,
): GoverningNumber[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...numbers];
  return numbers.filter((number) =>
    `${number.owner} ${number.field} ${number.key} ${number.value} ${number.explanation}`
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * The registry split into the room's groups, in draw order, with empty groups
 * dropped. Derived from the data: a kind nobody uses draws no heading, and a
 * kind somebody starts using draws one without this file being touched.
 *
 * @param numbers the entries to group
 * @return one entry per non-empty kind, in GOVERNING_KINDS order
 */
export function groupGoverningNumbers(
  numbers: readonly GoverningNumber[],
): { kind: GoverningKind; numbers: GoverningNumber[] }[] {
  return GOVERNING_KINDS.map((kind) => ({
    kind,
    numbers: numbers.filter((number) => number.kind === kind),
  })).filter((group) => group.numbers.length > 0);
}

let activeFetch: typeof fetch = (...args) => window.fetch(...args);

/** Swap the fetch the client uses — the same seam as the rest of `state/*`,
 *  and the reason the room's test can feed it the REAL registry file. */
export function setGoverningNumbersFetch(f: typeof fetch): void {
  activeFetch = f;
}

/**
 * `GET /api/governing-numbers` — every classified numeric constant this build
 * carries.
 *
 * @return the registry, in the order the server answers it
 */
export async function fetchGoverningNumbers(): Promise<GoverningNumber[]> {
  const res = await activeFetch("/api/governing-numbers");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as GoverningNumber[];
}
