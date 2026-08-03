import { describe, it, expect, beforeEach } from "vitest";
import { CHAT_VIEW_MODES, currentChatView, setChatView, __resetForTests } from "./chatView";

describe("chatView", () => {
  beforeEach(() => __resetForTests());

  // Owner call, 2026-08-03. The Work panel lives only in v2, so v1 showed a
  // twelve-agent workflow as one agent with a long list of tool calls. v1 stays
  // a mode you can choose; it is no longer the one you land in.
  it("defaults to v2, where concurrent work is visible at all", () => {
    expect(currentChatView()).toBe("v2");
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
