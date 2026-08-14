// The options control at the head of the session list stays reachable (card 216).
//
// What went wrong is worth writing down, because the rail already knew the
// answer. `.sidebar-foot` is sticky, so Settings is on screen at every scroll
// position; `.session-list-head` was `position: static`, so the control that
// governs the list left with the list. Measured on a real engine at 1440x900
// with 112 stored sessions: at the bottom of the rail the trigger's box sat
// 4091.5px ABOVE the rail's top edge while the settings row was still drawn at
// y=842.7. One end of the rail pinned, the other running away.
//
// The fix is not a second sticky element. The rail already owns one sticky top
// block — `.sidebar-head`, the brand plus the six nav rows — and the list's
// head joins it. Two sticky tops in one scroll container is the arrangement
// that needs an offset nobody can compute in CSS: `.sidebar-head`'s height is
// six rows plus a brand plus whatever a future row adds, so any `top:` written
// for a second sticky child is a number that goes stale the first time the head
// changes. Joining the block costs no number at all.
//
// So the assertion is about OUTPUT and about the one CSS rule that carries it:
// the trigger must render INSIDE the sticky block, and that block must be
// opaque, or the rows scroll through the control instead of under it. Rendering
// is `renderToStaticMarkup`, the idiom sessionRowDensity.test.tsx established —
// no DOM, so this suite still runs in plain Node.
//
// Card 217 then took the ROW away and kept the block: the control rides the
// last nav row's line now, which gave the head 34.0px back, and the rows scroll
// in `.sidebar-list` instead of in the rail. Neither touches what this file
// asserts — every claim here was about which block the control lives in, never
// about which line of it — and that is why the assertions below survived the
// move with two words changed. The new shape is pinned next door, in
// sidebarScrollSeam.test.tsx.
//
// What no source guard can reach is whether a browser actually pins it. That is
// measured live and reported on the card; this file's job is to stop it coming
// back.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "./Sidebar";
import { SESS_OPTS_GAP, sessOptsPlacement } from "./SessionListOptions";

/** The five segments the rail switches between, as <Sidebar> declares them
 *  (browser is the fourth since card 201, skills the fifth since card 225). */
type NavMode = "sessions" | "fleets" | "stategraph" | "skills";

/** Blank out block comments, keeping newlines so line numbers still line up.
 *  Prose about a sticky head is not a sticky head. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const css = code(readFileSync(fileURLToPath(new URL("../styles/sidebar.css", import.meta.url)), "utf8"));

/** Every rule in the stylesheet. The pattern matches INNERMOST blocks, so the
 *  one `@container` wrapper reads as the rules it holds rather than as one
 *  block whose selector is an at-rule. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? "").trim(),
  decls: m[2] ?? "",
}));

/** The declarations of the rule whose selector is EXACTLY `selector`. Missing
 *  throws rather than returning "": a guard that quietly reads nothing is the
 *  failure mode card 214's review found in the no-hiding guard. */
function declsOf(selector: string): string {
  const rule = rules.find((r) => r.selector === selector);
  if (rule === undefined) throw new Error(`no rule has the selector \`${selector}\``);
  return rule.decls;
}

/** The numeric `z-index` that rule declares. An absent one is `auto`, which is
 *  not 0 and not comparable, so it fails loudly instead of scoring zero. */
