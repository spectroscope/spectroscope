// How tall the composer is, and whether the placeholder may show.
//
// Both answers changed when live transcription arrived, and they changed for
// ONE reason: the words being heard are painted in a layer BEHIND the textarea
// (Chat.tsx, `.composer-ghost`) rather than in its value. They had to be — a
// guess must never be one Enter away from being sent as if somebody had typed
// it, and a textarea cannot style half of itself.
//
// But drawing is not the only thing text does. It also takes up room, and it
// also means the field is not empty. The layer was a first-class citizen for
// the eye and a non-citizen for the layout, which produced exactly two defects
// in the running app: the box did not grow when the live words wrapped, and
// "Message the agent …" sat on top of them while they arrived.
//
// Pure here, so both answers are one decision each rather than two branches
// drifting apart in a component.

/**
 * The height the textarea should be set to.
 *
 * @param draftScrollHeight the textarea's own `scrollHeight`, measured after
 *                          its height was reset to `auto`
 * @param ghostScrollHeight the live layer's `scrollHeight`, or null when it is
 *                          not mounted — which is most of the time
 * @param max the ceiling in px; past it the field scrolls instead of growing
 * @return the height in px
 */
export function composerHeight(
  draftScrollHeight: number,
  ghostScrollHeight: number | null,
  max: number,
): number {
  const tallest = Math.max(draftScrollHeight, ghostScrollHeight ?? 0);
  return Math.min(tallest, max);
}

/**
 * Whether the browser's placeholder may show.
 *
 * The browser decides this on its own from the textarea's value, and its answer
 * is right for typed text and wrong for heard text: a field with live words in
 * it is not empty to the reader, however empty it looks to the DOM. So the
 * placeholder becomes a decision rather than a default.
 *
 * @param draft what is typed
 * @param provisional what is being heard right now
 * @return true when the field really is empty
 */
export function showsPlaceholder(draft: string, provisional: string): boolean {
  return draft === "" && provisional === "";
}
