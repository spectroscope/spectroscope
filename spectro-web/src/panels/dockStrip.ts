// Release 0.14.2, live check D2: the dock strip scrolls inside itself with its
// scrollbar hidden, so a tab cut at its edge looked covered by the "Tabs"
// switch beside it. The strip names the edges where tabs are hidden and the
// stylesheet fades exactly those (panel-dock.css).

/** Which edges of the strip hide a tab. */
export type StripOverflow = "none" | "start" | "end" | "both";

/**
 * Reads the strip's scroll position against its content.
 *
 * One pixel is allowed on each side: Chrome rounds scrollWidth up and
 * clientWidth down, so a strip that fits can report one pixel of overflow.
 *
 * @param scrollLeft how far the strip is scrolled
 * @param scrollWidth the width of all tabs together
 * @param clientWidth the width the strip shows
 */
export function stripOverflow(scrollLeft: number, scrollWidth: number, clientWidth: number): StripOverflow {
  const start = scrollLeft > 1;
  const end = scrollLeft + clientWidth < scrollWidth - 1;
  if (start && end) return "both";
  if (start) return "start";
  if (end) return "end";
  return "none";
}
