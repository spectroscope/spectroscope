// Card 211. `openH` is the single number the trace window's whole arithmetic
// rests on: `total`, `padTop`, `padBottom` and every offset the stepper and the
// search walk compute are that number plus multiples of one row. When it is
// wrong the scroller's real `scrollHeight` stops describing its content, the
// browser clamps `scrollTop` to whichever of the two is shorter, and the reader
// is thrown somewhere they never asked for — measured on the owner's session
// 20260810-230306-72871659 as scrollTop 1600 → 463 with the detail gone.
//
// Two ways it went wrong, and this guard pins both against coming back. Neither
// can be reached by a pure test: they are about which DOM node is measured and
// when, and this project's vitest runs without a DOM.
//
//   1. THE WRONG NODE. `[data-seq=…]` is the row BUTTON. The detail is its
//      SIBLING, not its child, so `row.offsetHeight` read 25 px under a 1,143 px
//      detail — measured, both numbers, on the row above. The window then placed
//      every row below the open one against a total short by the whole detail.
//      The block wrapper `[data-block-seq=…]` is the thing the row occupies.
//
//   2. THE WRONG MOMENT. The measurement used to be a `useLayoutEffect` keyed on
//      `[openSeq]` that returned early when the row was not in the DOM:
//
//          const row = scrollRef.current?.querySelector(`[data-seq="${openSeq}"]`);
//          if (row === null || row === undefined) return;
//
//      One run per opened row, no measurement and no observer if that run missed,
//      and nothing to re-run it — so a row opened outside the window, or
//      remounted after a filter, kept whatever number happened to be there. A ref
//      callback cannot miss: React calls it on every mount and unmount of the
//      node it is attached to.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const view = readFileSync(fileURLToPath(new URL("./TraceView.tsx", import.meta.url)), "utf8");

/** Blank out comments, keeping newlines, so the prose above cannot satisfy the
 *  guard it describes. */
const code = view.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");

describe("the open row's height is measured from the block it occupies", () => {
  it("still finds the two things it is about, so a clean pass is not a broken parser", () => {
    expect(code).toContain("data-block-seq");
    expect(code).toContain("setOpenH");
  });

  it("puts the height marker on a wrapper around the detail, not on the button", () => {
    // The wrapper must sit OUTSIDE the button that carries data-seq. If the two
    // markers ever land on the same element the measurement is the button's
    // again, and the detail is invisible to it.
    const wrapper = code.indexOf("data-block-seq");
    const button = code.indexOf("data-seq={entry.seq}");
    expect(wrapper).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(wrapper);
    expect(code).toMatch(/<div className="trace-rowblock" data-block-seq=/);
  });

  it("never reads the height off the row button again", () => {
    // Every remaining querySelector on data-seq is a FOCUS or a scroll target —
    // those want the button, which is the focusable element. None of them may
    // feed the height.
    const heightOffDataSeq = /querySelector[^\n]*data-seq[^\n]*\n?[^\n]*offsetHeight/.test(code);
    expect(heightOffDataSeq).toBe(false);
    expect(code).not.toMatch(/setOpenH\(\s*row\.offsetHeight/);
  });

  it("attaches the measurement by ref callback, so a remount re-measures", () => {
    // The row's block reports itself; the view does not go looking for it once.
    expect(code).toMatch(/const measureOpen = useCallback\(\(el: HTMLDivElement \| null\)/);
    expect(code).toMatch(/blockRef=\{openSeq === e\.seq \? measureOpen : undefined\}/);
    // And the old shape stays gone: no effect keyed on openSeq alone that walks
    // the DOM for the open row and gives up when it is not there.
    expect(code).not.toMatch(/querySelector[^\n]*\$\{openSeq\}/);
  });

  it("keeps the last height when the row unmounts instead of zeroing it", () => {
    // A row that is not built still occupies its height in the arithmetic —
    // that is what the spacers stand in for. Zeroing on unmount is exactly the
    // too-small total that makes the browser clamp and the reader jump.
    const from = code.indexOf("const measureOpen");
    const body = code.slice(from, code.indexOf("\n  }, []);", from));
    expect(body).toMatch(/if \(el === null\) return;/);
    // Zeroing belongs to closing the row, which is a different event and lives
    // in its own effect. Inside the measurement it would be the defect.
    expect(body).not.toMatch(/setOpenH\(0\)/);
  });
});

describe("the open row is built even when the scroll has left it behind", () => {
  it("renders the pinned row from the same call as the windowed rows", () => {
    // Same function, same key: one keyed array, so React moves the DOM node
    // between the pinned slot and the window rather than remounting it — and
    // the ResizeObserver rides along.
    expect(code).toMatch(/rowChildren\.push\(renderRow\(slice\.pinIndex\)\)/);
    expect(code).toMatch(
      /for \(let i = slice\.start; i < slice\.end; i \+= 1\) rowChildren\.push\(renderRow\(i\)\)/,
    );
    // Both sides of the window, or the row vanishes whichever way you scroll.
    expect(code.match(/rowChildren\.push\(renderRow\(slice\.pinIndex\)\)/g)?.length).toBe(2);
  });
});
