// The client half of the ladder: pure reads over the snapshot the server sends.
//
// Two rules live here rather than in the components, because both are easy to
// break by accident in JSX and expensive to get wrong:
//
//   1. Locks are an allow-list. Only the surfaces the ladder actually names can
//      ever be covered, and the gate and the settings are never among them —
//      the first is a safety surface, the second is where the keys live, so a
//      lock on either would trap the very home it was meant to help.
//   2. Lock state is derived from the server snapshot on every read, never
//      cached. The mode can flip in another tab, and a stale closure showing a
//      lock that no longer exists is exactly the bug class the 0.2.0 autoPick
//      fix and the enteredFleet bleed both belonged to.

/** How much of the ladder is doing work in this home. */
export type LevelingMode = "ladder" | "checklist" | "off";

/** Whether the engine saw it happen or a hand said it did. */
export type MarkOrigin = "observed" | "manual";

/** One rung as the server describes it. */
export interface LevelingLevel {
  index: number;
  id: string;
  nameKey: string;
  blurbKey: string;
  opens: string[];
  advanceWhen: string[];
}

/** One criterion as the server describes it. */
export interface LevelingCriterion {
  id: string;
  level: number;
  source: string;
  surface: string | null;
  mastery: boolean;
  labelKey: string;
  countsKey: string;
}

/** One met criterion and the receipt behind it. */
export interface LevelingMark {
  sessionId: string | null;
  eventIndex: number | null;
  ts: number;
  origin: MarkOrigin;
}

/** The whole answer of GET /api/leveling, and of the leveling_state frame. */
export interface LevelingSnapshot {
  mode: LevelingMode;
  /** Whether this home has answered the once-per-home intro question. */
  introSeen: boolean;
  level: number;
  levelId: string;
  ladder: {
    schemaVersion: number;
    levels: LevelingLevel[];
    criteria: LevelingCriterion[];
  };
  marks: Record<string, LevelingMark>;
  remaining: string[];
  history: { level: number; ts: number }[];
}

/** What one slot of the header strip shows. */
export type SlotKind = "empty" | "line" | "band";

/** How many slots the strip has: five spectral lines plus the full band. */
export const STRIP_SLOTS = 6;

/**
 * Surfaces a lock may never cover, whatever the level says.
 *
 * The gate is a safety surface: a permission request that fires at level 0
 * renders and works, or an agent sits blocked behind a teaser. The settings
 * hold the keys, so locking them would wall a home off from becoming a home
 * that has a provider.
 */
const NEVER_LOCKED = new Set(["gate", "settings"]);

/**
 * The strip for a level: one filled line per rung climbed, and the full
 * spectrum in the last slot once the ladder is finished.
 */
export function slotKinds(level: number): SlotKind[] {
  const kinds: SlotKind[] = [];
  for (let slot = 0; slot < STRIP_SLOTS; slot++) {
    if (slot === STRIP_SLOTS - 1) {
      kinds.push(level >= 6 ? "band" : "empty");
    } else {
      kinds.push(slot < level ? "line" : "empty");
    }
  }
  return kinds;
}

/**
 * Whether a surface renders its real content, or a teaser.
 *
 * Open by default: an unknown surface, a missing snapshot, any mode other than
 * `ladder`, and the two surfaces that are never locked. Only a surface the
 * ladder itself lists as opening at a level above this one is closed.
 */
export function isSurfaceOpen(snapshot: LevelingSnapshot | null | undefined, surface: string): boolean {
  if (!snapshot || snapshot.mode !== "ladder") {
    return true;
  }
  if (NEVER_LOCKED.has(surface)) {
    return true;
  }
  const owner = snapshot.ladder.levels.find((level) => level.opens.includes(surface));
  if (!owner) {
    return true;
  }
  return owner.index <= snapshot.level;
}

/** The level that opens a surface, for the teaser's "unlocks at" line. */
export function levelOpening(
  snapshot: LevelingSnapshot | null | undefined,
  surface: string,
): LevelingLevel | null {
  if (!snapshot) {
    return null;
  }
  return snapshot.ladder.levels.find((level) => level.opens.includes(surface)) ?? null;
}

/** The criteria still standing between this home and the next rung. */
export function criteriaFor(snapshot: LevelingSnapshot, level: number): LevelingCriterion[] {
  return snapshot.ladder.criteria.filter((criterion) => criterion.level === level);
}

/** What a climb from one level to another just opened, in ladder order. */
export function newlyOpened(ladder: LevelingSnapshot["ladder"], from: number, to: number): string[] {
  if (to <= from) {
    return [];
  }
  return ladder.levels
    .filter((level) => level.index > from && level.index <= to)
    .flatMap((level) => level.opens);
}

/**
 * A level id read as its name: the ids were written to be read, so `the-gate`
 * is "the gate" and nothing has to keep a second copy of the words.
 */
export function levelName(levelId: string): string {
  return levelId.replace(/-/g, " ");
}

/**
 * A translated string, or the fallback when the key is unknown.
 *
 * `t()` returns the key itself for a missing entry, loudly and on purpose. That
 * is right for chrome a developer forgot, but wrong here: the ladder's copy
 * keys arrive from the server, so a newer server naming a level this build has
 * never heard of would print a dotted key at people. The id reads as a name, so
 * there is always something better to show.
 */
export function translated(translate: (key: string) => string, key: string, fallback: string): string {
  const value = translate(key);
  return !value || value === key ? fallback : value;
}
