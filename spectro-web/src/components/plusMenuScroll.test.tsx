// Card 260: the plus menu's Skills panel could not be scrolled, and the switches
// below the fold could not be reached AT ALL.
//
// What was actually wrong is worth writing down, because the declaration that
// was supposed to prevent it was there the whole time. `.wsg-pop` has carried
// `max-height: min(70vh, 480px)` and `overflow-y: auto` since July, and both
// this file's popover and the composer's slash tip cite that in their comments
// as the reason a flyout must be a SIBLING rather than a child. The popover
// still never scrolled: its one child, `.wsg-modes`, declares `overflow: hidden`
// for its rounded corners, and a flex item that is itself a scroll container has
// an automatic minimum size of ZERO. So the list did not overflow the popover —
// it was SHRUNK to fit it and clipped the rest, which leaves the popover with
// nothing to scroll and the reader with no scrollbar, no fade, and no hint that
// more exists.
//
// Measured live on 2026-08-18 at 1280x800 against the real stylesheets, with
// the 36 skills this machine has installed: the popover reported
// scrollHeight === clientHeight === 478 (it could not scroll), `.plus-items`
// reported 2277px of content inside 444px of box, 8 skill rows were fully
// visible, and 28 skills plus BOTH footer rows were unreachable. Flipping the
// child's `overflow` to `visible` in the live page made the popover scrollable
// in the same breath — that is the whole mechanism, measured in both directions.
//
// The fix keeps the popover as the FRAME and gives the entry rows a well of
// their own: `.plus-scroll` is the single scroller, it takes whatever height
// the footer leaves, and the reach sentence, the separator and the
// Manage/Browse rows stay put. One rule for both lists — the MCP servers beside
// the skills grow the same way and ride in the same well, not in a second one.
//
// This suite has no DOM, so nothing here clicks. It renders (react-dom/server)
// and it reads the stylesheet — which is enough for both halves of the claim:
// WHICH box the rows are in is markup, and WHETHER that box scrolls is CSS.
// The card said "a CSS drift pin is enough, this suite has no DOM"; that was
// measured wrong, there are 24 render tests, so the containment claim is
// rendered rather than grepped.

import { createRef } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { blankBlockComments as code } from "../testkit/source";
import type { SettingsView } from "../state/serverSettings";
import { PlusSubmenu, type SkillRow } from "./PlusMenuSettings";
import { dict } from "../i18n/i18n";

const css = code(
  readFileSync(fileURLToPath(new URL("../styles/workspace-gear.css", import.meta.url)), "utf8"),
);

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? "").trim(),
  decls: m[2] ?? "",
}));

/** The declarations of the rule whose selector is EXACTLY `selector`. Missing
 *  throws rather than returning "": a guard that quietly reads nothing passes
 *  green over the very edit it exists to stop. */
function declsOf(selector: string): string {
  const rule = rules.find((r) => r.selector === selector);
  if (rule === undefined) throw new Error(`no rule has the selector \`${selector}\``);
  return rule.decls;
}

/** The markup of the `<div class="…">` carrying `cls`, from its opening tag to
 *  its OWN closing tag — nesting counted, so a row's own `</div>` does not end
 *  the slice early. Containment is measured, not guessed from two indices.
 *  (The idiom is sidebarStickyHead.test.tsx's, which had the same problem.) */
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

/** How many switch rows a chunk of markup draws. */
const switchRows = (html: string): number => html.match(/role="menuitemcheckbox"/g)?.length ?? 0;

/** The `data-sub-index` values in document order — the keyboard's index space
 *  as the markup states it. */
const indices = (html: string): number[] =>
  [...html.matchAll(/data-sub-index="(\d+)"/g)].map((m) => Number(m[1]));

/** A catalogue-sized skills list: the 36 rows this machine's two roots really
 *  produce (5 unpacked skills + 31 in five packs, counted 2026-08-18 under the
 *  scan rule SkillsController uses). */
const SKILLS: SkillRow[] = Array.from({ length: 36 }, (_, i) => ({
  name: `pack:skill-${String(i).padStart(2, "0")}`,
  folder: `skill-${i}`,
  pack: "pack",
  description: "one line of truth about what this skill does",
  source: "user",
  disabled: i % 3 === 0,
}));

/** A settings view carrying `count` servers, all in the user layer — the shape
 *  mcpModel reads. */
function mcpView(count: number): SettingsView {
  const raw: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) raw[`server-${i}`] = { command: "npx", args: ["-y", `mcp-${i}`] };
  return {
    effective: {
      mcpServers: Array.from({ length: count }, (_, i) => ({
        name: `server-${i}`,
        command: "npx",
        args: ["-y", `mcp-${i}`],
      })),
    },
    origins: { mcpServers: { winner: "user", shadowed: [] } },
    layers: { user: { mcpServers: raw } },
    files: { user: "/tmp/settings.json" },
    workspace: null,
  };
}

