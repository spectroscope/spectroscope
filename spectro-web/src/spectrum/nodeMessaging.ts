// Who can be talked to, and what the answer means (card 166's server leg).
//
// Pure on purpose: the composer's enabled state and the server's 409 must come
// from ONE rule, or the UI collects a sentence the POST already knows it will
// throw away.

/** The two card fields the decision needs — anything shaped like this works. */
export interface Addressable {
  connected: boolean;
  /** The node's trigger note from its card (card 72), absent for a plain node. */
  trigger?: string | null;
}

/**
 * Whether this node can be sent a message.
 *
 * A trigger is not decoration here: it is the node's run loop. A triggered node
 * holds a fire slot the words land in and runs again; a plain `spectro node
 * --linger` parks on its stop latch and has nowhere to put them. The server
 * refuses the second kind with a 409, and this predicate is the same rule read
 * early, so the box is never offered for a sentence that cannot be delivered.
 */
export function canTakeMessages(card: Addressable): boolean {
  if (!card.connected) return false;
  const trigger = card.trigger;
  return typeof trigger === "string" && trigger.length > 0;
}

/** What the operator is told after a send — a key, resolved by the caller's lang. */
export interface SendOutcome {
  ok: boolean;
  key: string;
}

/**
 * Reads the endpoint's status into something an operator can act on.
 *
 * 202 is SENT, never "answered": the control plane has no ack, so the node
 * having received the words is the most anyone knows. Every status this does
 * not recognise — including a 0 from a fetch that never landed — is a failure,
 * because a composer that cleared itself on an unknown answer would eat the
 * sentence with nobody left to retype it.
 *
 * @param status the HTTP status, or 0 when the request never completed
 */
export function sendOutcome(status: number): SendOutcome {
  switch (status) {
    case 202:
      return { ok: true, key: "bus.messageSent" };
    case 409:
      return { ok: false, key: "bus.messageRefused" };
    case 404:
      return { ok: false, key: "bus.messageGone" };
    default:
      return { ok: false, key: "bus.messageFailed" };
  }
}
