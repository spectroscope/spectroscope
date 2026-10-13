// Card 586: a press in the run view asks the chat to show one place.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetChatFocusForTests,
  claimChatFocus,
  currentChatFocus,
  requestChatFocus,
  subscribeChatFocus,
} from "./chatFocus";

beforeEach(() => __resetChatFocusForTests());

describe("the chat focus request (card 586)", () => {
  it("is null until a request is made", () => {
    expect(currentChatFocus()).toBeNull();
  });

  it("tells a subscriber about a request, with a seq that grows", () => {
    const seen: unknown[] = [];
    const stop = subscribeChatFocus(() => seen.push(currentChatFocus()));
    requestChatFocus({ kind: "entry", key: "abcdefabcdef:brainstorm:1" });
    requestChatFocus({ kind: "agent", agentId: "worker-1" });
    stop();
    expect(seen).toEqual([
      { target: { kind: "entry", key: "abcdefabcdef:brainstorm:1" }, seq: 1 },
      { target: { kind: "agent", agentId: "worker-1" }, seq: 2 },
    ]);
  });

  it("gives the same target twice two seq values, so a second press jumps again", () => {
    const target = { kind: "entry", key: "abcdefabcdef:brainstorm:1" } as const;
    requestChatFocus(target);
    const first = currentChatFocus();
    requestChatFocus(target);
    const second = currentChatFocus();
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(second?.target).toEqual(target);
  });

  it("stops telling a subscriber that left", () => {
    let calls = 0;
    const stop = subscribeChatFocus(() => calls++);
    stop();
    requestChatFocus({ kind: "agent", agentId: "worker-1" });
    expect(calls).toBe(0);
  });
});

// Card 586, final fix round (review I1): a request is shown once. A chat that
// mounts again later, or a second chat, does not show it again.
describe("a focus request is claimed once (card 586)", () => {
  it("claims each request once, and a newer one again", () => {
    requestChatFocus({ kind: "entry", key: "abcdefabcdef:brainstorm:1" });
    const seq = currentChatFocus()?.seq ?? -1;
    expect(claimChatFocus(seq)).toBe(true);
    expect(claimChatFocus(seq)).toBe(false);
    requestChatFocus({ kind: "entry", key: "abcdefabcdef:brainstorm:1" });
    expect(claimChatFocus(seq + 1)).toBe(true);
    expect(claimChatFocus(seq), "an older request stays claimed").toBe(false);
  });
});
