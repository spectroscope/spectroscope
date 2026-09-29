// Cards 458 and 459: there is no single "live session" any more. Every
// session is one row and any number of them can run, so no visible string may
// still offer a way back to "the live one".

import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";

const RETIRED = [/live session/i, /live-session/i, /return to live/i, /zurück zu live/i];

describe("no text names the retired live session", () => {
  it("has no string in either language that names it", () => {
    const hits = Object.entries(dict).flatMap(([key, value]) =>
      (["en", "de"] as const)
        .filter((lang) => RETIRED.some((re) => re.test(value[lang])))
        .map((lang) => `${key}.${lang}: ${value[lang]}`),
    );
    expect(hits).toEqual([]);
  });

  it("still labels the way out of a read-only session", () => {
    expect(t("en", "lab.returnLive")).toBe("Back");
    expect(t("de", "lab.returnLive")).toBe("Zurück");
  });
});
