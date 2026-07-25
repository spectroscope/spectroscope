// The queue-while-running model (card 78 #3): a message submitted during a run
// waits here (with its attachment snapshot) and auto-sends when the run ends.
// Pure list ops — App owns the state and the drain timing; the chips render
// from this list. Ids are max+1 so a new item never collides with a surviving
// one — removal and React keys stay stable while items come and go.

import type { PendingAttachment } from "../components/AttachmentPreview";

export interface QueuedMessage {
  id: number;
  text: string;
  attachments?: PendingAttachment[];
}

/** Highest id ever present + 1 — ids never reuse within one queue lifetime. */
const nextId = (queue: QueuedMessage[]): number => queue.reduce((max, m) => Math.max(max, m.id), 0) + 1;

/**
 * Appends a message; blank text is ignored (the composer guards too, but the
 * model must not rely on it).
 */
export function enqueue(
  queue: QueuedMessage[],
  text: string,
  attachments?: PendingAttachment[],
): QueuedMessage[] {
  if (text.trim() === "") {
    return queue;
  }
  return [
    ...queue,
    {
      id: nextId(queue),
      text,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    },
  ];
}

/** Removes the chip with the given id; unknown ids leave the queue untouched. */
export function removeQueued(queue: QueuedMessage[], id: number): QueuedMessage[] {
  const next = queue.filter((m) => m.id !== id);
  return next.length === queue.length ? queue : next;
}