/** The skills panel as the operator gets it, with the focus on entry `subIdx`.
 *  The submenu's own index space is entries first, then Manage and Browse — so
 *  36 skills make 38 items, the number the parent's arrow keys count over. */
function skillsPanel(subIdx = 0, rows: SkillRow[] | null | "failed" = SKILLS): string {
  const count = Array.isArray(rows) ? rows.length + 2 : 2;
  return renderToStaticMarkup(
    <PlusSubmenu
      lang="en"
      sub="skills"
      skills={rows}
      view={null}
      mcpWritable={false}
      subIdx={subIdx}
      itemCount={count}
      listRef={createRef<HTMLDivElement>()}
      onKeyDown={() => {}}
      onFocusRow={() => {}}
      onToggleSkill={() => {}}
      onToggleServer={() => {}}
      onPick={() => {}}
    />,
  );
}

/** The MCP panel beside it, drawn from the same component with the same rule. */
function mcpPanel(count: number, subIdx = 0): string {
  return renderToStaticMarkup(
    <PlusSubmenu
      lang="en"
      sub="mcp"
      skills={null}
      view={mcpView(count)}
      mcpWritable={true}
      subIdx={subIdx}
      itemCount={count + 1}
      listRef={createRef<HTMLDivElement>()}
      onKeyDown={() => {}}
      onFocusRow={() => {}}
      onToggleSkill={() => {}}
      onToggleServer={() => {}}
      onPick={() => {}}
    />,
  );
}

describe("the plus menu's entry rows ride in a well of their own", () => {
  it("puts every installed skill inside the scroller", () => {
    const html = skillsPanel();
    expect(switchRows(html)).toBe(36);
    // The claim of the card, as markup: the rows are IN the well. A list that
    // renders beside the well instead of inside it is exactly the old shape.
    expect(switchRows(divBlock(html, "plus-scroll"))).toBe(36);
  });

  it("leaves the popover's own footer outside the well, so it cannot scroll away", () => {
    const html = skillsPanel();
    const well = divBlock(html, "plus-scroll");
    // ONE well. `divBlock` walks the first one it finds, so without this a
    // second scroller anywhere in the panel would sail past every assertion
    // below — measured: wrapping the footer in a well of its own left all
    // eleven of these green.
    expect(html.match(/class="plus-scroll"/g)?.length).toBe(1);
    // Manage and Browse are the chrome of this popover — it has no head and no
    // back row (measured: the submenu is one group, nothing above it). They are
    // what "stays put" means here, and they are unreachable today.
    expect(html).toContain(dict["plus.manageSkills"].en);
    expect(html).toContain(dict["plus.browseSkills"].en);
    expect(well).not.toContain(dict["plus.manageSkills"].en);
    expect(well).not.toContain(dict["plus.browseSkills"].en);
    // The reach sentence belongs to the switches, not to one screenful of them.
    expect(well).not.toContain("data-reach=");
    expect(html).toContain("data-reach=");
  });

  it("gives the MCP list the same well, not a second one", () => {
    // Criterion 4. The MCP rows come out of the same config map and are drawn
    // with the same row markup in the same box, so they clip at the same count
    // — one rule or the defect comes back one list over.
    const html = mcpPanel(20);
    expect(switchRows(html)).toBe(20);
    expect(html.match(/class="plus-scroll"/g)?.length).toBe(1);
    expect(switchRows(divBlock(html, "plus-scroll"))).toBe(20);
    expect(divBlock(html, "plus-scroll")).not.toContain(dict["plus.manageMcp"].en);
    expect(html).toContain(dict["plus.manageMcp"].en);
    // and the stylesheet grew ONE scroller rule, not one per list
    expect(rules.filter((r) => r.selector.includes(".plus-scroll")).map((r) => r.selector)).toEqual([
      ".plus-scroll",
    ]);
  });

  it("addresses every row by the index the arrow keys move, below the fold included", () => {
    // Criterion 3's mechanism. Nothing can be scrolled into view that cannot be
    // found: the parent's effect looks the focused row up by this attribute, so
    // the numbers here ARE the keyboard's index space — entries 0..35, then
    // Manage at 36 and Browse at 37.
    const html = skillsPanel();
    expect(indices(html)).toEqual(Array.from({ length: 38 }, (_, i) => i));
    expect(indices(divBlock(html, "plus-scroll"))).toEqual(Array.from({ length: 36 }, (_, i) => i));
  });

  it("keeps the index space honest when the list never arrived", () => {
    // A failed or pending fetch draws no entries, and the two footer rows are
    // then items 0 and 1 — the same arithmetic the parent counts with.
    expect(indices(skillsPanel(0, "failed"))).toEqual([0, 1]);
    expect(indices(skillsPanel(0, null))).toEqual([0, 1]);
  });

  it("opens with the first entry focused, and only that one", () => {
    // The second half of criterion 3. The submenu focuses the GROUP and marks
    // the current row with a class — so "the first entry keeps focus on open"
    // is the claim that exactly one row is marked and it is entry zero.
    const html = skillsPanel(0);
    expect(html.match(/wsg-mode-row--focus/g)?.length).toBe(1);
    const first = html.indexOf('data-sub-index="0"');
    const second = html.indexOf('data-sub-index="1"');
    const focus = html.indexOf("wsg-mode-row--focus");
    expect(focus).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(first);
    expect(focus).toBeLessThan(second);
  });

  it("marks a row below the fold when the arrow keys reach it", () => {
    const html = skillsPanel(30);
    expect(html.match(/wsg-mode-row--focus/g)?.length).toBe(1);
    const target = html.indexOf('data-sub-index="30"');
    const next = html.indexOf('data-sub-index="31"');
    const focus = html.indexOf("wsg-mode-row--focus");
    expect(focus).toBeGreaterThan(target);
    expect(focus).toBeLessThan(next);
  });
});

