// The web face's picture wire, held as pure functions (card 226).
//
// Everything here is the half of the live browser view that does not need a
// DOM: parsing what /ws/browser-view sends, building what it accepts, and the
// two coordinate translations (picture pixels to device pixels, wheel deltas
// to scroll steps). The server side of this wire is pinned by
// BrowserViewSocketTest; this suite pins the client's reading of the SAME
// shapes, so a drift on either end goes red in its own project first.

import { describe, expect, it } from "vitest";
import {
  clickFrame,
  closePageFrame,
  frameDataUrl,
  historyFrame,
  reloadFrame,
  keyFrame,
  keyName,
  launchListFrame,
  launchPlayFrame,
  navigateFrame,
  parseViewMessage,
  screenshotFilename,
  screenshotVerbFrame,
  scrollFrame,
  toDevicePoint,
  typedAddress,
  unwatchFrame,
  viewSocketUrl,
  watchFrame,
  webFaceMode,
  faceLabelKey,
  wheelStep,
} from "./liveView";

describe("the socket address", () => {
  it("rides the page's own origin, ws for http and wss for https", () => {
    expect(viewSocketUrl({ protocol: "http:", host: "localhost:8080" })).toBe(
      "ws://localhost:8080/ws/browser-view",
    );
    expect(viewSocketUrl({ protocol: "https:", host: "example.test" })).toBe(
      "wss://example.test/ws/browser-view",
    );
  });
});

