// Pins for the chat's reading width (owner 2026-07-25).

import { beforeEach, describe, expect, it } from "vitest";
import { CHAT_WIDTHS, currentChatWidth, setChatWidth } from "./chatWidth";

describe("chatWidth", () => {
  beforeEach(() => {
    setChatWidth("normal");
  });

  it("defaults to normal — today's reading width", () => {
    expect(currentChatWidth()).toBe("normal");
  });

  it("offers exactly the two widths, normal first", () => {
    expect(CHAT_WIDTHS).toEqual(["normal", "wide"]);
  });

  it("set + read round-trips", () => {
    setChatWidth("wide");
    expect(currentChatWidth()).toBe("wide");
  });
});
