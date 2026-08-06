// Every picture in a session, in the order it appeared.
//
// The owner, once the pictures were back: "kann du einen große ansicht im
// modalen fenster machen wenn ich darauf klicke und auch gerne eine cursor links
// und rechts modalität um die genazen bilder in einer session wie eine gallerie
// durchzugehen."
//
// A gallery needs one ordered list, and the pictures live in two different
// places: on a user turn as its attachments, and on a tool card as what a tool
// handed back. `turns` already holds both kinds in stream order, so walking it
// once is the whole ordering rule — no timestamps to sort by, no second source
// of truth to drift.
//
// Pure, so the order is a pinned decision rather than whatever the render
// happened to do.

import type { ToolCard, Turn, UiState, UserAttachment } from "./reducer";

/** One picture, and where in the session it came from. */
export interface GalleryImage extends UserAttachment {
  /** Where it sits, for the caption: the person's message or a tool's answer. */
  from: "message" | "tool";
  /** The tool's name when `from` is "tool" — what a reader wants to know. */
  toolName?: string;
  /** The turn's index, so a click can find its own picture again. */
  turn: number;
  /** Which line of the imported file carried it, zero-based, or undefined for a
   *  live session and for a paste — neither has a file behind it. */
  sourceLine?: number;
}

/**
 * Every picture in the session, in stream order.
 *
 * @param state the folded session
 * @returns the pictures, message ones and tool ones interleaved as they happened
 */
export function collectImages(state: UiState): GalleryImage[] {
  const out: GalleryImage[] = [];
  state.turns.forEach((turn: Turn, i: number) => {
    if (turn.kind === "user") {
      for (const a of turn.attachments ?? []) out.push({ ...a, from: "message", turn: i });
      return;
    }
    if (turn.kind === "tool") {
      const card: ToolCard | undefined = state.cards[turn.callId];
      for (const a of card?.images ?? []) {
        out.push({ ...a, from: "tool", toolName: card?.name, turn: i });
      }
    }
  });
  return out;
}

/**
 * Where a particular picture sits in that list.
 *
 * Matched on the bytes rather than on an index the caller carries: a click
 * happens in a component that knows its own picture and nothing about the
 * session's ordering, and threading an index through three render sites is how
 * the two get out of step.
 *
 * @param images the gallery
 * @param shot the picture that was clicked
 * @returns its index, or 0 when it cannot be found — an unopenable gallery is
 *          worse than one that opens at the wrong place
 */
export function indexOf(images: readonly GalleryImage[], shot: UserAttachment): number {
  const at = images.findIndex((g) => g.dataBase64 === shot.dataBase64 && g.mediaType === shot.mediaType);
  return at < 0 ? 0 : at;
}

/**
 * The next index when walking with the arrow keys.
 *
 * WRAPS, deliberately. A gallery of eleven screenshots is something a reader
 * cycles through looking for one of them, and a dead end at either edge means
 * turning around and going back. There is no scrollbar here to say where you
 * are; the counter in the footer does that.
 *
 * @param at where we are
 * @param count how many there are
 * @param step -1 or +1
 * @returns the next index, wrapped
 */
export function step(at: number, count: number, step: -1 | 1): number {
  if (count === 0) return 0;
  return (at + step + count) % count;
}

/**
 * Which line of the file each picture came from.
 *
 * The import already knows: `origin[i]` is the line index behind `events[i]`,
 * the same array the trace's source face reads. This only turns it into a
 * lookup the gallery can use, keyed on the bytes — the same key a click uses,
 * and the only one that survives the fold.
 *
 * @param events the recorded stream, in file order
 * @param origin `origin[i]` for `events[i]`, negative for a frame with no line
 * @returns base64 → line index, first occurrence winning; a duplicated picture
 *          points at where it FIRST appeared, which is where a reader looking
 *          for "the record that brought this in" wants to land
 */
export function imageLines(events: readonly unknown[], origin: ArrayLike<number>): Map<string, number> {
  const out = new Map<string, number>();
  const n = Math.min(events.length, origin.length);
  for (let i = 0; i < n; i++) {
    const e = events[i] as { type?: string; dataBase64?: unknown };
    if (e?.type !== "attachment_image" || typeof e.dataBase64 !== "string") continue;
    const at = origin[i];
    if (at >= 0 && !out.has(e.dataBase64)) out.set(e.dataBase64, at);
  }
  return out;
}

/**
 * The gallery with each picture's line stamped on it.
 *
 * @param images the gallery
 * @param lines the lookup from {@link imageLines}
 * @returns the same pictures, each carrying its line when the file had one
 */
export function withSourceLines(
  images: readonly GalleryImage[],
  lines: ReadonlyMap<string, number>,
): GalleryImage[] {
  return images.map((g) => {
    const at = lines.get(g.dataBase64);
    return at === undefined ? g : { ...g, sourceLine: at };
  });
}
