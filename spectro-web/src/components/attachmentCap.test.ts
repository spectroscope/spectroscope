// How many pictures one message may carry.
//
// There is no limit anywhere below this: not on the count, not on the total
// payload. The only ceilings are the 64 MB WebSocket text frame and the 5 MB
// per-image server check, and neither of them is a sentence anybody reads. The
// file picker made a big attachment set deliberate; ⌘V makes twenty images ten
// seconds of work, so the ceiling has to become visible here.

import { describe, expect, it } from "vitest";
import { MAX_PENDING_ATTACHMENTS, withinCap } from "./attachmentCap";

/** A file, reduced to the one field this decision reads. */
function file(name: string): File {
  return { name, type: "image/png" } as File;
}

/** `n` files, named 1..n. */
function files(n: number): File[] {
  return Array.from({ length: n }, (_, i) => file(`${i + 1}.png`));
}

describe("withinCap", () => {
  it("takes everything while there is room", () => {
    const decision = withinCap(0, files(3));
    expect(decision.take.map((f) => f.name)).toEqual(["1.png", "2.png", "3.png"]);
    expect(decision.declined).toBe(0);
  });

  it("counts what is already pending against the ceiling", () => {
    const decision = withinCap(MAX_PENDING_ATTACHMENTS - 2, files(5));
    expect(decision.take).toHaveLength(2);
    expect(decision.declined).toBe(3);
  });

  it("takes nothing once the ceiling is reached", () => {
    const decision = withinCap(MAX_PENDING_ATTACHMENTS, files(1));
    expect(decision.take).toEqual([]);
    expect(decision.declined).toBe(1);
  });

  it("keeps the first of an oversized paste rather than the last", () => {
    // Silently keeping the tail would drop the picture somebody watched
    // themselves copy. Clipboard order is the order they meant.
    const decision = withinCap(0, files(MAX_PENDING_ATTACHMENTS + 4));
    expect(decision.take[0]?.name).toBe("1.png");
    expect(decision.take).toHaveLength(MAX_PENDING_ATTACHMENTS);
    expect(decision.declined).toBe(4);
  });

  it("says nothing was declined when nothing was offered", () => {
    // An empty offer must not raise a notice — a paste of plain text reaches
    // this with no files at all.
    expect(withinCap(0, [])).toEqual({ take: [], declined: 0 });
  });
});
