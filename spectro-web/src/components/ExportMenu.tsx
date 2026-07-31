// "Take this tab with you" (owner 2026-07-27: "mache in jeden tab eine export
// funktion. im text die text view (as is) als html und im chat den chat as is
// als html"), and since 2026-07-28 a MODAL sheet rather than a two-item menu:
// "beim export kann man kein design auswählen, gerne hier ein modales export
// view fenster mit vorschau … und dann design auswahl, optionen".
//
// This file is now the seam, not the sheet. It owns three things the dialog
// must not guess: which streams exist, what the files are called, and whether a
// translation is in play at all.
//
// WHICH STREAM IS "AS IS". The chat tab renders a FOLDED state built from the
// translated stream, but its `events` prop is the recorded one (App.tsx hands
// Chat `tabEvents` and TextView `shownEvents`). So the old menu's promise —
// "exactly as you are reading it" — was false in the chat tab whenever a
// translation was showing: it wrote the original. With a viewKey this module
// can see the translation state itself, hold both sides, and default to the one
// on screen. Without a viewKey it degrades honestly: one stream, no switcher,
// no provenance claim.
//
// The menu renders no session data itself: it only names files and hands the
// streams to the renderers. Escaping lives where the markup is built.

import { useState } from "react";
import type { RunEvent } from "../events";
import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { useTranslation, withTranslation } from "../state/translate";
import { exportFilename, saveHtml } from "../export/html";
import { downloadJsonl, jsonlFilename, toJsonl } from "../export/jsonl";
import { toClaudeCodeJsonl } from "../export/claudeCode";
import { toVscodeAgentJsonl } from "../export/vscodeAgent";
import type { ExportRequest, JsonlFormat } from "../export/options";
import type { ExportKind } from "../export/kinds";
import { ExportDialog } from "./ExportDialog";

export type { ExportKind };

export interface ExportPlan {
  /** False when the stream is empty: there is no document to write. */
  enabled: boolean;
  htmlName: string;
  jsonlName: string;
}

/** The jsonl file's own kind word. Its counterpart for html is the tab name,
 *  which is a real distinction there and none here — one stream, one shape. */
const SESSION = "spectroscope-session";

/** What a foreign target adds to the file name. A folder holding three exports
 *  of one session has to say which is which, and the extension cannot. */
const FORMAT_SUFFIX: Record<JsonlFormat, string> = {
  spectroscope: "",
  "claude-code": ".claude-code",
  vscode: ".vscode",
};

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
 * @param input.format      the jsonl target, which names the file
 * @return both file names, and whether there is anything to write
 */
export function exportPlan(input: {
  kind: ExportKind;
  count: number;
  label?: string | null;
  translatedTo?: string | null;
  format?: JsonlFormat;
  now: number;
}): ExportPlan {
  const named = typeof input.label === "string" ? slugLabel(input.label) : "";
  const stamp = stampUtc(input.now);
  const base = named === "" ? `${SESSION}-${stamp}` : `${SESSION}-${named}-${stamp}`;
  return {
    enabled: input.count > 0,
    htmlName: exportFilename(input.kind, named === "" ? undefined : named, input.now),
    jsonlName: jsonlFilename({
      base,
      // Handed over separately so the cap cannot eat it: a label long enough to
      // fill the budget used to truncate ".claude-code" to ".clau" and, one
      // character further, to nothing at all — at which point all three formats
      // shared a name. The label stays budgeted for the stamp alone, so the html
      // and jsonl of one export keep the identical session segment.
      marker: FORMAT_SUFFIX[input.format ?? "spectroscope"],
      lang: input.translatedTo,
    }),
  };
}

/** The writer for a target. Kept beside the plan so the name and the bytes are
 *  chosen in one place and cannot disagree about which format was written. */
const WRITERS: Record<JsonlFormat, (events: readonly RunEvent[]) => string> = {
  spectroscope: toJsonl,
  "claude-code": toClaudeCodeJsonl,
  vscode: toVscodeAgentJsonl,
};

