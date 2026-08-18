// Who owns the transcript's scroll position while a run streams (card 257).
//
// The transcript follows the live edge, and that is right for a reader who is
// watching it arrive. The owner reported the other half: scrolling up during a
// heavy run threw him back down every time, so the transcript could not be READ
// while it was being written — in a tool whose whole claim is that you can
// watch it.
//
// The mechanic that did it meant to yield. It failed for three reasons, and all
// three are answered here rather than in the component:
//
//  1. it had no notion of WHO scrolled. Our own scrollTo fires the same scroll
//     event a wheel does, reports "at the bottom", and so re-armed the pin on
//     the reader's behalf. `scrollCause` is that missing question, and
//     `pinAfterScroll` only ever listens to the reader;
//  2. its dead zone was 120px. Anything that ended inside it counted as still
//     pinned, so a slow trackpad drag was undone notch by notch and never got
//     out. What is left here is two pixels of ROUNDING slack, not a zone;
//  3. it ran after every render. That is a policy question for the component
//     (the effect now names what it grows for), but the rule below is written
//     so that running it a hundred times a second changes nothing: a disarmed
//     pin stays disarmed no matter how often it is asked.
//
// Two things in here were not designed but MEASURED, on a bench that drove this
// module with real wheel input against a stream (both are spelled out where
// they live, and the numbers are on the card):
//
//  * the disarm happens on the GESTURE, not on the scroll it causes. A scroll
//    event reports where the box stood at the END of its frame, so a scrollTo
//    of ours in the same frame swallows the reader's notch whole — the first
//    version lost the reader's wheel entirely that way;
//  * landing at the bottom re-arms the pin only if the reader's last pull was
//    not away from it. An animation already in flight keeps travelling after
//    the reader pulls out of it, and reaching the edge would otherwise put the
//    pin back on for them.
//
// Card 271's fold rule (foldScrollDelta in childFold.ts) READS this pin and
// never sets it. It stays exactly as it was.

/** What moved the scroll box: a reader's hand, or this app's own scrollTo. */
export type ScrollCause = "reader" | "app";

/**
 * Which way a gesture pulls: away from the live edge, toward it, or neither.
 *
 * <p>Read from the GESTURE and not from the scroll that follows it. A scroll
 * event reports where the box stood at the end of the frame, so an app scrollTo
 * in that same frame erases the reader's notch before any handler can see it —
 * measured on the bench, with the reader's wheel simply vanishing. The wheel's
 * own delta is known before the browser has applied anything, so a pin taken
 * off here cannot lose that race.</p>
 */
export type ReaderPull = "away" | "toward" | "unknown";

/** What a growth event may do to the scroll position. */
export type FollowScroll = "none" | "auto" | "smooth";

/**
 * How long the reader stays in charge after reaching for the transcript.
 *
 * <p>A gesture is not one event. A wheel notch animates for a few hundred
 * milliseconds after the notch, a trackpad fling keeps firing while it coasts,
 * and every one of those scroll events is still the reader's doing. The window
 * is refreshed by each such event (see Chat's scroll handler), so a long fling
 * that ends at the bottom re-arms the pin instead of dying halfway.</p>
 */
export const READER_INTENT_WINDOW_MS = 700;

/**
 * How close to the bottom still counts as being AT it.
 *
 * <p>Rounding slack, not a dead zone — the distinction card 257 exists for.
 * scrollHeight and clientHeight are integers while scrollTop is fractional, and
 * a zoomed page carries about a pixel of residue per rounding. Two pixels
 * covers the arithmetic and nothing a reader could deliberately aim at.</p>
 */
export const AT_BOTTOM_PX = 2;

/**
 * Whose scroll this is — the question the old rule never asked.
 *
 * <p>Only the freshness of the reader's last gesture is decided here. WHERE the
 * box went is {@link pinAfterScroll}'s business, because the same gesture window
 * covers both a reader pulling away and a reader coming back.</p>
 *
 * @param msSinceReaderIntent how long ago the reader last reached for the
 *        transcript (wheel, touch, drag, a scrolling key), null if never
 * @return who to credit this scroll event to
 */
export function scrollCause(msSinceReaderIntent: number | null): ScrollCause {
  if (msSinceReaderIntent === null) return "app";
  return msSinceReaderIntent < READER_INTENT_WINDOW_MS ? "reader" : "app";
}

