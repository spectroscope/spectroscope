// The pane's own behaviour, tested without a window.
//
// browserPane.ts is the one module in this shell that talks to Electron, and it
// was therefore the one module with no test at all — which is exactly where the
// review of 2026-08-13 found three defects that a type could never have caught.
// So the module is loaded with a FAKE electron in the require cache: the real
// file runs, the real state machine runs, and only the window is imaginary.
//
// What this pins, in the reviewer's own terms:
//
//   1  after the operator leaves the Browser segment, the next tool call asks
//      the app to switch BACK. Before the fix the module flag survived hidePane()
//      and nav.browser was sent once per process, ever — so the native pane
//      painted over the session list while the rail stayed on Sessions.
//   2  a load the net fence stopped reports the FENCE's sentence, not Chromium's
//      ERR_BLOCKED_BY_CLIENT, which is indistinguishable from an ad blocker.
//   3  Electron's own security warning is the shell talking, not the page, so it
//      is kept out of browser_read_console and COUNTED rather than dropped in
//      silence.
//   4  browser_resize really emulates: device metrics, touch and a user agent,
//      and the reply carries what the page MEASURED rather than what was asked.

import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";

/** Everything the fake window and the fake page recorded this test. */
interface Recorder {
  segmentCalls: number;
  addedChildren: number;
  setVisible: boolean[];
  bounds: { x: number; y: number; width: number; height: number }[];
  loaded: string[];
  evals: string[];
  emulation: unknown[];
  userAgents: string[];
  cdp: [string, unknown][];
  currentUrl: string;
  loadFails: string | null;
  /** What the page's own traffic does while loadURL is in flight. */
  duringLoad: (() => Promise<void>) | null;
  evalResult: unknown;
  hook: ((details: { url: string; resourceType: string; referrer?: string },
    callback: (response: { cancel?: boolean }) => void) => void) | null;
  consoleSink: ((event: { level: string; message: string }) => void) | null;
}

const rec: Recorder = freshRecorder();

function freshRecorder(): Recorder {
  return {
    segmentCalls: 0,
    addedChildren: 0,
    setVisible: [],
    bounds: [],
    loaded: [],
    evals: [],
    emulation: [],
    userAgents: [],
    cdp: [],
    currentUrl: "about:blank",
    loadFails: null,
    duringLoad: null,
    evalResult: null,
    hook: null,
    consoleSink: null,
  };
}

function reset(): void {
  Object.assign(rec, freshRecorder());
}

function fakeWebContents(): Record<string, unknown> {
  let attached = false;
  return {
    isDestroyed: () => false,
    getURL: () => rec.currentUrl,
    getTitle: () => "fixture",
    on: (name: string, fn: (event: { level: string; message: string }) => void) => {
      if (name === "console-message") rec.consoleSink = fn;
    },
    setWindowOpenHandler: () => {},
    setUserAgent: (ua: string) => rec.userAgents.push(ua),
    getUserAgent: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      + "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    setZoomFactor: () => {},
    setVisualZoomLevelLimits: async () => {},
    enableDeviceEmulation: (parameters: unknown) => rec.emulation.push(parameters),
    disableDeviceEmulation: () => rec.emulation.push(null),
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand: async (method: string, params: unknown) => {
        rec.cdp.push([method, params]);
      },
    },
    loadURL: async (url: string) => {
      rec.loaded.push(url);
      if (rec.duringLoad) await rec.duringLoad();
      if (rec.loadFails) throw new Error(rec.loadFails);
      rec.currentUrl = url;
    },
    executeJavaScript: async (code: string) => {
      rec.evals.push(code);
      return rec.evalResult;
    },
    capturePage: async () => ({
      getSize: () => ({ width: 800, height: 600 }),
      toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }),
    sendInputEvent: () => {},
    insertText: () => {},
  };
}

