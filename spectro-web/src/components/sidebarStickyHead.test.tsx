// The options control at the head of the session list stays reachable (card 215).
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
// What no source guard can reach is whether a browser actually pins it. That is
// measured live and reported on the card; this file's job is to stop it coming
// back.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "./Sidebar";

/** The three segments the rail switches between, as <Sidebar> declares them. */
type NavMode = "sessions" | "fleets" | "stategraph";

/** Blank out block comments, keeping newlines so line numbers still line up.
 *  Prose about a sticky head is not a sticky head. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const css = code(readFileSync(fileURLToPath(new URL("../styles/sidebar.css", import.meta.url)), "utf8"));

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
    // goes red the moment the row is rendered as a sibling of the head again —
    // which is exactly the shape that scrolled away.
    const head = divBlock(sessions, "sidebar-head");
    expect(head).toContain('class="session-list-head"');
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
    // The risk this move introduces, named: the head is drawn on all three
    // segments, so a row dropped into it without its guard would offer the
    // session-list options while looking at fleets or a state graph — options
    // for a list that is not on screen.
    expect(sessions).toContain('class="sess-opts-btn"');
    for (const other of ["fleets", "stategraph"] as const) {
      expect(rail(other), other).not.toContain('class="sess-opts-btn"');
      expect(rail(other), other).not.toContain('class="session-list-head"');
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

  it("does not pin the list head a second time on its own", () => {
    // The shape this card rejected. `.session-list-head` is a row inside the
    // sticky block now; giving it its own `position: sticky` would put two
    // sticky tops in one container and re-open the offset problem.
    expect(css).not.toMatch(/\.session-list-head\s*\{[^}]*position:\s*sticky/);
  });
});
