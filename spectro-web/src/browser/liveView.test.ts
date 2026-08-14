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
  frameDataUrl,
  historyFrame,
  keyFrame,
  keyName,
  navigateFrame,
  parseViewMessage,
  screenshotFilename,
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
    ).toEqual({ kind: "state", state: { live: "web", url: "https://a.test/", attached: true } });
    // Forward compatibility errs toward the floor: a face this build does not
    // know must not paint pictures or accept input as if it did.
    const odd = parseViewMessage(
      JSON.stringify({ type: "state", sessionId: "s1", live: "hologram", url: null, attached: false }),
    );
    expect(odd).toEqual({ kind: "state", state: { live: "none", url: null, attached: false } });
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
    ).toEqual({ kind: "verb", verb: "navigate", ok: true, url: "https://a.test/", error: null });
    expect(
      parseViewMessage(JSON.stringify({ type: "verb", verb: "input", ok: false, error: "no page" })),
    ).toEqual({
      kind: "verb",
      verb: "input",
      ok: false,
      url: null,
      error: "no page",
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
});

describe("the mode the segment renders from", () => {
  it("is connecting before the first state frame, then the state's own face", () => {
    expect(webFaceMode(null)).toBe("connecting");
    expect(webFaceMode({ live: "web", url: null, attached: true })).toBe("web");
    expect(webFaceMode({ live: "desktop", url: null, attached: true })).toBe("desktop");
    expect(webFaceMode({ live: "none", url: null, attached: false })).toBe("none");
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
});
