// Card 363: how tall a tool card's body may get, and who decides.
//
// THE OWNER'S REPORT, and the half of it that was wrong. He asked why the
// markdown preview stops at a window while the json view "geht all down bis zum
// ende", and asked for the preview to be much taller when there is much text.
// Markdown-versus-json is not the line. `.tv-md` and `.tv-well` are the two
// faces of ONE chip in `ToolViewBody.tsx` — `rendered ? <div class="tv-md"> :
// <pre class="tv-well mono">` — and both stood at `max-height: 260px`, so
// flipping the chip could never have changed the box. The line is the json face
// against everything else.
//
// WHY THE CEILING IS A FRACTION OF THE WINDOW AND NOT A PIXEL COUNT. Measured
// 2026-09-01 over 411 transcript files (every 19th of the 7,796 under
// ~/.claude/projects): 18,746 tool results, 2,016 of them from `Read`. At this
// line-height a 260px box shows 13 lines and holds 27.6% of those file bodies
// whole; 780px shows 41 lines and holds 37.6%; 900px shows 48 and holds 40.9%.
// There is no pixel number that turns "most bodies fit" true, so the ceiling
// cannot be an argument about content. It is an argument about the window: a
// box taller than the window takes the card's head, its other regions and the
// next card off-screen while the reader is inside it. Completeness is answered
// somewhere else — by the json face, which this file pins as uncapped, and by
// the lifted clip, which toolBodyClip.test.tsx pins.
//
// So this asks four things of the sheet: that no body box pins a fixed height,
// that every one of them reads the SAME ceiling out of one token rather than
// carrying a number of its own, that the ceiling is stated against the window,
// and that the json tree is capped by nothing at all.
//
// Selectors are parsed, never grepped (card 360). A substring search for
// `.tv-well` matches `.modal-input .tv-well` and `.gate-payload .tv-well`, both
// of which deliberately say `max-height: none`, and a guard that read either of
// those as the unscoped rule would swear the cap was already gone.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blockOf, rules, subjectOf } from "../testkit/source";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** @return every file under `dir`, recursively */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const files = walk(SRC);
const toolcard = readFileSync(join(SRC, "styles/toolcard.css"), "utf8");
const everySheet = files
  .filter((f) => f.endsWith(".css"))
  .flatMap((f) => rules(f.slice(SRC.length), readFileSync(f, "utf8")));

/** The one `max-height` value a rule declares, or null. */
function ceilingOf(body: string): string | null {
  const found = /(?:^|;)\s*max-height\s*:([^;]+)/.exec(body);
  return found === null ? null : found[1].trim();
}

/** The value of a custom property defined in `css`, which must be defined once. */
function token(css: string, name: string): string {
  const all = [...css.matchAll(new RegExp(`${name}\\s*:([^;}]+)[;}]`, "g"))];
  expect(all.length, `${name} must be defined exactly once in this sheet`).toBe(1);
  return all[0][1].trim();
}

/** A length written against the viewport, e.g. `70vh`. */
const VIEWPORT = /^(\d+(?:\.\d+)?)(?:d|s|l)?vh$/;

// A box a reader scrolls INSIDE: it stops growing and then offers the rest.
// Same shape scrollChaining.drift.test.ts draws its line with.
const boundedWell = (body: string): boolean =>
  /max-height\s*:/.test(body) && /overflow(?:-y|-x)?\s*:\s*[^;]*(auto|scroll)/.test(body);

describe("a tool card's body grows with what is in it", () => {
  it("pins no fixed height on either face of the body chip", () => {
    for (const selector of [".tv-well", ".tv-md", ".tv-entries"]) {
      expect(blockOf(toolcard, selector), `${selector} must let content set the height`).not.toMatch(
        /(?:^|;)\s*height\s*:/,
      );
    }
  });

  it("gives the two faces of one chip the same ceiling, from one place", () => {
    // The bite this criterion asks for: a fix applied to `.tv-md` alone must
    // turn this red. Before the card both said `260px` and it passed by
    // accident; now they must say the same THING, not the same number.
    const well = ceilingOf(blockOf(toolcard, ".tv-well"));
    const md = ceilingOf(blockOf(toolcard, ".tv-md"));
    expect(well).toBe("var(--tv-body-max)");
    expect(md).toBe(well);
  });

  it("states the ceiling against the reader's window, so it can never outgrow it", () => {
    const body = token(toolcard, "--tv-body-max");
    expect(body, "a pixel ceiling is a number about nothing").toMatch(VIEWPORT);
    // Much higher than the 260px it replaces, at every window size: 70% of a
    // window is over 260px from 372px of height upward, and no window is that
    // short.
    expect(Number(VIEWPORT.exec(body)?.[1])).toBeGreaterThanOrEqual(60);
  });

  it("never lets a whole program sit in a shorter box than an ordinary value", () => {
    const body = token(toolcard, "--tv-body-max");
    const script = token(toolcard, "--tv-script-max");
    expect(script).toMatch(VIEWPORT);
    expect(Number(VIEWPORT.exec(script)?.[1])).toBeGreaterThanOrEqual(Number(VIEWPORT.exec(body)?.[1]));
    expect(ceilingOf(blockOf(toolcard, ".tv-well--script"))).toBe("var(--tv-script-max)");
  });

  it("leaves no body box in the sheet with a ceiling of its own", () => {
    // Derived from the sheet rather than listed by hand: a hand-list plus a
    // loop is two copies of the same lie, and a fifth box added next month
    // would be governed by neither.
    const own = rules("toolcard.css", toolcard)
      .filter((r) => boundedWell(r.body))
      .filter((r) => !/^var\(--tv-[a-z-]+\)$/.test(ceilingOf(r.body) ?? ""));
    expect(own.map((r) => r.selector)).toEqual([".io-block.output"]);
  });

  it("proves that exclusion instead of asserting it: .io-block reaches nothing", () => {
    // The one bounded box left with a number of its own is dead — card 363
    // defers deleting it deliberately, and this is the condition under which
    // the deferral holds. Render it and this guard goes red rather than quietly
    // exempting a live box.
    // Tests are not render sites, and this file names the class in its own
    // prose — without the filter the guard would find ITSELF and report the
    // dead box as live, which is how it first ran.
    const sites = files
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("io-block"))
      .map((f) => f.slice(SRC.length));
    expect(sites).toEqual([]);
  });
});

describe("the json face keeps its freedom", () => {
  const tree = everySheet.filter((r) => subjectOf(r.selector) === ".json-tree");

  it("still finds the rules, so an empty violation list is not a broken parser", () => {
    expect(tree.map((r) => r.selector)).toContain(".json-tree");
    expect(tree.length).toBeGreaterThanOrEqual(2);
  });

  it("caps the tree with neither a height nor a scroller, in any scope", () => {
    // It is the one face of a tool card that shows a value whole. A later tidy
    // that "harmonises" the four faces onto one ceiling would leave the card
    // with no complete view at all, and this is the sentence that stops it.
    const capped = tree
      .filter((r) => /max-height\s*:|(?:^|;)\s*height\s*:|overflow/.test(r.body))
      .map((r) => `${r.rel}:${r.line} ${r.selector}`);
    expect(capped).toEqual([]);
  });
});
