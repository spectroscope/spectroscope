// Card 504, last fix round: a settings write that follows a frame runs when
// that frame reaches a socket (App's onSent), never on the strength of the
// sender's answer. On a stored session the answer is true once the frame
// joined or started a resume, and a failed events fetch drops the frame.

import { describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "../events";
import { ResumeJoin } from "./resumeJoin";
import { SentWrites } from "./sentWrites";

const AUTO: ClientMessage = { type: "set_permission_mode", mode: "auto" };
const READONLY: ClientMessage = { type: "set_permission_mode", mode: "readonly" };

describe("a write held for a frame", () => {
  it("runs once when that frame of that session reaches the wire", () => {
    const writes = new SentWrites();
    const write = vi.fn();
    writes.hold("s1", AUTO, write);
    writes.sent("s2", AUTO);
    writes.sent("s1", READONLY);
    writes.sent(null, AUTO);
    expect(write).not.toHaveBeenCalled();
    writes.sent("s1", AUTO);
    writes.sent("s1", AUTO);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("is replaced by a later hold of the same frame type, so only the last choice writes", () => {
    const writes = new SentWrites();
    const first = vi.fn();
    const second = vi.fn();
    writes.hold("s1", AUTO, first);
    writes.hold("s1", READONLY, second);
    writes.sent("s1", AUTO);
    writes.sent("s1", READONLY);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("goes when the frame did not leave", () => {
    const writes = new SentWrites();
    const write = vi.fn();
    writes.hold("s1", AUTO, write);
    writes.drop("s1", AUTO);
    writes.sent("s1", AUTO);
    expect(write).not.toHaveBeenCalled();
  });

  it("never runs when the resume the frame joined fails, and is gone afterwards", () => {
    let newest = 1;
    const join = new ResumeJoin((ticket) => ticket === newest);
    const writes = new SentWrites();
    const write = vi.fn();
    // The gear on a stored session: the frame starts the resume and is held.
    writes.hold("s1", AUTO, write);
    join.begin("s1", newest, [AUTO]);
    // The resume fails: App's catch takes the frames and drops their writes.
    const taken = join.take(newest);
    expect(taken, "positive: the resume held the frame").toEqual([AUTO]);
    for (const frame of taken) writes.drop("s1", frame);
    expect(write).not.toHaveBeenCalled();
    // Last fix round 2026-10-12: the same frame reaching a socket later by
    // another path does not run the old write.
    newest = 2;
    join.begin("s1", newest, [AUTO]);
    for (const frame of join.take(newest)) writes.sent("s1", frame);
    expect(write).not.toHaveBeenCalled();
  });
});

// Card 504, final round of 2026-10-12: two holds for the same frame (the
// project-file write and the gear's mark of a stored session) both run.
describe("two holds for the same frame", () => {
  it("both run when the frame reaches the wire, and both go when it is dropped", () => {
    const writes = new SentWrites();
    const write = vi.fn();
    const mark = vi.fn();
    writes.hold("s1", AUTO, write);
    writes.hold("s1", AUTO, mark);
    writes.sent("s1", AUTO);
    expect(write).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledTimes(1);

    const write2 = vi.fn();
    const mark2 = vi.fn();
    writes.hold("s1", READONLY, write2);
    writes.hold("s1", READONLY, mark2);
    writes.drop("s1", READONLY);
    writes.sent("s1", READONLY);
    expect(write2).not.toHaveBeenCalled();
    expect(mark2).not.toHaveBeenCalled();
  });
});
