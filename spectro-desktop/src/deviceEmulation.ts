// What browser_resize actually does to the page (card 201, review finding 2).
//
// The first version wrote a `window.__spectroViewport` global that nothing read
// and then called setBounds on the pane — which layout() overwrote from
// paneBounds() on the next ensureVisible(), and navigate, eval, screenshot and
// input all call ensureVisible() first. The effect was unobservable BY
// CONSTRUCTION, while the tool reported "375x812 (mobile emulation on)".
// Measured after that call: innerWidth 800, innerHeight 740, maxTouchPoints 0,
// a Macintosh user agent. The sentence was false in three ways.
//
// So the viewport is emulated for real, in the renderer, where a responsive
// layout actually reads it:
//
//   metrics   Emulation.setDeviceMetricsOverride. It overrides what the PAGE
//             believes, so the pane rectangle stays the layout's business and
//             the two stop fighting.
//   touch     Emulation.setTouchEmulationEnabled + setEmitTouchEventsForMouse.
//   agent     setUserAgent plus Emulation.setUserAgentOverride. It reaches
//             navigator.userAgent on the NEXT load, which the sentence says.
//
// The ORDER is not arbitrary and cost a measurement: attaching the debugger
// CLEARS what webContents.enableDeviceEmulation set. Measured on Electron 43.3.0
// on 2026-08-13 — metrics first then attach gave screen.width 3440, the real
// monitor; attach first then metrics through the same session gave 375. So the
// debugger goes on first and owns all three overrides, and enableDeviceEmulation
// is the fallback for a pane whose debugger will not attach.
//
// Nothing here imports electron: the contents are a structural type, so the
// same code is driven by a fake in browserPane.test.ts and by the real Chromium
// in test/engineGuard.js. A module that can only be tested inside Electron is
// how the first version shipped untested.

/** The width at and above which a page is treated as a desktop layout. */
export const MOBILE_BREAKPOINT = 768;

/** How many contact points a phone reports. Chrome's own device mode says five. */
export const MOBILE_TOUCH_POINTS = 5;

/** What a viewport of this size should look like to the page. */
export interface DeviceProfile {
  width: number;
  height: number;
  /** Whether this is a phone-shaped viewport: touch, a mobile screen, a mobile agent. */
  mobile: boolean;
  deviceScaleFactor: number;
  maxTouchPoints: number;
  userAgent: string;
}

/** What Chromium's Emulation.setDeviceMetricsOverride takes, under its Electron name. */
export interface DeviceMetrics {
  screenPosition: "desktop" | "mobile";
  screenSize: { width: number; height: number };
  viewPosition: { x: number; y: number };
  deviceScaleFactor: number;
  viewSize: { width: number; height: number };
  scale: number;
}

