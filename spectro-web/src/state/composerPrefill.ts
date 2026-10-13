// Card 554, criterion 4: text another control writes into the composer of the
// session in view. The header's play button asks for "/run-with-playbook "
// here; the composer (Chat.tsx, through useTakePrefill) takes the request,
// puts the text into its draft with the caret at the end and focuses the
// field. Nothing is sent: the owner types the prompt and sends it. Words
// already in the draft stay, after the command, as its prompt.
//
// Each request carries a number of its own, so the same text asked for twice
// is two requests, and the composer takes each one once.

import { useEffect, useRef, useSyncExternalStore } from "react";

/** One request: the text, and its number. */
export interface Prefill {
  text: string;
  nonce: number;
}

let current: Prefill | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const wake of [...listeners]) wake();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask the composer in view to take this text into its draft. */
export function prefillComposer(text: string): void {
  counter += 1;
  current = { text, nonce: counter };
  notify();
}

/** The request waiting for the composer, or null. */
export function currentPrefill(): Prefill | null {
  return current;
}

/**
 * The composer took request `nonce`. A newer request than that one stays.
 *
 * @param nonce the number of the request taken
 */
export function takePrefill(nonce: number): void {
  if (current === null || current.nonce !== nonce) return;
  current = null;
  notify();
}

/** The request waiting for the composer, for a component. */
export function useComposerPrefill(): Prefill | null {
  return useSyncExternalStore(subscribe, currentPrefill, currentPrefill);
}

/**
 * The composer's half: while `open`, a waiting request is taken once, its
 * text handed to `take`, and the request cleared. A closed composer (an
 * archive that stays read only) leaves it for the next one that opens.
 *
 * @param open whether this composer can take text now
 * @param take puts the text into the draft and focuses the field
 */
export function useTakePrefill(open: boolean, take: (text: string) => void): void {
  const prefill = useComposerPrefill();
  const takeRef = useRef(take);
  takeRef.current = take;
  useEffect(() => {
    if (!open || prefill === null) return;
    takePrefill(prefill.nonce);
    takeRef.current(prefill.text);
  }, [open, prefill]);
}

/**
 * The draft after a request: the text, then whatever the owner had typed,
 * so nothing typed is lost; a draft that already opens with the text stays.
 *
 * @param text  what was asked for, "/run-with-playbook " today
 * @param draft the draft as it stands
 */
export function prefilledDraft(text: string, draft: string): string {
  const typed = draft.trimStart();
  if (typed === "") return text;
  if (typed.startsWith(text.trim())) return draft;
  return `${text}${typed}`;
}

/** Test seam: no request. */
export function __resetComposerPrefill(): void {
  current = null;
}
