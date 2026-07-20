// The UI-chrome language — a tiny external store (à la layout/designPrefs)
// persisted to localStorage. Default English; the header toggle flips it
// live (de ships as the second locale). Stamps <html lang> so the browser
// hyphenates and screen-readers pronounce the chrome correctly. Chat content
// is NEVER affected — a session keeps its own language.

import { useSyncExternalStore } from "react";
import type { Lang } from "../i18n/i18n";

const KEY = "spectroscope:lang";

function readSaved(): Lang {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "de" || raw === "en") return raw;
  } catch {
    /* no localStorage (tests) — default */
  }
  return "en";
}

let lang: Lang = readSaved();
const listeners = new Set<() => void>();

function stamp(): void {
  try {
    document.documentElement.lang = lang;
  } catch {
    /* DOM-less test environment */
  }
}
stamp();

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* ignore */
  }
  stamp();
  for (const l of listeners) l();
}

export function toggleLang(): void {
  setLang(lang === "de" ? "en" : "de");
}

/** Visible for tests. */
export function currentLang(): Lang {
  return lang;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): Lang {
  return lang;
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
