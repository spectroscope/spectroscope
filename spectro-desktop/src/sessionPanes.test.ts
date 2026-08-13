// A browser per session (card 218), tested without a window.
//
// Card 201 shipped ONE pane for the whole program: browserPane.ts kept the view,
// its visibility, its console buffer and its refusal log in module variables, and
// its Chromium session was one fixed partition. Two sessions driving a browser
// therefore drove the SAME browser — the second one's navigate took the first
// one's page away, and both agents shared one cookie jar.
//
// What this file pins is the fix, in the owner's own terms:
//
//   1  a browser is keyed by SESSION, created on first use, and each one gets
//      its OWN Chromium session — a separate partition is the isolation, and
//      cookies, localStorage and cache all hang off it
//   2  the pages survive each other: session A's page is still loaded and still
//      where it was after B took the screen and gave it back
//   3  exactly one pane is on screen — a native overlay that stacks is the one
//      failure a div could never make
//   4  the viewport report names its session, so opening the browser surface
//      shows THAT session's browser rather than whichever agent ran last
//   5  closing a session takes its browser with it and leaves its neighbour alone
//   6  a verb the shell cannot key to a session is refused, saying so
//
// The module is loaded with a FAKE electron in the require cache, the way
// browserPane.test.ts does it: the real file runs, the real state machine runs,
// and only Chromium is imaginary.

import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

/** One fake Chromium session, so a partition is a thing the test can hold. */
interface FakeSession {
  partition: string;
  hook: ((details: { url: string; resourceType: string; referrer?: string },
    callback: (response: { cancel?: boolean }) => void) => void) | null;
}

/** One fake page, so "did A reload" is a question the test can ask. */
interface FakePage {
  partition: string;
  loaded: string[];
  url: string;
  visible: boolean[];
  closed: boolean;
  consoleSink: ((event: { level: string; message: string }) => void) | null;
}

const sessions = new Map<string, FakeSession>();
const pages: FakePage[] = [];
let removedChildren = 0;
let addedChildren = 0;
let segmentCalls = 0;

function reset(): void {
  sessions.clear();
  pages.length = 0;
  removedChildren = 0;
  addedChildren = 0;
  segmentCalls = 0;
}

function fakeWebContents(page: FakePage): Record<string, unknown> {
  return {
    isDestroyed: () => page.closed,
    getURL: () => page.url,
    getTitle: () => "fixture",
    on: (name: string, fn: (event: { level: string; message: string }) => void) => {
      if (name === "console-message") page.consoleSink = fn;
    },
    setWindowOpenHandler: () => {},
    setUserAgent: () => {},
    getUserAgent: () => "Mozilla/5.0 (Macintosh)",
    close: () => {
      page.closed = true;
    },
    loadURL: async (url: string) => {
      page.loaded.push(url);
      page.url = url;
    },
    executeJavaScript: async () => null,
    capturePage: async () => ({
      getSize: () => ({ width: 800, height: 600 }),
      toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }),
    sendInputEvent: () => {},
    insertText: () => {},
    debugger: { isAttached: () => false, attach: () => {}, sendCommand: async () => {} },
  };
}

const fakeElectron = {
  BaseWindow: class {},
  BrowserWindow: class {},
  WebContentsView: class {
    webContents: Record<string, unknown>;
    page: FakePage;
    constructor(options: { webPreferences?: { session?: FakeSession } }) {
      this.page = {
        partition: options.webPreferences?.session?.partition ?? "(none)",
        loaded: [],
        url: "about:blank",
        visible: [],
        closed: false,
        consoleSink: null,
      };
      pages.push(this.page);
      this.webContents = fakeWebContents(this.page);
    }
    setBounds(): void {}
    setVisible(on: boolean): void {
      this.page.visible.push(on);
    }
  },
  session: {
    fromPartition: (partition: string): FakeSession => {
      const existing = sessions.get(partition);
      if (existing) return existing;
      const created: FakeSession = { partition, hook: null };
      Object.defineProperty(created, "webRequest", {
        value: {
          onBeforeRequest: (fn: FakeSession["hook"]) => {
            created.hook = fn;
          },
        },
      });
      sessions.set(partition, created);
      return created;
    },
  },
};

// The stub goes in BEFORE the module under test is required, which is why this
// file uses require() rather than an import that would hoist above it.
const electronEntry = require.resolve("electron");
require.cache[electronEntry] = {
  id: electronEntry,
  filename: electronEntry,
  loaded: true,
  exports: fakeElectron,
} as unknown as NodeModule;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pane = require("./browserPane") as typeof import("./browserPane");

const WINDOW = {
  isDestroyed: () => false,
  getContentBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
  contentView: {
    addChildView: () => {
      addedChildren += 1;
    },
    removeChildView: () => {
      removedChildren += 1;
    },
  },
};

const OPEN = { allowLocalhost: true, adblock: false };

