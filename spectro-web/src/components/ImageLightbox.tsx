// A picture, full size, and the rest of the session's pictures behind the arrow
// keys.
//
// The owner: "kann du einen große ansicht im modalen fenster machen wenn ich
// darauf klicke und auch gerne eine cursor links und rechts modalität um die
// genazen bilder in einer session wie eine gallerie durchzugehen. und bitte auch
// einen button den ordner aufmachen, in dem das bild lokal auf der platte liegt".
//
// THE PICTURE IS NOT A FILE ON DISK. It is base64 inside the transcript's own
// .jsonl — exactly why it could be brought back without a server endpoint, and
// why no Finder window can be opened "on the image".
//
// The owner's answer to that, once he knew: show him the truth instead. So this
// has THREE FACES, the same idea the trace already uses —
//
//   picture   what it is
//   base64    the string itself, measured, copyable
//   file      the .jsonl AROUND it: the record's own line with the blob marked
//             where it sits, and the lines before and after for context
//
// The file face needs no request. `ImportSource.lines` is the file byte for
// byte, already in memory, and `origin[i]` says which line produced event `i`.
//
// One mount, at the app level, because a modal that lives inside a chat turn
// cannot be walked out of into a tool card three turns down.

import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { step, type GalleryImage } from "../state/sessionImages";
import { sourceWindow } from "../state/sourceWindow";
import { openSessionFolder } from "../import/sessionFolders";

/** Which face is showing. */
type Face = "picture" | "base64" | "file";

export interface LightboxProps {
  /** Every picture in the session, in stream order. */
  images: readonly GalleryImage[];
  /** Which one is open, or null when the lightbox is closed. */
  at: number | null;
  onClose: () => void;
  onGo: (next: number) => void;
  /** The transcript's store path, when this session came from the store. */
  storePath: string | null;
  /** The imported file's own lines, for the `file` face. Null for a live
   *  session, which has no file behind it. */
  sourceLines: readonly string[] | null;
}

export function ImageLightbox(props: LightboxProps) {
  const lang = useLang();
  const { at, images, onClose, onGo } = props;
  const [saved, setSaved] = useState(false);
  const [face, setFace] = useState<Face>("picture");
  const [copied, setCopied] = useState(false);

  const shot = at === null ? undefined : images[at];
  // Plain locals, not `shot?.x` inside the memo below: an optional chain in a
  // dependency array is a value the React Compiler cannot track, and it refuses
  // the memo rather than silently keeping a stale one.
  const sourceLines = props.sourceLines;
  const line = shot === undefined ? undefined : shot.sourceLine;

  // The file around the record that carried it. Computed only when the file
  // face is showing: cutting a 600 KB line is cheap, doing it on every arrow
  // press while looking at pictures is not.
  const win = useMemo(
    () =>
      face === "file" && line !== undefined && sourceLines !== null ? sourceWindow(sourceLines, line) : null,
    [face, line, sourceLines],
  );

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

  // A new picture is a new save, and a new copy. The FACE is deliberately kept:
  // a reader comparing where three screenshots sit in the file should not have
  // to press "file" again for each one.
  useEffect(() => {
    setSaved(false);
    setCopied(false);
  }, [at]);

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

  const copyBase64 = useCallback(() => {
    if (!shot) return;
    void navigator.clipboard?.writeText(shot.dataBase64).then(() => setCopied(true));
  }, [shot]);

  if (at === null || shot === undefined) return null;

  // A face is only offered when it has something to show. `file` without a line
  // behind it would be an empty pane that reads as a bug.
  const canFile = shot.sourceLine !== undefined && props.sourceLines !== null;

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
          {/* The three faces, in the trace's own idiom: a segmented row where
              the one showing is pressed. `file` is absent rather than disabled
              when there is no file, because a dead control invites a click. */}
          <span className="img-faces" role="group" aria-label={t(lang, "shot.faces")}>
            {(["picture", "base64", ...(canFile ? (["file"] as const) : [])] as Face[]).map((f) => (
              <button
                key={f}
                type="button"
                className={face === f ? "is-on" : ""}
                aria-pressed={face === f}
                onClick={() => setFace(f)}
              >
                {t(lang, `shot.face.${f}`)}
              </button>
            ))}
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
          {images.length > 1 && face === "picture" && (
            <button
              type="button"
              className="img-arrow img-arrow--prev"
              aria-label={t(lang, "shot.prev")}
              onClick={() => onGo(step(at, images.length, -1))}
            >
              ‹
            </button>
          )}
          {face === "picture" && (
            <img
              className="img-full"
              src={`data:${shot.mediaType};base64,${shot.dataBase64}`}
              alt={shot.name}
            />
          )}

          {face === "base64" && (
            <div className="img-text">
              <div className="img-text-head mono">
                {t(lang, "shot.base64Head", {
                  media: shot.mediaType,
                  chars: shot.dataBase64.length.toLocaleString(),
                })}
                <button type="button" className="ghost" onClick={copyBase64}>
                  {copied ? t(lang, "shot.copied") : t(lang, "shot.copy")}
                </button>
              </div>
              {/* The whole string, in a box that scrolls. It is the thing he
                  asked to see; clipping it here would be the same evasion the
                  note-instead-of-picture was. */}
              <pre className="img-blob mono">{shot.dataBase64}</pre>
            </div>
          )}

          {face === "file" && (
            <div className="img-text">
              <div className="img-text-head mono">
                {win?.target
                  ? t(lang, win.target.blobs > 1 ? "shot.fileHeadN" : "shot.fileHead", {
                      line: win.target.number,
                      total: win.total,
                      n: win.target.blobs,
                    })
                  : t(lang, "shot.fileUnknown")}
              </div>
              <div className="img-file mono">
                {win?.above.map((l) => (
                  <div className="img-line" key={l.number}>
                    <span className="img-lineno tabular">{l.number}</span>
                    <span className="img-linetext">{l.text}</span>
                  </div>
                ))}
                {win?.target && (
                  <div className="img-line is-target">
                    <span className="img-lineno tabular">{win.target.number}</span>
                    <span className="img-linetext">
                      {/* Each blob as a measured absence where it sits. Printing
                          600 KB here would be the trace-row defect all over
                          again — the base64 face is where the string lives.
                          Every blob, not just this picture's: the owner's own
                          opening record carries four, and marking one left the
                          next one's raw base64 on screen. */}
                      {win.target.segments.map((seg, k) =>
                        seg.kind === "text" ? (
                          <span key={k}>{seg.text}</span>
                        ) : (
                          <button
                            key={k}
                            type="button"
                            className="img-blobmark"
                            title={t(lang, "shot.blobTitle")}
                            onClick={() => setFace("base64")}
                          >
                            {t(lang, "shot.blob", { chars: seg.chars.toLocaleString() })}
                          </button>
                        ),
                      )}
                    </span>
                  </div>
                )}
                {win?.below.map((l) => (
                  <div className="img-line" key={l.number}>
                    <span className="img-lineno tabular">{l.number}</span>
                    <span className="img-linetext">{l.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {images.length > 1 && face === "picture" && (
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
