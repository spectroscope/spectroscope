// Card 312 review, finding: the llamacpp option rendered a complete sentence
// ending in a full stop, then a space, then a bare link, then ". ", then a
// second sentence — so the sheet read "… goes in Settings. llama.cpp. One
// llama-server serves …". A one-word sentence made of a link is not a
// typographic nit: it reads as a broken paragraph on the very first screen a
// newcomer sees, and it is the only option row that does it. Every sibling
// puts its link INSIDE the sentence — "install [ollama], then ollama pull
// qwen3" — because the link IS the thing you are told to go get.
//
// The rule is checked over the whole rendered sheet rather than that one row:
// the next option added would otherwise be free to repeat it.
//
// renderToStaticMarkup, the house idiom (sessionRowDensity.test.tsx says why):
// the suite runs in plain Node, so these assertions are about output markup.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Onboarding } from "./Onboarding";
import { setLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";

function sheet(lang: Lang): string {
  setLang(lang);
  return renderToStaticMarkup(
    <Onboarding open onClose={() => {}} onStartLocal={() => {}} onOpenSettings={() => {}} />,
  );
}

// The store is module-global; leave it as the app ships it.
afterEach(() => setLang("en"));

describe("the first-run sheet reads as sentences", () => {
  for (const lang of ["de", "en"] as const) {
    it(`puts every link inside a sentence, in ${lang}`, () => {
      const html = sheet(lang);
      expect(
        (html.match(/<a\s/g) ?? []).length,
        "no links at all — the guard would pass on an empty sheet",
      ).toBeGreaterThanOrEqual(3);
      expect(html, `${lang}: a link may not open a sentence of its own`).not.toMatch(/\.\s*<a\s/);
      expect(html, `${lang}: a link may not close a sentence of its own`).not.toMatch(/<\/a>\s*\./);
    });
  }

  it("still offers llama.cpp, with somewhere to go and get it", () => {
    const html = sheet("en");
    expect(html).toContain("llamacpp");
    expect(html).toContain("https://github.com/ggml-org/llama.cpp");
  });
});

/** The llamacpp option row, from the badge that names it to the end of the
 *  list item — the copy this card added, as the reader receives it. */
function llamacppRow(lang: Lang): string {
  const html = sheet(lang);
  const start = html.indexOf(">llamacpp</span>");
  expect(start, `no llamacpp option in the ${lang} sheet`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</li>", start));
}

describe("the llamacpp option speaks both locales", () => {
  it("tells the reader what to start, in each", () => {
    for (const lang of ["de", "en"] as const) {
      const row = llamacppRow(lang);
      expect(row, `${lang} names the binary to run`).toContain("llama-server");
      expect(row, `${lang} names the provider to pick`).toContain("<code>llamacpp</code>");
    }
  });

  it("does not ship the English sentence as the German one", () => {
    // A locale filled with the other's text passes any "the copy exists" test
    // and is still an untranslated row on the first screen a newcomer sees.
    expect(llamacppRow("de")).not.toBe(llamacppRow("en"));
  });
});