const A = "20260813-120000-aaaaaaaa";
const B = "20260813-130000-bbbbbbbb";

/** The page a session's browser is holding, by the order the views were made. */
function pageOf(session: string): FakePage {
  const url = pane.paneUrl(session);
  const found = pages.find((p) => p.url === url && !p.closed);
  assert.ok(found, `session ${session} has no page (url ${String(url)})`);
  return found;
}

describe("a browser per session", () => {
  beforeEach(() => {
    reset();
    pane.attachPaneTo(
      () => WINDOW as unknown as Electron.BaseWindow,
      () => {
        segmentCalls += 1;
      },
    );
    pane.forgetPane();
  });

  it("gives every session its own view and its own Chromium partition", async () => {
    // The isolation IS the partition: a Chromium session owns the cookie jar,
    // localStorage, IndexedDB and the cache, and two partitions share none of
    // them. Card 201 had one fixed partition for the whole program, so a page
    // one agent logged into was a page every other agent was logged into.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);

    assert.equal(pages.length, 2, "two sessions, two views");
    assert.notEqual(pages[0].partition, pages[1].partition,
      "and two Chromium partitions: " + pages.map((p) => p.partition).join(" "));
    assert.ok(pages[0].partition.includes("spectro-browser"),
      "the partition names the product: " + pages[0].partition);
    assert.equal(sessions.size, 2, "each partition is a session of its own");
  });

  it("keeps the neighbour's page loaded while the other one takes the screen", async () => {
    // The owner's lifetime rule: "switching to another session and back finds
    // the page still there, still logged in, still where it was scrolled."
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    const first = pageOf(A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);

    assert.equal(pane.paneUrl(A), "http://localhost:5173/a", "A still holds its own page");
    assert.equal(pane.paneUrl(B), "http://localhost:5173/b");
    assert.equal(first.loaded.length, 1, "and it was not reloaded to get it back");
  });

  it("never leaves two panes on screen at once", async () => {
    // The one failure a native overlay makes that a div never could: two views
    // stacked over the same rectangle, the operator watching the top one and
    // the agent driving the other.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);

    assert.equal(pageOf(A).visible.at(-1), false, "A's pane came off screen");
    assert.equal(pageOf(B).visible.at(-1), true, "B's pane went on it");
    assert.equal(addedChildren, 2, "each view joins the window once");
  });

  it("shows the session the viewport report names, not whichever agent ran last", async () => {
    // The rail segment and the session's own browser tab both post the
    // rectangle they reserved, and both name the session they belong to. That
    // is what makes "the rail shows the CURRENT session's browser" true.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);

    await pane.runVerb("viewport",
      { x: 0, y: 0, width: 900, height: 700, visible: true }, OPEN, A);

    assert.equal(pageOf(A).visible.at(-1), true, "A is the one on screen now");
    assert.equal(pageOf(B).visible.at(-1), false, "and B is not");
  });

  it("closes a session's browser and leaves its neighbour untouched", async () => {
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);
    const closing = pageOf(A);

    await pane.runVerb("close_session", {}, OPEN, A);

    assert.equal(closing.closed, true, "A's page is gone");
    assert.equal(removedChildren, 1, "and its view left the window");
    assert.equal(pane.paneUrl(A), null, "A has no browser any more");
    assert.equal(pane.paneUrl(B), "http://localhost:5173/b", "B never noticed");

    // The record goes with the view, not only the view. A record that survived
    // would still claim inWindow, so the next browser for this id would be built
    // and then never added to the window — a page that runs and cannot be seen.
    const before = addedChildren;
    await pane.runVerb("navigate", { url: "http://localhost:5173/again" }, OPEN, A);
    assert.equal(addedChildren, before + 1, "a browser opened again joins the window again");
  });

  it("keeps each session's console to itself", async () => {
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);
    pageOf(A).consoleSink?.({ level: "error", message: "only A is broken" });

    const mine = await pane.runVerb("console", {}, OPEN, A);
    const theirs = await pane.runVerb("console", {}, OPEN, B);

    assert.match(String((mine.value as { lines: string }).lines), /only A is broken/);
    assert.equal((theirs.value as { lines: string }).lines, "",
      "B's console never saw A's page");
  });

  it("refuses a verb it cannot key to a session, and says so", async () => {
    // A browser per session means the shell must know whose browser it is
    // driving. Serving "the" browser to a caller that named none is exactly the
    // silent substitution card 201 refused for tab_id.
    const reply = await pane.runVerb("navigate", { url: "http://localhost:5173/" }, OPEN, null);

    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /session/i, reply.error ?? "");
  });

  it("forgets every session's browser when the window that carried them closes", async () => {
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);

    pane.forgetPane();

    assert.equal(pane.paneUrl(A), null);
    assert.equal(pane.paneUrl(B), null);
  });
});
