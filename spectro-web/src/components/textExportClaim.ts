// Which translation state the text tab's export control may read.
//
// The chat tab is handed the RECORDED stream and folds the translated one for
// display, so its export sheet holds both sides and can offer a switcher. The
// text tab is handed the SHOWN stream — App.tsx applies the translation once,
// to the one array every tab folds — and nothing inverts that: there is no
// function from a translated stream back to the recording. So this tab holds
// exactly one array, and what the file may claim is decided by which array that
// is.
//
// A viewKey is what lets the sheet see this view's translation state, and that
// state is what puts the provenance line in the document and the language tag
// in the jsonl name. Handed over while the reader is back on the record, it
// prints "translated to de" across the recording: card 114 with the sides
// swapped — the file claiming something the screen does not show.

export interface TextExportClaim {
  /** This session view: "live", a replay id, or an entered fleet's context. */
  viewKey: string;
  /** App's own test for "a translation is on screen": shownEvents !== tabEvents. */
  showingTranslation: boolean;
}

/**
 * The key the text tab's export control may read, or none.
 *
 * @param input the view and whether its translation is the thing on screen
 * @return the view key while the translation is showing; undefined otherwise,
 *         which is the sheet's honest mode: one stream, no switcher, no claim
 */
export function textExportViewKey(input: TextExportClaim): string | undefined {
  return input.showingTranslation ? input.viewKey : undefined;
}
