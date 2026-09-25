// Card 431, criterion 1: the surface a session open raises, rendered to static
// markup (no DOM in this suite, house rule).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OpeningSurface } from "./OpeningSurface";
import { dict } from "../i18n/i18n";
import type { SessionOpening } from "../state/sessionOpening";
import { createOpenProgress, type OpenProgress } from "../state/openProgress";

const OPEN: SessionOpening = { ticket: 7, sessionId: "20260923-145313-ada4053d", title: "fix the build" };

const html = (
  opening: SessionOpening,
  lang: "en" | "de" = "en",
  progress: OpenProgress = createOpenProgress(() => 0),
): string => renderToStaticMarkup(<OpeningSurface lang={lang} opening={opening} progress={progress} />);

/** A store holding one reading. */
function reading(ticket: number, folded: number, total: number): OpenProgress {
  const progress = createOpenProgress(() => 0);
  progress.report(ticket, folded, total);
  return progress;
}

/** The text of the first element carrying `cls`, tags stripped. */
function textOf(markup: string, cls: string): string | null {
  const m = markup.match(new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</[a-z]+>`));
  return m === null ? null : m[1].replace(/<[^>]+>/g, "");
}

describe("the loading surface of a session open", () => {
  it("is a polite status region", () => {
    const out = html(OPEN);
    expect(out).toMatch(/^<div class="opening-surface"[^>]*role="status"/);
    expect(out).toMatch(/^<div[^>]*aria-live="polite"/);
  });

  it("shows a spinner the reader's tools skip", () => {
    expect(html(OPEN)).toMatch(/<span class="opening-spinner" aria-hidden="true"><\/span>/);
  });

  it("says what is happening, in English and in German", () => {
    expect(dict["open.line"]).toEqual({ en: "Opening session", de: "Sitzung wird geöffnet" });
    expect(textOf(html(OPEN, "en"), "opening-line")).toBe("Opening session");
    expect(textOf(html(OPEN, "de"), "opening-line")).toBe("Sitzung wird geöffnet");
  });

  it("names the session by its first prompt, as the row does", () => {
    expect(textOf(html(OPEN), "opening-title")).toBe("fix the build");
  });

  it("uses the row's words for a session with no prompt", () => {
    const empty = { ...OPEN, title: "" };
    expect(textOf(html(empty, "en"), "opening-title")).toBe(dict["nav.emptySession"].en);
    expect(textOf(html(empty, "de"), "opening-title")).toBe(dict["nav.emptySession"].de);
  });

  it("falls back to the id when no row was in hand", () => {
    const unknown = { ...OPEN, title: null };
    expect(textOf(html(unknown), "opening-title")).toBe("20260923-145313-ada4053d");
    expect(html(unknown)).toMatch(/class="opening-title mono"/);
  });
});

describe("the count on the sign (criterion 9)", () => {
  it("shows how far the fold of this open has got, in the reader's language", () => {
    expect(textOf(html(OPEN, "en", reading(7, 40_000, 91_956)), "opening-count")).toBe(
      "40,000 of 91,956 events",
    );
    expect(textOf(html(OPEN, "de", reading(7, 40_000, 91_956)), "opening-count")).toBe(
      "40.000 von 91.956 Ereignissen",
    );
  });

  it("keeps the count out of what a screen reader announces", () => {
    // It changes ten times a second; the line and the title carry the state.
    expect(html(OPEN, "en", reading(7, 1, 2))).toMatch(
      /<span class="opening-count tabular" aria-hidden="true">/,
    );
  });

  it("holds the count's line before the fold has started, so the card does not move when it arrives", () => {
    // The card is centred; a line that appeared later would push it up by
    // half a line. Measured in Chrome on 2026-09-25, before this line was held.
    expect(textOf(html(OPEN), "opening-count")).toBe("\u00a0");
    expect(html(OPEN)).toMatch(/<span class="opening-count tabular" aria-hidden="true">/);
  });

  it("shows no count another open reported", () => {
    expect(textOf(html(OPEN, "en", reading(6, 40_000, 91_956)), "opening-count")).toBe("\u00a0");
  });
});
