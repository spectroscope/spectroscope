// The pictures waiting to be sent, drawn INSIDE the composer's border with the
// caret continuing below them (owner, 2026-08-12). It replaces the chip strip
// that used to sit above the box.
//
// Deliberately just the picture: no file name on screen, no size label. A
// pasted screenshot has a name nobody chose ("image.png") and a size nobody
// asked about, and three of them side by side turned the composer into a
// table of file metadata. Both still travel — in the title and in the remove
// button's label — so a reader who wants them can ask, and formatSize keeps
// its caller.
//
// The strip is a SIBLING of the textarea and lives outside .composer-field.
// Inside the field it would push the live-dictation ghost down by its own
// height; inside the textarea it would make scrollHeight count pictures as
// lines and break the ten-line cap.

import { formatSize } from "./AttachmentPreview";
import type { PendingAttachment } from "./AttachmentPreview";
import { t } from "../i18n/i18n";
import type { Lang } from "../i18n/i18n";

export function AttachmentThumbs(props: {
  attachments: PendingAttachment[];
  onRemove: (index: number) => void;
  lang: Lang;
}) {
  if (props.attachments.length === 0) return null;
  return (
    <div className="composer-thumbs" role="list" aria-label={t(props.lang, "chat.attachedAria")}>
      {props.attachments.map((a, i) => {
        // A clipboard blob may arrive nameless. "Remove" with nothing after it
        // is not a label, so the fallback names what it actually is.
        const name = a.name !== "" ? a.name : t(props.lang, "chat.attachPasted");
        const remove = t(props.lang, "chat.attachRemove", { name });
        return (
          <div
            key={`${a.name}-${i}`}
            className="composer-thumb"
            role="listitem"
            title={`${name} · ${formatSize(a.sizeBytes)}`}
          >
            <img
              className="composer-thumb-img"
              src={`data:${a.mediaType};base64,${a.dataBase64}`}
              alt={name}
            />
            <button
              type="button"
              className="composer-thumb-x"
              aria-label={remove}
              title={remove}
              onClick={() => props.onRemove(i)}
            >
              <svg
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
