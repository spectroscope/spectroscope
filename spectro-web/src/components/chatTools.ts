// Which session tools the chat offers, and whether they need a row at all.
//
// The owner's report was that the export and translation buttons, floating over
// the first message, are ugly. They now sit in the bottom bar instead. That
// move needs one decision made in a place a test can reach: when is the row
// there at all? A container drawn around nothing is the same defect wearing a
// different position.
//
// The translation rule is TranslatePanel's own guard restated
// (`events === 0 && byId.size === 0` -> no control), so the row and the panel
// cannot disagree about whether there is a button to hold.
//
// The export rule is the one that changes. It used to mount always and disable
// itself, which put a permanently dead button in the lab's chat column, where
// the component is handed a stepper's projection and no stream of its own.
//
// There is deliberately no `liveView` input: an archive is exactly what people
// export and translate, so the answer must not depend on which branch renders.

/** The tools row's shape: which controls it carries, and whether it exists. */
export type ChatTools = {
  row: boolean;
  exportControl: boolean;
  translateControl: boolean;
};

/**
 * What the composer's tools row should offer for this view.
 *
 * @param input.events          events in the stream this chat is showing
 * @param input.translatedUnits translated passages held for this view
 * @return which controls to mount, and whether to draw the row at all
 */
export function chatTools(input: { events: number; translatedUnits: number }): ChatTools {
  const exportControl = input.events > 0;
  const translateControl = input.events > 0 || input.translatedUnits > 0;
  return { row: exportControl || translateControl, exportControl, translateControl };
}
