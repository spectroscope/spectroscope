// "Take this tab with you" (owner 2026-07-27: "mache in jeden tab eine export
// funktion. im text die text view (as is) als html und im chat den chat as is
// als html", and from the translate sheet: "auch gerne anbieten das neue jsonl
// zu exportieren, dann kann man beim nächsten mal gleich das neue nehmen").
//
// ONE control, two tabs, two files. The HTML is what you are reading — the chat
// or the text feed, rendered by src/export/html.ts into a self-contained
// document. The JSONL is the event stream behind it, written by
// src/export/jsonl.ts in the exact wire shape the import reads back. Which
// tab you are in only decides WHICH html renderer runs; the stream is the same
// stream, because every view here is a fold over the same RunEvent[].
//
// NOT the same thing as the archive link in Chat's archive bar. That one is
// GET /api/sessions/{id}/export: the server hands back a STORED file verbatim,
// and it only exists for a session the store actually holds. This control
// exports the stream THIS TAB is rendering — a live run, an import, a scenario,
// a fleet, a translation — none of which the server has a copy of. For a stored
// session the bytes agree (the round-trip is pinned in jsonl.test.ts); the file
// names differ on purpose, so a folder still says where each file came from.
//
// The menu renders no session data itself: it only names files and hands the
// stream to the renderers. Escaping lives where the markup is built.

import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "../events";
import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { chatToHtml, exportFilename, saveHtml, textFeedToHtml } from "../export/html";
import { downloadJsonl, jsonlFilename } from "../export/jsonl";

/** The kind of view an export was taken from — it names the html file. */
export type ExportKind = "chat" | "text";

export interface ExportPlan {
  /** False when the stream is empty: there is no document to write. */
  enabled: boolean;
  htmlName: string;
  jsonlName: string;
}

/** The jsonl file's own kind word. Its counterpart for html is the tab name,
 *  which is a real distinction there and none here — one stream, one shape. */
const SESSION = "spectroscope-session";

/** The provenance line printed INSIDE the exported document. Deliberately not
 *  an i18n key: html.ts keeps its own chrome local because a file outlives the
 *  app it came from, and a key that has not landed yet would print as a key in
 *  a document someone mails to a colleague. */
const TRANSLATED_NOTE: Record<Lang, (tag: string) => string> = {
  en: (tag) => `translated to ${tag}`,
  de: (tag) => `übersetzt nach ${tag}`,
};

/** jsonlFilename caps the whole base at 64 characters and cuts from the END,
 *  which would eat the stamp. The label gets what is left over after the
 *  prefix, the stamp and their separators, so the date always survives. */
const LABEL_BUDGET = 29;

/**
 * The label as a file-name segment, under the same rule html.ts applies to its
 * own name — so both files carry an IDENTICAL session segment and sort together
 * in a folder. The input can be an imported file's name, so nothing but
 * lowercase alphanumerics and single dashes survives it.
 */
function slugLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LABEL_BUDGET)
    .replace(/-+$/, "");
}

/** UTC, in html.ts's stamp shape: two files saved by one click must read as one
 *  moment, and a local stamp is one nobody on another machine can place. */
function stampUtc(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  );
}

/**
 * What this control can offer right now, and under which names.
 *
 * @param input.count       events in the stream; zero disables the control
 * @param input.label       the session id, or an imported file's name; untrusted
 * @param input.translatedTo the language tag when this stream is a translation
 * @return both file names, and whether there is anything to write
 */
export function exportPlan(input: {
  kind: ExportKind;
  count: number;
  label?: string | null;
  translatedTo?: string | null;
  now: number;
}): ExportPlan {
  const named = typeof input.label === "string" ? slugLabel(input.label) : "";
  const stamp = stampUtc(input.now);
  return {
    enabled: input.count > 0,
    htmlName: exportFilename(input.kind, named === "" ? undefined : named, input.now),
    jsonlName: jsonlFilename({
      base: named === "" ? `${SESSION}-${stamp}` : `${SESSION}-${named}-${stamp}`,
      lang: input.translatedTo,
    }),
  };
}

export function ExportMenu(props: {
  kind: ExportKind;
  /** The stream this tab renders — exactly what both files are written from. */
  events: readonly RunEvent[];
  /** Names the files: the session id, or an imported file's name. */
  label?: string | null;
  /** Text tab only: mirrors its extended toggle, so the file is the view. */
  extended?: boolean;
  /** Set by the translate path: tags the jsonl name and prints a provenance
   *  line under the html header, so a translation never passes for the record. */
  translatedTo?: string | null;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Outside click and Escape close it — same mechanics as DisclosureMenu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const enabled = props.events.length > 0;

  const save = (what: "html" | "jsonl"): void => {
    // Stamped at the CLICK: a plan computed while rendering would date the file
    // to the moment the tab opened.
    const plan = exportPlan({
      kind: props.kind,
      count: props.events.length,
      label: props.label,
      translatedTo: props.translatedTo,
      now: Date.now(),
    });
    if (!plan.enabled) return;
    if (what === "jsonl") {
      downloadJsonl(props.events, plan.jsonlName);
    } else {
      const opts = {
        label: props.label ?? undefined,
        lang,
        extended: props.extended,
        // Only ever the tag we were handed; no note at all when nothing was
        // translated, rather than a sentence that claims provenance we lack.
        note:
          typeof props.translatedTo === "string" && props.translatedTo !== ""
            ? TRANSLATED_NOTE[lang](props.translatedTo)
            : undefined,
      };
      saveHtml(
        plan.htmlName,
        props.kind === "chat" ? chatToHtml(props.events, opts) : textFeedToHtml(props.events, opts),
      );
    }
    setOpen(false);
  };

  return (
    <div className="wsg-anchor export-anchor" ref={ref}>
      <button
        type="button"
        className="trace-lens mono export-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!enabled}
        title={t(lang, enabled ? "exp.title" : "exp.emptyTitle")}
        onClick={() => setOpen((o) => !o)}
      >
        {t(lang, "exp.button")}
      </button>

      {open && enabled && (
        <div className="wsg-pop export-pop" role="menu" aria-label={t(lang, "exp.title")}>
          <div className="wsg-section">
            <div className="wsg-section-head">
              <span>{t(lang, "exp.title")}</span>
            </div>
            <div className="wsg-modes">
              <button type="button" role="menuitem" className="wsg-mode-row" onClick={() => save("html")}>
                <span className="wsg-mode-body">
                  <span className="wsg-mode-name mono">
                    {t(lang, props.kind === "chat" ? "exp.htmlChat" : "exp.htmlText")}
                  </span>
                  <span className="wsg-mode-hint">{t(lang, "exp.htmlHint")}</span>
                </span>
              </button>
              <button type="button" role="menuitem" className="wsg-mode-row" onClick={() => save("jsonl")}>
                <span className="wsg-mode-body">
                  <span className="wsg-mode-name mono">{t(lang, "exp.jsonl")}</span>
                  <span className="wsg-mode-hint">
                    {t(lang, "exp.jsonlHint", { n: props.events.length })}
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
