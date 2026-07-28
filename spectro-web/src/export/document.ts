// Composing the file the dialog promised: one document that can hold several
// views of the same run, and both languages of a translated one.
//
// THE TABS ARE CSS. A radio input per view, sibling selectors to show the one
// that is checked, and no script anywhere. Three things follow from that, and
// all three are the reason for it:
//   - the file still opens from file:// with the network unplugged, which is
//     the only reason an attachment on a ticket is worth anything;
//   - the dialog's preview can run in a sandboxed iframe with scripts OFF and
//     still be faithful — a preview that needs scripts to look right proves
//     nothing about the file;
//   - printing works, because there is no runtime to have failed.
// Sibling combinators rather than :has() for reach: this file gets opened in
// whatever browser the person on the other end happens to have.
//
// The panes for the views that are NOT showing are in the document, not fetched
// later. That is the trade: a three-view bilingual export is six renders of the
// same stream, and the dialog prints the resulting size before anyone saves it.

import type { RunEvent } from "../events";
import type { Lang } from "../i18n/i18n";
import { chatBody, escapeHtml, jsonBody, kindLabel, metaLine, shell, textFeedBody } from "./html";
import type { ExportRequest, ViewId } from "./options";
import { JSON_VIEW_CAVEAT } from "./options";

export interface DocumentRequest extends ExportRequest {
  /** Export moment; injectable so the output is byte-stable in tests. */
  now?: number;
  label?: string;
  lang?: Lang;
  /** Text view only: the extended feed, as the tab's own toggle builds it. */
  extended?: boolean;
}

export interface DocumentStreams {
  /** The recorded stream. */
  original: readonly RunEvent[];
  /** The same run with the landed translations in it, when there is one. */
  translated?: readonly RunEvent[] | null;
  /** The target language tag, for the provenance line. */
  translatedTo?: string | null;
}

/** Ids are constants, never data: they are spelled into CSS selectors below,
 *  where an interpolated value would be a rule someone else's session wrote. */
const VIEW_TAB: Record<ViewId, string> = {
  chat: "x-tab-chat",
  text: "x-tab-text",
  json: "x-tab-json",
};
const VIEW_PANE: Record<ViewId, string> = {
  chat: "x-view-chat",
  text: "x-view-text",
  json: "x-view-json",
};
const LANG_TAB = { original: "x-lang-original", translated: "x-lang-translated" } as const;

const VIEW_NAME: Record<ViewId, Record<Lang, string>> = {
  chat: { en: "chat", de: "Chat" },
  text: { en: "text feed", de: "Text-Feed" },
  json: { en: "json", de: "JSON" },
};

const NOTE: Record<Lang, (tag: string) => string> = {
  en: (tag) => `translated to ${tag}`,
  de: (tag) => `übersetzt nach ${tag}`,
};

const BOTH_NOTE: Record<Lang, (tag: string) => string> = {
  en: (tag) => `this file carries both languages — the recording and its translation to ${tag}`,
  de: (tag) => `diese Datei trägt beide Sprachen — die Aufnahme und ihre Übersetzung nach ${tag}`,
};

const LANG_LABEL: Record<Lang, { original: string; translated: string }> = {
  en: { original: "original", translated: "translation" },
  de: { original: "Original", translated: "Übersetzung" },
};

/** One view of one stream. */
function paneBody(view: ViewId, events: readonly RunEvent[], request: DocumentRequest): string {
  const opts = {
    lang: request.lang ?? "en",
    extended: request.extended,
    reasoningOpen: request.reasoning === "open",
    toolsOpen: request.tools === "open",
  };
  switch (view) {
    case "chat":
      return chatBody(events, opts).body;
    case "text":
      return textFeedBody(events, opts);
    case "json":
      return jsonBody(events, opts);
  }
}

/**
 * The document.
 *
 * @param request what the dialog decided: views, order, theme, folds, switcher
 * @param streams the recorded stream, and its translation when there is one
 * @return one self-contained html file
 */
