// How far the source pane's tree reading opens (owner 2026-08-30, card 326):
// "dann können wir da auch eine option machen default (bis ebene 2
// ausgeklappt) und verbose alles ausklappen."
//
//   default   two levels, which is JsonTree's own default (JsonTree.tsx) — the
//             component as it was always built, so this card adds a setting
//             rather than a renderer
//   verbose   every level, ALL_LEVELS
//
// WHICH OF THE APP'S TWO DOCTRINES THIS ONE FOLLOWS, and why it is a choice
// rather than an oversight. state/disclosure.ts lets a hand-made choice SURVIVE
// a level change (`manual ?? defaultOpen(level)`), because a chat reader opens
// one specific block and means it. state/traceFace.ts has the MASTER WIN over
// every hand-made choice, because the complaint that produced it was "otherwise
// I have to switch every row".
//
// THIS CONTROL TAKES traceFace's DOCTRINE. A reader who presses "verbose" is
// asking for everything open, and a control that left the nodes they had
// already folded shut alone would look broken in exactly the case it exists
// for. So it is built on the same store: createFaceStore, whose epoch retires
// every hand-made fold at once without keeping a list of them.
//
// HOW THE EPOCH REACHES A FOLD. JsonTree holds each node's open state from
// mount (`useState(depth < defaultDepth)`), so handing a mounted tree a new
// `defaultDepth` moves nothing at all. The epoch is therefore a REMOUNT key,
// exactly as LlmExchangeDetail's `expandEpoch` already is: TraceView keys the
// source pane on {@link sourcePaneKey}, the tree is born again, and every node
// reads the new level. Remove the epoch from that key and a hand-folded node
// survives "verbose" — which is the whole promise the dictionary makes to the
// reader ("auch die Knoten, die du selbst zugeklappt hast").
//
// The key is BUILT HERE, next to the doctrine that needs it, rather than spelled
// out at the mount. It was a template literal in TraceView until the re-review
// of this card, and all three reviewers measured the same hole: taking the epoch
// out of it left the whole suite green while the promise stopped holding. Two
// halves guard it now — that the key moves with the epoch (pure, here) and that
// the pane is mounted under it (read off TraceView, because a React key never
// reaches the markup this gate renders). What neither half can see is React then
// rebuilding the subtree; that is React's contract and it was checked live.
//
// SESSION-WIDE, and persisted like the face master beside it: the level is a
// statement about how this reader reads, not about the file they happen to
// have open.

import { ALL_LEVELS } from "../components/JsonTree";
import { createFaceStore, useFaceStore } from "./faceStore";

export type SourceDepth = "default" | "verbose";

export const SOURCE_DEPTHS: readonly SourceDepth[] = ["default", "verbose"];

/** What the pane opens on. The owner's own word: "default (bis ebene 2
 *  ausgeklappt)", with verbose as the thing you ask for. */
export const DEFAULT_SOURCE_DEPTH: SourceDepth = "default";

/** The master as the pane reads it — the level, and the stamp that says when
 *  it last moved. */
export interface SourceDepthPref {
  depth: SourceDepth;
  /** Bumped on every real change; see the header for what it is FOR. */
  epoch: number;
}

const store = createFaceStore<SourceDepth>(
  "spectroscope:trace.sourceDepth",
  SOURCE_DEPTHS,
  DEFAULT_SOURCE_DEPTH,
);

// The store speaks of a `face`, which would be a lie over a level, so what
// leaves this module is renamed. Renamed ONCE per change and not per read:
// useSyncExternalStore compares snapshots by identity, and a fresh object every
// time would re-render the open pane forever.
let seen = store.current();
let view: SourceDepthPref = { depth: seen.face, epoch: seen.epoch };

/** Visible for tests: the stored master, or the default for anything else. */
export function parseSourceDepth(raw: string | null): SourceDepth {
  return store.parse(raw);
}

export function setSourceDepth(next: SourceDepth): void {
  store.set(next);
}

/** The master, epoch included. The same object until something actually
 *  changes. */
export function currentSourceDepth(): SourceDepthPref {
  const now = store.current();
  if (now !== seen) {
    seen = now;
    view = { depth: now.face, epoch: now.epoch };
  }
  return view;
}

/**
 * How many levels this setting starts open.
 *
 * @param depth the master's level
 * @return the number JsonTree's `defaultDepth` takes
 */
export function openLevels(depth: SourceDepth): number {
  return depth === "verbose" ? ALL_LEVELS : 2;
}

/**
 * The React key the source pane is mounted under.
 *
 * Built from the EPOCH and not from the level: the level is what a node reads
 * once it is born, the epoch is what makes it be born again. A key built from
 * the level alone would collapse default → verbose → default onto two keys, and
 * the second press would hand every hand-folded node straight back.
 *
 * @param pref the master, epoch included
 * @return a key that changes exactly when the master moves, and not otherwise
 */
export function sourcePaneKey(pref: SourceDepthPref): string {
  return `depth-${pref.epoch}`;
}

export function useSourceDepth(): SourceDepthPref {
  // Subscribed to the store, read through the rename above so the hook and
  // currentSourceDepth() hand back the very same object.
  useFaceStore(store);
  return currentSourceDepth();
}
