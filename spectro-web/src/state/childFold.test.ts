// Card 271: the fold state and the one rule that keeps opening it from moving
// the reader. Pure, because this suite has no DOM and a rule nobody can fail is
// not a rule.
import { describe, expect, it } from "vitest";
import { NO_FOLDS_OPEN, foldScrollDelta, foldedTurns, isFoldOpen, toggleFold } from "./childFold";
import type { ThreadItem } from "./threads";
import type { Turn } from "./reducer";

describe("which children a reader has opened", () => {
  it("closed is where every child starts", () => {
    expect(isFoldOpen(NO_FOLDS_OPEN, "live", "worker-1")).toBe(false);
  });

  it("opens and closes again", () => {
    const open = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    expect(isFoldOpen(open, "live", "worker-1")).toBe(true);
    expect(isFoldOpen(toggleFold(open, "live", "worker-1"), "live", "worker-1")).toBe(false);
  });

  it("opening one child leaves its siblings closed", () => {
    const open = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    expect(isFoldOpen(open, "live", "worker-2")).toBe(false);
  });

  it("a child opened in the live run is NOT open in an opened archive", () => {
    // Ids repeat: every run has a worker-1. App swaps props on the same ChatV2
    // instead of remounting it, so without the view in the key an archive would
    // open already unfolded, showing last week's child because this week's was
    // clicked.
    const open = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    expect(isFoldOpen(open, "sess-2026-08-11", "worker-1")).toBe(false);
  });

  it("toggling leaves the set it was given alone", () => {
    // React compares by identity; mutating in place would render nothing.
    const before = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    const after = toggleFold(before, "live", "worker-2");
    expect(after).not.toBe(before);
    expect(isFoldOpen(before, "live", "worker-2")).toBe(false);
  });
});

describe("opening a fold must not move the reader", () => {
  // Card 271 criterion 5. Card 257 has NOT landed, so this card states its own
  // rule: the chip that was clicked keeps its place on screen, and a reader
  // pinned to the bottom stays pinned — the bottom-pin effect owns that case
  // and this rule stands aside rather than fighting it for the same pixel.

  it("a reader pinned to the bottom is not compensated at all", () => {
    expect(foldScrollDelta({ pinned: true, topBefore: 500, topAfter: 120 })).toBe(0);
  });

  it("a chip pushed down by content above is pulled back to where it was", () => {
    expect(foldScrollDelta({ pinned: false, topBefore: 300, topAfter: 460 })).toBe(160);
  });

  it("a chip pulled up by a fold closing above it is pushed back down", () => {
    expect(foldScrollDelta({ pinned: false, topBefore: 300, topAfter: 140 })).toBe(-160);
  });

  it("a chip that did not move is not touched", () => {
    // The common case: the fold opened BELOW the chip, so nothing above it grew.
    expect(foldScrollDelta({ pinned: false, topBefore: 300, topAfter: 300 })).toBe(0);
  });
});

describe("which turns a chip shows", () => {
  // The pure half of card 271's criterion 1. This suite has no jsdom and cannot
  // click, so the decision a click leads to is made HERE, where it can be
  // bitten, and Chat is pinned separately on calling it.
  const turnOf = (text: string): Turn => ({ kind: "assistant", agentId: "w1", text, thinking: "" });
  const items = (...texts: string[]): ThreadItem[] =>
    texts.map((text, i) => ({ turn: turnOf(text), index: i }));
  const threads = { "worker-1": items("planning", "done"), "worker-2": items("reading") };

  it("shows nothing while everything is closed — the shipped reading", () => {
    expect(foldedTurns(threads, ["worker-1", "worker-2"], NO_FOLDS_OPEN, "live")).toEqual([]);
  });

  it("shows the opened child's own turns, and only that child's", () => {
    const open = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    expect(foldedTurns(threads, ["worker-1", "worker-2"], open, "live")).toEqual([
      { agentId: "worker-1", items: threads["worker-1"] },
    ]);
  });

  it("keeps the chip's own order when two are open, not the order they were clicked", () => {
    let open = toggleFold(NO_FOLDS_OPEN, "live", "worker-2");
    open = toggleFold(open, "live", "worker-1");
    expect(foldedTurns(threads, ["worker-1", "worker-2"], open, "live").map((f) => f.agentId)).toEqual([
      "worker-1",
      "worker-2",
    ]);
  });

  it("an open child the record knows nothing about shows no empty container", () => {
    // A chip can name an agent the walk saw once and never again; drawing an
    // empty bordered box for it would look like a rendering fault.
    const open = toggleFold(NO_FOLDS_OPEN, "live", "ghost-9");
    expect(foldedTurns(threads, ["ghost-9"], open, "live")).toEqual([]);
  });

  it("nor does one recorded with an empty list — both shapes of nothing", () => {
    // Two ways to have no turns, and only one of them was covered: the test
    // above hands a MISSING key, which an `items === undefined` check alone
    // would also survive. Measured — biting the length guard left the suite
    // green until this case existed.
    const open = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    expect(foldedTurns({ "worker-1": [] }, ["worker-1"], open, "live")).toEqual([]);
  });

  it("a fold opened in the live run does not open the same id in an archive", () => {
    const open = toggleFold(NO_FOLDS_OPEN, "live", "worker-1");
    expect(foldedTurns(threads, ["worker-1"], open, "sess-2026-08-11")).toEqual([]);
  });
});
