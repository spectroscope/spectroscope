// The expanded worker card's geometry — ONE source (card 296).
//
// Two numbers used to say the same thing in two files with nothing linking
// them: sceneToFlow's `EXPANDED_CARD.subagent` + `EXP_GAP` (what a seat
// reserves) and workerGrid's `WORLD.colW` + `WORLD.rowH` (what the row
// derivation thinks a seat costs). They agreed by hand, and the moment one
// moved the other was a quiet lie: rowsFor would price a row at 620 while the
// layout laid it out at something else, and the grid would pick the wrong
// shape for a reason nothing could show. Both now derive from here.
//
// THE RESERVE IS MEASURED, not hand-summed. Card 287 wrote 560 as "the zoomed
// body plus the worker chrome" and the owner's complaint (card 296) was the
// consequence: at five children on a 1920x1080 pane the card painted about
// 170 device px with about 180 device px of air under it — more gap than card.
//
// Measured 2026-08-29, Chrome, devicePixelRatio 1, both variable fonts loaded
// BEFORE the read (document.fonts.ready resolves before a font that nothing
// has used yet is even requested — measuring on `ready` alone came out 5-9 px
// short on every variant). The card was rendered with its real markup inside
// `.pf-root > .pf-flow > .react-flow__node-subagent` and read through
// getBoundingClientRect, so `zoom: 0.6` is already inside every number below;
// these are WORLD px, the units the seats are in.
//
//   bare (no tool, no brief, no model, no spend)         237.59
//   typical (the card 287 fixture)                       304.44
//   a deep tool-call JSON in flight                      323.72
//   a launch with 14 declared phases                     327.83
//   a 14-word task title                                 323.06
//   a long brief + long model + long last status         319.19
//   four attached pictures (the owner's own transcript)  420.61
//   everything at once                                   477.38
//
// The last two only hold BECAUSE of the caps below. Uncapped, the same worst
// case measured 712.30 and four attachments alone 423.09 — the picture shelf
// grows with the number of pictures, and `EXPANDED_CARD`'s own doctrine ("the
// heights that can be derived are derived from the caps flowmap.css puts on
// the parts of a card that grow with content") had simply never been applied
// to it. So 560 was not merely too generous for a typical card, it was also
// too SMALL for a card carrying pictures: both errors at once, and the
// runtime check that should have said so had no caller.
export const SUB_CARD_W = 408;
export const SUB_CARD_H = 480;

/**
 * What a worker card ACTUALLY measures in the common case — the card 287
 * fixture (a task, a tool in flight, a brief, a model, a spend line), read in
 * the same browser pass as the bound above: 304.44, rounded down.
 *
 * Not a layout input: nothing is seated from it. It is the yardstick the
 * reserve is judged against, in the gate and at runtime — a seat that reserves
 * twice this is the defect the owner reported, and the one the old 560 + 60
 * had.
 */
export const SUB_CARD_TYPICAL_H = 304;

/** Rail room between two expanded cards: enough that the packet on the rail
 *  reads as travelling, not as touching both cards at once. */
export const RAIL_GAP = 60;

/** What one grid row costs — the card plus its rail room. */
export const SUB_ROW_PITCH = SUB_CARD_H + RAIL_GAP;
/** What one grid column costs. */
export const SUB_COL_PITCH = SUB_CARD_W + RAIL_GAP;

// ---------------------------------------------------------------------------
// The caps that turn the reserve into a BOUND rather than an observation.
// Each is a `max-height` in flowmap.css on the full worker card only (the
// agent hub keeps its own envelope), in the card's own unzoomed px — multiply
// by 0.6 for world px. cardGeometry.test.ts holds the CSS against them.
// ---------------------------------------------------------------------------

/** The task title in the card's head: two lines, then it clips. */
export const SUB_CAP_HEAD_PX = 50;
/** Brief, spend, model and last status: scrolls past this. */
export const SUB_CAP_META_PX = 136;
/** The picture shelf (generated + attached). One row of thumbnails whole, the
 *  rest scrolls — the region that made the card unbounded. */
export const SUB_CAP_SHELF_PX = 168;
