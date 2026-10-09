// How far the fold of the open in flight has got (card 431, criterion 9).
//
// The sliced fold reports after every slice. A slice folds until an event
// reaches SLICE_BUDGET_MS (24 ms), and on the owner's big session the longest
// gap between frames during the fold was 25.9 to 33.6 ms (Chrome, 2026-09-25).
// This store passes a reading on to its listeners at most every
// PROGRESS_EVERY_MS, and at once for the first reading of an open and for the
// last. Only the loading surface listens (useSyncExternalStore), so a new count
// renders the surface and nothing else: App, and the chat under the sign, do
// not render for it.

import { t, type Lang } from "../i18n/i18n";

/** One reading: the open it belongs to, by navigation ticket, and its count. */
export interface OpenProgressReading {
  ticket: number;
  folded: number;
  total: number;
  /** Card 473: "wire" while an import reads its wire under the same sign;
   *  absent for the fold's event count. */
  unit?: "wire";
}

export interface OpenProgress {
  /** A fold's report. Kept and passed on, or dropped inside the quiet time. */
  report(ticket: number, folded: number, total: number, unit?: "wire"): void;
  /** The reading last passed on, or null. The same object until the next one. */
  read(): OpenProgressReading | null;
  subscribe(listener: () => void): () => void;
}

/** The quiet time between two readings passed on, in milliseconds. */
export const PROGRESS_EVERY_MS = 100;

export function createOpenProgress(now: () => number = () => performance.now()): OpenProgress {
  let reading: OpenProgressReading | null = null;
  let passedAt = 0;
  const listeners = new Set<() => void>();
  return {
    report(ticket, folded, total, unit) {
      const at = now();
      const first = reading === null || reading.ticket !== ticket || reading.unit !== unit;
      if (!first && folded < total && at - passedAt < PROGRESS_EVERY_MS) return;
      reading = unit === undefined ? { ticket, folded, total } : { ticket, folded, total, unit };
      passedAt = at;
      for (const listener of listeners) listener();
    },
    read: () => reading,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The one store App's opens report into. */
export const openProgress = createOpenProgress();

const grouped = (n: number, lang: Lang): string => n.toLocaleString(lang === "de" ? "de-DE" : "en-US");

/** "40,000 of 91,956 events", "40.000 von 91.956 Ereignissen". */
export function openCount(lang: Lang, folded: number, total: number): string {
  return t(lang, total === 1 ? "open.countOne" : "open.count", {
    folded: grouped(folded, lang),
    total: grouped(total, lang),
  });
}

/** Card 473: "reading the wire: 24%", "Wire wird gelesen: 24 %". */
export function openWire(lang: Lang, done: number, total: number): string {
  return t(lang, "open.wire", { pct: total <= 0 ? 0 : Math.floor((done / total) * 100) });
}
