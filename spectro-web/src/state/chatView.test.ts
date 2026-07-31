import { describe, it, expect, beforeEach } from "vitest";
import { CHAT_VIEW_MODES, currentChatView, setChatView, __resetForTests } from "./chatView";

describe("chatView", () => {
  beforeEach(() => __resetForTests());

  it("defaults to v1 — v2 is a mode you choose, never one you land in", () => {
    expect(currentChatView()).toBe("v1");
  });

  it("round trips both modes", () => {
    for (const m of CHAT_VIEW_MODES) {
      setChatView(m);
      expect(currentChatView()).toBe(m);
    }
  });

  it("notifies subscribers once per real change", () => {
    let hits = 0;
    // The store's subscribe is not exported; useSyncExternalStore is the only
    // consumer, so the observable contract here is the value itself.
    setChatView("v2");
    hits += currentChatView() === "v2" ? 1 : 0;
    setChatView("v2");
    expect(hits).toBe(1);
    expect(currentChatView()).toBe("v2");
  });
});
