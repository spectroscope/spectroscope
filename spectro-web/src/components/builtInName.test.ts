// The built-in provider has one name, and the first run sheet names the file
// the server really reads.
//
// Card 480, plan task 10. The settings page printed the raw id "spectro-local"
// while the picker printed "built-in". The first run sheet told the reader to
// put the key in a .env next to spectroscope and restart, but the server reads
// ~/.spectro/.env, and a saved key is taken on the next provider switch.
//
// The settings page is read off disk, the house drift idiom, because its
// provider select sits inside a large component with no renderer. The sheet is
// rendered statically, as onboardingLinks.test.tsx does.

import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Onboarding } from "./Onboarding";
import { setLang } from "../state/lang";
import type { Lang } from "../i18n/i18n";
import { read } from "../testkit/source";

const settingsSource = read("./SettingsPanel.tsx", import.meta.url);

/** The provider select's option template, from its opening to its closing `))}`. */
function providerOptions(source: string): string {
  const start = source.indexOf("{PROVIDERS.map((p) => (");
  expect(start, "the settings provider select is not where the test looks").toBeGreaterThan(-1);
  const end = source.indexOf("))}", start);
  expect(end, "the provider select template has no closing ))}").toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The first run sheet, rendered open in one language. */
function sheet(lang: Lang): string {
  setLang(lang);
  return renderToStaticMarkup(
    createElement(Onboarding, {
      open: true,
      onClose: () => {},
      onStartLocal: () => {},
      onOpenSettings: () => {},
    }),
  );
}

/** The cloud option row, the one that tells the reader about the key file. */
function cloudOption(html: string): string {
  const row = html.split("<li").find((chunk) => chunk.includes("ANTHROPIC_API_KEY"));
  expect(row, "the cloud option row is not in the sheet").toBeDefined();
  return row ?? "";
}

// The store is module-global; leave it as the app ships it.
afterEach(() => setLang("en"));

describe("the built-in provider has one name", () => {
  it("is rendered through providerDisplayName on the settings page too", () => {
    expect(providerOptions(settingsSource)).toContain("{providerDisplayName(p)}");
  });
});

describe("the first run sheet names the key file and no restart", () => {
  for (const lang of ["de", "en"] as const) {
    it(`names ~/.spectro/.env and drops the restart, in ${lang}`, () => {
      const row = cloudOption(sheet(lang));
      expect(row, `${lang}: the cloud row must name the real key file`).toContain("~/.spectro/.env");
      expect(
        row,
        `${lang}: the cloud row must not say the key is in a .env next to spectroscope`,
      ).not.toMatch(/neben spectroscope|next to spectroscope/);
      expect(row.toLowerCase(), `${lang}: no restart`).not.toMatch(/restart|starte neu|neustart/);
    });
  }
});