describe("the parent hands the panel its index space, and finds a row by it", () => {
  const parent = code(
    readFileSync(fileURLToPath(new URL("./PlusMenuSettings.tsx", import.meta.url)), "utf8"),
  );

  it("draws the panel with the very list its arrow keys count over", () => {
    // Source, because no test in this suite can open the menu: the panel is
    // drawn once a fetch has answered, and there is no DOM to click the plus
    // with. What is checked is the ONE argument that could drift — the parent's
    // subItems is what Enter activates, and the panel numbers the footer off
    // the same length.
    expect(parent).toContain("<PlusSubmenu");
    expect(parent).toContain("itemCount={subItems.length}");
    expect(parent).toContain("listRef={subListRef}");
  });

  it("looks the focused row up by the attribute the panel actually renders", () => {
    // The seam a render test cannot see and a grep would only pretend to: the
    // effect scrolls whatever `querySelector` finds, and the panel writes the
    // attribute. Rename either half alone and the keyboard walks to rows that
    // never come into view — silently, with every other assertion still green.
    const lookup = /querySelector\(`\[([a-z-]+)="\$\{subIdx\}"\]`\)/.exec(parent);
    if (lookup?.[1] === undefined) throw new Error("nothing looks a focused row up by attribute");
    expect(skillsPanel()).toContain(`${lookup[1]}="30"`);
    // and it asks for the least scrolling there is, so a row already in view
    // does not drag the list under the pointer that is hovering it
    expect(parent).toContain('scrollIntoView({ block: "nearest" })');
  });
});

describe("the stylesheet behind the well", () => {
  it("keeps the popover's bound and takes its scrollbar away", () => {
    // The bound stays where it always was; what changes is who scrolls. The
    // popover is the frame now — if it kept `overflow-y: auto` a short list
    // would have two scrollers and a long one would show both.
    expect(declsOf(".wsg-pop")).toMatch(/max-height:\s*min\(70vh,\s*480px\)/);
    expect(declsOf(".plus-sub")).toMatch(/overflow:\s*hidden/);
  });

  it("makes the entry well the one scroller, and lets it shrink to fit", () => {
    // `min-height: 0` is the declaration the old shape was missing one level
    // up: without it a flex item does not go below its content and the box
    // clips instead of scrolling.
    const well = declsOf(".plus-scroll");
    expect(well).toMatch(/overflow-y:\s*auto/);
    expect(well).toMatch(/min-height:\s*0/);
    expect(declsOf(".plus-items")).toMatch(/min-height:\s*0/);
  });

  it("pins the footer so the shrink lands on the list", () => {
    // Every direct child of the group that is NOT the well refuses to shrink,
    // so the height the popover is short by comes off the list and never off
    // the rows that lead out of it.
    const footer = rules.find((r) => /\.plus-items\s*>/.test(r.selector));
    if (footer === undefined) throw new Error("nothing pins the plus submenu's footer");
    expect(footer.decls).toMatch(/flex:\s*none/);
    for (const child of [".plus-sep", ".settings-note", '[role="menuitem"]']) {
      expect(footer.selector).toContain(child);
    }
  });

  it("does not cut the wheel off at the well's edges", () => {
    // The card-206 contract, restated where it is cheap: a bounded well may
    // consume the gesture while it can still move, and hands the rest back.
    expect(declsOf(".plus-scroll")).not.toMatch(/overscroll-behavior/);
  });
});
