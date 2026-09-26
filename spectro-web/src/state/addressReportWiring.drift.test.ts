// Card 433: the two App-level halves of the deep link fix.
//
// appRouter.test.ts pins createAddressReporter and history.test.ts pins
// stampBootEntry, each by behaviour. Both suites stay green if App stops
// seeding the reporter from the place it mounted on, builds a new reporter on
// every render, or stops stamping the boot entry. The branch's first bites
// measured that: a reporter per render and a dropped stamp call were caught
// only by Playwright scripts outside this repo.
//
// This gate has no DOM and App is not a component a suite mounts, so the
// wiring is read off disk, the way components/openingWiring.drift.test.ts
// reads it for card 431. It pins that the wiring is written, not that it runs.
// Comments are blanked first, so the prose in App cannot satisfy a match.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));

const REPORTER = "const [addressReporter] = useState(() => createAddressReporter(placeRef.current));";

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** The boot effect: the useEffect that declares `follow`, up to its `}, []);`. */
function bootEffect(): string {
  const follow = app.indexOf("    const follow = (event?: Event): void => {");
  if (follow < 0) throw new Error("App declares no follow");
  const start = app.lastIndexOf("useEffect(() => {", follow);
  const end = app.indexOf("\n  }, []);", follow);
  if (start < 0 || end < 0) throw new Error("follow sits in no mount effect");
  return app.slice(start, end);
}

/** The effect body after `follow` is declared: what the mount does with it. */
function bootTail(): string {
  const effect = bootEffect();
  const declared = effect.indexOf("    const follow = ");
  const closed = effect.indexOf("\n    };\n", declared);
  if (closed < 0) throw new Error("follow is never closed");
  return effect.slice(closed + "\n    };\n".length);
}

describe("App keeps one address reporter per mount (card 433)", () => {
  it("builds it in a useState initializer from placeRef, and nowhere else", () => {
    expect(app).toContain(REPORTER);
    expect(count(app, "createAddressReporter(")).toBe(1);
  });

  it("builds it after the render has written its place into placeRef", () => {
    const written = app.indexOf("  placeRef.current = {");
    expect(written).toBeGreaterThan(-1);
    expect(app.indexOf(REPORTER)).toBeGreaterThan(written);
  });

  it("reports placeRef after every render and commits a returned route as a gesture", () => {
    const tail = app.slice(app.indexOf(REPORTER) + REPORTER.length);
    expect(tail).toMatch(
      /^\s*useEffect\(\(\) => \{\s*const route = addressReporter\.report\(placeRef\.current\);\s*if \(route !== null\) commitUrl\(route, "gesture"\);\s*\}\);/,
    );
  });
});

describe("App stamps the entry it boots on (card 433)", () => {
  it("calls stampBootEntry once, in the boot effect", () => {
    expect(count(app, "stampBootEntry(")).toBe(1);
    expect(bootTail()).toContain("stampBootEntry();");
  });

  it("stamps before the first follow and before the listeners", () => {
    const tail = bootTail();
    const stamp = tail.indexOf("stampBootEntry();");
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(tail.indexOf("follow();"));
    expect(stamp).toBeLessThan(tail.indexOf('window.addEventListener("hashchange", follow);'));
  });
});
