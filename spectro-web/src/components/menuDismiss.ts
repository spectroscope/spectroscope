// When a press outside a popover menu should close it — and when it must not.
//
// Every popover in this app closes on a `mousedown` that lands outside its own
// anchor. That rule has one blind spot, and card 255 walked straight into it:
// a row INSIDE the menu can open a modal, and a modal that portals itself to
// the body is outside the anchor by construction. Closing the menu then
// unmounts the component that owns the modal, so the modal disappears under the
// press that was meant to operate it.
//
// Measured on the live app: with the translation trigger in the three-dots
// menu, one dispatched mousedown inside the sheet closed menu and sheet
// together, and no control in the sheet was reachable at all. The export dialog
// survived only because it renders inline, inside the anchor — an accident of
// where the JSX sits, not a decision.
//
// The marker is the app's own: 19 dialogs declare `aria-modal="true"`. A layer
// above the menu answers to that, whether it portals or not.

/** The selector every modal layer in this app answers to. */
export const MODAL_LAYER = '[aria-modal="true"]';

/** What the DOM is asked about a press, and nothing else. */
export interface Press {
  /** The press landed on the menu's own button or inside its popover. */
  inAnchor: boolean;
  /** The press landed inside a modal layer — one the menu itself may have
   *  opened, and which sits ABOVE it rather than beside it. */
  inModal: boolean;
}

/**
 * Whether this press dismisses the open menu.
 *
 * @param press where the press landed, as the two questions above
 * @return true only when it belongs to neither the menu nor a modal over it
 */
export function dismissesMenu(press: Press): boolean {
  return !press.inAnchor && !press.inModal;
}

/** A scroll somewhere on the page, as a row menu sees it. */
export interface ScrollSeen {
  /** The scroll happened inside the menu or its button. */
  inAnchor: boolean;
  /** The scrolled box (or the document) contains the menu's button. */
  holdsAnchor: boolean;
}

/**
 * Whether a scroll closes a row menu. The menu is placed against its button,
 * so only a scroll that moves the button leaves it standing in the wrong
 * place. A chat that follows its live edge scrolls on every batch (card 459:
 * the session in view may be running), and that must not close a menu in the
 * rail.
 */
export function scrollDismissesMenu(scroll: ScrollSeen): boolean {
  return !scroll.inAnchor && scroll.holdsAnchor;
}
