// Card 455: the whole App, rendered the way surfaces.guard.test.tsx renders it,
// shows the dialog state/firstStart.ts names and no other. The backend sheet
// opens from an effect, which the server renderer does not run, so its turn is
// pinned in firstStart.test.ts; the two questions render straight from state
// and are pinned here.

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LevelingSnapshot } from "./leveling";
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
  App = (await import("../App")).App;
}, 60_000);
afterAll(() => restoreWindow());

function leveling(introSeen: boolean): LevelingSnapshot {
  return {
    mode: introSeen ? "checklist" : "ladder",
    introSeen,
    level: 0,
    levelId: "dark-frame",
    ladder: { schemaVersion: 1, levels: [], criteria: [] },
    marks: {},
    remaining: [],
    history: [],
  };
}

/** The App as markup, from a stored mode (or none) and the mark, with the given leveling state. */
async function renderApp(stored: { mode?: ViewMode; chosen: boolean }, introSeen: boolean): Promise<string> {
  const viewMode = await import("./viewMode");
  const levelingHook = await import("./useLeveling");
  const store = new Map<string, string>();
  if (stored.mode) store.set(viewMode.VIEW_MODE_KEY, stored.mode);
  if (stored.chosen) store.set(viewMode.MODE_CHOSEN_KEY, "1");
  viewMode.__setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
  viewMode.__resetViewModeForTests();
  levelingHook.__setInitialLevelingForTests(leveling(introSeen));
  try {
    return renderToStaticMarkup(<App />);
  } finally {
    levelingHook.__setInitialLevelingForTests(null);
    viewMode.__setViewModeStorage({ get: () => null, set: () => {} });
    viewMode.__resetViewModeForTests();
  }
}

/** Every element with role="tab", as its data-surface. */
function tabs(html: string): string[] {
  return [...html.matchAll(/<[a-z]+\b[^>]*\brole="tab"[^>]*>/g)].map(
    (m) => /\bdata-surface="([^"]+)"/.exec(m[0])?.[1] ?? "(unlisted)",
  );
}

const MODE_SCREEN = 'class="mode-intro"';
const TUTORIAL = 'class="lvl-intro"';

describe("the first start in the rendered App", () => {
  it("a fresh install shows the mode screen and not the tutorial question", async () => {
    const html = await renderApp({ chosen: false }, false);
    expect(html).toContain(MODE_SCREEN);
    expect(html).not.toContain(TUTORIAL);
  });

  it("after learn, the tutorial question shows and the mode screen is gone", async () => {
    const html = await renderApp({ mode: "learn", chosen: true }, false);
    expect(html).toContain(TUTORIAL);
    expect(html).not.toContain(MODE_SCREEN);
  });

  it("after light, neither question shows and the chat is there", async () => {
    const html = await renderApp({ mode: "light", chosen: true }, false);
    expect(html).not.toContain(TUTORIAL);
    expect(html).not.toContain(MODE_SCREEN);
    expect(html).toContain('class="chat-row"');
  });

  it("after developer, neither question shows and the chat is there", async () => {
    const html = await renderApp({ mode: "developer", chosen: true }, false);
    expect(html).not.toContain(TUTORIAL);
    expect(html).not.toContain(MODE_SCREEN);
    expect(html).toContain('class="chat-row"');
    // developer opens the tabs learn opens
    expect(tabs(html)).toContain("lab");
  });

  it("the mode screen offers developer as a third choice", async () => {
    const html = await renderApp({ chosen: false }, false);
    expect(html).toContain('data-mode="developer"');
  });

  it("an existing home that answered the tutorial sees the mode screen, and its mode stays", async () => {
    const html = await renderApp({ mode: "light", chosen: false }, true);
    expect(html).toContain(MODE_SCREEN);
    expect(html).not.toContain(TUTORIAL);
    // Its light mode is still in force behind the screen: the lab tab is gone
    // and the chat is there.
    expect(tabs(html)).not.toContain("lab");
    expect(tabs(html)).toContain("chat");
    expect(html).toContain('class="chat-row"');
  });

  it("the same home after its choice sees no question at all", async () => {
    for (const mode of VIEW_MODES) {
      const html = await renderApp({ mode, chosen: true }, true);
      expect(html, mode).not.toContain(MODE_SCREEN);
      expect(html, mode).not.toContain(TUTORIAL);
      expect(html, mode).toContain('class="chat-row"');
    }
  });

  it("never shows two questions at once", async () => {
    for (const chosen of [false, true]) {
      for (const introSeen of [false, true]) {
        for (const mode of VIEW_MODES) {
          const html = await renderApp({ mode, chosen }, introSeen);
          const questions = [MODE_SCREEN, TUTORIAL].filter((q) => html.includes(q)).length;
          expect(questions, `${mode} chosen=${chosen} introSeen=${introSeen}`).toBeLessThanOrEqual(1);
          // The positive side: before a choice, exactly the mode screen is up.
          if (!chosen) expect(html).toContain(MODE_SCREEN);
        }
      }
    }
  });
});
