// What browser_resize promises, checked against what it does.
//
// The review of 2026-08-13 measured a tool that reported "375x812 (mobile
// emulation on)" and delivered innerWidth 800, maxTouchPoints 0 and a Macintosh
// user agent. So the shape of this file is deliberate: nothing asserts an
// intention, everything asserts either a call that was really made or a value
// the page really reported.

import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
  applyViewport, deviceProfile, forgetBaseUserAgent, mobileUserAgent, MOBILE_BREAKPOINT,
  type DeviceMetrics, type EmulatableContents,
} from "./deviceEmulation";

const DESKTOP_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

/** A web contents that records what it was told and reports what it is given. */
function fakeContents(options: {
  measured?: Record<string, unknown>;
  debuggerFails?: boolean;
} = {}): EmulatableContents & {
  metrics: DeviceMetrics[];
  agents: string[];
  cdp: [string, Record<string, unknown> | undefined][];
} {
  let agent = DESKTOP_AGENT;
  let attached = false;
  const metrics: DeviceMetrics[] = [];
  const agents: string[] = [];
  const cdp: [string, Record<string, unknown> | undefined][] = [];
  return {
    metrics,
    agents,
    cdp,
    getUserAgent: () => agent,
    setUserAgent: (next) => {
      agent = next;
      agents.push(next);
    },
    enableDeviceEmulation: (parameters) => {
      metrics.push(parameters);
    },
    executeJavaScript: async () =>
      options.measured ?? {
        innerWidth: 375, innerHeight: 812, screenWidth: 375, screenHeight: 812,
        maxTouchPoints: 5, devicePixelRatio: 3, coarsePointer: true, viewportMeta: true,
      },
    debugger: {
      isAttached: () => attached,
      attach: () => {
        if (options.debuggerFails) throw new Error("another debugger is already attached");
        attached = true;
      },
      sendCommand: async (method, params) => {
        cdp.push([method, params]);
      },
    },
  };
}

describe("deviceEmulation", () => {
  beforeEach(forgetBaseUserAgent);

  it("gives a phone-shaped viewport touch, a scale factor and a mobile agent", () => {
    const profile = deviceProfile(375, 812, DESKTOP_AGENT);
    assert.equal(profile.mobile, true);
    assert.equal(profile.maxTouchPoints, 5);
    assert.equal(profile.deviceScaleFactor, 3);
    assert.match(profile.userAgent, /Mobile Safari/);
    assert.ok(!profile.userAgent.includes("Macintosh"), profile.userAgent);
  });

  it("leaves a desktop viewport alone: no touch, no agent swap", () => {
    const profile = deviceProfile(MOBILE_BREAKPOINT, 1024, DESKTOP_AGENT);
    assert.equal(profile.mobile, false);
    assert.equal(profile.maxTouchPoints, 0);
    assert.equal(profile.userAgent, DESKTOP_AGENT);
  });

  it("borrows the Chromium version rather than hard-coding one that will rot", () => {
    assert.match(mobileUserAgent(DESKTOP_AGENT), /Chrome\/150\.0\.0\.0 Mobile/);
    assert.match(
      mobileUserAgent("Mozilla/5.0 … Chrome/201.0.0.0 Safari/537.36"),
      /Chrome\/201\.0\.0\.0 Mobile/,
    );
  });

  it("overrides the device metrics rather than resizing the pane", async () => {
    const contents = fakeContents();
    const applied = await applyViewport(contents, 375, 812);

    const override = contents.cdp.find(([m]) => m === "Emulation.setDeviceMetricsOverride");
    assert.ok(override, contents.cdp.map(([m]) => m).join(", "));
    assert.equal(override[1]?.width, 375);
    assert.equal(override[1]?.height, 812);
    assert.equal(override[1]?.mobile, true);
    assert.equal(override[1]?.deviceScaleFactor, 3);
    assert.equal(contents.metrics.length, 0, "the native wrapper is the fallback, not the path");
    assert.equal(applied.innerWidth, 375);
    assert.equal(applied.screenWidth, 375);
    assert.equal(applied.maxTouchPoints, 5);
    assert.equal(applied.coarsePointer, true);
  });

  it("puts the debugger on BEFORE the metrics, because attaching clears them", async () => {
    // Measured on Electron 43.3.0: enableDeviceEmulation followed by a debugger
    // attach left screen.width at 3440, the real monitor. Attach first and the
    // same page reported 375. The order is the mechanism, so it is pinned.
    const order: string[] = [];
    const contents = fakeContents();
    let attached = false;
    const watched: EmulatableContents = {
      ...contents,
      enableDeviceEmulation: (parameters) => {
        order.push("enableDeviceEmulation");
        contents.enableDeviceEmulation(parameters);
      },
      debugger: {
        isAttached: () => attached,
        attach: () => {
          order.push("attach");
          attached = true;
        },
        sendCommand: async (method, params) => {
          order.push(method);
          return contents.debugger.sendCommand(method, params);
        },
      },
    };
    await applyViewport(watched, 375, 812);
    assert.equal(order[0], "attach", order.join(" -> "));
    assert.equal(order[1], "Emulation.setDeviceMetricsOverride", order.join(" -> "));
    assert.ok(!order.includes("enableDeviceEmulation"), order.join(" -> "));
  });

  it("turns touch emulation on through the debugger, and says it did", async () => {
    const contents = fakeContents();
    const applied = await applyViewport(contents, 375, 812);
    const methods = contents.cdp.map(([method]) => method);
    assert.ok(methods.includes("Emulation.setTouchEmulationEnabled"), methods.join(", "));
    assert.ok(methods.includes("Emulation.setEmitTouchEventsForMouse"), methods.join(", "));
    assert.equal(applied.touchApplied, true);
    assert.equal(applied.userAgentApplied, true);
  });

  it("says touch is OFF when the debugger will not attach, instead of claiming a phone", async () => {
    const contents = fakeContents({
      debuggerFails: true,
      measured: {
        innerWidth: 375, innerHeight: 812, screenWidth: 375, screenHeight: 812,
        maxTouchPoints: 0, devicePixelRatio: 3, coarsePointer: false, viewportMeta: true,
      },
    });
    const applied = await applyViewport(contents, 375, 812);
    assert.equal(applied.touchApplied, false, "a failed step is reported as a failed step");
    assert.equal(applied.maxTouchPoints, 0);
    assert.equal(contents.metrics.length, 1, "the native wrapper carries the fallback");
    assert.equal(applied.innerWidth, 375, "and the metrics override still happened");
  });

  it("reports what the page measured even when it disagrees with the request", async () => {
    // This is the exact defect: a tool that answers with its own argument can
    // never be wrong, and is therefore worthless as evidence.
    const contents = fakeContents({
      measured: {
        innerWidth: 800, innerHeight: 740, screenWidth: 800, screenHeight: 740,
        maxTouchPoints: 0, devicePixelRatio: 2, coarsePointer: false, viewportMeta: false,
      },
    });
    const applied = await applyViewport(contents, 375, 812);
    assert.equal(applied.width, 375, "what was asked for");
    assert.equal(applied.innerWidth, 800, "and what actually happened, side by side");
  });

  it("does not build a desktop profile out of the mobile agent it just set", async () => {
    const contents = fakeContents();
    await applyViewport(contents, 375, 812);
    await applyViewport(contents, 1280, 800);
    assert.equal(contents.agents.at(-1), DESKTOP_AGENT, contents.agents.join(" | "));
  });
});
