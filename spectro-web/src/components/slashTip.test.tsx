// Card 253: the picker explains the FOCUSED row in a popover beside the list.
//
// The inline `.slash-desc` ellipsizes after a few words, which is worst exactly
// where it matters most: a catalogue skill carries its "use when" in the
// description, so the reader picked by four words and a guess. The popover is
// the whole text, and the row it explains is the row the reader is on — the
// picker keeps ONE focus index and both the arrow keys and the mouse write it,
// so keyboard and hover cannot disagree by construction.
//
// Three pins, because a fold nobody consults ships dead (the sessionRowDensity
// lesson). The two folds are driven directly; the markup is rendered statically
// (no DOM in this suite); and the picker's own source is read to prove the
// popover is fed from `index` and hangs OUTSIDE the scrolling list box.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SLASH_TIP_GAP, SLASH_TIP_MIN, SLASH_TIP_W, SlashTip, slashTipBox, slashTipView } from "./SlashTip";
import { useSlashPicker } from "./SlashPicker";
import { __resetSkillList, loadSkills } from "../state/skillList";
import type { SkillOption } from "../state/slashCommands";
import { blockOf, read, stripComments } from "../testkit/source";
import { setLang } from "../state/lang";

/** A real catalogue description: the reason this card exists is that four words
 *  of this say nothing. Plain ASCII so the markup assertions need no escaping. */
const GRILL =
  "Use when receiving code review feedback, before implementing suggestions, " +
  "especially if the feedback seems unclear or technically questionable - " +
  "requires verification rather than performative agreement.";
const BRAIN = "Explores user intent and requirements before any implementation.";

const SKILLS: SkillOption[] = [
  {
    name: "matt-pocock:grill-me",
    folder: "grill-me",
    pack: "matt-pocock",
    description: GRILL,
    disabled: false,
  },
  {
    name: "superpowers:brainstorming",
    folder: "brainstorming",
    pack: "superpowers",
    description: BRAIN,
    disabled: false,
  },
  { name: "zeta", folder: "zeta", pack: null, description: "", disabled: false },
];

describe("slashTipView — which row the popover explains", () => {
  it("carries the focused row, whole text and all", () => {
    const view = slashTipView(SKILLS, 0);
    expect(view?.name).toBe("matt-pocock:grill-me");
    expect(view?.description).toBe(GRILL);
    // The point of the card: nothing here shortens the prose.
    expect(view?.description.length).toBeGreaterThan(200);
  });

  it("follows the index — the one thing arrows and hover both move", () => {
    expect(slashTipView(SKILLS, 1)?.name).toBe("superpowers:brainstorming");
    expect(slashTipView(SKILLS, 1)?.description).toBe(BRAIN);
  });

  it("explains nothing when there is nothing to pick", () => {
    expect(slashTipView([], 0)).toBeNull();
  });

  it("explains nothing when the list shrank under the index", () => {
    // A keystroke narrows the query while the focus sat on row 5. The picker
    // resets the index in an effect, so for one render the index is past the
    // end — an empty box beside the list would be the visible bug.
    expect(slashTipView(SKILLS, 7)).toBeNull();
  });

  it("stays away from a skill that has no description", () => {
    // An older server sends none (skillList reads it as ""). A dark empty panel
    // beside the list reads as a broken popover rather than as silence.
    expect(slashTipView(SKILLS, 2)).toBeNull();
  });
});

