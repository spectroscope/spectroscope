// The state INSIDE a view, as an address.
//
// The owner: "ich will auch deep links zu trace, spectrum und so … und gerne
// noch dann die parameter des zooms oder so und bei trace welche filter und
// welche nachricht ausgewählt ist. also ein wirkliches deep link system."
//
// WHAT IS WORTH SERIALISING, which is the question the card asked first and the
// reason this is a module rather than three fields.
//
// A selected trace row is a POSITION. It is the commonest thing anybody sends
// anybody — "look at this one" — and it belongs in the address without
// question. A spectrum window is a READING, and the same argument holds: "look
// at this stretch" is a thing you send.
//
// Filters are different. They default to ALL ON, so writing them always would
// hang a noisy clause on every link a reader copies, describing a state nobody
// chose. So they travel only when they DIFFER from the default — which also
// means a link without them says "however you have it", and that is the right
// default for a filter.
//
// The spelling is a query string inside the hash, because it is a query: the
// path says WHERE, this says how you were looking at it. Everything here is
// optional and everything parses forgivingly — a malformed clause is dropped
// rather than refused, since landing on the right view with the wrong zoom
// beats not landing at all.

/** How a view was being looked at. Every field optional; an empty object and
 *  `undefined` mean the same thing and both format to nothing. */
export interface ViewState {
  /** The trace row a link points at, by its wire `seq`. */
  row?: number;
  /** The trace categories that are ON — written ONLY when some are off. */
  only?: string[];
  /** The spectrum window as two fractions of the whole domain. */
  win?: { a: number; b: number };
}

/** Nothing selected, nothing filtered, nothing zoomed. */
export const NO_VIEW_STATE: ViewState = {};

/** True when there is nothing to write. */
export function isEmptyViewState(v: ViewState | undefined): boolean {
  return v === undefined || (v.row === undefined && v.only === undefined && v.win === undefined);
}

const num = (s: string): number | undefined => {
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Two fractions, in order, both inside [0,1]. Anything else is not a window. */
function parseWindow(raw: string): { a: number; b: number } | undefined {
  const [x, y] = raw.split(",");
  const a = num(x ?? "");
  const b = num(y ?? "");
  if (a === undefined || b === undefined) return undefined;
  if (a < 0 || b > 1 || a >= b) return undefined;
  return { a, b };
}

/**
 * Reads the query part of a hash into view state.
 *
 * @param query the text after `?`, without it
 * @returns what it could read; unknown keys and malformed values are dropped
 */
export function parseViewState(query: string | undefined): ViewState {
  if (!query) return NO_VIEW_STATE;
  const out: ViewState = {};
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const key = part.slice(0, at);
    const raw = decodeURIComponent(part.slice(at + 1));
    if (key === "row") {
      const n = num(raw);
      // A row is an index into a recorded stream; a negative one addresses
      // nothing, and a fractional one is a typo rather than a position.
      if (n !== undefined && n >= 0 && Number.isInteger(n)) out.row = n;
    } else if (key === "only") {
      const list = raw.split(",").filter((c) => c !== "");
      if (list.length > 0) out.only = list;
    } else if (key === "win") {
      const w = parseWindow(raw);
      if (w !== undefined) out.win = w;
    }
  }
  return out;
}

/** How many digits a window fraction keeps. Three is about one pixel on a
 *  1,400-wide band, and it keeps the address short enough to read. */
const WIN_DIGITS = 3;

/**
 * Writes view state as a query suffix, `?` included, or "" when there is
 * nothing to say.
 *
 * @param v the state
 * @returns the suffix
 */
export function formatViewState(v: ViewState | undefined): string {
  if (isEmptyViewState(v)) return "";
  const parts: string[] = [];
  if (v!.row !== undefined) parts.push(`row=${v!.row}`);
  if (v!.only !== undefined && v!.only.length > 0) {
    parts.push(`only=${encodeURIComponent(v!.only.join(","))}`);
  }
  if (v!.win !== undefined) {
    const a = Number(v!.win.a.toFixed(WIN_DIGITS));
    const b = Number(v!.win.b.toFixed(WIN_DIGITS));
    parts.push(`win=${a},${b}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * The `only` clause for a filter selection — or nothing, when everything is on.
 *
 * This is the rule that keeps copied links short: a reader who has changed no
 * filter should get no filter clause, and a link without one means "however you
 * have it" rather than "turn everything on".
 *
 * @param active the categories currently on
 * @param all every category there is
 * @returns the list to write, or undefined when nothing is filtered out
 */
export function onlyClause(active: ReadonlySet<string>, all: readonly string[]): string[] | undefined {
  if (active.size >= all.length) return undefined;
  const on = all.filter((c) => active.has(c));
  // Everything off is a real state and a readable one; it is written as an
  // empty selection rather than dropped, or the address would say "all on".
  return on;
}
