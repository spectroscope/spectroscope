// The epoch-stamped master/override mechanism, extracted from traceFace.ts
// (card 120) so the trace's face store and the lab's retire hand-made
// overrides identically. Each store keeps its OWN face vocabulary, default and
// persistence key — what is shared is the mechanism:
//
// The reset keeps no list of rows/panels: an override is stamped with the
// epoch it was made under, and every real master change bumps the epoch, so
// all stamps go stale at once. The epoch is monotonic rather than the face's
// own value, because A → B → A must not resurrect an override made under the
// first A. It is never persisted: overrides do not outlive a reload either.

import { useSyncExternalStore } from "react";

/** The master switch as the rows/panels read it. */
export interface FacePref<F extends string> {
  face: F;
  /** Bumped on every real master change — see the header. */
  epoch: number;
}

/** What one row/panel was switched to by hand, and under which master. */
export interface FaceOverride<F extends string> {
  face: F;
  epoch: number;
}

/**
 * Which face one row/panel shows.
 *
 * @param master the master switch, epoch included
 * @param override what was switched to by hand, or null
 * @return the hand-picked face while its stamp is current, else the master's
 */
export function overrideFace<F extends string>(master: FacePref<F>, override: FaceOverride<F> | null): F {
  return override !== null && override.epoch === master.epoch ? override.face : master.face;
}

export interface FaceStore<F extends string> {
  /** The stored master, or the default for anything else. */
  parse(raw: string | null): F;
  set(next: F): void;
  current(): FacePref<F>;
  subscribe(cb: () => void): () => void;
}

/**
 * @param key         where the master is persisted
 * @param faces       this store's whole vocabulary
 * @param defaultFace what an absent, malformed or foreign value falls back to
 * @param legacy      words this store used to write, mapped to what they are
 *                    called now. A renamed face would otherwise reset every
 *                    reader who had chosen it, because the stored word is no
 *                    longer in the vocabulary and parse() falls through to the
 *                    default. Only for a name that changed with the CONTENT
 *                    unchanged; a word that came to mean something else has to
 *                    fall back, not carry a reader across.
 */
export function createFaceStore<F extends string>(
  key: string,
  faces: readonly F[],
  defaultFace: F,
  legacy: Readonly<Record<string, F>> = {},
): FaceStore<F> {
  function isFace(raw: string | null): raw is F {
    return raw !== null && (faces as readonly string[]).includes(raw);
  }
  function parse(raw: string | null): F {
    if (isFace(raw)) return raw;
    return raw !== null && raw in legacy ? legacy[raw] : defaultFace;
  }
  function readSaved(): FacePref<F> {
    try {
      return { face: parse(localStorage.getItem(key)), epoch: 0 };
    } catch {
      /* no localStorage (tests) — default */
    }
    return { face: defaultFace, epoch: 0 };
  }

  let pref = readSaved();
  const listeners = new Set<() => void>();

  function set(next: F): void {
    if (next === pref.face) return;
    // A fresh object per change, the same one between changes — the snapshot
    // identity is what useSyncExternalStore compares.
    pref = { face: next, epoch: pref.epoch + 1 };
    try {
      localStorage.setItem(key, pref.face);
    } catch {
      /* ignore */
    }
    for (const l of listeners) l();
  }

  function current(): FacePref<F> {
    return pref;
  }
  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return { parse, set, current, subscribe };
}

/** The shared subscription wiring; each store wraps this in its own named
 *  hook (useTraceFace, useLabFace) so the rules-of-hooks lint can see it. */
export function useFaceStore<F extends string>(store: FaceStore<F>): FacePref<F> {
  return useSyncExternalStore(store.subscribe, store.current, store.current);
}
