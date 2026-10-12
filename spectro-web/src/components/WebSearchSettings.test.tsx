// Card 448: what the Web search block tells an operator about a SearXNG
// instance that serves HTML only. Rendered with react-dom/server like the other
// view suites; the block's two fetches run in effects, which a static render
// never runs, so only the static notes are on the page here.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SearxngOfferBlock, WebSearchSettings } from "./WebSearchSettings";
import { SEARXNG_RUN_COMMAND, searxngFetchCommand, searxngScriptUrl } from "./webSearchSetup";
import type { DockerStatus } from "./dockerOffer";
import { dict, t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

/** React escapes quotes and ampersands in text; the dictionary does not. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function render(): string {
  return renderToStaticMarkup(<WebSearchSettings anchorId="web-search" searxngUrl="" onSave={() => {}} />);
}

/** Everything after the first sentence: the part that says what to do. */
function fix(text: string): string {
  return text.slice(text.indexOf(". ") + 2);
}

describe("the Web search block on an HTML-only instance (card 448)", () => {
  it("says such an instance still answers, and how to switch json on", () => {
    const html = render();
    expect(html).toContain(escaped(t(currentLang(), "set.searxngHtmlOnly")));
  });

  it("gives the same fix as the line in the transcript, in both languages", () => {
    // The settings note speaks about any instance, the transcript line about
    // the one that just refused JSON, so their first sentences differ. The
    // second one is the remedy and must not.
    for (const lang of ["de", "en"] as const) {
      const note = dict["set.searxngHtmlOnly"][lang];
      const line = dict["info.searxngHtmlOnly"][lang];
      expect(fix(note).length).toBeGreaterThan(40);
      expect(fix(note)).toBe(fix(line));
    }
  });

  it("no longer tells the operator that a bare docker run is not enough", () => {
    // Until card 448 a stock container answered web_search with nothing, and
    // this sentence said so. It now answers from its HTML page.
    const cost = dict["set.searxngCost"];
    expect(cost.en).not.toContain("is not enough");
    expect(cost.de).not.toContain("reicht nicht");
    expect(cost.en).toContain("HTML results page");
    expect(cost.en).toContain("json");
  });

  it("writes no dash in the new sentences", () => {
    for (const key of ["set.searxngHtmlOnly", "set.searxngCost"]) {
      for (const text of [dict[key].de, dict[key].en]) {
        expect(text, key).not.toMatch(/[–—]/);
      }
    }
  });
});

describe("the SearXNG offer with Docker ready (card 531)", () => {
  const ready: DockerStatus = { docker: "ready", compose: true, remote: false, detail: "" };

  function offer(lang: "de" | "en"): string {
    return renderToStaticMarkup(<SearxngOfferBlock status={ready} lang={lang} port="8291" />);
  }

  /** The text of every command block, in order. */
  function blocks(html: string): string[] {
    return [...html.matchAll(/<pre class="settings-docker-cmd"><code>([^<]*)<\/code><\/pre>/g)].map(
      (m) => m[1],
    );
  }

  it("shows the fetch and the run as two blocks with the page's port (fix round 2)", () => {
    for (const lang of ["de", "en"] as const) {
      expect(blocks(offer(lang))).toEqual([
        escaped(searxngFetchCommand("8291")),
        escaped(SEARXNG_RUN_COMMAND),
      ]);
    }
  });

  it("gives each block its own copy button, and the read note sits between them (fix round 2)", () => {
    for (const lang of ["de", "en"] as const) {
      const html = offer(lang);
      const label = escaped(t(lang, "set.langfuseCommand"));
      expect(html.split(label).length - 1, lang).toBe(2);
      const pres = [...html.matchAll(/<pre class="settings-docker-cmd">/g)].map((m) => m.index!);
      const read = html.indexOf(escaped(t(lang, "set.searxngRead")));
      expect(read).toBeGreaterThan(pres[0]);
      expect(read).toBeLessThan(pres[1]);
    }
  });

  it("says where the download lands and where to move it (fix round 2)", () => {
    for (const lang of ["de", "en"] as const) {
      const html = offer(lang);
      const note = escaped(t(lang, "set.searxngDownloadMove"));
      expect(html).toContain(note);
      expect(html.indexOf(note)).toBeGreaterThan(html.indexOf("settings-docker-download"));
      expect(dict["set.searxngDownloadMove"][lang]).toContain("~/spectro-searxng");
      expect(dict["set.searxngDownloadMove"][lang]).toContain("install-searxng.sh");
    }
  });

  it("offers the script as a download that leaves for the system browser", () => {
    for (const lang of ["de", "en"] as const) {
      const html = offer(lang);
      const link = html.match(/<a [^>]*class="[^"]*settings-docker-download[^"]*"[^>]*>([^<]*)<\/a>/);
      expect(link, lang).not.toBeNull();
      const tag = link![0];
      expect(tag).toContain(`href="${searxngScriptUrl("8291")}"`);
      expect(tag).toContain('target="_blank"');
      expect(tag).toContain("noopener");
      expect(link![1]).toBe(escaped(t(lang, "set.searxngDownload")));
    }
  });

  it("says under the block how to read the script before it runs (fix round 1)", () => {
    for (const lang of ["de", "en"] as const) {
      const html = offer(lang);
      const note = escaped(t(lang, "set.searxngRead"));
      expect(html).toContain(note);
      expect(html.indexOf(note)).toBeGreaterThan(html.indexOf("settings-docker-cmd"));
    }
    expect(dict["set.searxngRead"].en).toContain("install-searxng.sh");
    expect(dict["set.searxngDockerReady"].en).toContain("spectro-searxng");
    expect(dict["set.searxngDockerReady"].de).toContain("spectro-searxng");
  });

  it("sits beside the copy button, not instead of it", () => {
    const html = offer("en");
    expect(html).toContain(escaped(t("en", "set.langfuseCommand")));
    expect(html.indexOf("settings-docker-download")).toBeGreaterThan(-1);
  });

  it("offers neither command nor download before Docker answers", () => {
    const html = renderToStaticMarkup(<SearxngOfferBlock status={null} lang="en" port="8291" />);
    expect(html).toBe("");
  });

  it("writes no dash in the new sentences", () => {
    for (const key of [
      "set.searxngDownload",
      "set.searxngDockerReady",
      "set.tierScrapeScript",
      "set.searxngRead",
      "set.searxngDownloadMove",
    ]) {
      for (const text of [dict[key].de, dict[key].en]) {
        expect(text, key).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});
