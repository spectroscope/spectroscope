import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearReportedViews,
  reportView,
  reportedViewFor,
  subscribeReportedViews,
  takeIncomingView,
  offerIncomingView,
  incomingGeneration,
} from "./viewReport";

beforeEach(() => clearReportedViews());

describe("what a view reports", () => {
  it("gives back only the report of the tab being asked about", () => {
    // The address describes the view you are LOOKING at. A trace row hanging
    // off a spectrum link would be state nobody chose and nobody can see.
    reportView("trace", { row: 12 });
    reportView("spectrum", { win: { a: 0.2, b: 0.5 } });

    expect(reportedViewFor("trace")).toEqual({ row: 12 });
    expect(reportedViewFor("spectrum")).toEqual({ win: { a: 0.2, b: 0.5 } });
  });

  it("says nothing for a tab that reports nothing", () => {
    reportView("trace", { row: 3 });

    expect(reportedViewFor("chat")).toEqual({});
    expect(reportedViewFor("lab")).toEqual({});
    expect(reportedViewFor(null)).toEqual({});
  });

  it("keeps a per-tab report while another tab overwrites its own", () => {
    reportView("trace", { row: 1 });
    reportView("spectrum", { win: { a: 0, b: 0.5 } });
    reportView("spectrum", { win: { a: 0.5, b: 1 } });

    expect(reportedViewFor("trace")).toEqual({ row: 1 });
    expect(reportedViewFor("spectrum")).toEqual({ win: { a: 0.5, b: 1 } });
  });

  it("forgets everything when the session under the views changes", () => {
    // Row 12 of one session addresses nothing in the next one, and a window
    // fitted to one run's clock is meaningless against another's.
    reportView("trace", { row: 12 });
    reportView("spectrum", { win: { a: 0.2, b: 0.5 } });

    clearReportedViews();

    expect(reportedViewFor("trace")).toEqual({});
    expect(reportedViewFor("spectrum")).toEqual({});
  });
});

describe("subscribers", () => {
  it("wakes on a report and stops on unsubscribe", () => {
    const woke = vi.fn();
    const stop = subscribeReportedViews(woke);

    reportView("trace", { row: 1 });
    expect(woke).toHaveBeenCalledTimes(1);

    stop();
    reportView("trace", { row: 2 });
    expect(woke).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when a report says what the store already holds", () => {
    // The store is read during render, so a report that changes nothing must
    // not schedule one: a view that reports on every frame of a zoom drag
    // would otherwise re-render the whole app per frame.
    reportView("spectrum", { win: { a: 0.2, b: 0.5 } });
    const woke = vi.fn();
    subscribeReportedViews(woke);

    reportView("spectrum", { win: { a: 0.2, b: 0.5 } });
    expect(woke).not.toHaveBeenCalled();

    reportView("spectrum", { win: { a: 0.2, b: 0.6 } });
    expect(woke).toHaveBeenCalledTimes(1);
  });

  it("hands the same object back until something changes", () => {
    // useSyncExternalStore compares snapshots by identity and loops forever on
    // a fresh object per read.
    reportView("trace", { row: 7 });
    expect(reportedViewFor("trace")).toBe(reportedViewFor("trace"));
  });
});

describe("an offer wakes the view it is for", () => {
  it("notifies, so a view can take it without waiting for its data to change", () => {
    // The defect this exists to prevent, found live: the trace took its
    // incoming reading in an effect keyed on the entries. Navigating WITHIN a
    // session does not change the entries, so back and forward between two
    // readings of the same session moved the address and not the view. An
    // offer has to be a signal in its own right.
    const woke = vi.fn();
    subscribeReportedViews(woke);

    offerIncomingView("trace", { row: 12 });

    expect(woke).toHaveBeenCalledTimes(1);
  });

  it("moves the generation on every offer, including two alike", () => {
    // Two offers of the same reading are two navigations, and the second one
    // still has to reach a view the reader has since scrolled away from.
    const first = incomingGeneration();
    offerIncomingView("trace", { row: 12 });
    const second = incomingGeneration();
    offerIncomingView("trace", { row: 12 });

    expect(second).not.toBe(first);
    expect(incomingGeneration()).not.toBe(second);
  });

  it("does not move for an offer that says nothing", () => {
    const before = incomingGeneration();
    offerIncomingView("trace", {});
    expect(incomingGeneration()).toBe(before);
  });
});

describe("an address arriving at a view", () => {
  it("is taken exactly once, by the view it names", () => {
    // Once, because a view that re-applied its incoming state on every render
    // could never be scrolled or zoomed away from.
    offerIncomingView("trace", { row: 12, only: ["tool"] });

    expect(takeIncomingView("trace")).toEqual({ row: 12, only: ["tool"] });
    expect(takeIncomingView("trace")).toBeUndefined();
  });

  it("is not taken by a different view", () => {
    offerIncomingView("trace", { row: 12 });

    expect(takeIncomingView("spectrum")).toBeUndefined();
    expect(takeIncomingView("trace")).toEqual({ row: 12 });
  });

  it("is dropped when it says nothing", () => {
    // An address with no query means "however you have it", so it must not
    // arrive as an instruction to reset the view to nothing.
    offerIncomingView("trace", {});

    expect(takeIncomingView("trace")).toBeUndefined();
  });

  it("is replaced by a later offer rather than queued", () => {
    offerIncomingView("spectrum", { win: { a: 0, b: 0.5 } });
    offerIncomingView("spectrum", { win: { a: 0.5, b: 1 } });

    expect(takeIncomingView("spectrum")).toEqual({ win: { a: 0.5, b: 1 } });
    expect(takeIncomingView("spectrum")).toBeUndefined();
  });

  it("goes away with the session it belonged to", () => {
    offerIncomingView("trace", { row: 12 });

    clearReportedViews();

    expect(takeIncomingView("trace")).toBeUndefined();
  });
});
