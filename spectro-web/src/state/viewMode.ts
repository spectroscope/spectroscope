// Card 430: the window's mode. `learn` shows every surface, as the app always
// did; `light` keeps the chat, the workspace dock, the sessions and the skills,
// and stops the background work of everything else. Which surface is open in
// which mode is the table in state/surfaces.ts; this module only holds the word.
//
// A browser mode (owner decision 2 of 2026-09-24): the server records every
// session as it always does. The word lives in local storage under one key,
// read before the first render the way state/lang.ts reads the language, and
// other open windows of the same origin follow a switch through the `storage`
// event. The desktop app and a browser tab are two origins' worth of storage,
// so each keeps its own mode (owner call 4, at its default).

import { useSyncExternalStore } from "react";

export type ViewMode = "learn" | "light";

/** Both modes, learn first. */
export const VIEW_MODES: readonly ViewMode[] = ["learn", "light"];

/** Owner call 1, at its default: nothing changes for anybody until they switch. */
export const DEFAULT_VIEW_MODE: ViewMode = "learn";

/** The one key. Its value is the mode word and nothing else. */
export const VIEW_MODE_KEY = "spectroscope:mode";

interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserStorage: Storage = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
};

let storage: Storage = browserStorage;

/** A stored or received value as a mode: either word, and learn for anything else. */
function asMode(raw: string | null): ViewMode {
  return raw === "light" || raw === "learn" ? raw : DEFAULT_VIEW_MODE;
}

/** The stored mode. A value that is neither word, and a storage that throws, read as learn. */
export function readViewMode(): ViewMode {
  try {
    return asMode(storage.get(VIEW_MODE_KEY));
  } catch {
    return DEFAULT_VIEW_MODE;
  }
}

let mode: ViewMode = readViewMode();
const listeners = new Set<() => void>();

function adopt(next: ViewMode): void {
  if (next === mode) return;
  mode = next;
  for (const listener of [...listeners]) listener();
}

/** Switch the mode in this window and store it for the next load and the other windows. */
export function setViewMode(next: ViewMode): void {
  if (next === mode) return;
  try {
    storage.set(VIEW_MODE_KEY, next);
  } catch {
    /* a blocked storage: this window switches, the next load starts in learn */
  }
  adopt(next);
}

/** The mode now. Read at call time by code that runs outside a render. */
export function currentViewMode(): ViewMode {
  return mode;
}

/** Told once per change, synchronously, in the order the listeners subscribed. */
export function subscribeViewMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribeViewMode, currentViewMode, currentViewMode);
}

/**
 * Follow the switches other windows of this origin make. The browser fires
 * `storage` only in the windows that did not write, so following writes
 * nothing back. A removed key, `localStorage.clear()` (a null key) and a value
 * that is neither word all read as learn.
 *
 * @param target the window, or a stand-in in a test
 * @return the unsubscribe
 */
export function followOtherWindows(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): () => void {
  const onStorage = (event: Event): void => {
    const { key, newValue } = event as StorageEvent;
    if (key !== VIEW_MODE_KEY && key !== null) return;
    adopt(asMode(key === null ? null : newValue));
  };
  target.addEventListener("storage", onStorage);
  return () => target.removeEventListener("storage", onStorage);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  followOtherWindows(window);
}

/** Test seam: swap the storage. */
export function __setViewModeStorage(next: Storage): void {
  storage = next;
}

/** Test seam: read the storage again, the way a page load does, with no listener told. */
export function __resetViewModeForTests(): void {
  mode = readViewMode();
}