/** The subset of a WebContents this module drives, so it needs no electron import. */
export interface EmulatableContents {
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
  enableDeviceEmulation(parameters: DeviceMetrics): void;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  debugger: {
    isAttached(): boolean;
    attach(version?: string): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * What the pane DID, measured in the page afterwards rather than assumed.
 *
 * <p>The device size and the layout viewport are two different numbers and both
 * are here, because on a phone they routinely differ: a page with no
 * {@code <meta name="viewport">} lays out at the legacy 980 CSS pixels no matter
 * how small the screen is. Measured on this Chromium on 2026-08-13 — a 375x812
 * device gave {@code innerWidth} 981. That is a real phone's behaviour and it is
 * the single most useful thing a responsive check can tell you, so it is
 * reported rather than smoothed over.
 */
export interface AppliedViewport {
  width: number;
  height: number;
  mobile: boolean;
  /** What the page believes its SCREEN is — the device that was emulated. */
  screenWidth: number;
  screenHeight: number;
  /** What the page actually LAYS OUT in, which is not the same number. */
  innerWidth: number;
  innerHeight: number;
  /** Whether the page declares a viewport meta tag, which is why the two differ. */
  viewportMeta: boolean;
  maxTouchPoints: number;
  devicePixelRatio: number;
  coarsePointer: boolean;
  /** Whether touch emulation was actually installed, not whether it was asked for. */
  touchApplied: boolean;
  /** Whether the user agent was actually swapped. */
  userAgentApplied: boolean;
}

/**
 * The mobile user agent, built from the pane's OWN Chromium version.
 *
 * A hard-coded version string is a lie with a shelf life: it is true on the day
 * it is written and wrong at the next Electron bump, and nothing warns. The
 * major comes out of the agent the pane already reports.
 *
 * @param desktopUserAgent the pane's own agent string
 */
export function mobileUserAgent(desktopUserAgent: string): string {
  const chrome = /Chrome\/(\d+)/.exec(desktopUserAgent);
  const major = chrome ? chrome[1] : "0";
  return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 `
    + `(KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

/**
 * What a viewport of this size should be emulated as.
 *
 * @param width             the requested viewport width in CSS pixels
 * @param height            the requested viewport height
 * @param desktopUserAgent  the pane's own agent, for the mobile one to borrow a version from
 */
export function deviceProfile(
  width: number,
  height: number,
  desktopUserAgent: string,
): DeviceProfile {
  const mobile = width < MOBILE_BREAKPOINT;
  return {
    width,
    height,
    mobile,
    // Zero means "keep the host's own", which is the honest desktop answer; a
    // phone-shaped viewport gets the ratio the 375x812 preset is named after.
    deviceScaleFactor: mobile ? 3 : 0,
    maxTouchPoints: mobile ? MOBILE_TOUCH_POINTS : 0,
    userAgent: mobile ? mobileUserAgent(desktopUserAgent) : desktopUserAgent,
  };
}

/** What the page is asked about itself once the overrides are in. */
const MEASURE = "({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, "
  + "screenWidth: window.screen.width, screenHeight: window.screen.height, "
  + "maxTouchPoints: navigator.maxTouchPoints, devicePixelRatio: window.devicePixelRatio, "
  + "coarsePointer: window.matchMedia('(pointer: coarse)').matches, "
  + "viewportMeta: !!document.querySelector('meta[name=\"viewport\"]') })";

/**
 * Puts the profile into the renderer and reports back what the page measures.
 *
 * <p>Every field of the result is a measurement or a fact about whether a step
 * SUCCEEDED. Nothing here reports an intention: a debugger that will not attach
 * means {@code touchApplied} is false, and the sentence the model reads says so
 * rather than claiming a phone.
 *
 * @param contents the pane's web contents
 * @param width    the requested viewport width
 * @param height   the requested viewport height
 */
export async function applyViewport(
  contents: EmulatableContents,
  width: number,
  height: number,
): Promise<AppliedViewport> {
  const desktopAgent = baseUserAgent(contents);
  const profile = deviceProfile(width, height, desktopAgent);

  // Attach FIRST. An attach after enableDeviceEmulation throws the metrics away.
  let attached = false;
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach("1.3");
    }
    attached = true;
  } catch {
    attached = false;
  }

  let metricsApplied = false;
  if (attached) {
    try {
      await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: profile.deviceScaleFactor,
        mobile: profile.mobile,
        screenWidth: width,
        screenHeight: height,
      });
      metricsApplied = true;
    } catch {
      metricsApplied = false;
    }
  }
  if (!metricsApplied) {
    // No debugger: the native wrapper still moves the page's own viewport, and
    // without a debugger session there is nothing left to clear it.
    contents.enableDeviceEmulation({
      screenPosition: profile.mobile ? "mobile" : "desktop",
      screenSize: { width, height },
      viewSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: profile.deviceScaleFactor,
      scale: 1,
    });
  }

  const touchApplied = attached && await emulateTouch(contents, profile);

  let userAgentApplied = false;
  try {
    contents.setUserAgent(profile.userAgent);
    userAgentApplied = true;
  } catch {
    userAgentApplied = false;
  }
  if (attached) {
    try {
      await contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
        userAgent: profile.userAgent,
      });
    } catch {
      // The Electron-level setUserAgent above still governs the next load.
    }
  }

  const measured = (await contents.executeJavaScript(MEASURE, true)) as Partial<AppliedViewport>;
  return {
    width,
    height,
    mobile: profile.mobile,
    screenWidth: Number(measured?.screenWidth ?? 0),
    screenHeight: Number(measured?.screenHeight ?? 0),
    innerWidth: Number(measured?.innerWidth ?? 0),
    innerHeight: Number(measured?.innerHeight ?? 0),
    viewportMeta: measured?.viewportMeta === true,
    maxTouchPoints: Number(measured?.maxTouchPoints ?? 0),
    devicePixelRatio: Number(measured?.devicePixelRatio ?? 0),
    coarsePointer: measured?.coarsePointer === true,
    touchApplied,
    userAgentApplied,
  };
}

/** The pane's own agent, remembered so a second resize does not borrow a mobile one. */
let firstSeenAgent: string | null = null;

function baseUserAgent(contents: EmulatableContents): string {
  const current = contents.getUserAgent();
  // Once a mobile agent is in place, asking again would build the next profile
  // out of it — and a "desktop" preset would hand back a Pixel.
  if (firstSeenAgent === null && !/ Mobile /.test(current)) {
    firstSeenAgent = current;
  }
  return firstSeenAgent ?? current;
}

/** Forgets the remembered desktop agent. The pane it belonged to is gone. */
export function forgetBaseUserAgent(): void {
  firstSeenAgent = null;
}

/** Touch, through the debugger session that is already open. */
async function emulateTouch(
  contents: EmulatableContents,
  profile: DeviceProfile,
): Promise<boolean> {
  try {
    await contents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled: profile.mobile,
      maxTouchPoints: Math.max(1, profile.maxTouchPoints),
    });
    await contents.debugger.sendCommand("Emulation.setEmitTouchEventsForMouse", {
      enabled: profile.mobile,
      configuration: profile.mobile ? "mobile" : "desktop",
    });
    return true;
  } catch {
    // A debugger that will not attach is a smaller failure than a tool that
    // says "mobile emulation on" and delivers a mouse.
    return false;
  }
}
