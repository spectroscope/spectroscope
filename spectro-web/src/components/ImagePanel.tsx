// The image gallery, the body of the dock's images panel (card 443; until
// 0.14.2 it was a column of its own beside the dock). Every image_generated
// event becomes a card (newest first); the bytes themselves are fetched
// lazily from GET /api/images/<file>, never pushed over the socket. The
// provider select switches the generation backend server-side. The dock card
// around it carries the name, the count, full screen and close.

import { useState } from "react";
import type { GeneratedImage } from "../state/reducer";
import { t } from "../i18n/i18n";
import { imageUrl, isDemoImage } from "../lab/flowmap/imageUrl";
import { useLang } from "../state/lang";

/** The blob store is addressed by file name only — strip the directory part. */
const fileName = (blobPath: string): string => blobPath.slice(blobPath.lastIndexOf("/") + 1);

/** How long the "copied" confirmation reads before the button label returns. */
const COPY_FEEDBACK_MS = 1600;

export function ImagePanel(props: {
  images: GeneratedImage[];
  provider: string;
  /** Key PRESENCE per backend (from /api/config); null until known. A
   *  keyless backend stays selectable but says so in its option label. */
  keys: { gemini: boolean; openai: boolean } | null;
  onProviderChange: (provider: string) => void;
  /** The live session whose workspace receives copies — absent hides the button (replays). */
  sessionId?: string;
}) {
  // The reducer appends in arrival order; the gallery shows newest first.
  const newestFirst = [...props.images].reverse();
  const lang = useLang();
  const [copiedCallId, setCopiedCallId] = useState<string | null>(null);

  // The owner names the file (native prompt, prefilled with the store name;
  // a name without an extension inherits the original's server-side), then
  // the server copies from ~/.spectro/images into the session's workspace.
  const copyToWorkspace = async (image: GeneratedImage): Promise<void> => {
    const file = fileName(image.blobPath);
    const name = window.prompt(t(lang, "img.copyPrompt"), file);
    if (name === null) return; // cancelled
    try {
      const res = await fetch("/api/images/copy-to-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, session: props.sessionId, name }),
      });
      if (res.ok) {
        setCopiedCallId(image.callId);
        window.setTimeout(() => setCopiedCallId(null), COPY_FEEDBACK_MS);
        return;
      }
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      window.alert(
        t(lang, "img.copyFailed") + (body?.message ? ` ${body.message}` : ` (HTTP ${res.status})`),
      );
    } catch {
      window.alert(t(lang, "img.copyFailed"));
    }
  };

  return (
    <div className="image-dock">
      <div className="image-dock-head">
        <label className="image-provider">
          <span className="image-provider-label">Provider</span>
          <select value={props.provider} onChange={(e) => props.onProviderChange(e.target.value)}>
            <option value="gemini">
              gemini{props.keys && !props.keys.gemini ? ` · ${t(lang, "img.noKey")}` : ""}
            </option>
            <option value="openai">
              openai{props.keys && !props.keys.openai ? ` · ${t(lang, "img.noKey")}` : ""}
            </option>
          </select>
        </label>
      </div>

      <div className="image-dock-list" role="group" aria-label={t(lang, "img.aria")}>
        {newestFirst.length === 0 ? (
          <p className="image-dock-empty">{t(lang, "img.empty")}</p>
        ) : (
          newestFirst.map((image) => {
            const url = imageUrl(image.blobPath);
            return (
              <a
                key={image.callId}
                className="image-card"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={t(lang, "img.openFull")}
              >
                <img loading="lazy" src={url} alt={image.prompt} />
                <span className="image-caption">{image.prompt}</span>
                <span className="image-meta">
                  <span className="badge">{image.provider}</span>
                  <span className="mono image-model">{image.model}</span>
                  {props.sessionId !== undefined && !isDemoImage(image.blobPath) && (
                    <button
                      type="button"
                      className="image-copy"
                      title={t(lang, "img.copyTitle")}
                      onClick={(e) => {
                        e.preventDefault(); // the card is a link to the full-size view
                        e.stopPropagation();
                        void copyToWorkspace(image);
                      }}
                    >
                      {copiedCallId === image.callId ? t(lang, "img.copied") : t(lang, "img.copy")}
                    </button>
                  )}
                </span>
              </a>
            );
          })
        )}
      </div>
    </div>
  );
}
