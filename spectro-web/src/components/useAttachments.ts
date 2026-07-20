// The composer's attachment intake, as a hook: drag-and-drop or the
// file picker -> canvas downscale (AttachmentPreview) -> pending chips above
// the input. Nothing leaves the page until submit. The drop TARGET stays the
// caller's root element — the hook only hands out the handlers, so the drop
// zone keeps its full size.

import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent, RefObject } from "react";
import { downscaleImage } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";

export interface Attachments {
  /** The chips above the input — everything queued for the next send. */
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
  removeAt: (index: number) => void;
  /** Called on submit — the chips travel with the sent turn. */
  clear: () => void;
  openFilePicker: () => void;
  onFilePicked: (e: ChangeEvent<HTMLInputElement>) => void;
}

/** Attachment state + handlers for the composer. `acceptDrops` is false for
 *  the read-only archive view — drags are still cancelled (the browser must
 *  not open the image), but nothing is added. */
export function useAttachments(acceptDrops: boolean): Attachments {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Accepted files are downscaled in the browser BEFORE anything is sent;
  // non-images are ignored.
  async function addFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue; // accept images only
      const attachment = await downscaleImage(file);
      setPending((prev) => [...prev, attachment]);
    }
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

  return {
    pending,
    dragOver,
    fileInputRef,
    dropHandlers: { onDrop, onDragOver, onDragLeave },
    removeAt: (index) => setPending((prev) => prev.filter((_, j) => j !== index)),
    clear: () => setPending([]),
    openFilePicker: () => fileInputRef.current?.click(),
    onFilePicked: (e) => {
      if (e.target.files !== null) void addFiles(e.target.files);
      e.target.value = ""; // same file again re-triggers change
    },
  };
}
