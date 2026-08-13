// The composer's attachment intake, as a hook: drag-and-drop, the file picker
// or ⌘V -> canvas downscale (AttachmentPreview) -> pending thumbnails inside
// the composer's border. Nothing leaves the page until submit. The drop TARGET
// stays the caller's root element — the hook only hands out the handlers, so
// the drop zone keeps its full size. The PASTE target does not: it is the
// textarea alone, because a paste into the search box or the workspace terminal
// is not an attachment.
//
// All three routes meet in one addFiles. A pasted image is a File like any
// other and rides the existing path — same downscale, same pending list, same
// `{mediaType, dataBase64}` on the send frame. There is no upload endpoint in
// this product to join instead: /api/images is the gallery of GENERATED images
// and has no multipart route at all.

import { useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, RefObject } from "react";
import { downscaleImage } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import { pastedImageFiles } from "./clipboardImages";
import { withinCap } from "./attachmentCap";

export interface Attachments {
  /** The thumbnails in the box — everything queued for the next send. */
  pending: PendingAttachment[];
  /** True while a drag hovers the drop zone (drives the visual highlight). */
  dragOver: boolean;
  /** Wire this to the hidden file input so openFilePicker can click it. */
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** Spread these on the element that should accept drops (the chat root). */
  dropHandlers: {
    onDrop: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
  };
  /** Put this on the DRAFT, not on the chat root — see the note above. */
  onPaste: (e: ClipboardEvent) => void;
  /** The one intake. Exported so a caller can hand files in directly. */
  addFiles: (files: FileList | File[]) => Promise<void>;
  /** An i18n KEY when the last intake had something to say, else null. The
   *  hook has no language; the caller translates it. */
  notice: string | null;
  removeAt: (index: number) => void;
  /** Called on submit — the thumbnails travel with the sent turn. */
  clear: () => void;
  openFilePicker: () => void;
  onFilePicked: (e: ChangeEvent<HTMLInputElement>) => void;
}

/** Attachment state + handlers for the composer. `acceptDrops` is false for
 *  the read-only archive view — drags are still cancelled (the browser must
 *  not open the image), but nothing is added. */
export function useAttachments(acceptDrops: boolean): Attachments {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The list is held twice on purpose. `addFiles` awaits a downscale per file,
  // so by the time the second one lands the `pending` this closure captured is
  // stale, and the cap would be decided against a count from before the paste.
  // The ref is the truth for DECIDING, the state is the truth for RENDERING,
  // and both are written together outside any updater — a ref mutated inside a
  // setState updater would double-count under StrictMode.
  const pendingRef = useRef<PendingAttachment[]>([]);
  const commit = (next: PendingAttachment[]): void => {
    pendingRef.current = next;
    setPending(next);
  };

  // Accepted files are downscaled in the browser BEFORE anything is sent;
  // non-images are ignored.
  async function addFiles(files: FileList | File[]): Promise<void> {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return; // nothing offered, nothing to report
    setNotice(null);
    const { take, declined } = withinCap(pendingRef.current.length, images);
    let failed = 0;
    for (const file of take) {
      let attachment: PendingAttachment;
      try {
        attachment = await downscaleImage(file);
      } catch {
        // createImageBitmap rejects on anything the browser will not decode —
        // macOS hands out image/tiff from the clipboard, and this was an
        // unhandled rejection on the drag path too. One unreadable picture must
        // not take the rest of the paste down with it.
        failed++;
        continue;
      }
      commit([...pendingRef.current, attachment]);
    }
    if (declined > 0) setNotice("chat.attachTooMany");
    else if (failed > 0) setNotice("chat.attachFailed");
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    if (!acceptDrops) return; // the archive view is read-only
    void addFiles(e.dataTransfer.files);
  };
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault(); // otherwise the browser opens the image in a new tab
    if (acceptDrops) setDragOver(true);
  };
  const onDragLeave = (): void => setDragOver(false);

  const onPaste = (e: ClipboardEvent): void => {
    if (!acceptDrops) return; // the archive view is read-only
    // `items` is typed non-null and every browser that fires `paste` fills it,
    // but this is an event handler: a TypeError here is a composer that freezes
    // on ⌘V with nothing in the console anybody connects to it.
    const items: DataTransferItemList | undefined = e.clipboardData?.items;
    const images = pastedImageFiles(items === undefined ? [] : Array.from(items));
    // Cancel ONLY when there is a picture to take. A paste carrying text must
    // reach the browser untouched, or ⌘V stops typing — the common case by far.
    if (images.length === 0) return;
    e.preventDefault();
    void addFiles(images);
  };

  return {
    pending,
    dragOver,
    fileInputRef,
    dropHandlers: { onDrop, onDragOver, onDragLeave },
    onPaste,
    addFiles,
    notice,
    removeAt: (index) => commit(pendingRef.current.filter((_, j) => j !== index)),
    clear: () => {
      commit([]);
      setNotice(null);
    },
    openFilePicker: () => fileInputRef.current?.click(),
    onFilePicked: (e) => {
      if (e.target.files !== null) void addFiles(e.target.files);
      e.target.value = ""; // same file again re-triggers change
    },
  };
}
