// Card 504, hub and spoke review round 2: the frames a stored session's resume
// carries. A gear change on a stored session continues it first (App's
// sessionFrame); a second change before that resume has fetched used to start
// a second resume, whose newer ticket made the first return with its frame
// dropped. Now a frame for the session being resumed joins that resume, and a
// later resume of the same session (a typed message, a command) carries the
// frames the earlier one held. A navigation in between issues a ticket of its
// own, and the held frames go with the abandoned resume.

import type { ClientMessage } from "../events";

interface Pending {
  id: string;
  ticket: number;
  frames: ClientMessage[];
}

export class ResumeJoin {
  private pending: Pending | null = null;

  /** @param isCurrent whether a navigation ticket is still the newest one */
  constructor(private readonly isCurrent: (ticket: number) => boolean) {}

  /** The resume of `id` still in flight, or null. */
  private live(id: string): Pending | null {
    const p = this.pending;
    return p !== null && p.id === id && this.isCurrent(p.ticket) ? p : null;
  }

  /**
   * A frame for the stored session `id`.
   *
   * @returns true when a resume of `id` is in flight and took the frame
   */
  join(id: string, frame: ClientMessage): boolean {
    const p = this.live(id);
    if (p === null) return false;
    p.frames.push(frame);
    return true;
  }

  /** The frames a resume of `id` in flight holds. Read before a new ticket is issued. */
  carried(id: string): ClientMessage[] {
    return [...(this.live(id)?.frames ?? [])];
  }

  /** A resume of `id` under `ticket` starts, holding `frames`. */
  begin(id: string, ticket: number, frames: ClientMessage[]): void {
    this.pending = { id, ticket, frames: [...frames] };
  }

  /** The frames the resume under `ticket` hands to its record, once. */
  take(ticket: number): ClientMessage[] {
    const p = this.pending;
    if (p === null || p.ticket !== ticket) return [];
    this.pending = null;
    return p.frames;
  }
}