function zIndexOf(selector: string): number {
  const m = /z-index:\s*(-?\d+)/.exec(declsOf(selector));
  if (m?.[1] === undefined) throw new Error(`\`${selector}\` declares no numeric z-index`);
  return Number(m[1]);
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

/** The markup of the `<div class="…">` element carrying `cls`, from its opening
 *  tag to its OWN closing tag — `<div>` nesting counted, so a child div does not
 *  end the slice early. Containment measured, not guessed from two indices. */
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

describe("the options control rides the rail's sticky head", () => {
  it("renders the trigger inside the sticky block, not above the scrolling list", () => {
    // The whole card in one line. `divBlock` walks the real nesting, so this
    // goes red the moment the control is rendered as a sibling of the head
    // again — which is exactly the shape that scrolled away.
    //
    // WHERE inside the block changed with card 217 (it rides the last nav row's
    // line now instead of a row of its own) and this assertion did not have to:
    // it was never about the row, it is about the block.
    const head = divBlock(sessions, "sidebar-head");
    expect(head).toContain('class="wsg-anchor sess-opts"');
    expect(head).toContain('class="sess-opts-btn"');
  });

  it("leaves the list itself outside the sticky block, so it can scroll", () => {
    // A head that swallowed the list would pass the assertion above and pin
    // nothing: everything would be sticky and nothing would move.
    const head = divBlock(sessions, "sidebar-head");
    expect(head).not.toContain('class="session-list"');
    expect(sessions).toContain('<nav class="session-list"');
    expect(sessions.indexOf('class="sidebar-head"')).toBeLessThan(
      sessions.indexOf('<nav class="session-list"'),
    );
  });

  it("keeps the control on the sessions segment only", () => {
    // The risk this move introduces, named: the head is drawn on all four
    // segments, so a control dropped into it without its guard would offer the
    // session-list options while looking at fleets, a state graph or the
    // skills view — options for a list that is not on screen.
    expect(sessions).toContain('class="sess-opts-btn"');
    for (const other of ["fleets", "stategraph", "skills"] as const) {
      expect(rail(other), other).not.toContain('class="sess-opts-btn"');
      expect(rail(other), other).not.toContain("sess-opts");
    }
  });
});

describe("the sticky block the control now sits in", () => {
  it("is pinned to the top of the rail", () => {
    expect(css).toMatch(/\.sidebar-head\s*\{[^}]*position:\s*sticky/);
    expect(css).toMatch(/\.sidebar-head\s*\{[^}]*top:\s*0/);
  });

  it("is opaque, in the house's token rather than a literal", () => {
    // The classic version of this bug: a sticky head with no background lets
    // every row scroll THROUGH the control, and the control becomes unreadable
    // exactly when it is needed. A literal colour would be one design's answer
    // to a question all four ask.
    expect(css).toMatch(/\.sidebar-head\s*\{[^}]*background-color:\s*var\(--surface\)/);
    expect(css).not.toMatch(/\.sidebar-head\s*\{[^}]*background[^;}]*#[0-9a-fA-F]{3}/);
  });

  it("leaves the head and the foot one sticky each, so they cannot fight", () => {
    // Both stick in the SAME scroll container (`.sidebar` owns the overflow).
    // One top and one bottom is the arrangement that works; a second sticky top
    // would need an offset equal to this head's height, and that height is six
    // nav rows and a brand — a number that goes stale on the next row added.
    const sticky = [...css.matchAll(/([^{}]+)\{([^{}]*position:\s*sticky[^{}]*)\}/g)].map((m) => ({
      selector: m[1].trim(),
      decls: m[2].replace(/\s+/g, ""),
    }));
    expect(sticky.map((s) => s.selector).sort()).toEqual([".sidebar-foot", ".sidebar-head"]);
    expect(sticky.filter((s) => s.decls.includes("top:0"))).toHaveLength(1);
    expect(sticky.filter((s) => s.decls.includes("bottom:0"))).toHaveLength(1);
  });

  it("does not pin the control's own line a second time", () => {
    // The shape this card rejected, still rejected one card later. The line the
    // control rides is inside the sticky block; giving that line its own
    // `position: sticky` would put two sticky tops in one container and re-open
    // the offset problem — a `top:` equal to a height nobody can compute in CSS.
    expect(css).not.toMatch(/\.sidebar-nav-seg-line\s*\{[^}]*position:\s*sticky/);
  });
});

// ---------------------------------------------------------------------------
// What the move COST, and the four invariants that pay for it.
//
// `position: sticky` plus a z-index makes `.sidebar-head` a stacking context.
// That is the price of pinning the control: everything the head contains is now
// ranked inside the head, and everything the head does not contain is ranked
// against the head's one number. Four things follow, three of them measured on
// a live jar during review and none of them visible to a test until now.
// ---------------------------------------------------------------------------

describe("the stacking context the sticky block became", () => {
  it("lifts the head above the rows that scroll under it", () => {
    // `z-index: 2` is load-bearing, and deleting it kept the whole suite green.
    // Opacity is not enough: `.session-row:hover` carries a transform, and a
    // transformed element paints in the positioned layer, where the head — a
    // sticky box at `auto`, EARLIER in the tree — loses. Measured with the
    // z-index removed and a row hovered, the topmost element inside the head's
    // own band is `session-row`; with it, `nav-row`. The row punched straight
    // through the control the head exists to keep readable.
    expect(zIndexOf(".sidebar-head")).toBeGreaterThanOrEqual(1);
  });

  it("lets an open panel outrank the sticky foot, and only while one is open", () => {
    // The regression this move was most likely to cause, and did. The options
    // panel declares `z-index: var(--z-dropdown)` = 100, but 100 now means
    // "inside the head", and what the rest of the rail compares against is the
    // head's own number. `.sidebar-foot` carried the same 2 and comes later in
    // the DOM, so the Settings row won: measured at 1440x460 on a live jar,
    // 15.8px of the panel painted UNDER the foot, with `sidebar-foot` topmost
    // in the overlap. Coverage started below 476px of window height at the
    // default 240px rail (475px: 0.8px covered, foot on top; 476px: clear).
    //
    // The raise is scoped to an open panel rather than made permanent, and that
    // is the design call. A head that always outranks the foot would hide the
    // Settings row in a window too short to hold both, with nothing open and no
    // way to ask for it back. Scoped, the cost is bounded and reversible: while
    // a panel is open it covers the foot's top edge, and closing it — which is
    // one Escape, one outside click, or the trigger again — puts the rail back.
    expect(zIndexOf(".sidebar-head:has(.wsg-pop)")).toBeGreaterThan(zIndexOf(".sidebar-foot"));
    expect(zIndexOf(".sidebar-head")).toBeLessThanOrEqual(zIndexOf(".sidebar-foot"));
  });

  it("never clips, on either box, because the panel hangs out of both", () => {
    // A constraint that is new BECAUSE of this move: before it, the head held
    // no popover, so `overflow` here was harmless. The panel opens downward out
    // of the boxes it lives in — measured, 99.1px of its 101.1px falls outside
    // the head — so an `overflow: hidden` on either the head or the line the
    // control rides clips it away entirely and the suite stayed green for it.
    // At the panel's midpoint the topmost element became a session row: the
    // panel gone, and not reachable by scrolling to it either.
    //
    // The inner box is `.sidebar-nav-seg-line` since card 217, and the rule
    // followed the control: the line is the popover's positioned ancestor now.
    expect(declsOf(".sidebar-head")).not.toMatch(/overflow/);
    expect(declsOf(".sidebar-nav-seg-line")).not.toMatch(/overflow/);
  });

  it("sticks in the scroll container `.sidebar` owns", () => {
    // Both sticky children stick to `.sidebar`, and only because `.sidebar`
    // scrolls: `overflow-y: auto` is what makes it their nearest scrollport.
    // Changing it to `visible` unpins the head AND the foot in one line while
    // leaving the whole suite green — the neighbouring drift test pins this
    // rule's padding but never its overflow.
    //
    // Since card 217 the rows scroll in `.sidebar-list` and this box overflows
    // only in a window shorter than the rail's own chrome. That makes the rule
    // rarer, not optional: it is what keeps the Settings row reachable there,
    // and it is still the scrollport both sticky blocks are measured against.
    expect(declsOf(".sidebar")).toMatch(/overflow-y:\s*auto/);
  });
});

// ---------------------------------------------------------------------------
// The second short window, and it is not the foot's doing.
//
// Pinning the trigger to the head fixed WHERE it is and left WHAT IT OPENS
// alone: the panel hangs 6px under a trigger whose bottom is a constant 304.7px
// down the rail, and it is 101.1px tall. Measured on a live jar: it needs a
// window of 419.8px to land inside one, while the trigger itself is reachable
// from 304.7px. That is a 115px band of window heights in which a reader can
// open a panel they cannot touch — `elementFromPoint` at both radios returns
// null, and no amount of scrolling brings them back, because the panel is
// anchored inside a block that does not scroll.
//
// The two constants moved 40px up the rail with card 217 and the band kept its
// width, which is the argument for measuring rather than thresholding: nothing
// here had to be re-derived, only re-measured.
//
// This one predates the move — the panel opened downward from a static head
// too — but the move is what made the trigger reachable at every scroll
// position, so the panel behind it has to be reachable too. There is room the
// other way: 289.5px above the trigger against the 107.1px the panel and its
// gap need. So it flips, from what is measured rather than from a height
// written into a media query, which would be the same stale literal this card
// refused for `top:`.
// ---------------------------------------------------------------------------

describe("the panel opens where there is room for it", () => {
  it("opens downward whenever the window has the room", () => {
    // The documented direction, and the one card 214 chose: this trigger sits
    // at the TOP of the rail, so down is where a reader looks for it. The
    // geometry is the one card 217 left behind, measured on a live jar.
    expect(
      sessOptsPlacement({
        triggerTop: 282.7,
        triggerBottom: 304.7,
        panelHeight: 101.1,
        viewportHeight: 900,
      }),
    ).toBe("down");
  });

  it("flips upward in the window where downward runs off the screen", () => {
    // The measured band: trigger reachable at 304.7, panel needs 419.8.
    expect(
      sessOptsPlacement({
        triggerTop: 282.7,
        triggerBottom: 304.7,
        panelHeight: 101.1,
        viewportHeight: 340,
      }),
    ).toBe("up");
    // Both edges of the band, so the boundary is pinned rather than implied —
    // and both were opened for real at those two window heights, not only
    // computed here: 420 opens down, 419 opens up.
    expect(
      sessOptsPlacement({
        triggerTop: 282.7,
        triggerBottom: 304.7,
        panelHeight: 101.1,
        viewportHeight: 420,
      }),
    ).toBe("down");
    expect(
      sessOptsPlacement({
        triggerTop: 282.7,
        triggerBottom: 304.7,
        panelHeight: 101.1,
        viewportHeight: 419,
      }),
    ).toBe("up");
  });

  it("stays down when neither side fits, rather than moving the problem", () => {
    // A flip that puts the panel off the TOP is not an improvement, and the
    // documented direction is the better thing to fail in.
    expect(
      sessOptsPlacement({
        triggerTop: 40,
        triggerBottom: 62,
        panelHeight: 300,
        viewportHeight: 320,
      }),
    ).toBe("down");
  });

  it("has a rule for the flipped panel, and it wins the cascade", () => {
    // `.wsg-pop.sess-opts-pop` and `.wsg-pop.sess-opts-pop--up` have the same
    // specificity, so ORDER is the whole mechanism — the trap `.disc-pop`
    // documents and `.sess-opts-pop` was already written against. Both classes
    // are on the element at once; the flipped rule has to come second.
    const down = css.indexOf(".wsg-pop.sess-opts-pop {");
    const up = css.indexOf(".wsg-pop.sess-opts-pop--up {");
    expect(down).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(down);
    expect(declsOf(".wsg-pop.sess-opts-pop--up")).toMatch(/top:\s*auto/);
    expect(declsOf(".wsg-pop.sess-opts-pop--up")).toMatch(/bottom:\s*calc\(100% \+ 6px\)/);
  });

  it("hands the decision to the class that carries it", () => {
    // Read off the SOURCE, and that is a limit rather than a claim: the panel
    // only exists while it is open, no server render opens it, and this suite
    // has no DOM. So the two ends are pinned by rendering and by the stylesheet
    // — the decision is a pure function with its own cases, the flipped rule is
    // a rule that wins its cascade — and the link between them is asserted as
    // text. Without it, both ends could stay green while the class never
    // reached the element, which is the exact failure card 214's review found
    // in this file's neighbour.
    const source = readFileSync(fileURLToPath(new URL("./SessionListOptions.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/placement === "up" \? " sess-opts-pop--up" : ""/);
  });

  it("measures the same gap the stylesheet draws", () => {
    // The 6px lives in two languages, and a pair that drifts is worse than a
    // literal that does not: the decision would be made against a gap the
    // panel is not actually drawn with.
    expect(declsOf(".wsg-pop.sess-opts-pop")).toMatch(
      new RegExp(`top:\\s*calc\\(100% \\+ ${SESS_OPTS_GAP}px\\)`),
    );
  });
});
