// Card 520: the Files pane's answers, one query at a time.
//
// A click from one stored session to the next changes the pane's query. The
// live check of 2026-10-11 found the pane stuck on "loading" after ten quick
// clicks that ended on the session it had shown first: the tree was cleared
// for the new query, and the answer, identical to the one seen before, was
// dropped by the dedupe as "nothing changed". The fold keeps the dedupe per
// query and drops answers for a query the pane has left.

import { describe, expect, it } from "vitest";
import { answered, askFor, emptyFetch, failed } from "./filesFetch";

const A = "session=a";
const B = "session=b";
const treeA = { root: "ForgeDemo" };
const treeB = { root: "Other" };

describe("the Files pane's answers", () => {
  it("draws the first answer and keeps an identical one as it is", () => {
    let s = askFor(emptyFetch<typeof treeA>(), A);
    s = answered(s, A, '{"a":1}', treeA);
    expect(s.tree).toBe(treeA);
    expect(s.outcome).toEqual({ kind: "ok" });
    const again = answered(s, A, '{"a":1}', { root: "ForgeDemo" });
    expect(again.tree).toBe(treeA);
  });

  it("a new query starts from no answer", () => {
    let s = answered(askFor(emptyFetch<typeof treeA>(), A), A, '{"a":1}', treeA);
    s = askFor(s, B);
    expect(s.tree).toBeNull();
    expect(s.outcome).toBeNull();
    expect(askFor(s, B)).toBe(s);
  });

  it("drops an answer or a failure for a query the pane has left", () => {
    let s = askFor(emptyFetch<typeof treeA>(), A);
    s = askFor(s, B);
    expect(answered(s, A, '{"a":1}', treeA)).toBe(s);
    expect(failed(s, A, { kind: "offline" })).toBe(s);
  });

  it("A, B, back to A: the same answer as before draws the tree again", () => {
    let s = answered(askFor(emptyFetch<typeof treeA>(), A), A, '{"a":1}', treeA);
    s = answered(askFor(s, B), B, '{"b":1}', treeB);
    s = askFor(s, A);
    expect(s.tree).toBeNull();
    s = answered(s, A, '{"a":1}', treeA);
    expect(s.tree).toBe(treeA);
    expect(s.outcome).toEqual({ kind: "ok" });
  });

  it("A, no query, back to A draws the tree again", () => {
    let s = answered(askFor(emptyFetch<typeof treeA>(), A), A, '{"a":1}', treeA);
    s = askFor(s, null);
    s = answered(askFor(s, A), A, '{"a":1}', treeA);
    expect(s.tree).toBe(treeA);
  });

  it("a failure keeps the tree and says why", () => {
    let s = answered(askFor(emptyFetch<typeof treeA>(), A), A, '{"a":1}', treeA);
    s = failed(s, A, { kind: "status", status: 404 });
    expect(s.outcome).toEqual({ kind: "status", status: 404 });
    expect(s.tree).toBe(treeA);
  });
});
