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
//   7  "takes its browser with it" includes the COOKIES: the Chromium session is
//      emptied and its partition retired, so a resumed id cannot walk back into
//      the login of the run that closed (the review's Finding 1)
//   8  and the second life gets its own request hook, so its fence still names
//      the host and the rule instead of ERR_BLOCKED_BY_CLIENT (Finding 2)
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
  /** What was emptied out of it, in order — the close's own evidence. */
  cleared: string[];
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
    // Cached by partition name, exactly as Electron caches it — which is the
    // fact card 218 first got wrong. A fake that handed out a fresh object per
    // call would have made the lifetime defect invisible here.
    fromPartition: (partition: string): FakeSession => {
      const existing = sessions.get(partition);
      if (existing) return existing;
      const created: FakeSession = { partition, hook: null, cleared: [] };
      Object.defineProperty(created, "webRequest", {
        value: {
          onBeforeRequest: (fn: FakeSession["hook"]) => {
            created.hook = fn;
          },
        },
      });
      Object.defineProperty(created, "clearStorageData", {
        value: async () => {
          created.cleared.push("storage");
        },
      });
      Object.defineProperty(created, "clearCache", {
        value: async () => {
          created.cleared.push("cache");
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

/** Lets every queued microtask and immediate run, so an async hook has settled. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("a browser per session", () => {
  beforeEach(() => {
    // The tear-down goes FIRST, and that order is load-bearing now: forgetPane()
    // retires the panes a previous test left, which reaches the fake Chromium
    // sessions. Resetting afterwards keeps a previous test's clean-up out of this
    // test's books.
    pane.forgetPane();
    reset();
    pane.attachPaneTo(
      () => WINDOW as unknown as Electron.BaseWindow,
      () => {
        segmentCalls += 1;
      },
    );
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
    // the agent driving the other. Since card 241 what puts a pane ON screen
    // is the app's report, so the single-pane rule is proven on that road: the
    // second report takes the first pane off before the second one paints.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);
    await pane.runVerb("viewport",
      { x: 0, y: 0, width: 900, height: 700, visible: true }, OPEN, A);
    assert.equal(pageOf(A).visible.at(-1), true, "A's report put A on screen");

    await pane.runVerb("viewport",
      { x: 0, y: 0, width: 900, height: 700, visible: true }, OPEN, B);
    assert.equal(pageOf(A).visible.at(-1), false, "B's report took A off screen");
    assert.equal(pageOf(B).visible.at(-1), true, "and put B on it");
    assert.equal(addedChildren, 2, "each view joins the window once");
  });

  it("shows the session the viewport report names, not whichever agent ran last", async () => {
    // The browser surfaces post the rectangle they reserved and name the
    // session they belong to. That is what makes "the surface shows the
    // CURRENT session's browser" true. Since card 241 the agent that ran last
    // cannot even reach the screen: only the report road paints.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/b" }, OPEN, B);

    await pane.runVerb("viewport",
      { x: 0, y: 0, width: 900, height: 700, visible: true }, OPEN, A);

    assert.equal(pageOf(A).visible.at(-1), true, "A is the one on screen now");
    assert.ok(!pageOf(B).visible.includes(true),
      "and B, though it drove last, never reached the screen");
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

// What "closed" means, after the review measured that it did not mean it.
//
// The card said four times that closing a session takes its cookies and its
// storage with it. It did not: `closeSession` dropped the record and closed the
// page, and Electron went on holding the Chromium session by partition name for
// the life of the app — so five closed sessions still held five cookie jars, and
// a session resumed under the same id opened onto its old login, HttpOnly cookie
// and all. The same reuse left the request hook closed over the record the close
// had thrown away, so a reopened session's fence went on blocking and stopped
// saying why.
//
// One change answers both, and each half is pinned here because neither half is
// enough alone: EMPTY the Chromium session on close, and give every OPENING its
// own partition.
describe("a closed browser is really given back", () => {
  beforeEach(() => {
    pane.forgetPane();
    reset();
    pane.attachPaneTo(() => WINDOW as unknown as Electron.BaseWindow, () => {});
  });

  it("empties the Chromium session it is giving back: storage and cache", async () => {
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    const used = [...sessions.values()].at(-1);
    assert.ok(used, "the navigate built a Chromium session");
    assert.deepEqual(used.cleared, [], "nothing is emptied while the session is open");

    await pane.runVerb("close_session", {}, OPEN, A);

    assert.deepEqual(used.cleared, ["storage", "cache"],
      "a closed session's cookies, storage and cache stay in the process: "
      + JSON.stringify(used.cleared));
  });

  it("hands a reopened session a partition of its own, so it inherits no jar", async () => {
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    const firstLife = pages.at(-1)?.partition;
    await pane.runVerb("close_session", {}, OPEN, A);

    await pane.runVerb("navigate", { url: "http://localhost:5173/again" }, OPEN, A);
    const secondLife = pages.at(-1)?.partition;

    assert.notEqual(secondLife, firstLife,
      `both lives of ${A} browsed in one Chromium session: ${String(firstLife)}`);
    assert.ok(String(secondLife).startsWith("spectro-browser/"), String(secondLife));
    assert.ok(!String(secondLife).startsWith("persist:"), String(secondLife));
  });

  it("installs a fresh hook for the second life, so its fence still names itself", async () => {
    // The damage this stops is not a hole — the request is still cancelled. It
    // is the model being handed ERR_BLOCKED_BY_CLIENT, the one code card 201
    // built loadFailureSentence to avoid because an ad blocker, a content
    // extension and the net fence are indistinguishable behind it.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("close_session", {}, OPEN, A);
    await pane.runVerb("navigate", { url: "http://localhost:5173/again" }, OPEN, A);

    const live = [...sessions.values()].at(-1);
    const answers: { cancel?: boolean }[] = [];
    live?.hook?.({ url: "http://192.168.1.1/admin", resourceType: "mainFrame" },
      (answer) => answers.push(answer));
    await settle();

    assert.equal(answers[0]?.cancel, true, "the fence refuses on the second life too");
    const said = await pane.runVerb("console", {}, OPEN, A);
    assert.match(String((said.value as { lines: string }).lines),
      /refused since this page loaded/,
      "the refusal was pushed onto the record the close threw away, so the pane the "
      + "model asks knows nothing about it");
    assert.equal(sessions.size, 2,
      "the second life reused the first life's Chromium session: "
      + [...sessions.keys()].join(" "));
  });

  it("never maps two different session ids onto one partition", () => {
    // The comment on partitionFor claimed "the length and the raw id both ride
    // along" as the belt against exactly this; the length rode, the raw id did
    // not, and a collision here is one cookie jar for two sessions — the whole
    // failure mode of this card.
    for (const [one, other] of [["ab/c", "ab:c"], ["a b", "a\tb"], ["../x", ".._x"]]) {
      assert.notEqual(pane.partitionFor(one), pane.partitionFor(other),
        `${JSON.stringify(one)} and ${JSON.stringify(other)} share `
        + pane.partitionFor(one));
    }
  });

  it("is stable: the same session and the same opening name the same partition", () => {
    assert.equal(pane.partitionFor(A, 3), pane.partitionFor(A, 3));
    assert.notEqual(pane.partitionFor(A, 3), pane.partitionFor(A, 4));
  });
});

describe("the agent drives the panel, never the surface (card 241)", () => {
  beforeEach(() => {
    pane.forgetPane();
    reset();
    pane.attachPaneTo(
      () => WINDOW as unknown as Electron.BaseWindow,
      () => {
        segmentCalls += 1;
      },
    );
  });

  it("a driving verb asks for a surface but never paints the pane itself", async () => {
    // The measured crash (card 241, owner's field report): a driving verb used
    // to call setVisible(true) and lay the pane at the LAST reported rectangle
    // before the app had answered — over whatever the operator was looking at.
    // New contract: the verb ASKS (segment request); only the app's own
    // viewport report, which carries a rectangle the app just measured, may
    // put the pane on screen.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);

    assert.ok(!pageOf(A).visible.includes(true),
      "the verb painted nothing: " + JSON.stringify(pageOf(A).visible));
    assert.equal(segmentCalls, 1, "and asked the app to reveal its browser surface");

    await pane.runVerb("viewport",
      { x: 10, y: 20, width: 900, height: 700, visible: true }, OPEN, A);
    assert.equal(pageOf(A).visible.at(-1), true,
      "the app's report is what shows the pane");
  });

  it("a reload of the app window hides every pane until a hole reports again", async () => {
    // The measured wedge (card 241): hidePane() had exactly ONE production
    // caller — a viewport verb with visible:false. A reloaded page that lands
    // anywhere but a browser surface mounts no reporter, so nothing could ever
    // send that verb, and the native page kept painting over the fresh app
    // until the whole program was restarted.
    await pane.runVerb("navigate", { url: "http://localhost:5173/a" }, OPEN, A);
    await pane.runVerb("viewport",
      { x: 10, y: 20, width: 900, height: 700, visible: true }, OPEN, A);
    assert.equal(pageOf(A).visible.at(-1), true, "the pane is on screen");

    const listeners = new Map<string, () => void>();
    pane.wirePaneLifecycle({
      on: (name: string, fn: () => void) => {
        listeners.set(name, fn);
      },
    } as unknown as Electron.WebContents);
    const reload = listeners.get("did-navigate");
    assert.ok(reload, "the app window's real navigations are wired");
    reload();

    assert.equal(pageOf(A).visible.at(-1), false,
      "the fresh page starts with no pane over it");
  });
});
