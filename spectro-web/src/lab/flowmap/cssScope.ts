// ONE READER for flowmap.css, because the 0.11.0 merge shipped two and they
// disagreed. Pure string work — the caller hands in the stylesheet — so nothing
// here touches the file system and nothing here is a fixture.
//
// WHY THIS FILE EXISTS AT ALL, and it is not tidiness.
//
// The merge repair that folded the tool belt into a row count read the belt's
// columns out of the stylesheet with `selector.split(/\s+/).pop()`: the LAST
// component of the selector won and the rest was thrown away. So a rule written
// `.pf-agent--wide .pf-tools { grid-template-columns: 1fr 1fr }` was credited to
// `.pf-tools` on every card — including the compact one, which carries no
// `pf-agent--wide` anywhere in its markup (that class lives on `AgentNode`'s
// root, one level above the body the census renders). Measured: the compact
// belt is the one that has no cap and really does grow a row at a time, so a
// census pricing it at two columns while it renders one would have been green
// about a card moving under the reader's cursor.
//
// The rule these functions are built on: A SELECTOR IS A CLAIM ABOUT AN
// ANCESTOR, and the census can only honour a claim it can check.
//
//   `.pf-tools { … }`                     reaches both cards
//   `.pf-agent--wide .pf-tools { … }`     reaches the expanded card only
//   anything else                          reaches neither, because nothing in
//                                          this markup can satisfy it
//
// The third line is the conservative one on purpose: a rule this reader drops
// can only make a fold refuse to price, and a fold that refuses to price falls
// back to reading every element — which is the loud direction.

/** Which card is being read. The expanded hub renders inside `.pf-agent--wide`;
 *  the compact one, and the worker card, render inside nothing. */
export type Scope = "wide" | "compact";

/** One rule, as the folds need it: the class tokens of the compound selector it
 *  lands on, and its declaration body. */
export interface ScopedRule {
  readonly tokens: readonly string[];
  readonly body: string;
}

/** The one ancestor the agent card's own markup can be under. */
const WIDE = ".pf-agent--wide";

/** The classes a compound selector carries, with pseudo-classes, pseudo-
 *  elements and attribute filters cut off — `.pf-disc__btn[aria-expanded]`
 *  is the `pf-disc__btn` box either way. */
function classesOf(compound: string): string[] {
  return compound
    .split(".")
    .slice(1)
    .map((c) => c.split(/[[:]/)[0])
    .filter((c) => c !== "");
}

/**
 * Every rule of `css` that can reach markup rendered in `scope`.
 *
 * Comments come off FIRST — the scrubKeepsItsWidth lesson: a `}` inside a
 * comment ends an extracted rule early, and everything judged after it is
 * judged on a rule that is not there.
 *
 * A selector list is split on commas and each selector judged on its own. Child
 * and sibling combinators are dropped whole: `>` and `+` and `~` are claims
 * about a parent or a neighbour, and a card body rendered on its own has
 * neither.
 */
export function rulesOf(css: string, scope: Scope): ScopedRule[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: ScopedRule[] = [];
  const rule = /(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(bare)) !== null) {
    for (const selector of m[2].split(",")) {
      const trimmed = selector.trim();
      if (trimmed === "" || /[>+~]/.test(trimmed)) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length > 2) continue;
      if (parts.length === 2 && (parts[0] !== WIDE || scope !== "wide")) continue;
      const tokens = classesOf(parts[parts.length - 1]);
      if (tokens.length > 0) out.push({ tokens, body: m[3] });
    }
  }
  return out;
}

/**
 * The boxes a card RESERVES: a class the stylesheet gives a fixed `height` AND
 * a scroll. Nothing inside such a box can move the card, so a census may count
 * the box and stop there.
 *
 * A `height`, never a `max-height`: a max-height still collapses when its
 * region is empty, and a region that collapses is a region that moves the card.
 */
export function reservesOf(css: string, scope: Scope): Set<string> {
  const out = new Set<string>();
  for (const { tokens, body } of rulesOf(css, scope)) {
    if (!/(^|[\s;])height:\s*\d/.test(body)) continue;
    if (!/overflow(-y)?:\s*(auto|scroll)/.test(body)) continue;
    for (const token of tokens) out.add(token);
  }
  return out;
}

/** How many columns a `grid-template-columns` value declares — tracks at the
 *  top level, so `84px minmax(0, 1fr) auto` is three and not four. */
export function trackCount(value: string): number {
  let nesting = 0;
  let tracks = 0;
  let inTrack = false;
  for (const ch of value.trim()) {
    if (ch === "(") nesting++;
    else if (ch === ")") nesting--;
    if (nesting === 0 && /\s/.test(ch)) {
      inTrack = false;
      continue;
    }
    if (!inTrack) {
      tracks++;
      inTrack = true;
    }
  }
  return tracks;
}

/**
 * The fixed-column grids a card renders, by class -> columns. A census may
 * price such a grid by its row count instead of by its cells.
 *
 * `repeat()` is refused: a repeat count is not a track count, and a wrong
 * column count prices the rows wrong. Refusing only costs the fold — the census
 * then reads the grid element by element, which is the loud direction.
 */
export function gridsOf(css: string, scope: Scope): Map<string, number> {
  const out = new Map<string, number>();
  for (const { tokens, body } of rulesOf(css, scope)) {
    const tracks = /(^|[\s;])grid-template-columns:([^;]+)/.exec(body);
    if (tracks === null || /repeat\(/.test(tracks[2])) continue;
    for (const token of tokens) out.set(token, trackCount(tracks[2]));
  }
  return out;
}

/**
 * Does the stylesheet keep `.<token>` to a SINGLE LINE — reading every rule
 * that touches it, not the first one that agrees?
 *
 * This is the second condition a row count rests on, and the first draft of it
 * asked the question the wrong way round: "does any rule say nowrap". That
 * answers yes on `.pf-chip` and never sees a modifier one rule below taking it
 * back. `.pf-chip--foreign` is the live example — the one chip whose text is an
 * arbitrary wire name, so the only one that could ever want to wrap — and a
 * `white-space: normal` there would leave a fold pricing rows that are no
 * longer one line each.
 *
 * BEM modifiers count as the same box and nothing else does: `.pf-chip--on` is
 * the chip recoloured, `.pf-chip__fan` is a different element inside it. That
 * is the rule the census reads its markup by, so it is the rule read here.
 */
export function keptToOneLine(token: string, rules: readonly ScopedRule[]): boolean {
  let said = false;
  for (const { tokens, body } of rules) {
    if (!tokens.some((t) => t === token || t.startsWith(`${token}--`))) continue;
    for (const m of body.matchAll(/(^|[\s;])white-space:\s*([\w-]+)/g)) {
      if (m[2] !== "nowrap") return false;
      said = true;
    }
  }
  return said;
}
