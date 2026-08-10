// Who can be talked to, and what the answer means (card 166's server leg).
//
// The rule lives here rather than inline in the card, because it is the one
// piece the UI and the server must agree on: the server refuses a node with no
// trigger, and a composer that offered the box anyway would collect a sentence
// only to throw it away at the POST. Both faces read the same predicate.

import { describe, expect, it } from "vitest";
import { canTakeMessages, sendOutcome } from "./nodeMessaging";

describe("which nodes can be talked to", () => {
  it("accepts a connected node that announced a trigger", () => {
    // A trigger means a run loop, and a run loop is what the words fire.
    expect(canTakeMessages({ connected: true, trigger: "watch:/tmp/drop" })).toBe(true);
    expect(canTakeMessages({ connected: true, trigger: "listen:127.0.0.1:8300" })).toBe(true);
  });

  it("refuses a node with no trigger even when it is connected", () => {
    // A plain `spectro node --linger` parks on its stop latch and has no run
    // loop at all — the words would reach it and go nowhere. The server answers
    // 409 for exactly this, and the composer must not ask for a sentence it
    // already knows will be refused.
    expect(canTakeMessages({ connected: true, trigger: null })).toBe(false);
    expect(canTakeMessages({ connected: true, trigger: undefined })).toBe(false);
    expect(canTakeMessages({ connected: true, trigger: "" })).toBe(false);
  });

  it("refuses a node that has left", () => {
    expect(canTakeMessages({ connected: false, trigger: "watch:/tmp/drop" })).toBe(false);
  });
});

describe("what the endpoint's answer means to the operator", () => {
  it("reads 202 as sent, never as answered", () => {
    // The whole control plane is best-effort with no ack — a UI that said
    // "delivered" would be claiming something the server never learns.
    expect(sendOutcome(202)).toEqual({ ok: true, key: "bus.messageSent" });
  });

  it("reads 409 as a node that cannot take it", () => {
    expect(sendOutcome(409)).toEqual({ ok: false, key: "bus.messageRefused" });
  });

  it("reads 404 as a node that is no longer there", () => {
    expect(sendOutcome(404)).toEqual({ ok: false, key: "bus.messageGone" });
  });

  it("reads anything else as a failure rather than a quiet success", () => {
    // Including the 400 for blank text, and a 0 for a fetch that never landed.
    // Every unmapped answer is a failure — a composer that clears itself on an
    // unknown status would eat the sentence.
    for (const status of [0, 400, 415, 500, 503]) {
      expect(sendOutcome(status).ok, String(status)).toBe(false);
    }
  });
});
