// Where the rail's fixed chrome ends and the scrolled list begins (card 217).
//
// Two asks off the owner's own screen, and they are the same seam twice. The
// options control sat on a line of its own under the nav rows, so the block
// that never moves grew a whole row for one 22px glyph; and the scrollbar
// belonged to `.sidebar`, so it measured the brand, six nav rows and the
// settings foot as well as the sessions it actually moves.
//
// Both answers are structural. The control moves onto the LAST nav row's line,
// placed against that group's own bottom edge rather than given a row; and the
// segment content moves into `.sidebar-list`, which owns the overflow, so the
// bar spans the rows and nothing else.
//
// What this file cannot see is a browser: the numbers are measured live on a
// freshly built jar and reported on the card. Its job is to stop the shape
// coming back — the same `renderToStaticMarkup` idiom as
// sidebarStickyHead.test.tsx, no DOM, plain Node.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments as code } from "../testkit/source";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "./Sidebar";

/** The five segments the rail switches between: browser since card 201,
 *  skills since card 225. */
type NavMode = "sessions" | "fleets" | "stategraph" | "skills";

const SEGMENTS: NavMode[] = ["sessions", "fleets", "stategraph", "skills"];

const css = code(readFileSync(fileURLToPath(new URL("../styles/sidebar.css", import.meta.url)), "utf8"));

/** Every innermost rule in the stylesheet, so an at-rule wrapper reads as the
 *  rules it holds rather than as one block with an at-rule for a selector. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? "").trim(),
  decls: m[2] ?? "",
}));

/** The declarations of the rule whose selector is EXACTLY `selector`. Missing
 *  throws rather than returning "": a guard that quietly reads nothing passes
 *  forever, which is the failure card 214's review found. */
function declsOf(selector: string): string {
  const rule = rules.find((r) => r.selector === selector);
  if (rule === undefined) throw new Error(`no rule has the selector \`${selector}\``);
  return rule.decls;
}

/** The rail as a reader gets it, on one segment. */
function rail(nav: NavMode): string {
  return renderToStaticMarkup(
    <Sidebar
      activeId={null}
      refreshToken={0}
      onSelectLive={() => {}}
      onSelectSession={() => {}}
      onNewChat={() => {}}
      onSettings={() => {}}
      liveRunning={false}
      resumeId={null}
      onImport={() => {}}
      onScenarios={() => {}}
      onStarters={() => {}}
      onSelectScenario={() => {}}
      stateGraphSource={null}
      onStateGraphScenario={() => {}}
      activeFleet={null}
      onSelectFleet={() => {}}
      onSpawnNode={() => {}}
      nav={nav}
      onNav={() => {}}
    />,
  );
}

/** The markup of the `<div class="…">` carrying `cls`, from its opening tag to
 *  its OWN closing tag — `<div>` nesting counted, so a child div does not end
 *  the slice early. Containment measured, not guessed from two indices. */
function divBlock(html: string, cls: string): string {
  const at = html.indexOf(`class="${cls}"`);
  if (at < 0) throw new Error(`no element carries class="${cls}"`);
  const open = html.lastIndexOf("<div", at);
  if (open < 0) throw new Error(`class="${cls}" is not on a <div>`);
  let i = open;
  let depth = 0;
  for (;;) {
    const nextOpen = html.indexOf("<div", i + 1);
    const nextClose = html.indexOf("</div>", i + 1);
    if (nextClose < 0) throw new Error(`class="${cls}" is never closed`);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen;
    } else if (depth === 0) {
      return html.slice(open, nextClose + "</div>".length);
    } else {
      depth -= 1;
      i = nextClose;
    }
  }
}

const sessions = rail("sessions");

