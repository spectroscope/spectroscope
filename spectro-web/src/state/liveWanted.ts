// Whether the speaker wants the words to appear while they are still speaking
// (card 187 step 6).
//
// Persisted on the same idiom as the microphone choice, the trace's columns and
// its filter: a module store rather than a context, read with
// useSyncExternalStore.
//
// OFF until somebody turns it on, and that is a decision rather than caution.
// A live session is METERED BY THE MINUTE where a batch transcription is billed
// by the clip, and it is the newer of the two paths. A feature that spends money
// differently gets switched on by a person.
//
// This is only half the answer: wanting live text does not make it happen. What
// the control actually does is `liveReading`'s business, because a route that
// cannot stream must never be quietly swapped for one that can.

import { useSyncExternalStore } from "react";

/** The stored key. Exported so a test can write the junk a real browser writes. */
export const LIVE_WANTED_KEY = "spectroscope:stt.live";

/** The one stored value that means yes. Anything else, including a half-written
 *  or foreign string, falls to the safe side — which here is the one that does
 *  not open a metered session. */
const YES = "1";

let wanted = readLiveWanted();
const listeners = new Set<() => void>();

/**
 * What the store says, read from scratch.
 *
 * @return whether live text was asked for
 */
export function readLiveWanted(): boolean {
  try {
    return localStorage.getItem(LIVE_WANTED_KEY) === YES;
  } catch {
    return false; // no localStorage (private mode, tests)
  }
}

/**
 * Turn live text on or off.
 *
 * @param on whether the speaker wants it
 */
export function setLiveWanted(on: boolean): void {
  wanted = on;
  try {
    if (on) localStorage.setItem(LIVE_WANTED_KEY, YES);
    else localStorage.removeItem(LIVE_WANTED_KEY);
  } catch {
    // A browser that refuses storage still gets the feature for this session;
    // it just does not remember. Losing the preference is not worth losing the
    // press that set it.
  }
  for (const l of listeners) l();
}

/** Visible for tests, and for a caller that cannot use a hook. */
export function currentLiveWanted(): boolean {
  return wanted;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): boolean {
  return wanted;
}

/** The setting, as a hook. */
export function useLiveWanted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
