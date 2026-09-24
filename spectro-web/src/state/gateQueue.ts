// The one queue behind the one gate window (card 382).
//
// Two queues park a run: the session's own permissions, folded from the live
// event stream, and the gates of a fleet node, polled over REST. They are
// answered over different transports and only one of them has an allowlist we
// control, so they cannot simply be concatenated and forgotten. They are
// concatenated and LABELLED instead: the window draws entry 0 and counts the
// rest, and the label says where an answer has to go.
//
// The lookup is the second half, and it is the half the server cannot do for
// us. `SessionConnection.onPermissionResponse` answers an unknown call id with
// silence: no future completes, no rule is written, no error comes back. So a
// browser that posts an answer for a call that is no longer parked reports
// success and changes nothing. Every answer goes through this file first.

import type { PendingPermission } from "./reducer";

/** Which transport answers this gate. */
export type GateSource = "session" | "fleet";

export interface GateEntry {
  permission: PendingPermission;
  source: GateSource;
}

/**
 * The gates a person may answer right now, session first.
 *
 * <p>Session first because it is this machine's own run: a node's gate is
 * answered over the hub and its node denies it on close anyway, while the local
 * run stands still until somebody says yes or no.</p>
 *
 * @param session the live fold's pending permissions — never a stepped prefix
 * @param fleet   the entered fleet's parked gates, empty when none is entered
 * @return one labelled entry per parked gate, in the order they are offered
 */
export function gateQueue(
  session: readonly PendingPermission[],
  fleet: readonly PendingPermission[],
): GateEntry[] {
  return [
    ...session.map((permission) => ({ permission, source: "session" as const })),
    ...fleet.map((permission) => ({ permission, source: "fleet" as const })),
  ];
}

/**
 * The parked gate with this call id, or null when none is.
 *
 * @param queue the current queue
 * @param callId the call an answer names
 * @return the entry, or null when the call is not parked any more
 */
export function gateEntryFor(queue: readonly GateEntry[], callId: string): GateEntry | null {
  return queue.find((entry) => entry.permission.callId === callId) ?? null;
}

/**
 * Where an answer for this call has to go, or null when it may not be sent.
 *
 * @param queue the current queue
 * @param callId the call the answer names
 * @return the transport, or null when the call carries a decision already
 */
export function routeGateAnswer(queue: readonly GateEntry[], callId: string): GateSource | null {
  return gateEntryFor(queue, callId)?.source ?? null;
}

/** What a parked gate draws: the window, a small notice, or nothing. */
export type GateSurface = "window" | "notice" | "none";

/**
 * Where the head of the queue shows, given what is on screen.
 *
 * <p>Fix round 2026-09-24. The owner on the window in the Lab: "Der muss weg
 * im Lab, weil im Lab macht der überhaupt keinen Sinn." So the Lab never draws
 * it, not even for a live gate. The gate stays parked and answerable in the
 * chat; the Lab gets a notice that one is waiting, nothing more.</p>
 *
 * @param queue the current queue
 * @param labOnScreen true while the Lab view is what the page renders
 * @return "none" with nothing parked, "notice" on the Lab, "window" elsewhere
 */
export function gateSurface(queue: readonly GateEntry[], labOnScreen: boolean): GateSurface {
  if (queue.length === 0) return "none";
  return labOnScreen ? "notice" : "window";
}
