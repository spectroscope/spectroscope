// One saver for a text artifact of any mime — the exact wiring saveHtml
// (html.ts) and the jsonl savers use: a blob URL under an anchor, clicked, and
// revoked a tick later because revoking in the same one cancels the download.
// A third copy of that idiom was on its way (the state graph exports two file
// kinds); this is the shared seam instead.

/**
 * Hands `text` to the browser's own save dialog as `filename`.
 *
 * @param filename what lands in the downloads folder
 * @param text     the file's whole content
 * @param mime     content type, charset included (e.g. "text/markdown;charset=utf-8")
 */
export function saveTextFile(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