describe("slashTipBox — the side with the room, measured", () => {
  it("hangs to the right of the list when the window has the room", () => {
    // A 1600px window, the centred column: 564px to the right of the pop.
    expect(slashTipBox({ popLeft: 500, popRight: 1020, viewportWidth: 1600 })).toEqual({
      side: "right",
      width: SLASH_TIP_W,
    });
  });

  it("flips to the left when the right side has no room", () => {
    // 1000px window: 44px right of the pop, 404px left of it.
    expect(slashTipBox({ popLeft: 420, popRight: 940, viewportWidth: 1000 })).toEqual({
      side: "left",
      width: SLASH_TIP_W,
    });
  });

  it("takes the roomier side and shrinks to it when neither fits", () => {
    // A 900px window with the sidebar: 68px right, 280px left. A flip that puts
    // the box half off the window only moves the problem.
    expect(slashTipBox({ popLeft: 296, popRight: 816, viewportWidth: 900 })).toEqual({
      side: "left",
      width: 280,
    });
  });

  it("shrinks down to the legibility floor and no further", () => {
    const box = slashTipBox({ popLeft: 216, popRight: 700, viewportWidth: 760 });
    expect(box).toEqual({ side: "left", width: SLASH_TIP_MIN });
  });

  it("draws nothing rather than a sliver when neither side has the floor", () => {
    // 600px window, no rail: 84px each side. The row's title attribute is what
    // is left, and that is the honest answer.
    expect(slashTipBox({ popLeft: 100, popRight: 500, viewportWidth: 600 })).toBeNull();
  });

  it("keeps the window edge, not just the window", () => {
    // Right room is exactly the width plus the gap plus the edge: it fits.
    expect(slashTipBox({ popLeft: 900, popRight: 1000, viewportWidth: 1336 })?.side).toBe("right");
    // One pixel less and it does not.
    expect(slashTipBox({ popLeft: 900, popRight: 1000, viewportWidth: 1335 })?.side).toBe("left");
  });
});

