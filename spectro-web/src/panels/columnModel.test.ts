// Card 236 — the column model behind the workspace. The owner used the 228
// grid for real and the motion was wrong, twice over, measured on the live
// build (2026-08-14, main at 4777314):
//
// 1. Opening panels one by one went side-by-side → row-wrap (a second panel
//    landed BESIDE the first, a third halved everyone's height), not the
//    reference's full-height → split → new-column.
// 2. Resizing 1440→760 moved Files from beside Agents to under Agents: the
//    grid's `repeat(auto-fit, minmax(240px, 1fr))` derives the column COUNT
//    from the available width and re-flows the cards row-major on every
//    breakpoint. The window size fed the assignment.
//
// The card's cure: an ordered list of columns, each holding one or two panel
// ids, plus a width weight per column and a split ratio per column. Opening
// appends by the fill rule; closing removes and collapses emptied columns;
// the WINDOW SIZE never feeds the assignment — only the pixel projection.
// This module is that model, pure and DOM-free like the rest of the suite.

import { describe, expect, it } from "vitest";
import {
  closeInColumns,
  DEFAULT_SPLIT,
  openInColumns,
  panelsInColumns,
  parseColumns,
  RATIO_CEIL,
  RATIO_FLOOR,
  reconcileColumns,
  separateFills,
  serializeColumns,
  setColumnPairShare,
  setColumnSplit,
} from "./columnModel";
import type { PanelColumn } from "./columnModel";

const IDS = ["work", "agents", "plan", "context", "files", "terminal", "browser"] as const;

const col = (panels: string[], weight = 1, split = DEFAULT_SPLIT): PanelColumn => ({
  panels,
  weight,
  split,
});

/**
 * Card 362 gave the fill rule a predicate: a panel whose body owns its layout
 * gets a column to itself. This module stayed id-agnostic, so these cases hand
 * over their own answer rather than importing the app's.
 *
 * NONE is "nothing fills" — the cases below it are about how MANY panels may
 * share a column, which is what they were about before the card too, and the
 * ids in them (files, terminal) are stand-ins for "some panel". What the app's
 * own predicate makes true is pinned next door in fillSeating.test.ts, against
 * panels/dockModel.panelFills, because that is where a second copy of the list
 * would have to be caught.
 */
const NONE = (): boolean => false;
/** …and its opposite, for the cases about the rule itself. */
const ALL = (): boolean => true;

describe("the fill rule, exactly as the owner said it", () => {
  it("one open panel takes one column — the full height is the projection's job", () => {
    expect(openInColumns([], "agents", NONE)).toEqual([col(["agents"])]);
  });

  it("a second panel splits the first column", () => {
    const one = openInColumns([], "agents", NONE);
    expect(openInColumns(one, "files", NONE)).toEqual([col(["agents", "files"])]);
  });

  it("a third opens a NEW column to the right, alone at full height", () => {
    const two = openInColumns(openInColumns([], "agents", NONE), "files", NONE);
    expect(openInColumns(two, "terminal", NONE)).toEqual([col(["agents", "files"]), col(["terminal"])]);
  });

  it("a fourth splits that new column — the pattern continues", () => {
    let cols: PanelColumn[] = [];
    for (const id of ["agents", "files", "terminal", "browser"]) cols = openInColumns(cols, id, NONE);
    expect(cols).toEqual([col(["agents", "files"]), col(["terminal", "browser"])]);
  });

  it("after a close left a one-panel column at the end, the next open joins it", () => {
    // [agents,files],[terminal] — closing files then opening browser must not
    // wedge browser into agents' column: it appends to the LAST column.
    const cols = [col(["agents"]), col(["terminal"])];
    expect(openInColumns(cols, "browser", NONE)).toEqual([col(["agents"]), col(["terminal", "browser"])]);
  });

  it("is idempotent — an already-open panel moves nothing", () => {
    const cols = [col(["agents", "files"])];
    expect(openInColumns(cols, "agents", NONE)).toBe(cols);
  });
});

