// How a component deep in the tree tells the ladder what it just showed.
//
// The acts the event stream cannot see — a lens switched on, a scrubber moved,
// a thinking block expanded — happen four layers below the component that holds
// the leveling state. Threading a prop through those layers would put leveling
// in the signature of components that have nothing to do with it, and every one
// of them would have to be touched again for the next criterion.
//
// So this follows the house's module-store pattern (labPushLive, fleetPushLive):
// the app registers one sink, and a component fires a one-liner. Nothing here
// holds state, and a beacon before the app is ready, or into a broken sink, is
// silently nothing — leveling is a nicety and must never cost a lens toggle.

type Sink = (surface: string, sessionId?: string | null) => void;

let sink: Sink | null = null;

/**
 * Registers the app's beacon sink, or clears it with null.
 *
 * @param next where beacons go from now on
 */
export function setBeaconSink(next: Sink | null): void {
  sink = next;
}

/**
 * Reports that a surface was just shown or used.
 *
 * @param surface the surface id, as the ladder names it
 * @param sessionId the session on screen, when the criterion joins with the stream
 */
export function beacon(surface: string, sessionId?: string | null): void {
  try {
    sink?.(surface, sessionId);
  } catch {
    /* a nicety never costs the caller its click */
  }
}
