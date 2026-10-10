/** A bounded undo and redo stack over immutable values. */
export const UNDO_DEPTH = 50;

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** The same object as the present records nothing and returns the history unchanged. */
export function push<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-UNDO_DEPTH), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return {
    past: [...h.past, h.present].slice(-UNDO_DEPTH),
    present: h.future[0],
    future: h.future.slice(1),
  };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0;
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}
