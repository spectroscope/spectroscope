// Card 321, review round. `chipFor` reads its kind→chip table with a key that
// TypeScript guarantees is in the union — and reads the miss as a HIT:
//
//     const byShape = CHIP_FOR_KIND[viewKindOf(tool)];
//     if (byShape !== null) return byShape;          // undefined !== null
//
// A kind the table has no key for came back as `undefined`, and `undefined` is
// neither a chip nor a null. `agentBelt` then lights nothing (`name ===
// undefined` is false for every chip) AND skips the honesty half, because that
// one guards on `lit === null`. Total darkness — the exact defect this card was
// written to remove — with nothing red anywhere.
//
// The type system makes it unreachable while describeTool's runtime kinds stay
// inside its declared union, so this file buys the guarantee the types cannot:
// it MOCKS the classifier into answering a kind off the union and demands the
// belt still says what is running. Its own file because the mock is file-wide.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/toolViews", () => ({
  // Off the union on purpose. Not a tool name and not a kind the product has:
  // the point is only that the table has no key for it.
  describeTool: () => ({ kind: "zzz-off-union" }),
}));

import { agentBelt } from "./belt";

describe("a shape the kind table has no key for (card 321)", () => {
  it("is still reported as running, never silently dark", () => {
    const belt = agentBelt("zzz-no-such-tool");
    const on = belt.filter((c) => c.on);
    expect(on, "the belt went dark for a running tool — the defect card 321 removes").toHaveLength(1);
    expect(on[0].name).toBe("zzz-no-such-tool");
  });
});