/**
 * The pin after one scroll event — the arm/disarm rule itself.
 *
 * <p>An app-caused scroll leaves the pin exactly as it found it. It can neither
 * arm it (the defect the owner hit) nor disarm it.</p>
 *
 * <p>Under a fresh gesture the DIRECTION decides, and that is the second thing
 * this card learned the hard way. A first version compared timestamps — the
 * reader's last gesture against our own last scrollTo — and a bench measurement
 * killed it: while a run streams, this view commands a scroll many times a
 * second, so a wheel notch that landed between two of them was credited to the
 * app and the reader was carried back down with the pin still armed. Where the
 * box MOVED cannot be faked that way. Our own follow only ever travels toward
 * the live edge, so a box moving away from it under the reader's hand is the
 * reader leaving, and a smooth follow still gliding toward it is not.</p>
 *
 * @param input pinned — the pin as it stands; cause — who scrolled;
 *              movedUp — whether the box moved AWAY from the live edge;
 *              distanceFromBottom — scrollHeight - scrollTop - clientHeight
 * @return the pin after this event
 */
export function pinAfterScroll(input: {
  pinned: boolean;
  cause: ScrollCause;
  lastPull: ReaderPull;
  movedUp: boolean;
  distanceFromBottom: number;
}): boolean {
  if (input.cause === "app") return input.pinned;
  // Landing at the edge re-arms — unless the reader's last gesture was away
  // from it. That exception was measured: an animation this view had already
  // started keeps travelling after the reader pulls out, reaches the bottom
  // inside the same gesture window, and would otherwise put the pin back on
  // for them.
  if (input.lastPull !== "away" && input.distanceFromBottom <= AT_BOTTOM_PX) return true;
  if (input.movedUp) return false; // pulled away from it
  return input.pinned; // on the way down, or our glide: no news either way
}

/**
 * The pin after a GESTURE, decided before the browser has scrolled anything.
 *
 * @param input pinned — the pin as it stands; pull — which way the gesture
 *              pulls; distanceFromBottom — where the box stands right now
 * @return the pin after this gesture
 */
export function pinAfterGesture(input: {
  pinned: boolean;
  pull: ReaderPull;
  distanceFromBottom: number;
}): boolean {
  if (input.pull === "away") return false;
  // Toward the edge AND already at it: the way back for a reader whose last
  // pull was away. They are sitting at the bottom, so wheeling down moves
  // nothing and no scroll event would ever come to re-arm on.
  if (input.pull === "toward" && input.distanceFromBottom <= AT_BOTTOM_PX) return true;
  return input.pinned;
}

/**
 * What a growth event does — new text, a new turn, a fold opening.
 *
 * @param input pinned — whether the reader is at the live edge;
 *              newTurn — whether this growth is a whole new turn beginning
 * @return "none" to leave the reader alone, or how to move to the live edge
 */
export function followScroll(input: { pinned: boolean; newTurn: boolean }): FollowScroll {
  if (!input.pinned) return "none";
  // Instant while a turn grows — an animation per token is jitter. A whole new
  // turn is worth a glide, and the cause rule above keeps that animation's own
  // scroll events from being read back as the reader disagreeing with it.
  return input.newTurn ? "smooth" : "auto";
}

/**
 * A wheel or trackpad notch, as a pull.
 *
 * @param deltaY the WheelEvent delta — negative is up, away from the edge
 * @return which way the reader is pulling
 */
export function wheelPull(deltaY: number): ReaderPull {
  if (deltaY < 0) return "away";
  return deltaY > 0 ? "toward" : "unknown";
}

/** The keys that carry a direction of their own. */
const AWAY_KEYS = new Set(["PageUp", "ArrowUp", "Home"]);
const TOWARD_KEYS = new Set(["PageDown", "ArrowDown", "End", " "]);

/**
 * A key press, as a pull.
 *
 * @param key the KeyboardEvent key
 * @return which way it would scroll the transcript
 */
export function keyPull(key: string): ReaderPull {
  if (AWAY_KEYS.has(key)) return "away";
  return TOWARD_KEYS.has(key) ? "toward" : "unknown";
}

/** The keys that scroll a box, as the reader's intent to leave the live edge. */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

/**
 * Whether this key press is the reader reaching for the transcript.
 *
 * @param key        the KeyboardEvent key
 * @param inEditable whether the press landed in a text field — arrowing
 *                   through a draft is editing, and the composer is not the
 *                   transcript
 * @return true when it should disarm a pin the reader is scrolling away from
 */
export function isReaderScrollKey(key: string, inEditable: boolean): boolean {
  return !inEditable && SCROLL_KEYS.has(key);
}
