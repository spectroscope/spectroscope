// Card 576, fix round: the frames of a command typed in the composer.
//
// An error that answers such a command offers no "Send again" (reducer.ts,
// noteSent). Only the composer's commands count: the same set_playbook from
// the header's playbook chip, or the set_loop stop of the loop chip, is no
// typed command. So the frame object carries the fact, not its type: the
// composer tags the frames it sends for a command, and the tag rides with the
// object through the resume's held frames to the socket. Nothing goes on the
// wire.

import type { ClientMessage } from "../events";

const typed = new WeakSet<ClientMessage>();

/**
 * Tags a frame the composer sends for a command typed in it.
 *
 * @param frame the command's frame
 * @return the same frame
 */
export function asTypedCommand<T extends ClientMessage>(frame: T): T {
  typed.add(frame);
  return frame;
}

/** Whether this frame object was tagged by {@link asTypedCommand}; a copy is not. */
export function isTypedCommand(frame: ClientMessage): boolean {
  return typed.has(frame);
}
