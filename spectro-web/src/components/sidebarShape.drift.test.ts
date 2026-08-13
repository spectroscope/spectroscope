// The shape of the rail, read off disk.
//
// There is no DOM in this suite (house rule), so this is the same idiom as
// chatToolsPlacement.drift.test.ts and fleetLobby.drift.test.ts: the source is
// the evidence. What it pins is the class of thing a screenshot review misses —
// a deleted feature that is only hidden, a stylesheet rule left behind with no
// markup to attach to, and a control that quietly moved inside a branch and so
// stopped existing on two of the three segments.
//
// The pile is the reason the first two exist. It folded look-alike rows into a
// count with a chevron; it is gone by owner decision, and "gone" here means the
// fold, its strings and its rules — not `display: none`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Blank out block comments, keeping newlines so line numbers still line up. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** The same, plus line comments — prose about a deleted class is not the class. */
function ts(src: string): string {
  return code(src).replace(/\/\/[^\n]*/g, "");
}

const sidebar = read("./Sidebar.tsx");
const navRow = read("./NavRow.tsx");
const rows = read("./sessionRows.tsx");
const css = code(read("../styles/sidebar.css"));
const fleetCss = code(read("../styles/fleet.css"));

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

describe("the session list is flat", () => {
  it("no longer folds identical prompts into a pile", () => {
    expect(sidebar).not.toContain("groupSessions");
    expect(sidebar).not.toContain("unfolded");
    expect(rows).not.toContain("groupSessions");
    expect(rows).not.toContain("SessionGroup");
  });

  it("left no orphan pile rules in the stylesheet", () => {
    // An orphan rule is invisible: nothing type-checks CSS against markup, so
    // the fold could be removed and its whole visual vocabulary survive.
    for (const rule of [".session-pile", ".pile-row", ".pile-count", ".pile-chevron", ".piled-row"]) {
      expect(css, rule).not.toContain(rule);
    }
  });

  it("kept the row content the flat list still draws", () => {
    // Only the fold went. The glyph, the model label and the counted line are
    // what a row IS, and sessionRows.test.ts remains their regression net.
    for (const kept of ["sessionSignal", "sessionModelLabel", "countLabel", "sessionTitleLines"]) {
      expect(rows, kept).toContain(`export function ${kept}`);
    }
  });
});

describe("the rail's controls are rows, not buttons", () => {
  it("gives the nav rows no button chrome", () => {
    // Comments stripped: a sentence recalling the ghost buttons is not a ghost
    // button, and a guard that cannot tell the two apart forbids saying why.
    const markup = ts(sidebar);
    expect(markup).not.toContain("soft-primary");
    expect(markup).not.toContain("ghost");
    expect(markup).not.toContain("sidebar-seg-btn");
    for (const rule of [".new-chat", ".sidebar-actions", ".sidebar-seg-btn", ".sidebar-scenarios"]) {
      expect(css, rule).not.toContain(rule);
    }
    expect(fleetCss).not.toContain(".sidebar-seg-btn");
  });

  it("draws every row through the one shared primitive", () => {
    expect(sidebar).toContain("navActionRows(");
    expect(sidebar).toContain("navSegmentRows(");
    expect(mounts(sidebar, "NavRow")).toBeGreaterThanOrEqual(3);
  });

  it("keeps the segments announced as tabs after losing their box", () => {
    // Losing the button box must not lose the semantics. The group is named in
    // the rail; the per-row half moved into the primitive with the row.
    expect(sidebar).toContain('role="tablist"');
    expect(sidebar).toContain('role="tab"');
    expect(navRow).toContain("aria-selected");
    expect(navRow).toContain("aria-disabled");
  });
});

describe("settings is pinned to the foot of the rail", () => {
  const footAt = sidebar.indexOf('className="sidebar-foot"');
  const listAt = sidebar.indexOf('className="session-list"');
  const asideAt = sidebar.indexOf("</aside>");

  it("pins settings to the foot of the rail, below the list", () => {
    expect(footAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(-1);
    expect(footAt).toBeGreaterThan(listAt);
    expect(footAt).toBeLessThan(asideAt);
    expect(sidebar).toContain("props.onSettings");
    // The existing key, not a freshly minted one — two doors, one word.
    expect(sidebar).toContain('"hdr.settings"');
  });

  it("keeps the settings row outside the segment branch", () => {
    // The branch tests the segments in order; anything rendered inside the
    // sessions arm sits BEFORE the stategraph test. The foot sits after all of
    // them, so it is present on all three segments.
    expect(footAt).toBeGreaterThan(sidebar.lastIndexOf('nav === "stategraph"'));
  });

  it("owns the padding the sticky foot has to cover", () => {
    // A sticky-bottom child cannot cover padding it does not own; the head made
    // the same correction for the top.
    expect(css).toMatch(/\.sidebar-foot\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.sidebar-foot\s*\{[^}]*bottom:\s*0/);
    expect(css).toMatch(/\.sidebar\s*\{[^}]*padding:\s*0 var\(--sp-3\);/);
  });
});

describe("every row says whether it is running", () => {
  it("puts the indicator on the live row and on the stored rows alike", () => {
    expect(mounts(sidebar, "RunDot")).toBeGreaterThanOrEqual(2);
    expect(sidebar).toContain("runState(");
  });

  it("reads the server's live set rather than only this page's socket", () => {
    // This guard used to say the opposite, and it was right at the time: no
    // endpoint reported who was live, so a stored row could only be called live
    // when it was the one being resumed. Card 212 built the endpoint. What must
    // not come back is a rail that resolves a stored row's dot from this page's
    // own socket alone, which is how a second run went invisible.
    expect(sidebar).toContain("useLiveSessions()");
    expect(sidebar).toContain("storedRunState(");
    expect(sidebar).toContain("props.resumeId"); // still the fallback for an older server
  });

  it("keeps the whole rule out of the markup", () => {
    // A dot resolved inline is a dot no test can hold: there is no DOM in this
    // suite. The decision lives in runIndicator.ts, and runIndicator.test.ts is
    // its regression net.
    const markup = ts(sidebar);
    expect(markup).not.toMatch(/live:\s*props\.resumeId === s\.id/);
    expect(markup).not.toMatch(/running:\s*props\.liveRunning,\s*\n\s*stopReason/);
  });
});