describe("parsing what the server sends", () => {
  it("reads a state frame, and coerces an unknown face to none", () => {
    expect(
      parseViewMessage(
        JSON.stringify({
          type: "state",
          sessionId: "s1",
          live: "web",
          url: "https://a.test/",
          attached: true,
        }),
      ),
    ).toEqual({
      kind: "state",
      state: {
        live: "web",
        url: "https://a.test/",
        attached: true,
        canGoBack: null,
        canGoForward: null,
      },
    });
    // Forward compatibility errs toward the floor: a face this build does not
    // know must not paint pictures or accept input as if it did.
    const odd = parseViewMessage(
      JSON.stringify({ type: "state", sessionId: "s1", live: "hologram", url: null, attached: false }),
    );
    expect(odd).toEqual({
      kind: "state",
      state: { live: "none", url: null, attached: false, canGoBack: null, canGoForward: null },
    });
  });

  it("reads the two history booleans, and keeps 'not said' apart from 'no' — card 344 (c)", () => {
    // Three states, not two. A face that cannot answer must not be read as a
    // face that answered "there is nothing there": the first leaves the button
    // alone, the second kills it, and collapsing them ships a wrong disabled.
    const said = parseViewMessage(
      JSON.stringify({
        type: "state",
        sessionId: "s1",
        live: "web",
        url: "https://a.test/",
        attached: true,
        canGoBack: true,
        canGoForward: false,
      }),
    );
    expect(said).toEqual({
      kind: "state",
      state: {
        live: "web",
        url: "https://a.test/",
        attached: true,
        canGoBack: true,
        canGoForward: false,
      },
    });

    const silent = parseViewMessage(
      JSON.stringify({
        type: "state",
        sessionId: "s1",
        live: "desktop",
        url: null,
        attached: true,
        canGoBack: null,
        canGoForward: null,
      }),
    );
    expect(silent).toEqual({
      kind: "state",
      state: { live: "desktop", url: null, attached: true, canGoBack: null, canGoForward: null },
    });

    // Anything that is not a boolean is "not said" — the same floor the face
    // value takes, for the same reason.
    const nonsense = parseViewMessage(
      JSON.stringify({
        type: "state",
        sessionId: "s1",
        live: "web",
        url: null,
        attached: true,
        canGoBack: "yes",
        canGoForward: 1,
      }),
    );
    expect(nonsense).toEqual({
      kind: "state",
      state: { live: "web", url: null, attached: true, canGoBack: null, canGoForward: null },
    });
  });

  it("reads a picture frame into a data URL and its device size", () => {
    const msg = parseViewMessage(
      JSON.stringify({
        type: "frame",
        sessionId: "s1",
        format: "jpeg",
        dataBase64: "abc123",
        deviceWidth: 1280,
        deviceHeight: 800,
        ts: 12.5,
      }),
    );
    expect(msg).toEqual({
      kind: "frame",
      picture: { dataUrl: "data:image/jpeg;base64,abc123", deviceWidth: 1280, deviceHeight: 800, ts: 12.5 },
    });
  });

  it("drops a picture frame without bytes rather than drawing a broken image", () => {
    expect(
      parseViewMessage(
        JSON.stringify({ type: "frame", sessionId: "s1", dataBase64: "", deviceWidth: 1, deviceHeight: 1 }),
      ),
    ).toBeNull();
  });

  it("reads verb, refused and error frames", () => {
    expect(
      parseViewMessage(JSON.stringify({ type: "verb", verb: "navigate", ok: true, url: "https://a.test/" })),
    ).toEqual({ kind: "verb", verb: "navigate", ok: true, url: "https://a.test/", error: null, shot: null });
    expect(
      parseViewMessage(JSON.stringify({ type: "verb", verb: "input", ok: false, error: "no page" })),
    ).toEqual({
      kind: "verb",
      verb: "input",
      ok: false,
      url: null,
      error: "no page",
      shot: null,
    });
    expect(parseViewMessage(JSON.stringify({ type: "refused", sentence: "the fence said no" }))).toEqual({
      kind: "refused",
      sentence: "the fence said no",
    });
    expect(parseViewMessage(JSON.stringify({ type: "error", sentence: "not json" }))).toEqual({
      kind: "error",
      sentence: "not json",
    });
  });

  it("answers null for what is not this wire", () => {
    expect(parseViewMessage("not json at all")).toBeNull();
    expect(parseViewMessage(JSON.stringify({ type: "run_start" }))).toBeNull();
    expect(parseViewMessage(42)).toBeNull();
  });

  it("carries a screenshot verb's bytes so the desktop row can save them", () => {
    // Card 227: the desktop face has no client-side picture to save, so the
    // shot travels back as verb fields — read here, never guessed.
    const msg = parseViewMessage(
      JSON.stringify({
        type: "verb",
        verb: "screenshot",
        ok: true,
        mediaType: "image/png",
        dataBase64: "cGln",
      }),
    );
    expect(msg).toEqual({
      kind: "verb",
      verb: "screenshot",
      ok: true,
      url: null,
      error: null,
      shot: { mediaType: "image/png", dataBase64: "cGln" },
    });
    const plain = parseViewMessage(JSON.stringify({ type: "verb", verb: "navigate", ok: true }));
    expect(plain).toMatchObject({ kind: "verb", shot: null });
  });

  it("reads the start page's configuration list tolerantly (card 227)", () => {
    const msg = parseViewMessage(
      JSON.stringify({
        type: "launch_configs",
        sessionId: "s1",
        ok: true,
        skipped: 1,
        configs: [
          { name: "web", address: "http://localhost:5173/", attaches: false, up: true },
          { name: "api", address: "http://localhost:9999/", attaches: true, up: false, exitCode: 137 },
          { bogus: "no name, dropped" },
        ],
      }),
    );
    expect(msg).toEqual({
      kind: "launchConfigs",
      ok: true,
      sentence: null,
      skipped: 1,
      configs: [
        { name: "web", address: "http://localhost:5173/", attaches: false, up: true, exitCode: null },
        { name: "api", address: "http://localhost:9999/", attaches: true, up: false, exitCode: 137 },
      ],
    });
  });

  it("reads a refused configuration list as its sentence", () => {
    expect(
      parseViewMessage(
        JSON.stringify({ type: "launch_configs", ok: false, sentence: "this session is not open" }),
      ),
    ).toEqual({
      kind: "launchConfigs",
      ok: false,
      sentence: "this session is not open",
      skipped: 0,
      configs: [],
    });
  });

  it("reads a play answer with its outcome, address and sentence", () => {
    expect(
      parseViewMessage(
        JSON.stringify({
          type: "launch_played",
          name: "web",
          ok: true,
          up: true,
          url: "http://localhost:5173/",
        }),
      ),
    ).toEqual({
      kind: "launchPlayed",
      name: "web",
      ok: true,
      up: true,
      url: "http://localhost:5173/",
      sentence: null,
    });
    expect(
      parseViewMessage(
        JSON.stringify({
          type: "launch_played",
          name: "web",
          ok: false,
          up: true,
          sentence: "refused localhost",
        }),
      ),
    ).toMatchObject({ kind: "launchPlayed", ok: false, up: true, sentence: "refused localhost" });
  });
});

