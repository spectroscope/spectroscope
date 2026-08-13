// How much a session row says (card 214) — a tiny external store à la
// chatWidth.ts / disclosure.ts, persisted, and offered from the options control
// at the head of the session list.
//
//   normal   — the name and the state dot, and nothing else
//   extended — what a row draws today: the comb, the relative time, the turn
//              and token counts, and the model once the rail is wide enough
//
// normal is the DEFAULT, including for a reader who never opened the panel:
// "less in the rail" is the ask, so the quiet shape is the one you get without
// asking for it. That is a decision, not a leftover — the tests say so.
//
// WHERE IT LIVES, and what was rejected. localStorage, key
// `spectroscope:sessions.density`, because that is what this UI already uses to
// remember a choice across reloads: lang, disclosure, chatWidth, chatView,
// traceFace and a dozen more sit there under the same `spectroscope:` prefix,
// each behind exactly this shape of store. Following the idiom costs nothing
// and buys the reader one place to look.
//
//   - The server's settings store (GET/PUT /api/settings) was rejected: it is
//     about how runs BEHAVE — provider, model, keys, permission mode — and a
//     round trip for a view preference makes the rail wait on the network to
//     find out how to draw itself.
//   - sessionStorage was rejected: it dies with the tab, and criterion 5 is a
//     reload, so a store that forgets on the second one is a store that fails
//     the ask half the time.
//   - React state lifted into App was rejected for the same reason: it is a
//     reload away from gone.
//
// One consequence worth naming, because the same home is opened twice: the
// desktop app and a browser tab are two different origins over one ~/.spectro,
// so each keeps its own copy of this choice. That is the right trade here — the
// setting is about the window you are reading in, and a reader who wants the
// rail quiet on the laptop screen has not said anything about the other one.
// (It is also the honest limit of localStorage rather than a design.)

import { useSyncExternalStore } from "react";

/** How much a session row says. */
export type Density = "normal" | "extended";

/** Every value, in the order the panel offers them. */
export const DENSITIES: readonly Density[] = ["normal", "extended"];

/** Where the choice is written. Named so a test can look for it by name. */
export const DENSITY_KEY = "spectroscope:sessions.density";

/** The storage seam. Injected in tests — this suite runs in plain Node. */
interface Hooks {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
}

const browserHooks: Hooks = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore — a private window is not a reason to lose the rail */
    }
  },
};

let hooks: Hooks = browserHooks;

/** Visible for tests. */
export function __setTestHooks(next: Hooks): void {
  hooks = next;
}

/** Visible for tests: re-read from the seam, the way a page load does. */
export function __resetForTests(): void {
  density = readSaved();
}

/** What the previous visit left behind, or the default. */
export function readSaved(): Density {
  const raw = hooks.get(DENSITY_KEY);
  return DENSITIES.includes(raw as Density) ? (raw as Density) : "normal";
}

let density: Density = readSaved();
const listeners = new Set<() => void>();

export function setDensity(next: Density): void {
  if (next === density) return;
  density = next;
  hooks.set(DENSITY_KEY, density);
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentDensity(): Density {
  return density;
}

/** What a stored row draws at this density. */
export interface RowParts {
  /** The state dot. Always — see below. */
  dot: boolean;
  /** The coloured signal comb. */
  sigil: boolean;
  /** The line of relative time, turn count, token count and model. */
  meta: boolean;
}

/**
 * What a stored session row draws, per density.
 *
 * <p>The dot is true at every density on purpose, and it is the one part this
 * function may not cut: with the metadata line gone, the dot is the ONLY thing
 * left in the row that can say a session is running, and it carries its state
 * as a word as well as a hue (see {@code RunDot}). The comb goes with the
 * metadata line rather than with the name, because it is a second glyph and the
 * card asks normal for the name and the state dot.</p>
 */
export function rowParts(at: Density): RowParts {
  const extended = at === "extended";
  return { dot: true, sigil: extended, meta: extended };
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Density {
  return density;
}

export function useDensity(): Density {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
