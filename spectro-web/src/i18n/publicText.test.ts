// Card 413: the dictionary is the text a reader sees, and the reader has the
// public repository, not the private product home. A path into that home or a
// number off its board points at something no reader can open.
//
// The entries are read off the dictionary itself, so a new entry is checked
// the day it is added.

import { describe, expect, it } from "vitest";
import { dict } from "./i18n";

const PRIVATE: ReadonlyArray<readonly [string, RegExp]> = [
  ["a path into the private board", /kanban\//i],
  ["an evidence folder", /evidence\//i],
  ["a card by number", /\b(cards?|karten?)[\s-]+#?\d/i],
];

describe("no dictionary entry points into the private product home", () => {
  it("reads the dictionary the app renders", () => {
    expect(Object.keys(dict).length).toBeGreaterThan(100);
    expect(dict["set.gnCopy"].en).toBe("Copy prompt");
  });

  it("names no kanban/ path, no evidence/ folder and no card number, in either language", () => {
    const offenders: string[] = [];
    for (const [key, entry] of Object.entries(dict)) {
      for (const lang of ["de", "en"] as const) {
        for (const [what, pattern] of PRIVATE) {
          if (pattern.test(entry[lang])) offenders.push(`${key}.${lang}: ${what}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
