// The size hygiene of the attachment stage: canvas downscaling, because an
// unscaled 4000-pixel photo is the most expensive mistake here (roughly
// width x height / 750 tokens), plus the shape a pending picture has while it
// waits. Nothing leaves the browser until the user hits send.
//
// Every intake route lands on downscaleImage — drop, file picker and ⌘V alike
// (useAttachments). The drawing of the waiting pictures is AttachmentThumbs.

export type PendingAttachment = {
  name: string;
  mediaType: string;
  dataBase64: string;
  sizeBytes: number;
};

const MAX_EDGE = 1568; // longest edge after downscaling
const REENCODE_OVER = 1_500_000; // re-encode above ~1.5 MB, even without downscaling

// Downscales via canvas (longest edge maxEdge) and encodes as JPEG.
// Small images and GIFs (animation!) are passed through unchanged.
export async function downscaleImage(file: File, maxEdge = MAX_EDGE): Promise<PendingAttachment> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (!(scale < 1 || file.size > REENCODE_OVER) || file.type === "image/gif") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
      name: file.name,
      mediaType: file.type,
      dataBase64: toBase64(bytes),
      sizeBytes: bytes.byteLength,
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D context not available");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b !== null ? res(b) : rej(new Error("toBlob returned null"))), "image/jpeg", 0.85),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    name: file.name,
    mediaType: "image/jpeg",
    dataBase64: toBase64(bytes),
    sizeBytes: bytes.byteLength,
  };
}

// btoa needs a binary string; chunked, because String.fromCharCode(...hugeArray)
// throws a RangeError on large images.
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The chip strip that used to live here moved INTO the composer's border on
// 2026-08-12 and is now AttachmentThumbs. What stays is the size hygiene of
// this stage — downscaleImage, formatSize and the PendingAttachment shape — all
// three imported across the tree, formatSize by the new thumbnails' title.
