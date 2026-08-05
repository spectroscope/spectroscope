import { describe, it, expect, beforeEach } from "vitest";
import { CHAT_VIEW_MODES, currentChatView, isFlipIntoV2, setChatView, __resetForTests } from "./chatView";

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

describe("isFlipIntoV2", () => {
  // The panel-opening effect in App is keyed on chatView, so for a reader whose
  // stored reading is ALREADY v2 — every reader, v2 being the default — it fired
  // on every mount and reopened the panel on Work. Work on a fresh session says
  // "Nothing yet.", so the app greeted its owner with an empty pane at every
  // single start. The effect's own comment said "only on the flip INTO v2".
  it("a mount that merely finds v2 already chosen is not a flip", () => {
    expect(isFlipIntoV2(null, "v2")).toBe(false);
  });

  it("choosing v2 while reading v1 is the flip", () => {
    expect(isFlipIntoV2("v1", "v2")).toBe(true);
  });

  it("staying on v2 across a re-render is not a flip", () => {
    expect(isFlipIntoV2("v2", "v2")).toBe(false);
  });

  it("leaving v2 is never a flip into it", () => {
    expect(isFlipIntoV2("v2", "v1")).toBe(false);
    expect(isFlipIntoV2("v1", "v1")).toBe(false);
    expect(isFlipIntoV2(null, "v1")).toBe(false);
  });
});
