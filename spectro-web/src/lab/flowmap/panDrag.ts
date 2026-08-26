// Right-drag panning that may START on a card (card 287; owner: a drag on an
// object was swallowed). React Flow marks draggable nodes `nopan` and its
// d3-zoom filter refuses any right-button mousedown inside one (middle-drag
// is special-cased past it, the right button is not), so the canvas pans
// those pixels itself.
//
// The drag ends THREE ways — mouseup, a move whose buttons no longer carry
// the right button, and the owner's cleanup — because a release over browser
// chrome or after an alt-tab never delivers mouseup, and a viewport following
// a bare pointer is worse than no pan at all (measured on a downstream
// consumer: a synthetic buttons:0 move panned a further 190x140 before this
// rule).
export type PanDrag = { x: number; y: number } | null;

export function panStart(button: number, x: number, y: number): PanDrag {
  return button === 2 ? { x, y } : null;
}

/** The delta to apply and the next drag state; ends on a lost button. */
export function panMove(
  drag: PanDrag,
  buttons: number,
  x: number,
  y: number,
): { dx: number; dy: number; next: PanDrag } {
  if (drag === null) return { dx: 0, dy: 0, next: null };
  if ((buttons & 2) === 0) return { dx: 0, dy: 0, next: null };
  return { dx: x - drag.x, dy: y - drag.y, next: { x, y } };
}