describe("the rendered popover", () => {
  afterEach(() => setLang("en"));

  const view = { name: "matt-pocock:grill-me", description: GRILL };

  it("prints the whole description, wrapped in a box of the measured width", () => {
    const html = renderToStaticMarkup(<SlashTip view={view} box={{ side: "right", width: 280 }} />);
    expect(html).toContain(GRILL);
    expect(html).toContain("matt-pocock:grill-me");
    expect(html).toContain("--slash-tip-w:280px");
    expect(html).toContain("slash-tip--right");
  });

  it("wears the shared popover surface, so all four designs restyle it", () => {
    const html = renderToStaticMarkup(<SlashTip view={view} box={{ side: "left", width: SLASH_TIP_W }} />);
    expect(html).toContain("wsg-pop slash-tip slash-tip--left");
  });

  it("is decoration: no key, no pointer, nothing to focus", () => {
    const html = renderToStaticMarkup(<SlashTip view={view} box={{ side: "right", width: SLASH_TIP_W }} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<button");
    expect(html).not.toMatch(/tabindex/i);
    // The listbox row already carries the same text as its own content, so the
    // reader on a screen reader hears it from the option. A second copy would
    // be announced twice.
    const source = stripComments(read("./SlashTip.tsx", import.meta.url));
    expect(source).not.toMatch(/on[A-Z]\w+=/);
    expect(source).not.toContain("addEventListener");
  });

  it("labels itself in both languages", () => {
    setLang("en");
    expect(renderToStaticMarkup(<SlashTip view={view} box={{ side: "right", width: 320 }} />)).toContain(
      "Description",
    );
    setLang("de");
    expect(renderToStaticMarkup(<SlashTip view={view} box={{ side: "right", width: 320 }} />)).toContain(
      "Beschreibung",
    );
  });
});

describe("the picker hands the popover the focused row", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(async () => {
    __resetSkillList();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ skills: SKILLS }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    // Seeds the module store the picker reads, so a static render has rows.
    loadSkills();
    await flush();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetSkillList();
  });

  function Picker({ draft }: { draft: string }) {
    const slash = useSlashPicker(draft, draft.length, true, () => {});
    return <div className="composer-inner">{slash.node}</div>;
  }

  /** Everything from the popover's own box to the end of the markup — so an
   *  assertion cannot be satisfied by the row's `title` attribute above it. */
  function tipOf(html: string): string {
    const at = html.indexOf("slash-tip");
    expect(at, "the popover is in the markup at all").toBeGreaterThan(-1);
    return html.slice(at);
  }

  it("explains the row it has marked selected", () => {
    // `/r` matches both packed skills; grill-me ranks first, so it is the row
    // the picker has focused and the row the popover must be about.
    const html = renderToStaticMarkup(<Picker draft="/r" />);
    expect(html).toMatch(/aria-selected="true"[\s\S]{0,160}matt-pocock:grill-me/);
    const tip = tipOf(html);
    expect(tip).toContain(GRILL);
    expect(tip).not.toContain(BRAIN);
  });

  it("hangs the popover outside the list's own scrolling box", () => {
    // .wsg-pop scrolls (overflow-y), so a flyout INSIDE it is clipped — the
    // rule .plus-sub already documents. The popover is a sibling of the pop.
    const html = renderToStaticMarkup(<Picker draft="/r" />);
    expect(html.indexOf("slash-tip")).toBeGreaterThan(html.indexOf("slash-hint"));
    const source = stripComments(read("./SlashPicker.tsx", import.meta.url));
    expect(source.indexOf("{tip}")).toBeGreaterThan(source.lastIndexOf("</div>"));
  });

  it("says nothing when no skill matches", () => {
    const html = renderToStaticMarkup(<Picker draft="/zzzz" />);
    expect(html).not.toContain("slash-tip");
  });

  it("is fed by the index that both the arrows and the mouse move", () => {
    // The whole of "keyboard focus and hover agree" is that there is ONE index.
    const source = stripComments(read("./SlashPicker.tsx", import.meta.url));
    // Card 471: the commands share that index and stand first, so a skill's
    // place in it is its place in the skill list plus the commands above it.
    expect(source).toMatch(/slashTipView\(options, index - commands\.length\)/);
    expect(source).toMatch(/onMouseEnter=\{\(\) => setIndex\(at\)\}/);
    expect(source).toMatch(/const at = commands\.length \+ skillAt;/);
    expect(source).toMatch(/const rowCount = commands\.length \+ options\.length;/);
    expect(source).toMatch(/setIndex\(\(i\) => \(i \+ step \+ rowCount\) % rowCount\)/);
  });

  it("measures the pop it hangs off, and re-measures when the room changes", () => {
    const source = stripComments(read("./SlashPicker.tsx", import.meta.url));
    expect(source).toMatch(/ref=\{popRef\}/);
    expect(source).toMatch(/slashTipBox\(\{/);
    expect(source).toMatch(/popLeft: [\w.]+\.left/);
    expect(source).toMatch(/popRight: [\w.]+\.right/);
    expect(source).toMatch(/viewportWidth: window\.innerWidth/);
    // The dock is dragged without the window resizing, and the window resizes
    // without the pop changing width. Both move the room, so both are watched.
    expect(source).toContain("ResizeObserver");
    expect(source).toMatch(/addEventListener\("resize"/);
  });

  it("keeps Escape and Enter the picker's own", () => {
    const source = stripComments(read("./SlashPicker.tsx", import.meta.url));
    expect(source).toMatch(/event\.key === "Escape"[\s\S]{0,120}setDismissed\(true\)/);
    expect(source).toMatch(/event\.key === "Enter" \|\| event\.key === "Tab"[\s\S]{0,120}pick\(active\)/);
  });

  /** The rows, one fragment each, so an assertion cannot be satisfied by some
   *  other row's markup further down. */
  function rowsOf(html: string): string[] {
    return html.split("<li").slice(1);
  }

  it("says which pack a row came from, and says nothing for a top-level skill", () => {
    const rows = rowsOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(rows.length).toBe(3);
    const grill = rows.find((r) => r.includes("matt-pocock:grill-me"));
    expect(grill).toMatch(/class="wsg-scope-tag"[^>]*>matt-pocock</);
    const zeta = rows.find((r) => r.includes(">zeta<"));
    expect(zeta).toBeDefined();
    expect(zeta).not.toContain("wsg-scope-tag");
  });

  it("names the tag in both languages", () => {
    setLang("de");
    expect(renderToStaticMarkup(<Picker draft="/" />)).toContain('title="Namensraum"');
    setLang("en");
    expect(renderToStaticMarkup(<Picker draft="/" />)).toContain('title="Namespace"');
  });
});

describe("the popover's box, as the stylesheet draws it", () => {
  const css = read("../styles/modal-composer.css", import.meta.url);

  /** The declarations of the first block whose selector line contains `sel`. */
  function declsOf(sel: string): string {
    const at = css.indexOf(`${sel} {`);
    expect(at, `the rule ${sel} exists`).toBeGreaterThan(-1);
    const open = css.indexOf("{", at);
    return css.slice(open + 1, css.indexOf("}", open));
  }

  it("beats .wsg-pop's own right:0 and 380px with a compound selector", () => {
    // workspace-gear.css loads AFTER this file, so a bare .slash-tip would lose
    // the cascade and take .wsg-pop's right edge — the trap .slash-pop and
    // .disc-pop both document.
    expect(declsOf(".wsg-pop.slash-tip")).toMatch(/width:\s*var\(--slash-tip-w\)/);
    expect(declsOf(".wsg-pop.slash-tip")).toMatch(new RegExp(`--slash-tip-w:\\s*${SLASH_TIP_W}px`));
  });

  it("cannot trap the pointer or show a scrollbar it will not let anybody use", () => {
    const base = declsOf(".wsg-pop.slash-tip");
    expect(base).toMatch(/pointer-events:\s*none/);
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).toMatch(/max-height:\s*min\(/);
  });

  it("sits beside the list at the gap the fold measures, both ends reset", () => {
    const gap = String(SLASH_TIP_GAP);
    const right = declsOf(".wsg-pop.slash-tip--right");
    expect(right).toMatch(new RegExp(`left:\\s*calc\\(min\\(520px, 100%\\) \\+ ${gap}px\\)`));
    expect(right).toMatch(/right:\s*auto/);
    const left = declsOf(".wsg-pop.slash-tip--left");
    expect(left).toMatch(new RegExp(`right:\\s*calc\\(100% \\+ ${gap}px\\)`));
    expect(left).toMatch(/left:\s*auto/);
    // The 520 is the list's own width; measured against a different one, the
    // popover would overlap the list or float away from it.
    expect(declsOf(".wsg-pop.slash-pop")).toMatch(/width:\s*min\(520px, 100%\)/);
  });

  it("wraps the prose the row could not, and bounds what it draws", () => {
    const text = declsOf(".slash-tip-text");
    expect(text).toMatch(/white-space:\s*normal/);
    expect(text).toMatch(/overflow-wrap:\s*anywhere/);
    expect(text).toMatch(/-webkit-line-clamp:\s*\d+/);
  });

  it("paints in tokens only — four designs, no colour of its own", () => {
    for (const sel of [".wsg-pop.slash-tip", ".slash-tip-name", ".slash-tip-text"]) {
      expect(declsOf(sel)).not.toMatch(/#[0-9a-fA-F]{3}/);
      expect(declsOf(sel)).not.toMatch(/\b(rgb|hsl)a?\(/);
    }
  });

  it("holds the pack tag at its own width inside the row", () => {
    // .wsg-scope-tag carries font, colour, border and padding and NO flex, so
    // inside .slash-row it takes the flex default 0 1 auto and shrinks under a
    // long description. The row rule is what stops that.
    expect(blockOf(css, ".slash-row .wsg-scope-tag")).toMatch(/flex:\s*none/);
    // And the description keeps the ellipsis it had, so a long one still ends
    // in dots rather than pushing the name or the tag out of the row.
    const desc = blockOf(css, ".slash-desc");
    expect(desc).toMatch(/flex:\s*1/);
    expect(desc).toMatch(/min-width:\s*0/);
    expect(desc).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("lets a narrow row wrap, and holds the name to the row's width", () => {
    // Card 375 criterion 5 failed at 390 px in loop wave V0 (Finding 1): the
    // name was flex: none in a row that did not wrap, so
    // superpowers:verification-before-completion and its tag ran past a 308 px
    // row and the picker scrolled sideways. These are the declarations the fix
    // rests on: the row may break into a second line, and the name is capped at
    // the row's width and may break inside itself. What they add up to on
    // screen is read in the browser, not here.
    expect(blockOf(css, ".slash-row")).toMatch(/flex-wrap:\s*wrap\s*;/);
    const name = blockOf(css, ".slash-name");
    expect(name).toMatch(/max-width:\s*100%\s*;/);
    expect(name).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  it("paints the tag in three tokens and no colour of its own", () => {
    // Criterion 7, decided statically: a screenshot cannot say "only these
    // three". --text-faint, --surface-2 and --border are the colour-bearing
    // ones; the rest is font, radius and spacing.
    const gear = read("../styles/workspace-gear.css", import.meta.url);
    const allowed = new Set([
      "--font-mono",
      "--fs-11",
      "--text-faint",
      "--surface-2",
      "--border",
      "--radius-chip",
      "--sp-2",
    ]);
    for (const body of [blockOf(gear, ".wsg-scope-tag"), blockOf(css, ".slash-row .wsg-scope-tag")]) {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3}/);
      expect(body).not.toMatch(/\b(rgb|hsl)a?\(/);
      for (const m of body.matchAll(/var\((--[\w-]+)/g)) {
        expect(allowed, `${m[1]} is new on the tag`).toContain(m[1]);
      }
    }
  });
});
