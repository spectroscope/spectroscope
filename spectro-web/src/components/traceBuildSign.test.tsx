// Card 435, criterion 7: the sign card 431 raises for an open also stands over
// the first build of an archive's trace, with its own line and the build's
// count. Rendered to static markup (no DOM in this suite, house rule).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OpeningSurface } from "./OpeningSurface";
import { dict } from "../i18n/i18n";
import { createOpenProgress } from "../state/openProgress";
import type { SessionOpening } from "../state/sessionOpening";

/**
 * The markup's text for the assertions. Tags are stripped until none is left,
 * so a tag that only forms once an inner one is gone goes too.
 */
function stripTags(markup: string): string {
  let text = markup;
  for (let prev = ""; prev !== text;) {
    prev = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return text;
}

const BUILD: SessionOpening = {
  ticket: 3,
  sessionId: "20260923-145313-ada4053d",
  title: "fix the build",
  purpose: "trace",
};

/** The text of the first element carrying `cls`, tags stripped. */
function textOf(markup: string, cls: string): string | null {
  const m = markup.match(new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</[a-z]+>`));
  return m === null ? null : stripTags(m[1]);
}

describe("the sign over the first build of a trace", () => {
  it("says the trace is being built, in English and in German", () => {
    expect(dict["open.traceLine"]).toEqual({ en: "Building the trace", de: "Trace wird aufgebaut" });
    const progress = createOpenProgress(() => 0);
    const en = renderToStaticMarkup(<OpeningSurface lang="en" opening={BUILD} progress={progress} />);
    const de = renderToStaticMarkup(<OpeningSurface lang="de" opening={BUILD} progress={progress} />);
    expect(textOf(en, "opening-line")).toBe("Building the trace");
    expect(textOf(de, "opening-line")).toBe("Trace wird aufgebaut");
  });

  it("keeps the open's line when no purpose is named", () => {
    const progress = createOpenProgress(() => 0);
    const { purpose: _purpose, ...open } = BUILD;
    const en = renderToStaticMarkup(<OpeningSurface lang="en" opening={open} progress={progress} />);
    expect(textOf(en, "opening-line")).toBe("Opening session");
  });

  it("counts the rows its build reports, under its own ticket", () => {
    const progress = createOpenProgress(() => 0);
    progress.report(BUILD.ticket, 40_000, 91_956);
    const en = renderToStaticMarkup(<OpeningSurface lang="en" opening={BUILD} progress={progress} />);
    const de = renderToStaticMarkup(<OpeningSurface lang="de" opening={BUILD} progress={progress} />);
    expect(textOf(en, "opening-count")).toBe("40,000 of 91,956 events");
    expect(textOf(de, "opening-count")).toBe("40.000 von 91.956 Ereignissen");
  });
});
