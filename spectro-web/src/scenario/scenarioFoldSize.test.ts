// Card 431, criterion 6: the scenario path keeps the one-shot fold, and this is
// the measured reason. A chat scenario compiles a DSL that ships in the bundle,
// and the largest one folds far below the size where a one-shot fold becomes a
// long task. The card's evidence measured the one-shot fold of 10,000 events at
// 28 ms in the app's own V8 (Electron 43) and 34 ms in Node 25, both under the
// 50 ms of a long task. A scenario that grows past that size turns this red,
// and then the path wants the sliced fold the session opens use.

import { describe, expect, it } from "vitest";
import { compile } from "./compile";
import { SCENARIOS } from "./registry";

const ONE_SHOT_CEILING = 10_000;

describe("the largest chat scenario stays a short fold", () => {
  const sizes = SCENARIOS.filter((dsl) => dsl.fleet !== true).flatMap((dsl) =>
    (["en", "de"] as const).map((lang) => ({ id: `${dsl.id}/${lang}`, events: compile(dsl, lang).length })),
  );

  it("reads every chat scenario in both languages", () => {
    expect(sizes.length).toBeGreaterThan(10);
    expect(Math.min(...sizes.map((s) => s.events))).toBeGreaterThan(0);
  });

  it(`compiles to fewer than ${ONE_SHOT_CEILING} events`, () => {
    const largest = sizes.reduce((a, b) => (b.events > a.events ? b : a));
    expect(largest.events, largest.id).toBeLessThan(ONE_SHOT_CEILING);
  });
});
