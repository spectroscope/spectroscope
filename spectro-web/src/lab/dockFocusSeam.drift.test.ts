// Card 301, fix round: the OUTER half of the focus seam, which nothing held.
//
// The seam runs App.tsx -> LabView -> LabDock -> the handover and file rows.
// Its inner half was pinned (LabCtxDock.test.tsx renders LabView with a seam
// and without one, and reads the rows' `disabled` either way). Its outer half
// was not: `onFocusEvent={focusInTrace}` could be deleted from App.tsx's one
// LabView mount and the whole gate stayed green — 350 files, 5119 tests —
// while every handover row and every file row in the shipped app rendered
// disabled, quietly, with the "show in the trace" promise simply not made.
//
// A dropped prop is the same hole as an unmounted component, one level down,
// and componentReach.drift.test.ts already says so in those words. There is no
// DOM in this suite and App.tsx cannot be rendered here (it opens a websocket
// and owns the whole shell), so the seam is read off disk — the pattern
// traceSeam.drift.test.ts uses for the two App.tsx lines it holds.

import { describe, expect, it } from "vitest";
import { read } from "../testkit/source";

const app = read("../App.tsx", import.meta.url);
const labView = read("./LabView.tsx", import.meta.url);

/**
 * The JSX element `<Name … />` as text, from its first mount.
 *
 * Read to the element's own `/>`, and asserted to exist: a slice that quietly
 * returns "" would make every check below green against nothing.
 */
function element(src: string, name: string): string {
  const from = src.indexOf(`<${name}`);
  expect(from, `<${name} must be mounted`).toBeGreaterThan(-1);
  const to = src.indexOf("/>", from);
  expect(to, `<${name} must be a self-closing element`).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe("the lab's focus seam reaches the dock from App", () => {
  it("has the one LabView mount this file knows about", () => {
    // A second, unpinned mount is how the fleet's trace pane came to announce
    // another record's losses for a whole release.
    expect(app.split("<LabView").length - 1).toBe(1);
  });

  it("hands App's focusInTrace to it — the same seam, not a fourth one", () => {
    expect(element(app, "LabView")).toContain("onFocusEvent={focusInTrace}");
  });

  it("and focusInTrace is the function App actually declares", () => {
    // The premise of the check above, kept beside it: a renamed seam would make
    // that string an assertion about a name nothing defines.
    expect(app).toContain("const focusInTrace = (agentId: string, event: RunEvent): void =>");
  });

  it("LabView passes it on to the dock rather than stopping with it", () => {
    expect(labView.split("<LabDock").length - 1).toBe(1);
    expect(element(labView, "LabDock")).toContain("onFocusEvent={props.onFocusEvent}");
  });
});