export function ExportMenu(props: {
  kind: ExportKind;
  /** The stream this tab renders — what the files are written from. */
  events: readonly RunEvent[];
  /** Names the files: the session id, or an imported file's name. */
  label?: string | null;
  /** Text tab only: mirrors its extended toggle, so the file is the view. */
  extended?: boolean;
  /** Which session view this is, so the sheet can read that view's translation
   *  state. Absent means no switcher and no provenance claim — never a claim
   *  about a translation this control cannot see. */
  viewKey?: string;
  /** Set by a caller that already knows the target language. Optional now: with
   *  a viewKey the tag is read from the translation state, which is how the
   *  text tab finally gets its provenance line (card 114). */
  translatedTo?: string | null;
}) {
  const lang = useLang();
  const [open, setOpen] = useState(false);
  // Reading a fixed key when none was given keeps the hook order stable; the
  // result is only USED when a viewKey really came in.
  const translation = useTranslation(props.viewKey ?? "live");
  const known = props.viewKey !== undefined;
  const landed = known ? translation.byId.size : 0;

  const enabled = props.events.length > 0;

  // The chat tab is handed the RECORDED stream, so both sides are available
  // here. The text tab is handed the already-translated one, and no function
  // turns that back into the original — it gets the note and no switcher.
  const isRecorded = props.kind === "chat";
  const original = landed > 0 && isRecorded ? props.events : null;
  const translated =
    landed === 0 ? null : isRecorded ? withTranslation(props.events, translation) : props.events;
  const tag =
    props.translatedTo !== undefined && props.translatedTo !== null && props.translatedTo !== ""
      ? props.translatedTo
      : landed > 0
        ? translation.target
        : null;

  const saveTheJsonl = (request: ExportRequest): void => {
    const plan = exportPlan({
      kind: props.kind,
      count: props.events.length,
      label: props.label,
      translatedTo: tag,
      format: request.format,
      now: Date.now(),
    });
    if (!plan.enabled) return;
    // Whatever the sheet previews, the bytes are the stream on screen.
    const events = translated ?? props.events;
    if (request.format === "spectroscope") {
      // The app's own shape keeps its own saver: downloadJsonl is what the
      // byte-compatibility tests drive, and routing it through a second writer
      // here would leave that contract pinned to code the app stopped calling.
      downloadJsonl(events, plan.jsonlName);
    } else {
      saveText(WRITERS[request.format](events), plan.jsonlName);
    }
    setOpen(false);
  };

  const saveTheHtml = (_request: ExportRequest, html: string): void => {
    const plan = exportPlan({
      kind: props.kind,
      count: props.events.length,
      label: props.label,
      translatedTo: tag,
      now: Date.now(),
    });
    if (!plan.enabled) return;
    saveHtml(plan.htmlName, html);
  };

  return (
    <>
      <button
        type="button"
        className="trace-lens mono export-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!enabled}
        title={t(lang, enabled ? "exp.title" : "exp.emptyTitle")}
        onClick={() => setOpen(true)}
      >
        {t(lang, "exp.button")}
      </button>

      {open && enabled && (
        <ExportDialog
          kind={props.kind}
          events={props.events}
          original={original}
          translated={translated}
          translatedTo={tag}
          failedUnits={known ? translation.failed.size : 0}
          label={props.label}
          extended={props.extended}
          onSaveHtml={saveTheHtml}
          onSaveJsonl={saveTheJsonl}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The provenance sentence, exported for the callers that build their own
 *  documents. Unused inside this file since the composer prints its own. */
export function translatedNote(lang: Lang, tag: string): string {
  return TRANSLATED_NOTE[lang](tag);
}

/** One saver for the three jsonl shapes; the spectroscope path keeps using
 *  downloadJsonl so its event-count contract stays pinned by its own tests. */
function saveText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
