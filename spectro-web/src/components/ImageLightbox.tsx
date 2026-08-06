// A picture, full size, and the rest of the session's pictures behind the arrow
// keys.
//
// The owner: "kann du einen große ansicht im modalen fenster machen wenn ich
// darauf klicke und auch gerne eine cursor links und rechts modalität um die
// genazen bilder in einer session wie eine gallerie durchzugehen. und bitte auch
// einen button den ordner aufmachen, in dem das bild lokal auf der platte liegt".
//
// ⚠️ THE ONE THING THIS CANNOT DO, and it is worth saying in the code rather
// than only in a chat message: THE PICTURE IS NOT A FILE ON DISK. It is base64
// inside the transcript's own .jsonl — that is exactly why it could be brought
// back without a server endpoint, and it is also why no Finder window can be
// opened "on the image". So the button offers the two honest things instead:
// show the folder the TRANSCRIPT lives in, and save the picture, after which it
// really is a file.
//
// One mount, at the app level, because a modal that lives inside a chat turn
// cannot be walked out of into a tool card three turns down.

import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { step, type GalleryImage } from "../state/sessionImages";
import { openSessionFolder } from "../import/sessionFolders";

export interface LightboxProps {
  /** Every picture in the session, in stream order. */
  images: readonly GalleryImage[];
  /** Which one is open, or null when the lightbox is closed. */
  at: number | null;
  onClose: () => void;
  onGo: (next: number) => void;
  /** The transcript's store path, when this session came from the store. */
  storePath: string | null;
}

export function ImageLightbox(props: LightboxProps) {
  const lang = useLang();
  const { at, images, onClose, onGo } = props;
  const [saved, setSaved] = useState(false);

  const shot = at === null ? undefined : images[at];

  // Bound to the WINDOW rather than to the dialog: a click on the backdrop
  // moves focus, and a keydown handler on an element that just lost focus is a
  // gallery whose arrow keys stop working after the first click.
  useEffect(() => {
    if (at === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onGo(step(at, images.length, 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onGo(step(at, images.length, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [at, images.length, onClose, onGo]);

  // A new picture is a new save.
  useEffect(() => setSaved(false), [at]);

  const save = useCallback(() => {
    if (!shot) return;
    // The bytes are already here, so the download is local — no request, and
    // nothing leaves the machine.
    const a = document.createElement("a");
    a.href = `data:${shot.mediaType};base64,${shot.dataBase64}`;
    const ext = shot.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    a.download = `spectroscope-${String(shot.turn).padStart(3, "0")}.${ext}`;
    a.click();
    setSaved(true);
  }, [shot]);

  if (at === null || shot === undefined) return null;

  const where =
    shot.from === "tool"
      ? t(lang, "shot.fromTool", { tool: shot.toolName ?? "a tool" })
      : t(lang, "shot.fromMessage");

  return (
    <div
      className="modal-backdrop img-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t(lang, "shot.title")}
    >
      {/* The picture and its chrome stop the click; the backdrop closes. */}
      <div className="img-modal" onClick={(e) => e.stopPropagation()}>
        <div className="img-bar">
          <span className="img-where mono">{where}</span>
          <span className="img-note mono">{shot.name}</span>
          <span className="img-spacer" />
          <span className="img-count mono tabular">
            {at + 1} / {images.length}
          </span>
          <button type="button" className="ghost" onClick={save}>
            {saved ? t(lang, "shot.saved") : t(lang, "shot.save")}
          </button>
          {/* Honest wording: the transcript's folder, not the picture's — there
              is no picture file to point at. */}
          {props.storePath !== null && (
            <button
              type="button"
              className="ghost"
              title={t(lang, "shot.folderTitle")}
              onClick={() => void openSessionFolder(props.storePath as string, "transcript")}
            >
              {t(lang, "shot.folder")}
            </button>
          )}
          <button type="button" className="ghost" onClick={onClose} aria-label={t(lang, "shot.close")}>
            ✕
          </button>
        </div>

        <div className="img-stage">
          {images.length > 1 && (
            <button
              type="button"
              className="img-arrow img-arrow--prev"
              aria-label={t(lang, "shot.prev")}
              onClick={() => onGo(step(at, images.length, -1))}
            >
              ‹
            </button>
          )}
          <img
            className="img-full"
            src={`data:${shot.mediaType};base64,${shot.dataBase64}`}
            alt={shot.name}
          />
          {images.length > 1 && (
            <button
              type="button"
              className="img-arrow img-arrow--next"
              aria-label={t(lang, "shot.next")}
              onClick={() => onGo(step(at, images.length, 1))}
            >
              ›
            </button>
          )}
        </div>

        <div className="img-foot mono">{t(lang, "shot.keys")}</div>
      </div>
    </div>
  );
}