export function composeDocument(request: DocumentRequest, streams: DocumentStreams): string {
  const lang: Lang = request.lang ?? "en";
  const now = request.now ?? Date.now();
  const views = request.views.length > 0 ? request.views : [request.kind];
  const primary = views.includes(request.primary) ? request.primary : views[0];

  // A switcher is only real when both sides are in hand AND they are different
  // streams. The identity test is the app's own convention for "is a
  // translation actually showing" (App.tsx: shownEvents !== tabEvents), and it
  // is what stops the text tab — which holds only the translated array — from
  // getting a control that flips between two identical documents. Asked for and
  // not possible means no switcher; the provenance note is printed either way.
  const translated = streams.translated ?? null;
  const bilingual = request.switcher && translated !== null && translated !== streams.original;
  const tag = streams.translatedTo ?? "";

  const kindName = kindLabel(lang, request.kind);
  const title =
    request.label !== undefined && request.label !== "" ? request.label : `spectroscope ${kindName}`;

  const langs: ReadonlyArray<{ id: "original" | "translated"; events: readonly RunEvent[] }> = bilingual
    ? [
        { id: "original", events: streams.original },
        { id: "translated", events: translated as readonly RunEvent[] },
      ]
    : [{ id: "original", events: translated ?? streams.original }];

  // ---- panes ----
  const sections = views
    .map((view) => {
      const caveat =
        view === "json" ? `<p class="x-view-note">${escapeHtml(JSON_VIEW_CAVEAT[lang])}</p>` : "";
      const panes = langs
        .map((l) => `<div class="x-lang x-lang--${l.id}">${paneBody(view, l.events, request)}</div>`)
        .join("");
      return `<section class="x-view" id="${VIEW_PANE[view]}">${caveat}${panes}</section>`;
    })
    .join("\n");

  // ---- controls ----
  const parts: string[] = [];
  let css = "";

  if (views.length > 1) {
    for (const view of views) {
      parts.push(
        `<input class="x-tab-in" type="radio" name="x-view" id="${VIEW_TAB[view]}"` +
          `${view === primary ? " checked" : ""}>`,
      );
    }
  }
  if (bilingual) {
    for (const id of ["original", "translated"] as const) {
      parts.push(
        `<input class="x-tab-in" type="radio" name="x-lang" id="${LANG_TAB[id]}"` +
          // The translation leads: someone who exported a translated session
          // was reading the translation.
          `${id === "translated" ? " checked" : ""}>`,
      );
    }
  }
  if (views.length > 1) {
    parts.push(
      `<nav class="x-tabs">` +
        views
          .map((view) => `<label for="${VIEW_TAB[view]}">${escapeHtml(VIEW_NAME[view][lang])}</label>`)
          .join("") +
        `</nav>`,
    );
    css +=
      `\n.x-view{display:none}\n` +
      views.map((view) => `#${VIEW_TAB[view]}:checked ~ main #${VIEW_PANE[view]}{display:block}`).join("\n") +
      "\n" +
      views
        .map(
          (view) =>
            `#${VIEW_TAB[view]}:checked ~ .x-tabs label[for="${VIEW_TAB[view]}"]` +
            `{border-color:var(--accent);color:var(--accent)}`,
        )
        .join("\n") +
      "\n";
  }
  if (bilingual) {
    parts.push(
      `<nav class="x-langs">` +
        `<label for="${LANG_TAB.original}">${escapeHtml(LANG_LABEL[lang].original)}</label>` +
        `<label for="${LANG_TAB.translated}">${escapeHtml(LANG_LABEL[lang].translated)}</label>` +
        `</nav>`,
    );
    css +=
      `\n.x-lang--original{display:none}\n` +
      `#${LANG_TAB.original}:checked ~ main .x-lang--original{display:block}\n` +
      `#${LANG_TAB.original}:checked ~ main .x-lang--translated{display:none}\n` +
      `#${LANG_TAB.original}:checked ~ .x-langs label[for="${LANG_TAB.original}"]` +
      `{border-color:var(--accent);color:var(--accent)}\n` +
      `#${LANG_TAB.translated}:checked ~ .x-langs label[for="${LANG_TAB.translated}"]` +
      `{border-color:var(--accent);color:var(--accent)}\n`;
  }

  // ---- chrome ----
  // Provenance is never omitted when there is any: a translation that passes
  // for the record is the one failure this whole path exists to prevent.
  const note =
    translated === null
      ? undefined
      : bilingual
        ? BOTH_NOTE[lang](tag === "" ? "?" : tag)
        : NOTE[lang](tag === "" ? "?" : tag);

  const foot =
    views.includes("chat") && streams.original.length > 0
      ? chatBody(langs[0].events, { lang }).foot
      : kindLabel(lang, "events").replace("{n}", String(streams.original.length));

  return shell({
    lang,
    title,
    theme: request.theme,
    meta: metaLine({ kindName, count: streams.original.length, now, lang, theme: request.theme }),
    note,
    controls: parts.join("\n"),
    extraCss: css,
    body: sections,
    foot,
  });
}
