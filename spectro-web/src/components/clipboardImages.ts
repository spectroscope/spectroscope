// What a paste is offering the composer.
//
// The whole decision of the clipboard path, as a pure function, because the
// event around it cannot be tested in this tree (no DOM, and jsdom implements
// neither clipboardData nor createImageBitmap). Everything the handler does
// besides calling this is wiring, and the drift test reads that off disk.
//
// Pasted images join the EXISTING attachment path — the same downscale, the
// same pending list, the same `{mediaType, dataBase64}` on the send frame. A
// clipboard blob is a File like any other; the only field it usually lacks is a
// meaningful name, and the name never travels.

/** The three fields of a DataTransferItem this decision needs. */
export interface ClipboardItemLike {
  /** "file" or "string" — a string item has no file behind it. */
  kind: string;
  /** The MIME type the clipboard advertises. */
  type: string;
  getAsFile: () => File | null;
}

/**
 * The images a paste is offering, in clipboard order.
 *
 * A screenshot paste arrives as one file item. A copy from a web page arrives
 * as text/html PLUS an image file; the image wins and the markup is dropped,
 * because "paste the picture I copied" is what anyone means by it. A plain-text
 * paste yields nothing here, and that empty result is what lets the browser's
 * own paste happen — the handler only cancels the event when this returns
 * something.
 *
 * @param items the clipboard's items, in the order it offers them
 * @return the image files among them, order preserved, never null entries
 */
export function pastedImageFiles(items: readonly ClipboardItemLike[]): File[] {
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    // Allowed to be null even for kind "file" (a revoked blob, an item the OS
    // withdrew). Dereferencing it would throw inside an event handler.
    const file = item.getAsFile();
    if (file !== null) files.push(file);
  }
  return files;
}
