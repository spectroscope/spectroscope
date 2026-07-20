// The preview widget: shows attached images BEFORE sending. Nothing
// leaves the browser until the user hits send; the remove cross throws a chip
// out again. Plus the size hygiene of this stage: canvas downscaling, because
// an unscaled 4000-pixel photo is the most expensive mistake of the stage
// (roughly width x height / 750 tokens).

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
    return { name: file.name, mediaType: file.type, dataBase64: toBase64(bytes), sizeBytes: bytes.byteLength };
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
  return { name: file.name, mediaType: "image/jpeg", dataBase64: toBase64(bytes), sizeBytes: bytes.byteLength };
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

export function AttachmentPreview(props: {
  attachments: PendingAttachment[];
  onRemove: (index: number) => void;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <div className="attach-strip" role="list" aria-label="Attached images">
      {props.attachments.map((a, i) => (
        <div key={`${a.name}-${i}`} className="attach-chip" role="listitem">
          <img
            className="attach-thumb"
            src={`data:${a.mediaType};base64,${a.dataBase64}`}
            alt={a.name}
          />
          <div className="attach-meta">
            <span className="attach-name" title={a.name}>{a.name}</span>
            <span className="attach-size">{formatSize(a.sizeBytes)}</span>
          </div>
          <button
            type="button"
            className="attach-remove"
            aria-label={`Remove ${a.name}`}
            onClick={() => props.onRemove(i)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
