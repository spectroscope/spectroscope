// Card 300, step 1: the lab's right dock lives in the same tiny store as its
// two neighbours, and obeys the same three promises — it persists, it heals a
// poisoned blob, and it EMITS.
//
// The emit is not decoration. layout.ts's own comment names the trap: a field
// added to LayoutState and not to set()'s field-by-field comparison is written
// and then discarded, because set() returns early on "no change". The width
// test below fails loudly in exactly that case.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __getState,
  __resetForTests,
  DEFAULT_LAYOUT,
  hydrateLayout,
  readLayoutBlob,
  setCtxW,
  toggleCtx,
} from "./layout";

beforeEach(() => __resetForTests());

describe("the lab's context dock (card 300)", () => {
  it("a collapsed dock is the default — it costs nothing until it is asked for", () => {
    expect(DEFAULT_LAYOUT.ctxOpen).toBe(false);
    expect(__getState().ctxOpen).toBe(false);
  });

  it("the toggle flips it, both ways", () => {
    toggleCtx();
    expect(__getState().ctxOpen).toBe(true);
    toggleCtx();
    expect(__getState().ctxOpen).toBe(false);
  });

  it("the width is settable and clamps like the panes beside it", () => {
    setCtxW(360);
    expect(__getState().ctxW).toBe(360);
    setCtxW(10);
    expect(__getState().ctxW).toBe(200);
    setCtxW(99999);
    expect(__getState().ctxW).toBe(1200);
  });

  it("a stored blob carries both fields back", () => {
    const state = hydrateLayout({ ctxW: 412, ctxOpen: true, dockAgents: "open" }, null);
    expect(state.ctxW).toBe(412);
    expect(state.ctxOpen).toBe(true);
  });

  it("a blob whose ctxW is not a number resets the layout rather than wedging it", () => {
    const read = readLayoutBlob(JSON.stringify({ ctxW: "wide" }), null);
    expect(read.recovered).toBe(true);
    expect(read.state.ctxW).toBe(DEFAULT_LAYOUT.ctxW);
  });

  it("a blob whose ctxOpen is not a boolean does the same", () => {
    const read = readLayoutBlob(JSON.stringify({ ctxOpen: "yes" }), null);
    expect(read.recovered).toBe(true);
    expect(read.state.ctxOpen).toBe(false);
  });

  it("a pre-card blob simply has no dock, and gets the default", () => {
    const state = hydrateLayout({ chatW: 300 }, null);
    expect(state.ctxOpen).toBe(false);
    expect(state.ctxW).toBe(DEFAULT_LAYOUT.ctxW);
  });
});
