// The ceiling on one message's pictures.
//
// Nothing below the composer counts attachments: not the send frame, not the
// store. The only real limits are the 64 MB WebSocket text frame and the 5 MB
// per-image server check, and both of them fail as a wall rather than as a
// sentence. Dragging twenty files in was deliberate work; pasting twenty is ten
// seconds, so the composer is where the number has to be said out loud.

/** How many pictures one message may carry. */
export const MAX_PENDING_ATTACHMENTS = 10;

export interface CapDecision {
  /** The files that fit, in the order they were offered. */
  take: File[];
  /** How many were turned away — 0 means say nothing. */
  declined: number;
}

/**
 * Which of the offered files still fit beside what is already pending.
 *
 * The head is kept and the tail is declined, because the order files arrive in
 * is the order somebody chose them in, and dropping the first picture of a
 * paste to make room for the last would be the wrong half.
 *
 * @param currentCount how many attachments are already waiting to be sent
 * @param files the files being offered, in offer order
 */
export function withinCap(currentCount: number, files: readonly File[]): CapDecision {
  const room = Math.max(0, MAX_PENDING_ATTACHMENTS - currentCount);
  return { take: files.slice(0, room), declined: Math.max(0, files.length - room) };
}