describe("the start page's frames (card 227)", () => {
  it("asks for the list and presses play in the channel's own names", () => {
    expect(launchListFrame("s1")).toEqual({ type: "launch_list", sessionId: "s1" });
    expect(launchPlayFrame("s1", "web")).toEqual({ type: "launch_play", sessionId: "s1", name: "web" });
    expect(screenshotVerbFrame("s1")).toEqual({ type: "screenshot", sessionId: "s1" });
  });
});

describe("the mode the segment renders from", () => {
  it("is connecting before the first state frame, then the state's own face", () => {
    expect(webFaceMode(null)).toBe("connecting");
    const nav = { canGoBack: null, canGoForward: null };
    expect(webFaceMode({ live: "web", url: null, attached: true, ...nav })).toBe("web");
    expect(webFaceMode({ live: "desktop", url: null, attached: true, ...nav })).toBe("desktop");
    expect(webFaceMode({ live: "none", url: null, attached: false, ...nav })).toBe("none");
  });

  it("names each face for the reader — criterion 5's honesty", () => {
    expect(faceLabelKey("web")).toBe("browser.view.faceWeb");
    expect(faceLabelKey("desktop")).toBe("browser.view.faceDesktop");
    expect(faceLabelKey("none")).toBe("browser.view.faceNone");
  });
});

describe("picture pixels to device pixels", () => {
  it("scales a click on the shown picture into the page's own coordinates", () => {
    // Picture shown at half size: a click at (100, 50) is (200, 100) on the page.
    expect(toDevicePoint(100, 50, 640, 400, 1280, 800)).toEqual([200, 100]);
  });

  it("rounds and clamps to the device bounds", () => {
    expect(toDevicePoint(639.7, 399.7, 640, 400, 1280, 800)).toEqual([1279, 799]);
    expect(toDevicePoint(-3, -3, 640, 400, 1280, 800)).toEqual([0, 0]);
  });

  it("refuses to guess when a dimension is missing", () => {
    expect(toDevicePoint(10, 10, 0, 400, 1280, 800)).toBeNull();
    expect(toDevicePoint(10, 10, 640, 400, 0, 0)).toBeNull();
  });
});

describe("wheel deltas to scroll steps", () => {
  it("takes the dominant axis and converts pixels to steps", () => {
    expect(wheelStep(0, 120)).toEqual({ direction: "down", amount: 1 });
    expect(wheelStep(0, -360)).toEqual({ direction: "up", amount: 4 });
    expect(wheelStep(200, 10)).toEqual({ direction: "right", amount: 2 });
    expect(wheelStep(-150, 20)).toEqual({ direction: "left", amount: 2 });
  });

  it("is silent on a zero delta and capped against one giant flush", () => {
    expect(wheelStep(0, 0)).toBeNull();
    expect(wheelStep(0, 99999)).toEqual({ direction: "down", amount: 15 });
  });
});

