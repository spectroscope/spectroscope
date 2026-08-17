// Card 247: /skill tokens inside a message. The SHAPE rule is the twin of the
// Java side's SkillInvocations (SkillInvocationsTest.java carries the same
// vectors): a slash at the start or after a non-word, non-slash character,
// then a name in the skill charset. What the server expands and what the
// client colors must be the same reading, or the color becomes a lie.

import { describe, expect, it } from "vitest";
import { skillTokenSegments, tokenSpans } from "./skillTokens";
import { read, stripComments } from "../testkit/source";

const KNOWN = new Set(["writing-plans", "brainstorming", "humanizer", "superpowers:test-driven-development"]);

describe("tokenSpans — the twin of the Java shape rule", () => {
  it("finds tokens at the start, mid-sentence and in packs", () => {
    expect(tokenSpans("/humanizer fix this").map((s) => s.name)).toEqual(["humanizer"]);
    expect(tokenSpans("review this /writing-plans /brainstorming please").map((s) => s.name)).toEqual([
      "writing-plans",
      "brainstorming",
    ]);
    expect(tokenSpans("do it /superpowers:test-driven-development").map((s) => s.name)).toEqual([
      "superpowers:test-driven-development",
    ]);
  });

  it("punctuation ends a token without joining it", () => {
    expect(tokenSpans("run /humanizer, then stop").map((s) => s.name)).toEqual(["humanizer"]);
    expect(tokenSpans("(/humanizer)").map((s) => s.name)).toEqual(["humanizer"]);
  });

  it("a slash inside a word or path is no invocation", () => {
    expect(tokenSpans("look at /tmp/x").map((s) => s.name)).toEqual(["tmp"]);
    expect(tokenSpans("3/4 of the time")).toEqual([]);
    expect(tokenSpans("and/or")).toEqual([]);
  });
});

describe("skillTokenSegments — what the transcript colors", () => {
  it("splits around known tokens and reproduces the text exactly", () => {
    const text = "review this /writing-plans /brainstorming please";
    const segs = skillTokenSegments(text, KNOWN);
    expect(segs.map((s) => s.skill)).toEqual([null, "writing-plans", null, "brainstorming", null]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs[1].text).toBe("/writing-plans");
  });

  it("an unknown name stays plain prose — the color never lies", () => {
    const segs = skillTokenSegments("look at /tmp/x and /nothing", KNOWN);
    expect(segs).toEqual([{ text: "look at /tmp/x and /nothing", skill: null }]);
  });

  it("a text without tokens is one plain segment", () => {
    expect(skillTokenSegments("no slash here", KNOWN)).toEqual([{ text: "no slash here", skill: null }]);
  });
});

describe("the consumers — the fold is consulted, not just exported", () => {
  const chat = stripComments(read("../components/Chat.tsx", import.meta.url));

  it("the sent user turn renders the segments in the accent voice", () => {
    // The TURN's call, not the draft's — a first bite pass proved the loose
    // `skillTokenSegments(` matched the composer memo and let a dead
    // transcript consumer ship green.
    expect(chat).toContain("skillTokenSegments(turn.text, knownSkills)");
    expect(chat).toContain('"skill-token"');
  });

  it("the composer carries the pill underlay, scroll-synced", () => {
    expect(chat).toContain('"composer-marks"');
    expect(chat).toContain("skill-pill");
    expect(chat).toContain("marksRef");
  });
});
