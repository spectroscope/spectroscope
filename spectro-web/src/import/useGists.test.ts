// Card 179 stage 3: which rows a press would actually pay for.

import { describe, expect, it } from "vitest";
import { missingGists, type GistRow } from "./useGists";

const g = (path: string, stale = false): GistRow => ({ path, text: "a line", model: "m", stale });

describe("missingGists", () => {
  it("names the rows with no line yet", () => {
    const have = new Map([["a", g("a")]]);
    expect(missingGists(["a", "b", "c"], have)).toEqual(["b", "c"]);
  });

  it("counts a stale one as missing, because the file has changed under it", () => {
    // A live session grows constantly, and those are the rows an operator looks
    // at most. Yesterday's sentence describes a shorter run.
    const have = new Map([["a", g("a", true)]]);
    expect(missingGists(["a"], have)).toEqual(["a"]);
  });

  it("is empty when everything shown is current, so the button goes dark", () => {
    const have = new Map([
      ["a", g("a")],
      ["b", g("b")],
    ]);
    expect(missingGists(["a", "b"], have)).toEqual([]);
  });

  it("asks about nothing when nothing is shown", () => {
    expect(missingGists([], new Map([["a", g("a")]]))).toEqual([]);
  });

  it("ignores stored lines for rows that are not on screen", () => {
    // The buttons act on the FILTERED view: pressing with 300 rows showing and
    // pressing with 6 are different prices, and only what is shown is asked.
    const have = new Map([["elsewhere", g("elsewhere")]]);
    expect(missingGists(["a"], have)).toEqual(["a"]);
  });
});
