// Pins for the chat's half of the in-view search: WHAT counts as searchable
// conversation, and how a matched string is cut for marking. The scrolling and
// the outline live in Chat.tsx; everything decidable without a DOM lives here.

import { describe, expect, it } from "vitest";
import { chatHits, markSegments, turnSearchText } from "./chatSearch";
import type { Turn } from "../state/reducer";

const user = (text: string): Turn => ({ kind: "user", text });
const assistant = (text: string, thinking = ""): Turn => ({
  kind: "assistant",
  agentId: "main",
  text,
  thinking,
});

describe("turnSearchText", () => {
  it("reads a user message", () => {
    expect(turnSearchText(user("docker compose up"))).toBe("docker compose up");
  });

  it("reads an assistant answer", () => {
    expect(turnSearchText(assistant("run `docker compose up` first"))).toBe("run `docker compose up` first");
  });

  it("includes the thinking block — it is on screen when the disclosure opens it", () => {
    expect(turnSearchText(assistant("", "the user wants docker"))).toBe("the user wants docker");
  });

  it("ignores tool, info and error turns", () => {
    expect(turnSearchText({ kind: "tool", callId: "c1" })).toBe("");
    expect(turnSearchText({ kind: "info", text: "session resumed", tone: "neutral" })).toBe("");
    expect(turnSearchText({ kind: "error", text: "provider refused" })).toBe("");
  });
});

describe("chatHits", () => {
  const turns: Turn[] = [
    user("how do I run docker?"),
    assistant("call docker compose, then docker ps", "docker docker docker"),
    { kind: "tool", callId: "c1" },
    assistant("nothing to see"),
    user("thanks"),
  ];

  it("returns the indices of matching turns, in document order", () => {
    expect(chatHits(turns, "docker")).toEqual([0, 1]);
  });

  it("counts a turn once however often it matches inside", () => {
    // Stepping must never land twice on the same outline: a "next" that looks
    // like nothing happened reads as a broken button.
    expect(chatHits([assistant("docker docker docker")], "docker")).toEqual([0]);
  });

  it("matches case-insensitively", () => {
    expect(chatHits([user("Docker")], "docker")).toEqual([0]);
    expect(chatHits([user("docker")], "DOCKER")).toEqual([0]);
  });

  it("finds nothing for an empty or whitespace query", () => {
    expect(chatHits(turns, "")).toEqual([]);
    expect(chatHits(turns, "   ")).toEqual([]);
  });

  it("matches a turn whose only hit is in its thinking block", () => {
    expect(chatHits([assistant("all done", "secret docker plan")], "docker")).toEqual([0]);
  });
});

describe("markSegments", () => {
  it("cuts the text around every occurrence, keeping the original casing", () => {
    expect(markSegments("Docker and docker", "docker")).toEqual([
      { text: "Docker", mark: true },
      { text: " and ", mark: false },
      { text: "docker", mark: true },
    ]);
  });

  it("keeps the text either side of a middle match", () => {
    expect(markSegments("a docker b", "docker")).toEqual([
      { text: "a ", mark: false },
      { text: "docker", mark: true },
      { text: " b", mark: false },
    ]);
  });

  it("returns the whole text unmarked when nothing matches", () => {
    expect(markSegments("nothing here", "docker")).toEqual([{ text: "nothing here", mark: false }]);
  });

  it("returns the whole text unmarked for an empty query", () => {
    expect(markSegments("nothing here", "")).toEqual([{ text: "nothing here", mark: false }]);
  });

  it("emits no empty segments between adjacent matches", () => {
    expect(markSegments("aaaa", "aa")).toEqual([
      { text: "aa", mark: true },
      { text: "aa", mark: true },
    ]);
  });

  it("joins back to the original text", () => {
    const text = "the docker line, twice: docker.";
    expect(
      markSegments(text, "docker")
        .map((s) => s.text)
        .join(""),
    ).toBe(text);
  });
});