describe("the options control shares the last nav row's line", () => {
  it("draws it on the segment group's line instead of a row of its own", () => {
    // The whole first ask. The line box holds the segment group AND the
    // control; the control is placed against the group's bottom edge, which IS
    // the last row's bottom edge, so no row is added for one glyph.
    const line = divBlock(sessions, "sidebar-nav-seg-line");
    expect(line).toContain('role="tablist"');
    expect(line).toContain('class="sess-opts-btn"');
  });

  it("leaves no options row behind, in the markup or in the stylesheet", () => {
    // `.session-list-head` was a whole row of the block that never moves. It is
    // gone, and gone means the rule too — an orphan rule is invisible, which is
    // the lesson the deleted pile left in sidebarShape.drift.test.ts.
    expect(sessions).not.toContain("session-list-head");
    expect(rules.some((r) => r.selector.includes(".session-list-head"))).toBe(false);
  });

  it("keeps the tablist owning tabs and nothing else", () => {
    // The control rides the same LINE as the last tab, not the same LIST. A
    // button inside `role="tablist"` is an owned element that is not a tab,
    // which is exactly what the role forbids — so the wrapper goes around the
    // group rather than inside it.
    const tablist = divBlock(sessions, "sidebar-nav sidebar-nav-seg");
    expect(tablist).not.toContain("sess-opts");
    expect(tablist).toContain('role="tab"');
  });

  it("still rides the block that does not scroll (card 216)", () => {
    // The move must not undo the fix it is built on: the control is reachable
    // at every scroll position because it is inside `.sidebar-head`, and now
    // also because the rows scroll in their own box underneath it.
    expect(divBlock(sessions, "sidebar-head")).toContain('class="sess-opts-btn"');
  });

  it("offers it on the sessions segment only", () => {
    // The line is drawn on every segment — it wraps the segment group — but
    // options for a list nobody is looking at are noise.
    for (const nav of SEGMENTS) {
      const html = rail(nav);
      expect(html, nav).toContain("sidebar-nav-seg-line");
      expect(html.includes("sess-opts-btn"), nav).toBe(nav === "sessions");
    }
  });

  it("places the control against the group's bottom edge, not a row's name", () => {
    // Which row is last is a fact about `navSegmentRows()`, and it has already
    // changed once (card 201 made Browser the fourth). So the placement names
    // no row: the group's bottom edge is the last row's bottom edge, whichever
    // row that is and however many rows come before it.
    expect(declsOf(".sidebar-nav-seg-line")).toMatch(/position:\s*relative/);
    const opts = declsOf(".sidebar-nav-seg-line > .sess-opts");
    expect(opts).toMatch(/position:\s*absolute/);
    expect(opts).toMatch(/bottom:\s*var\(--nav-row-pad-y\)/);
  });

  it("reads the row's own padding rather than a second copy of it", () => {
    // The offset that lands the control on the row's line is the row's own
    // vertical padding. Written twice it is a pair that drifts the day the
    // rows get roomier — and the drift is silent, because a control 6px off
    // its row still looks like a control. Declared once, read twice.
    expect(css.match(/--nav-row-pad-y:/g) ?? []).toHaveLength(1);
    expect(declsOf(".sidebar")).toMatch(/--nav-row-pad-y:/);
    expect(declsOf(".nav-row")).toMatch(/padding:\s*var\(--nav-row-pad-y\)/);
  });

  it("keeps every nav row inside the rail that declares that property", () => {
    // The property is inherited from `.sidebar`, so a `.nav-row` rendered
    // anywhere else would resolve it to nothing — and an unknown custom
    // property warns nowhere: the whole `padding` declaration would be invalid
    // at computed-value time and quietly fall back to zero. Today the row has
    // exactly one caller; this is what makes the inheritance safe.
    const src = readFileSync(fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)), "utf8");
    expect(src.split("<NavRow").length - 1).toBeGreaterThanOrEqual(3);
    expect(rules.some((r) => r.selector === ".nav-row")).toBe(true);
  });
});

describe("the scrollbar spans the session list only", () => {
  it("gives every segment's content one scrolling block", () => {
    // The second ask. `.sidebar-list` starts where the rows start, so the bar
    // measures the rows it moves — on all four segments, because a block that
    // existed on one of them would move the seam when the reader switches.
    for (const nav of SEGMENTS) {
      expect(rail(nav), nav).toContain('class="sidebar-list"');
    }
    const list = divBlock(sessions, "sidebar-list");
    expect(list).toContain('<nav class="session-list"');
    expect(list).toContain("scenario-list");
  });

  it("leaves the fixed chrome outside it", () => {
    // A block that swallowed the head or the foot would pin nothing: the bar
    // would span them again, which is the defect this card is about.
    const list = divBlock(sessions, "sidebar-list");
    expect(list).not.toContain("sidebar-head");
    expect(list).not.toContain("sidebar-foot");
    const at = (cls: string): number => sessions.indexOf(`class="${cls}"`);
    expect(at("sidebar-head")).toBeLessThan(at("sidebar-list"));
    expect(at("sidebar-list")).toBeLessThan(at("sidebar-foot"));
  });

  it("makes that block the scroll container, and gives it the room to be one", () => {
    // `min-height: 0` is the line that does the work and the one nobody misses
    // when it goes: a column flex item's automatic minimum size is its own
    // content, so without it the list refuses to shrink, the rail overflows
    // instead, and the bar is back on the rail — the defect restored while
    // every rule below still reads correct.
    const list = declsOf(".sidebar-list");
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).toMatch(/min-height:\s*0/);
    expect(list).toMatch(/flex:\s*1 1 auto/);
    expect(list).toMatch(/overscroll-behavior:\s*contain/);
  });

  it("keeps the hover nudge from growing a second bar across the bottom", () => {
    // `.session-row:hover` moves the row 2px right, and a transformed
    // descendant counts toward its scroll container's overflow. On the rail
    // that landed in 12px of padding and cost nothing; the list has no padding
    // of its own, so it needs the end room or a horizontal scrollbar appears
    // under the pointer.
    expect(declsOf(".sidebar-list")).toMatch(/padding-right:\s*var\(--sp-1\)/);
    expect(declsOf(".session-row:hover")).toMatch(/transform:\s*translateX\(2px\)/);
  });

  it("keeps the rail's own scroll for a window too short for the chrome", () => {
    // Not a second bar in any window that fits: the head and the foot are the
    // only fixed blocks and the list takes the rest, so the rail overflows only
    // when the window is shorter than the chrome itself. There it still
    // scrolls, and the head and foot still stick — or the Settings row would be
    // pushed below the window with no way to reach it.
    expect(declsOf(".sidebar")).toMatch(/overflow-y:\s*auto/);
    expect(declsOf(".sidebar-head")).toMatch(/position:\s*sticky/);
    expect(declsOf(".sidebar-foot")).toMatch(/position:\s*sticky/);
  });
});
