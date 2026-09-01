// Card 362 — a panel that FILLS gets its own column.
//
// THE PREMISE THAT WAS REFUTED, kept here because the next reader will have the
// same idea: nothing steals height inside the Files panel. Measured across 2980
// parsed rules on 2026-09-01 — `section.dock-panel[data-panel="files"]` has the
// 26px header every dock panel wears and `.dock-panel-body--fill`, nothing
// renders below it, and the height chain is unbroken flex with no `height`, no
// `max-height` and zero at-rule overrides. What the owner saw was the AGENTS
// panel sharing his column: COLUMN_CAP is 2, the shipped default seats agents
// alone, and one press of Files put both at flexGrow 0.5.
//
// So the lever is the seating, not the stylesheet — and a stylesheet fix would
// have been actively harmful: panel-dock.css:9-14 records that the browser
// panel's hole is a rectangle a native WebContentsView is laid over (card 201),
// and a dock that scrolls moves the hole without resizing it.
//
// WHY THE CASES BELOW NAME PANELS INSTEAD OF DERIVING THEM: this file's whole
// job is to prove the seating READS `panelFills` rather than carrying a second
// list that happens to agree with it. A case that derived its own expectation
// from `panelFills` could not tell those two apart — adding a fourth filling
// panel would just move the case from one loop to the other and stay green,
// which is the two-copies-of-one-truth defect card 312 found three times. So
// the sharing case names two prose panels and the separation cases name one
// filling panel each: adding `plan` to the list turns the first red, removing
// `files` from it turns the second red, and a duplicate list in columnModel
// would leave both green.

import { describe, expect, it } from "vitest";
import { COLUMN_CAP, DEFAULT_SPLIT, openInColumns, reconcileColumns } from "./columnModel";
import type { PanelColumn } from "./columnModel";
import { DOCK_ORDER, panelFills } from "./dockModel";

const col = (panels: string[], weight = 1, split = DEFAULT_SPLIT): PanelColumn => ({
  panels,
  weight,
  split,
});

const open = (cols: readonly PanelColumn[], id: string): PanelColumn[] => openInColumns(cols, id, panelFills);

describe("the fill rule now asks whether the panel fills", () => {
  it("two prose panels still share a column — COLUMN_CAP survives this card", () => {
    // agents and plan both scroll as prose. This card changes WHO may share, not
    // how many. Adding either of these to panelFills turns this case red, which
    // is the bite criterion 2 asks for.
    expect(open(open([], "agents"), "plan")).toEqual([col(["agents", "plan"])]);
    expect(COLUMN_CAP).toBe(2);
  });

  it("a filling panel opens its own column instead of joining the last one", () => {
    // The owner's exact gesture: the dock opens on the roster, he presses Files.
    expect(open(open([], "agents"), "files")).toEqual([col(["agents"]), col(["files"])]);
  });

  it("nothing seats UNDER a filling panel either", () => {
    // The other direction of one rule. Without it, opening Files then Plan puts
    // Plan back under the tree and the owner is where he started.
    expect(open(open([], "files"), "plan")).toEqual([col(["files"]), col(["plan"])]);
  });

  it("holds for every panel the predicate names, and for every neighbour", () => {
    // Coverage, derived — the cases above are what BITE, this is what is true
    // of all of them. A panel added to panelFills is covered here the day it
    // is added, without anybody remembering to write a case for it.
    const fillers = DOCK_ORDER.filter(panelFills);
    expect(fillers.length).toBeGreaterThan(0);
    for (const filler of fillers) {
      for (const other of DOCK_ORDER) {
        if (other === filler) continue;
        expect(
          open(open([], other), filler).map((c) => c.panels),
          `${other} then ${filler}`,
        ).toEqual([[other], [filler]]);
        expect(
          open(open([], filler), other).map((c) => c.panels),
          `${filler} then ${other}`,
        ).toEqual([[filler], [other]]);
      }
    }
  });

  it("is still idempotent — an already-seated panel moves nothing", () => {
    const cols = [col(["files"]), col(["agents"])];
    expect(open(cols, "files")).toBe(cols);
  });

  it("seats two prose panels together even when a filling one stands to the left", () => {
    // The fill rule appends to the LAST column, and the last column here is a
    // prose one with room. A rule that refused every join once a filling panel
    // existed anywhere would be a different, larger change than the card asks.
    const cols = [col(["files"]), col(["agents"])];
    expect(open(cols, "plan")).toEqual([col(["files"]), col(["agents", "plan"])]);
  });
});

describe("a stored arrangement from before this card still opens", () => {
  it("separates a shared column, and loses nobody doing it", () => {
    // Criterion 4: `agents,files~1~0.5` is what every reader who pressed Files
    // before this card has in localStorage. It must not throw and must not
    // silently drop the panel.
    const stored = [col(["agents", "files"])];
    const next = reconcileColumns(stored, ["agents", "files"], panelFills);
    expect(next.map((c) => c.panels)).toEqual([["agents"], ["files"]]);
  });

  it("keeps the pair's total width when it splits them", () => {
    // Weights are relative. Two columns of the parent's weight would make the
    // pair twice as wide as it was, at every other column's expense.
    const stored = [col(["agents", "files"], 2), col(["plan"], 2)];
    const next = reconcileColumns(stored, ["agents", "files", "plan"], panelFills);
    expect(next.map((c) => [c.panels, c.weight])).toEqual([
      [["agents"], 1],
      [["files"], 1],
      [["plan"], 2],
    ]);
  });

  it("leaves an arrangement that already obeys the rule exactly as it was", () => {
    const fine = [col(["agents", "plan"], 1.4, 0.3), col(["files"], 2)];
    expect(reconcileColumns(fine, ["agents", "plan", "files"], panelFills)).toBe(fine);
  });

  it("still drops panels the modes closed and refills the ones they opened", () => {
    const stored = [col(["agents", "files"])];
    const next = reconcileColumns(stored, ["agents", "terminal"], panelFills);
    expect(next.map((c) => c.panels)).toEqual([["agents"], ["terminal"]]);
  });
});