describe("the fill rule takes the predicate it is handed (card 362)", () => {
  // The MODEL's half: it asks, and it obeys whatever it is told. WHICH panels
  // answer yes is dockModel's business and is pinned in fillSeating.test.ts.
  const fillsFiles = (id: string): boolean => id === "files";

  it("opens a new column for a panel the predicate names", () => {
    expect(openInColumns([col(["agents"])], "files", fillsFiles)).toEqual([col(["agents"]), col(["files"])]);
  });

  it("refuses to seat anything under one, in the other direction", () => {
    expect(openInColumns([col(["files"])], "agents", fillsFiles)).toEqual([col(["files"]), col(["agents"])]);
  });

  it("with everything filling, every panel gets a column and the cap never binds", () => {
    let cols: PanelColumn[] = [];
    for (const id of ["agents", "files", "terminal"]) cols = openInColumns(cols, id, ALL);
    expect(cols).toEqual([col(["agents"]), col(["files"]), col(["terminal"])]);
  });

  it("separateFills splits a mixed column and conserves its width", () => {
    expect(separateFills([col(["agents", "files"], 2)], fillsFiles)).toEqual([
      col(["agents"], 1),
      col(["files"], 1),
    ]);
  });

  it("separateFills is identity-stable when no column mixes", () => {
    const cols = [col(["agents", "plan"], 1.4, 0.3), col(["files"])];
    expect(separateFills(cols, fillsFiles)).toBe(cols);
  });

  it("separateFills never lets a split weight fall through the sanity floor", () => {
    // WEIGHT_FLOOR is 0.1; halving a column already at the floor would put both
    // halves under it and parseColumns would clamp them back on the next load,
    // silently widening the pair.
    expect(separateFills([col(["agents", "files"], 0.1)], fillsFiles).map((c) => c.weight)).toEqual([
      0.1, 0.1,
    ]);
  });
});

describe("closing re-flows minimally", () => {
  it("removes the panel and keeps its partner in place", () => {
    const cols = [col(["agents", "files"]), col(["terminal"])];
    expect(closeInColumns(cols, "files")).toEqual([col(["agents"]), col(["terminal"])]);
  });

  it("collapses an emptied column — its width redistributes by renormalization", () => {
    const cols = [col(["agents", "files"]), col(["terminal"], 2)];
    expect(closeInColumns(cols, "terminal")).toEqual([col(["agents", "files"])]);
  });

  it("never migrates a panel between columns on a close", () => {
    // [agents],[files,terminal]: closing agents drops column one; files and
    // terminal stay TOGETHER in their column rather than re-flowing.
    const cols = [col(["agents"]), col(["files", "terminal"], 1.4, 0.3)];
    expect(closeInColumns(cols, "agents")).toEqual([col(["files", "terminal"], 1.4, 0.3)]);
  });

  it("is identity-stable when the panel is not there", () => {
    const cols = [col(["agents"])];
    expect(closeInColumns(cols, "browser")).toBe(cols);
  });
});

