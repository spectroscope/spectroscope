// Card 430, criterion 4: App asks the mode at every way into a surface. The
// rules are pure and tested in modeRoute.test.ts and shellCommandRouter.test.ts;
// this file pins the lines in App that call them, because a rule nobody calls
// ships dead. Read off disk with the comments blanked: the suite has no DOM.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));

/** The body of `const name = ...` in App, up to its closing `};` line. */
function fn(name: string): string {
  const at = app.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`App declares no ${name}`);
  return app.slice(at, app.indexOf("\n  };\n", at));
}

/** The body of the one `const follow = ...` in App's route effect. */
function follow(): string {
  const at = app.indexOf("    const follow = (event?: Event): void => {");
  if (at < 0) throw new Error("App declares no follow");
  return app.slice(at, app.indexOf("\n    };\n", at));
}

describe("an address asks the mode before it is applied", () => {
  it("rewrites the parsed hash through routeInMode with the mode at call time", () => {
    const body = follow();
    expect(body).toMatch(/const asked = parseAppRoute\(window\.location\.hash\);/);
    expect(body).toMatch(/const route = routeInMode\(asked, currentViewMode\(\)\);/);
  });

  it("writes the rewritten address by replace before it applies it", () => {
    const body = follow();
    const write = body.indexOf('if (route !== asked) writeRoute(route, "apply");');
    const apply = body.indexOf("void applyRouteRef.current(route);");
    expect(write).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(write);
  });
});

describe("a scenario asks the mode", () => {
  it("lands on the tab scenarioLanding names", () => {
    expect(fn("openScenario")).toContain("setTab(scenarioLanding(currentViewMode()));");
    expect(fn("openScenario")).not.toContain('setTab("lab")');
  });

  it("refuses a fleet scenario before the fleet store is fed", () => {
    const body = fn("openScenario");
    const refuse = body.indexOf("if (!fleetEntryAllowed(currentViewMode())) return;");
    expect(refuse).toBeGreaterThan(-1);
    expect(body.indexOf("fleetLoadScenario(")).toBeGreaterThan(refuse);
  });
});

describe("a fleet and a tab ask the mode", () => {
  it("enterFleet refuses first", () => {
    expect(fn("enterFleet")).toMatch(
      /const enterFleet = \(contextId: string\): void => \{\s*if \(!fleetEntryAllowed\(currentViewMode\(\)\)\) return;/,
    );
  });

  it("changeTab refuses a tab the mode closes first", () => {
    expect(fn("changeTab")).toMatch(
      /const changeTab = \(next: ViewTab\): void => \{\s*if \(!isOpen\(next, currentViewMode\(\)\)\) return;/,
    );
  });

  it("the hand-off to the trace refuses first, before it pins an agent or an event", () => {
    expect(fn("focusInTrace")).toMatch(
      /const focusInTrace = \(agentId: string, event: RunEvent\): void => \{\s*if \(!isOpen\("trace", currentViewMode\(\)\)\) return;/,
    );
  });

  it("hands the shell router the mode", () => {
    const deps = app.slice(
      app.indexOf("shellDeps.current = {"),
      app.indexOf("};", app.indexOf("shellDeps.current = {")),
    );
    expect(deps).toMatch(/\bmode: viewMode,/);
  });
});

describe("the tab on screen asks the mode (criterion 8)", () => {
  it("is the chosen tab through shownTab, and the chosen tab is state nobody else reads", () => {
    expect(app).toContain('const [chosenTab, setTab] = useState<ViewTab>("chat");');
    expect(app).toContain("const tab = shownTab(chosenTab, viewMode);");
    expect(app.split("chosenTab").length - 1).toBe(2);
  });
});
