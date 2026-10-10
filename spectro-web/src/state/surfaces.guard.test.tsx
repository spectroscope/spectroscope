// Card 430, criterion 2: the guard. It renders the whole App in each mode, the
// way main.tsx mounts it, reads every tab and every nav row the markup holds,
// and compares them with what the surface table opens in that mode. The
// expectation is computed from the table, never typed here, so a tab button
// written by hand outside the table turns this red wherever in App it sits.
//
// The suite has no DOM, and App renders on React's server renderer, which runs
// no effect: no socket opens and no fetch is sent. A window stand-in carries
// the few calls that run at import or in a render. The leveling snapshot, which
// the app fetches in an effect, comes in through the hook's test seam.

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LevelingSnapshot } from "./leveling";
import { isOpen, tabsShown } from "./surfaces";
import { VIEW_MODES, type ViewMode } from "./viewMode";

const windowStandIn = Object.assign(new EventTarget(), {
  setTimeout: (task: () => void, ms: number) => setTimeout(task, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id),
  location: { hash: "" },
  history: { state: null, length: 1 },
});

let restoreWindow: () => void = () => {};
let App: () => ReactNode = () => null;
beforeAll(async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: windowStandIn, configurable: true, writable: true });
  restoreWindow = () => {
    if (had) Object.defineProperty(globalThis, "window", had);
    else delete (globalThis as { window?: unknown }).window;
  };
  // The whole app's module graph loads once, here, and not inside a test's time.
  App = (await import("../App")).App;
}, 60_000);
afterAll(() => restoreWindow());

/** A leveling snapshot in the given mode, at level 0, every surface named nowhere. */
function levelingIn(mode: LevelingSnapshot["mode"]): LevelingSnapshot {
  return {
    mode,
    introSeen: true,
    level: 0,
    levelId: "dark-frame",
    ladder: { schemaVersion: 1, levels: [], criteria: [] },
    marks: {},
    remaining: [],
    history: [],
  };
}

/** The whole App as markup, in one mode, with the tutorial on or off. */
async function renderApp(mode: ViewMode, tutorial: boolean): Promise<string> {
  const viewMode = await import("./viewMode");
  const leveling = await import("./useLeveling");
  const store = new Map<string, string>();
  viewMode.__setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
  viewMode.__resetViewModeForTests();
  viewMode.setViewMode(mode);
  leveling.__setInitialLevelingForTests(tutorial ? levelingIn("checklist") : levelingIn("off"));
  try {
    return renderToStaticMarkup(<App />);
  } finally {
    leveling.__setInitialLevelingForTests(null);
    viewMode.setViewMode("learn");
  }
}

/** Every element with the given role, as the value of its data-surface, or "(unlisted)". */
function surfacesWithRole(html: string, role: string): string[] {
  return [...html.matchAll(new RegExp(`<[a-z]+\\b[^>]*\\brole="${role}"[^>]*>`, "g"))].map(
    (m) => /\bdata-surface="([^"]+)"/.exec(m[0])?.[1] ?? "(unlisted)",
  );
}

/** Every nav row in the rail's head, the two groups above the list, as its data-surface. */
function navRowsInHead(html: string): string[] {
  const head = html.slice(html.indexOf('class="sidebar-head"'), html.indexOf('class="sidebar-list"'));
  return [...head.matchAll(/<button\b[^>]*\bclass="nav-row[^"]*"[^>]*>/g)].map(
    (m) => /\bdata-surface="([^"]+)"/.exec(m[0])?.[1] ?? "(unlisted)",
  );
}

const SEGMENTS = ["sessions", "fleets", "stategraph", "playbook"] as const;
const ACTIONS = ["newChat", "scenarios", "starters", "skills"] as const;

describe("the rendered tabs and nav rows are the table's (criterion 2)", () => {
  for (const mode of VIEW_MODES) {
    for (const tutorial of [false, true]) {
      it(`${mode}, tutorial ${tutorial ? "on" : "off"}: every tab on screen is one the table opens`, async () => {
        const html = await renderApp(mode, tutorial);
        const segments = SEGMENTS.filter((id) => isOpen(id, mode, tutorial));
        const tabs = tabsShown(mode, tutorial);
        // The rail's segment rows come first in the markup, then the tab row.
        expect(surfacesWithRole(html, "tab")).toEqual([...segments, ...tabs]);
        // A positive promise beside the negative one: learn and developer draw all six.
        if (mode !== "light") expect(tabs).toHaveLength(6);
      });

      it(`${mode}, tutorial ${tutorial ? "on" : "off"}: every nav row in the rail's head is one the table opens`, async () => {
        const html = await renderApp(mode, tutorial);
        const actions = ACTIONS.filter((id) => isOpen(id, mode, tutorial));
        const segments = SEGMENTS.filter((id) => isOpen(id, mode, tutorial));
        expect(navRowsInHead(html)).toEqual([...actions, ...segments]);
        expect(actions).toContain("skills");
      });
    }
  }

  it("draws the tab row in light only while the tutorial is on, and the level pill with it", async () => {
    const off = await renderApp("light", false);
    expect(off).not.toContain('class="tab-nav"');
    expect(off).not.toContain("lvl-pill");
    const on = await renderApp("light", true);
    expect(on).toContain('class="tab-nav"');
    expect(on).toContain("lvl-pill");
    const learn = await renderApp("learn", false);
    expect(learn).toContain('class="tab-nav"');
    // Developer keeps the tab row with the tutorial off, and the level pill only with it on.
    const developerOff = await renderApp("developer", false);
    expect(developerOff).toContain('class="tab-nav"');
    expect(developerOff).not.toContain("lvl-pill");
    const developerOn = await renderApp("developer", true);
    expect(developerOn).toContain("lvl-pill");
  });

  it("draws the mode switch in every mode (criterion 3)", async () => {
    for (const mode of VIEW_MODES) {
      for (const tutorial of [false, true]) {
        const html = await renderApp(mode, tutorial);
        expect(html.match(/class="mode-switch" role="radiogroup"/g), `${mode} ${tutorial}`).toHaveLength(1);
      }
    }
  });

  it("draws the playbook segment in developer and in no other mode (card 481)", async () => {
    // The rail's rows only: the first start picture carries a data-surface for
    // every table entry in every mode.
    for (const tutorial of [false, true]) {
      expect(navRowsInHead(await renderApp("developer", tutorial)), `developer ${tutorial}`).toContain(
        "playbook",
      );
      for (const mode of VIEW_MODES.filter((m) => m !== "developer")) {
        expect(navRowsInHead(await renderApp(mode, tutorial)), `${mode} ${tutorial}`).not.toContain(
          "playbook",
        );
      }
    }
  });

  it("shows the chat in light, with the tab row gone", async () => {
    const html = await renderApp("light", false);
    expect(html).toContain('class="chat-row"');
  });
});
