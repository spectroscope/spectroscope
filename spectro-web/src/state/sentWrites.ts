// Card 504, last fix round: a settings write that follows a frame. The gear
// writes the permission mode into the project file, and that write must name
// only a mode the session took. A sender's answer cannot say so: on a stored
// session App's sessionFrame answers true once the frame joined or started a
// resume, and a failed events fetch drops the frame. So the write is held
// here and runs from App's onSent, where every frame that reached a socket
// passes, the drain of a continued session included (the beacons ride there
// too).

import type { ClientMessage } from "../events";

interface Held {
  frame: string;
  writes: (() => void)[];
}

export class SentWrites {
  private readonly held = new Map<string, Held>();

  private static key(sessionId: string, frame: ClientMessage): string {
    return `${sessionId}\n${frame.type}`;
  }

  /**
   * Holds `write` until `frame` of session `sessionId` reaches a socket. A
   * later hold of the same frame type for the same session replaces it, so
   * only the last choice writes; a second hold of the identical frame joins
   * the first, so the project-file write and the gear's mark both run.
   */
  hold(sessionId: string, frame: ClientMessage, write: () => void): void {
    const key = SentWrites.key(sessionId, frame);
    const text = JSON.stringify(frame);
    const held = this.held.get(key);
    if (held !== undefined && held.frame === text) held.writes.push(write);
    else this.held.set(key, { frame: text, writes: [write] });
  }

  /** The frame did not leave: its write goes. */
  drop(sessionId: string, frame: ClientMessage): void {
    const key = SentWrites.key(sessionId, frame);
    if (this.held.get(key)?.frame === JSON.stringify(frame)) this.held.delete(key);
  }

  /** A frame reached the socket of session `sessionId`; a write held for exactly it runs, once. */
  sent(sessionId: string | null, msg: ClientMessage): void {
    if (sessionId === null) return;
    const key = SentWrites.key(sessionId, msg);
    const held = this.held.get(key);
    if (held === undefined || held.frame !== JSON.stringify(msg)) return;
    this.held.delete(key);
    for (const write of held.writes) write();
  }
}

/** The app's one instance: the gear holds, App's onSent releases. */
export const sentWrites = new SentWrites();