const fakeElectron = {
  BaseWindow: class {},
  BrowserWindow: class {},
  WebContentsView: class {
    webContents = fakeWebContents();
    setBounds(rect: { x: number; y: number; width: number; height: number }): void {
      rec.bounds.push(rect);
    }
    setVisible(on: boolean): void {
      rec.setVisible.push(on);
    }
  },
  session: {
    fromPartition: () => ({
      webRequest: {
        onBeforeRequest: (fn: Recorder["hook"]) => {
          rec.hook = fn;
        },
      },
      // What a closed session's browser gives back. sessionPanes.test.ts is
      // where that is measured; here they only have to exist, because
      // forgetPane() retires whatever a test left open.
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
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
      rec.addedChildren += 1;
    },
  },
};

const OPEN = { allowLocalhost: true, adblock: false };

/** Lets every queued microtask and immediate run, so an async hook has settled. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const SESSION = "20260813-090000-fixture0";

/** Points the pane at a page, the way every other verb needs it to be. */
async function navigate(url = "http://localhost:5173/"): Promise<void> {
  await pane.runVerb("navigate", { url }, OPEN, SESSION);
}

describe("browserPane", () => {
  beforeEach(() => {
    reset();
    pane.attachPaneTo(
      () => WINDOW as unknown as Electron.BaseWindow,
      () => {
        rec.segmentCalls += 1;
      },
    );
    pane.forgetPane();
  });

  it("asks the app to show the browser segment AGAIN after the operator left it", async () => {
    // The card's own scenario: "the owner has watched the same page the agent
    // drove". Measured on 2026-08-13: click Browser, navigate, segment shown;
    // click Sessions, navigate again, and the native pane painted over the
    // session list while the rail stayed highlighted on Sessions. The operator
    // was not watching the page the agent drove and had lost the view he chose.
    await navigate();
    assert.equal(rec.segmentCalls, 1, "the first tool call switches the app to the pane");

    pane.hidePane();
    await navigate("http://localhost:5173/second");

    assert.equal(rec.segmentCalls, 2, "and so does the first tool call after leaving it");
    assert.equal(rec.addedChildren, 1, "the view joins the window once, not once per show");
  });

  it("hides on a viewport report with visible:false and comes back on the next call", async () => {
    await navigate();
    await pane.runVerb("viewport", { x: 0, y: 0, width: 900, height: 700, visible: false }, OPEN, SESSION);
    assert.equal(rec.setVisible.at(-1), false, "leaving the segment takes the pane off screen");

    await navigate("http://localhost:5173/third");
    assert.equal(rec.segmentCalls, 2, "the pane asks for its segment back rather than covering another");
    assert.equal(rec.setVisible.at(-1), true);
  });

  it("reports the FENCE's own sentence when the fence stopped the load", async () => {
    // ERR_BLOCKED_BY_CLIENT is what an ad blocker, a content extension and the
    // net fence all look like to a model. The refusal the hook just recorded
    // says which one it was, and it was already in hand.
    await navigate();
    assert.ok(rec.hook, "the pane installs a request hook");

    // The 302 hop the reviewer drove: loopback is opted in, the server answers
    // a redirect to a private address, and only the hook sees the second leg.
    rec.duringLoad = async () => {
      const seen: { cancel?: boolean }[] = [];
      rec.hook?.(
        { url: "http://192.168.1.1/secret", resourceType: "mainFrame" },
        (r) => seen.push(r),
      );
      await settle();
      assert.equal(seen[0]?.cancel, true, "the hop is cancelled");
    };
    rec.loadFails = "ERR_BLOCKED_BY_CLIENT (-20) loading 'http://localhost:5173/hop'";

    const reply = await pane.runVerb("navigate", { url: "http://localhost:5173/hop" }, OPEN, SESSION);
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /192\.168\.1\.1/, reply.error ?? "");
    assert.match(String(reply.error), /rfc1918/, reply.error ?? "");
  });

  it("puts a name-based hop through the hook's own resolver, not only literals", async () => {
    // The wiring, which neither browserFence.test.ts nor the guard covers: the
    // pane's request hook must actually be the async, resolving one. With the
    // opt-in OFF a 302 to a public name resolving to loopback used to load and
    // title itself PWNED.
    pane.useHostLookup(async (host) =>
      host === "localtest.example" ? ["127.0.0.1"] : ["93.184.216.34"]);
    await navigate();
    // The policy the hook judges by is the one the last command carried.
    await pane.runVerb("status", {}, { allowLocalhost: false, adblock: false }, SESSION);
    const seen: { cancel?: boolean }[] = [];
    rec.hook?.(
      { url: "http://localtest.example:8875/secret", resourceType: "mainFrame" },
      (r) => seen.push(r),
    );
    await settle();
    assert.equal(seen[0]?.cancel, true, "a name that resolves to loopback is refused");

    const allowed: { cancel?: boolean }[] = [];
    rec.hook?.(
      { url: "http://cdn.example.com/lib.js", resourceType: "script" },
      (r) => allowed.push(r),
    );
    await settle();
    assert.equal(allowed[0]?.cancel, undefined, "and a public one is not");
  });

  it("passes an ordinary load failure through unchanged", async () => {
    rec.loadFails = "ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:5173/'";
    const reply = await pane.runVerb("navigate", { url: "http://localhost:5173/" }, OPEN, SESSION);
    assert.equal(reply.ok, false);
    assert.match(String(reply.error), /ERR_CONNECTION_REFUSED/);
  });

  it("keeps Electron's own security warning out of the page's console and counts it", async () => {
    await navigate();
    rec.consoleSink?.({ level: "warning", message: "Electron Security Warning (Insecure "
      + "Content-Security-Policy) This renderer process has Node.js integration…" });
    rec.consoleSink?.({ level: "error", message: "TypeError: the app is broken" });

    const reply = await pane.runVerb("console", {}, OPEN, SESSION);
    const lines = String((reply.value as { lines: string }).lines);
    assert.match(lines, /TypeError: the app is broken/);
    assert.ok(!lines.includes("Insecure Content-Security-Policy"), lines);
    assert.match(lines, /1 .*(shell|Electron)/i, "the drop is counted, not silent: " + lines);
  });

  it("filters the warning the SHIPPED Electron really writes, %c and all", async () => {
    // The line above is not the string Electron 43 emits. It writes
    // console.warn("%cElectron Security Warning (…)%c\n…", "font-weight: bold;",
    // ""), so the message reaches the handler with the format directive on the
    // front and the ^\s* anchor never matched. The filter was inert: every one
    // of those lines went to the model as if the page had said it, and the
    // "(N … left out)" sentence never appeared because the counter stayed 0.
    //
    // This vector is the measurement, not a guess — captured from Electron
    // 43.3.0 on 2026-08-13 by reading a real WebContentsView's console.
    const MEASURED = "%cElectron Security Warning (Insecure Content-Security-Policy) "
      + "font-weight: bold; This renderer process has either no Content-Security-Policy set…";
    assert.equal(pane.isPageLine(MEASURED), false, MEASURED);

    await navigate();
    rec.consoleSink?.({ level: "warning", message: MEASURED });
    rec.consoleSink?.({ level: "error", message: "TypeError: the app is broken" });

    const reply = await pane.runVerb("console", {}, OPEN, SESSION);
    const lines = String((reply.value as { lines: string }).lines);
    assert.ok(!lines.includes("Content-Security-Policy"), lines);
    assert.match(lines, /1 .*(shell|Electron)/i, "and the drop is named: " + lines);
  });

  it("really emulates a device and answers with what the page MEASURED", async () => {
    // The reviewer measured innerWidth 800, touch 0 and a Macintosh user agent
    // after preset=mobile, against a tool that reported "375x812 (mobile
    // emulation on)". The reply now carries the measurement, so the sentence
    // upstream cannot promise what the pane did not do.
    await navigate();
    rec.evalResult = {
      innerWidth: 375, innerHeight: 812, screenWidth: 375, screenHeight: 812,
      maxTouchPoints: 5, viewportMeta: true,
    };
    const reply = await pane.runVerb("resize", { width: 375, height: 812 }, OPEN, SESSION);

    assert.equal(reply.ok, true, reply.error ?? "");
    const value = reply.value as Record<string, unknown>;
    assert.equal(value.innerWidth, 375, "the reply says what the PAGE measured");
    assert.equal(value.screenWidth, 375);
    assert.equal(value.maxTouchPoints, 5);
    assert.ok(
      rec.cdp.some(([method]) => method === "Emulation.setDeviceMetricsOverride"),
      "device metrics were actually overridden: " + JSON.stringify(rec.cdp),
    );
    assert.ok(
      rec.cdp.some(([method]) => method === "Emulation.setTouchEmulationEnabled"),
      "touch emulation is asked for, not assumed: " + JSON.stringify(rec.cdp),
    );
    assert.ok(
      rec.userAgents.some((ua) => /Mobile/.test(ua)),
      "a mobile user agent is set: " + JSON.stringify(rec.userAgents),
    );
  });

  it("does not let the pane's own layout undo the emulated viewport", async () => {
    // The measured cause: resize called setBounds, and layout() overwrote it
    // from paneBounds() on the next ensureVisible() — and navigate, eval,
    // screenshot and input all call ensureVisible() first, so the effect was
    // unobservable BY CONSTRUCTION. Device emulation is a renderer override,
    // so the pane rectangle is free to be whatever the layout says.
    await navigate();
    rec.evalResult = {
      innerWidth: 375, innerHeight: 812, screenWidth: 375, screenHeight: 812,
      maxTouchPoints: 5, viewportMeta: true,
    };
    await pane.runVerb("resize", { width: 375, height: 812 }, OPEN, SESSION);
    const overrides = rec.cdp.filter(([m]) => m === "Emulation.setDeviceMetricsOverride").length;

    await pane.runVerb("eval", { text: "1" }, OPEN, SESSION);   // calls ensureVisible() → layout()
    assert.equal(
      rec.cdp.filter(([m]) => m === "Emulation.setDeviceMetricsOverride").length,
      overrides,
      "the layout neither clears nor re-applies the emulation",
    );
    assert.equal(rec.emulation.length, 0, "and never falls back to resizing the pane");
  });
});
