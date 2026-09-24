// How much the line under one answer says (card 374, owner 2026-09-18). A tiny
// external store like state/chatWidth.ts, persisted, offered in the same three
// dots menu as the disclosure level and the text width.
//
//   normal    input tokens, output tokens, duration. The everyday reading.
//   extended  every number the usage event carries, plus the model.
//
// Two deliberate differences from the chatWidth template, both so the pins can
// reach what they assert: the reader is a pure exported function, and subscribe
// is exported so a notification can be observed with no DOM.

import { useSyncExternalStore } from "react";

export type AnswerLineMode = "normal" | "extended";

export const ANSWER_LINE_MODES: AnswerLineMode[] = ["normal", "extended"];

const KEY = "spectroscope:chat.answerLine";

/** The stored string to a reading. Anything else, null included, is normal. */
export function parseAnswerLine(raw: string | null): AnswerLineMode {
  if (raw === "normal" || raw === "extended") return raw;
  return "normal";
}

function readSaved(): AnswerLineMode {
  try {
    return parseAnswerLine(localStorage.getItem(KEY));
  } catch {
    /* no localStorage (tests, blocked site data): default */
    return "normal";
  }
}

let mode: AnswerLineMode = readSaved();
const listeners = new Set<() => void>();

export function setAnswerLine(next: AnswerLineMode): void {
  if (next === mode) return;
  mode = next;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentAnswerLine(): AnswerLineMode {
  return mode;
}

/** Exported, unlike the chatWidth twin: criterion 4 observes a notification. */
export function subscribeAnswerLine(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): AnswerLineMode {
  return mode;
}

export function useAnswerLine(): AnswerLineMode {
  return useSyncExternalStore(subscribeAnswerLine, getSnapshot, getSnapshot);
}
