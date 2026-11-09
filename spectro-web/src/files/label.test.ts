// Card 604: the row labels of the files timeline. The live check of 2026-11-09
// found 24 of 30 labels without their file name: the code kept the last 34
// characters, the column showed about 25, and CSS cut the end again. A label
// now keeps the file name and gives way in the folders before it, and the
// column is sized in characters of the label font, so CSS never cuts.

import { describe, expect, it } from "vitest";
import { read, rules } from "../testkit/source";
import { fitLabel, LABEL_CHARS, LABEL_CHARS_NARROW } from "./label";

describe("fitLabel", () => {
  it("keepsTheFileNameAndShortensTheFolders", () => {
    const deep = "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java";
    expect(fitLabel(deep, 32)).toBe("…/session/SessionConnection.java");
    const outside = "/Users/someone/.claude/projects/-Users-someone-Spectroscope/memory/audit-2026-09-21.md";
    expect(fitLabel(outside, 32)).toBe("…/memory/audit-2026-09-21.md");
    expect(fitLabel("kanban/evidence/audit-2026-09-21/", 32)).toBe("…/evidence/audit-2026-09-21/");
    // A short label stays as it is.
    expect(fitLabel("src/a.ts", 32)).toBe("src/a.ts");
    expect(fitLabel("src/a.ts", 8)).toBe("src/a.ts");
  });

  it("aFileNameLongerThanTheColumnIsCutInTheMiddleAndKeepsItsExtension", () => {
    const long = "kanban/461-dead-hub-node-test-takes-twenty-seconds-on-every-single-run.md";
    expect(fitLabel(long, 32)).toBe("461-dead-hub-n…ery-single-run.md");
    expect(fitLabel("spectro-server/src/SessionConnection.java", 18)).toBe("Sessio…ection.java");
    expect(fitLabel("a-very-long-file-name-without-any-extension-at-all", 18)).toBe("a-very-lo…n-at-all");
    // A name that fits alone keeps all of it, even without room for the folder marker.
    expect(fitLabel("docs/ParkingLot.java", 16)).toBe("ParkingLot.java");
  });

  it("neverReturnsMoreCharactersThanAsked", () => {
    const labels = [
      "spectro-server/src/main/java/dev/spectroscope/server/session/SessionConnection.java",
      "/Users/someone/.claude/projects/-Users-someone-Spectroscope/memory/audit-2026-09-21.md",
      "kanban/461-dead-hub-node-test-takes-twenty-seconds-on-every-single-run.md",
      "spectro-web/src/**/*.test.tsx",
      "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z.md",
      "x".repeat(80),
      ".x".repeat(40),
    ];
    for (const label of labels) {
      for (const max of [LABEL_CHARS_NARROW, LABEL_CHARS, 12, 6]) {
        expect(fitLabel(label, max).length, `${label} at ${max}`).toBeLessThanOrEqual(max);
      }
    }
  });

  it("theLabelColumnIsSizedInCharactersAndCssNeverCutsALabel", () => {
    const css = rules("files.css", read("./files.css", import.meta.url));
    const label = css.filter((r) => r.selector === ".files-tl__label");
    expect(label).toHaveLength(1);
    expect(label[0].body).not.toMatch(/text-overflow/);
    // The base rule and the narrow rule, in that order, each as wide as its budget.
    const column = css.filter((r) => r.selector === ".files-tl__labels").map((r) => r.body);
    expect(column).toHaveLength(2);
    expect(column[0]).toMatch(new RegExp(`width:\\s*calc\\(${LABEL_CHARS}ch \\+`));
    expect(column[1]).toMatch(new RegExp(`width:\\s*calc\\(${LABEL_CHARS_NARROW}ch \\+`));
    // `ch` is measured in the column's own font, the monospace font the labels use.
    expect(column[0]).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(column[0]).toMatch(/font-size:\s*var\(--fs-11\)/);
  });
});