describe("keys the picture forwards, and keys it must not", () => {
  it("forwards printable characters and the named keys the engine knows", () => {
    expect(keyName("a", false, false)).toBe("a");
    expect(keyName("A", false, false)).toBe("A");
    expect(keyName("Enter", false, false)).toBe("Enter");
    expect(keyName("Backspace", false, false)).toBe("Backspace");
    expect(keyName("ArrowDown", false, false)).toBe("ArrowDown");
    expect(keyName("PageUp", false, false)).toBe("PageUp");
  });

  it("keeps Tab and Escape for the app — the picture must never trap the keyboard", () => {
    expect(keyName("Tab", false, false)).toBeNull();
    expect(keyName("Escape", false, false)).toBeNull();
  });

  it("keeps shortcuts for the app and the OS", () => {
    expect(keyName("a", true, false)).toBeNull();
    expect(keyName("r", false, true)).toBeNull();
  });

  it("stays silent on named keys the engine has no code for", () => {
    expect(keyName("F5", false, false)).toBeNull();
    expect(keyName("Shift", false, false)).toBeNull();
  });
});

describe("what the reader types becomes an address", () => {
  it("passes a schemed address through and lends https to a bare host", () => {
    expect(typedAddress("https://example.test/a")).toBe("https://example.test/a");
    expect(typedAddress("example.test")).toBe("https://example.test");
    expect(typedAddress("  example.test  ")).toBe("https://example.test");
  });

  it("answers null for an empty line", () => {
    expect(typedAddress("   ")).toBeNull();
  });
});

describe("the frames the client sends — browser_computer's own argument names", () => {
  it("builds watch, unwatch, navigate and history frames", () => {
    expect(watchFrame("s1")).toEqual({ type: "watch", sessionId: "s1" });
    expect(unwatchFrame()).toEqual({ type: "unwatch" });
    expect(navigateFrame("s1", "https://a.test/")).toEqual({
      type: "navigate",
      sessionId: "s1",
      url: "https://a.test/",
    });
    expect(historyFrame("s1", "back")).toEqual({ type: "back", sessionId: "s1" });
    expect(historyFrame("s1", "forward")).toEqual({ type: "forward", sessionId: "s1" });
  });

  it("builds a reload frame that carries no address — card 344 (b)", () => {
    // The whole point of the verb: nothing here names a page, so nothing here
    // can re-post a form or throw away what was typed into one. The engine
    // reloads what it is already showing.
    expect(reloadFrame("s1")).toEqual({ type: "reload", sessionId: "s1" });
    expect(Object.keys(reloadFrame("s1"))).not.toContain("url");
  });

  it("builds a close_page frame — card 346", () => {
    expect(closePageFrame("s1")).toEqual({ type: "close_page", sessionId: "s1" });
  });

  it("builds input frames the face can run unchanged", () => {
    expect(clickFrame("s1", [200, 100])).toEqual({
      type: "input",
      sessionId: "s1",
      action: "left_click",
      coordinate: [200, 100],
    });
    expect(scrollFrame("s1", [10, 20], "down", 3)).toEqual({
      type: "input",
      sessionId: "s1",
      action: "scroll",
      coordinate: [10, 20],
      scroll_direction: "down",
      scroll_amount: 3,
    });
    expect(keyFrame("s1", "Enter")).toEqual({ type: "input", sessionId: "s1", action: "key", text: "Enter" });
  });
});

describe("the screenshot control", () => {
  it("wraps the frame bytes as the data URL the download rides", () => {
    expect(frameDataUrl("abc")).toBe("data:image/jpeg;base64,abc");
  });

  it("names the file off the clock, deterministically", () => {
    // 2026-08-14T12:34:56.000Z
    expect(screenshotFilename(Date.UTC(2026, 7, 14, 12, 34, 56))).toBe(
      "spectro-browser-20260814-123456.jpeg",
    );
  });

  it("names a wire shot by its own media type (card 227)", () => {
    // The desktop row's shot arrives as verb fields, PNG from the pane —
    // a .jpeg name on PNG bytes would be a small lie every file manager reads.
    expect(screenshotFilename(Date.UTC(2026, 7, 14, 12, 34, 56), "image/png")).toBe(
      "spectro-browser-20260814-123456.png",
    );
    expect(screenshotFilename(Date.UTC(2026, 7, 14, 12, 34, 56), "image/jpeg")).toBe(
      "spectro-browser-20260814-123456.jpeg",
    );
  });
});
