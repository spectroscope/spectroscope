// t() fills a {name} placeholder with String.prototype.replace and a string
// pattern, which replaces the first occurrence only. A template that names one
// placeholder twice renders the second one as a raw "{name}".
import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";

const PLACEHOLDER = /\{(\w+)\}/g;

const placeholders = (template: string): string[] => [...template.matchAll(PLACEHOLDER)].map((m) => m[1]);

describe("no dictionary entry names one placeholder twice", () => {
  it("the scan finds the placeholders a known entry uses, and t() fills them", () => {
    expect(placeholders(dict["lab.ctx.share"].en)).toEqual(["peak", "limit", "pct"]);
    expect(t("en", "lab.ctx.share", { peak: "1k", limit: "2k", pct: 50 })).toBe("1k of 2k · 50%");
  });

  it("every placeholder appears at most once per language", () => {
    const repeated: string[] = [];
    for (const [key, entry] of Object.entries(dict)) {
      for (const lang of ["de", "en"] as const) {
        const names = placeholders(entry[lang]);
        for (const name of new Set(names)) {
          const n = names.filter((x) => x === name).length;
          if (n > 1) repeated.push(`${key}.${lang} {${name}} x${n}`);
        }
      }
    }
    expect(repeated).toEqual([]);
  });
});
