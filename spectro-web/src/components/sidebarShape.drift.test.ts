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

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments as code, read, stripComments as ts } from "../testkit/source";

/** Every stylesheet in the app, comments already blanked. A guard that reads
 *  one file only forbids a rule in that file, and a stylesheet is one import
 *  line away from anywhere. */
function stylesheets(): { file: string; css: string }[] {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const out: { file: string; css: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css"))
        out.push({ file: p.slice(root.length), css: code(readFileSync(p, "utf8")) });
    }
  };
  walk(root.replace(/\/$/, ""));
  return out;
}

/** The innermost `selector { … }` blocks of a stylesheet. At-rule preludes
 *  (`@media`, `@container`) only wrap these, so a rule nested inside one is
 *  found here as well — which is the whole point: a density-scoped hiding rule
 *  can be written anywhere, and "anywhere" is what this has to cover. */
function rules(sheet: string): { selector: string; decls: string }[] {
  const out: { selector: string; decls: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sheet)) !== null) out.push({ selector: m[1].trim(), decls: m[2].replace(/\s+/g, "") });
  return out;
}

const sidebar = read("./Sidebar.tsx", import.meta.url);
const navRow = read("./NavRow.tsx", import.meta.url);
const rows = read("./sessionRows.tsx", import.meta.url);
const css = code(read("../styles/sidebar.css", import.meta.url));
const fleetCss = code(read("../styles/fleet.css", import.meta.url));

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

describe("the session list has an options control at its head", () => {
  const optsAt = sidebar.indexOf("<SessionListOptions");
  const listAt = sidebar.indexOf('className="session-list"');

  it("mounts the control once, above the list it governs", () => {
    expect(mounts(sidebar, "SessionListOptions")).toBe(1);
    expect(optsAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(-1);
    expect(optsAt).toBeLessThan(listAt);
  });

  it("keeps the list's own class a plain literal", () => {
    // This file reads the rail as TEXT, and a density class written into
    // className as a template literal would use backticks — the search above
    // would stop matching and the head assertion would fail for a reason that
    // has nothing to do with the head. Density is a rendering decision here,
    // not a class on the container, and this says so out loud.
    expect(sidebar).toContain('<nav className="session-list"');
  });

  it("reads the chosen value in the house's own pair, not accent on accent", () => {
    // `.sess-opt-value.is-on` wore `color: var(--accent)` on `--accent-soft`,
    // and at --fs-11 that measured 2.61 on graphite, 3.25 on paper — the
    // SELECTED value less readable than the unselected one beside it (7.62).
    // `.settings-seg-option--active` had already solved this; the two must
    // stay the same pair, so a future edit cannot quietly undo it again.
    expect(css).toMatch(/\.sess-opt-value\.is-on\s*\{[^}]*background:\s*var\(--accent-soft\)/);
    expect(css).toMatch(/\.sess-opt-value\.is-on\s*\{[^}]*color:\s*var\(--text\)/);
    expect(code(read("../styles/settings-trace.css", import.meta.url))).toMatch(
      /\.settings-seg-option--active\s*\{[^}]*color:\s*var\(--text\)/,
    );
  });

  it("lets the option row wrap, because the rail goes down to 180px", () => {
    // state/layout.ts clamps the rail at 180px, which caps this panel at ~144px
    // and leaves ~120px inside its padding — less than the label and the two
    // values need side by side. Held on one line, the values ran 32px past the
    // panel's right edge in EN (review of card 214). `margin-left: auto` is what
    // keeps them right of the label on one line and right-aligned on two, so
    // criterion 1's shape survives the wrap.
    expect(css).toMatch(/\.sess-opt-row\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.sess-opt-values\s*\{[^}]*margin-left:\s*auto/);
    expect(css).toMatch(/\.sess-opt-values\s*\{[^}]*max-width:\s*100%/);
  });
});

describe("normal density REMOVES the metadata line rather than hiding it", () => {
  it("hands the row what the STORE said, not a constant", () => {
    // The two ends of this chain are pinned by RENDER, in
    // sessionRowDensity.test.tsx: the store decides what <Sidebar> draws, and
    // <SessionRow> draws what its `parts` say. This is the link in the middle,
    // and it is the one no render can reach — the stored rows arrive from a
    // fetch inside an effect, and no server render runs effects. So it is read
    // off the source, deliberately and narrowly: the list computes `parts` from
    // the live store, and hands THAT to the row.
    expect(sidebar).toContain("rowParts(");
    expect(sidebar).toContain("useDensity(");
    expect(ts(sidebar)).toContain("const parts = rowParts(useDensity());");
    expect(ts(sidebar)).toMatch(/<SessionRow\b[\s\S]{0,400}?parts=\{parts\}/);
  });

  // Which classes density governs. Hiding any of them from a stylesheet is the
  // forbidden move; `.session-model` is NOT here, because its `display: none`
  // is a real, older design — the model appears once the rail is dragged wide
  // enough to spell one out.
  const ROW_PARTS = [".session-sigil", ".session-meta", ".session-meta-line", ".session-facts"];

  it("leaves no rule in ANY stylesheet that hides a row part", () => {
    // The pile taught this: `display: none` is not "gone", and an orphan rule
    // outlives the markup it was written for because nothing checks CSS against
    // JSX. The line is either rendered or it is not.
    //
    // The first version of this guard read the FIRST block whose selector was
    // exactly `<class> {`, and passed in silence when there was none. It went
    // red for `display: none` written into that one block and stayed green for
    //
    //     .session-list.is-normal .session-meta-line,
    //     .session-list.is-normal .session-sigil { display: none; }
    //
    // which is how anyone would actually write it (review of card 214). Every
    // rule in every sheet is read now, grouped selectors and at-rules included.
    const sheets = stylesheets();
    for (const { file, css: sheet } of sheets) {
      for (const rule of rules(sheet)) {
        if (!ROW_PARTS.some((p) => rule.selector.includes(p))) continue;
        for (const hide of ["display:none", "visibility:hidden", "content-visibility:hidden"]) {
          expect(rule.decls, `${file}: ${rule.selector}`).not.toContain(hide);
        }
      }
    }
  });

  it("is looking at rules that exist", () => {
    // A guard that matches nothing passes forever. Each governed class must be
    // styled somewhere, or this suite is guarding a name nobody uses.
    const sheets = stylesheets();
    for (const part of ROW_PARTS) {
      const seen = sheets.some(({ css: sheet }) => rules(sheet).some((r) => r.selector.includes(part)));
      expect(seen, part).toBe(true);
    }
  });

  it("keeps ONE hover string for the row, at either density", () => {
    // Non-functional criterion: the hover carries the cut facts in normal
    // density, and a density-aware second string would be a second thing to
    // keep in step with the DTO. What the two hover strings SAY is compared on
    // the rendered row in sessionRowDensity.test.tsx; this counts the calls.
    expect(ts(sidebar).split("sessionTitleLines(").length - 1).toBe(1);
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