describe("the two drag verbs", () => {
  it("setColumnSplit reassigns one column's ratio, clamped to the sanity band", () => {
    const cols = [col(["agents", "files"]), col(["terminal"])];
    expect(setColumnSplit(cols, 0, 0.3)[0].split).toBe(0.3);
    expect(setColumnSplit(cols, 0, 0)[0].split).toBe(RATIO_FLOOR);
    expect(setColumnSplit(cols, 0, 1)[0].split).toBe(RATIO_CEIL);
    // Junk indices and junk ratios change nothing — identity, no re-render.
    expect(setColumnSplit(cols, 5, 0.3)).toBe(cols);
    expect(setColumnSplit(cols, 0, Number.NaN)).toBe(cols);
  });

  it("setColumnPairShare re-cuts two neighbours' weights, conserving their sum", () => {
    const cols = [col(["agents"], 1), col(["files"], 3), col(["terminal"], 2)];
    const next = setColumnPairShare(cols, 0, 0.5);
    expect(next[0].weight).toBeCloseTo(2);
    expect(next[1].weight).toBeCloseTo(2);
    expect(next[2].weight).toBe(2); // the third column is untouched
    expect(next[0].weight + next[1].weight).toBeCloseTo(cols[0].weight + cols[1].weight);
  });

  it("clamps the pair share and ignores an edge with no right neighbour", () => {
    const cols = [col(["agents"], 1), col(["files"], 1)];
    expect(setColumnPairShare(cols, 0, 0)[0].weight).toBeCloseTo(2 * RATIO_FLOOR);
    expect(setColumnPairShare(cols, 1, 0.5)).toBe(cols);
    expect(setColumnPairShare(cols, 0, Number.NaN)).toBe(cols);
  });
});

describe("the wire format survives a round trip and rejects junk", () => {
  it("serializes and parses back byte-identical", () => {
    const cols = [col(["agents", "files"], 1.25, 0.35), col(["terminal"], 2)];
    const raw = serializeColumns(cols);
    expect(parseColumns(raw, IDS)).toEqual(cols);
    expect(serializeColumns(parseColumns(raw, IDS))).toBe(raw);
  });

  it("drops unknown ids, duplicates and emptied columns", () => {
    const raw = serializeColumns([
      col(["agents", "banana"]),
      col(["agents"]), // duplicate of column one's survivor
      col(["files", "terminal"]),
    ]);
    expect(parseColumns(raw, IDS)).toEqual([col(["agents"]), col(["files", "terminal"])]);
  });

  it("clamps stored weights and splits instead of trusting them", () => {
    const parsed = parseColumns("agents~-3~99|files~banana~banana", IDS);
    expect(parsed[0].weight).toBeGreaterThan(0);
    expect(parsed[0].split).toBe(RATIO_CEIL);
    expect(parsed[1].weight).toBe(1);
    expect(parsed[1].split).toBe(DEFAULT_SPLIT);
  });

  it("reads junk wholesale as an empty arrangement — nothing opens from garbage", () => {
    expect(parseColumns("", IDS)).toEqual([]);
    expect(parseColumns("~~|~~", IDS)).toEqual([]);
  });

  it("caps a stored column at two panels — the overflow re-enters by the fill rule", () => {
    const parsed = parseColumns("agents,files,terminal~1~0.5", IDS);
    expect(parsed).toEqual([col(["agents", "files"])]);
  });
});

describe("reconcile: the stored arrangement meets the stored modes", () => {
  it("drops panels the modes call closed, and fills panels the columns miss, in the order given", () => {
    // A 228-era blob has modes but no columns: everything open hydrates
    // through the fill rule in the caller's order (DOCK_ORDER).
    expect(reconcileColumns([], ["agents", "files", "terminal"], NONE)).toEqual([
      col(["agents", "files"]),
      col(["terminal"]),
    ]);
    // A stored arrangement whose column carries a closed panel loses exactly
    // that panel; the open one it misses re-enters by the fill rule, which
    // joins the last column while it has room.
    const stored = [col(["agents", "files"], 2, 0.3)];
    expect(reconcileColumns(stored, ["agents", "browser"], NONE)).toEqual([
      col(["agents", "browser"], 2, 0.3),
    ]);
  });

  it("returns the same array when nothing diverges", () => {
    const stored = [col(["agents", "files"], 2, 0.3)];
    expect(reconcileColumns(stored, ["agents", "files"], NONE)).toBe(stored);
  });

  it("flattens column-major for the invariant checks", () => {
    expect(panelsInColumns([col(["agents", "files"]), col(["terminal"])])).toEqual([
      "agents",
      "files",
      "terminal",
    ]);
  });
});
