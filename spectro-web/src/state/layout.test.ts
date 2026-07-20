import { beforeEach, describe, expect, it } from "vitest";
import {
  __getState,
  __resetForTests,
  clampW,
  DEFAULT_LAYOUT,
  openRightPanel,
  setActiveRightTab,
  setChatW,
  setRightPanelW,
  setSidebarW,
  setTraceW,
  toggleChat,
  toggleRightPanel,
  toggleTrace,
} from "./layout";

beforeEach(() => __resetForTests());

describe("layout store", () => {
  it("starts from the defaults", () => {
    expect(__getState()).toEqual(DEFAULT_LAYOUT);
  });

  it("clampW keeps a value inside [min, max] and rounds", () => {
    expect(clampW(50, 200, 1200)).toBe(200);
    expect(clampW(5000, 200, 1200)).toBe(1200);
    expect(clampW(340.6, 200, 1200)).toBe(341);
  });

  it("setters clamp the width to sane bounds", () => {
    setSidebarW(10);
    expect(__getState().sidebarW).toBe(180);
    setChatW(99999);
    expect(__getState().chatW).toBe(1200);
    setTraceW(260);
    expect(__getState().traceW).toBe(260);
  });

  it("the Lab panes start collapsed and toggles flip them", () => {
    expect(__getState().chatOpen).toBe(false);
    expect(__getState().traceOpen).toBe(false);
    toggleChat();
    expect(__getState().chatOpen).toBe(true);
    toggleTrace();
    expect(__getState().traceOpen).toBe(true);
    toggleChat();
    expect(__getState().chatOpen).toBe(false);
  });

  it("the right panel starts closed and toggles/resizes/switches tab", () => {
    expect(__getState().rightPanelOpen).toBe(false);
    expect(__getState().activeRightTab).toBe("agents");
    toggleRightPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    setRightPanelW(10); // clamps up to the min
    expect(__getState().rightPanelW).toBe(260);
    setRightPanelW(99999); // clamps down to the max
    expect(__getState().rightPanelW).toBe(720);
    setActiveRightTab("context");
    expect(__getState().activeRightTab).toBe("context");
  });

  it("a no-op set does not change the state object identity", () => {
    setSidebarW(240); // already the default → clamped 240, no change
    const before = __getState();
    setSidebarW(240);
    expect(__getState()).toBe(before);
  });

  it("openRightPanel opens once and stays idempotent", () => {
    // The workspace announcement calls this on every session — an already
    // open panel must not churn state (or re-render subscribers).
    if (__getState().rightPanelOpen) toggleRightPanel();
    openRightPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    const before = __getState();
    openRightPanel();
    expect(__getState()).toBe(before);
  });
});
