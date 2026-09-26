// Card 408: the composer and the status bar carry less padding.
//
// The owner asked for a few pixels less above the message field and a lower
// status bar under it. Three declared values move and one must not:
//
//   .composer        padding-top     --sp-3 (12px) to --sp-2 (8px)
//   .composer-history margin-bottom  --sp-1 (4px)  to 0
//   .usage-footer    padding-top and padding-bottom, --sp-2 (8px) to --sp-1 (4px)
//   .composer        padding-bottom  stays --sp-3 (12px)
//
// The last line is the seam with card 383: composerRow.drift.test.ts reads the
// same padding-bottom for its reach math, against two ceilings and a tolerance
// of one --sp-1 rung, so it accepts more than one value. This file pins one.
//
// How a value is read. A rule counts only when one of its comma-separated
// selectors is exactly the selector asked for, and only in the ./styles/
// sheets that app.css @imports. Those rules are taken in import order,
// shorthand and longhand alike, and the last declaration wins. Rules inside an
// @media block are read as if they always applied, so a media override of
// these properties reads as the value here. On 2026-09-24 none of the rules
// this file reads sits inside one.
//
// What it does not read. It weighs neither specificity nor !important, so a
// scoped rule such as ".chat .composer" or "[data-design] .composer" is
// skipped. It skips the rules app.css declares after its own imports,
// designs.css (main.tsx loads it after app.css), and the sheets a component
// imports on its own, such as bus.css and export-dialog.css. An override in
// any of those leaves this file green while the browser renders another
// value. On 2026-09-24 a scan of every .css file under src found no skipped
// rule that sets padding, margin or font-size on .composer, .composer-history
// or .usage-footer.
//
// Card 441: on a new chat the working folder row gets as much room below it
// as it has above it, and the status bar loses its top line and its own
// background, so the input area and the status bar read as one piece. Four
// more declared values:
//
//   .ws-chooser      margin-bottom  --sp-1 (4px) to --sp-5 (24px)
//   .usage-footer    border-top     1px var(--border) to 1px transparent
//   .usage-footer    background     var(--surface) to none declared
//   .composer        border-top     stays 1px solid var(--border)
//
// The room above the row is not typed here. It is added up from what the
// sheets declare above the row in the composer column: .composer padding-top,
// .composer-column padding-top, the walk counter slot (.composer-history) and
// the row's own margin-top. That sum counts the slot as the only element
// between the composer's top line and the row. Chat.tsx mounts more there,
// none of it is counted, and while any of it shows the room above the row is
// bigger than the room below:
//
//   the queue chips. A message waits as a chip while a run is going, and also
//     while the socket is down, so a chip can show before the first prompt.
//   the intake notice (attachments.notice), for a picture it could not read
//     or more pictures than one message may carry.
//   the level meter and the recording line, while the microphone records.
//   the line that says why a live transcription gave no text
//     (voice.liveFailed). It stays until the next live recording starts.
//
// Each of them can show on a new chat before the first message, next to the
// row.
//
// Which rules the reader skips. On 2026-09-25 a scan of every .css file under
// src looked at the rules that name .ws-chooser, .composer-column,
// .composer-history, .composer-inner, .usage-footer or .composer and set a
// margin, padding, border, background, height, min-height, max-height,
// line-height or white-space. Every rule whose selector is exactly one of
// them sits in a sheet this file reads. Three scoped rules are skipped, and
// none of them sets a value this file reads:
//
//   ".archive-bar .composer-inner" sets min-height: 42px. It styles the
//     archive bar, and Chat.tsx mounts the row only in the live composer.
//   ".composer-inner.drag-over .composer-box" sets the border and background
//     of the box inside .composer-inner, not of .composer-inner.
//   ".composer::before" sets the height and background of the fade above the
//     composer's top line, not of .composer.

import { describe, expect, it } from "vitest";
import { read, rules } from "../testkit/source";

const app = read("../app.css", import.meta.url);
const tokens = read("../tokens.css", import.meta.url);

/** The spacing ladder, read out of tokens.css. */
const SPACING = new Map<string, number>(
  [...tokens.matchAll(/--(sp-\d+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]),
);

/** One rung of the spacing ladder in px, or a throw naming the missing token. */
function rung(name: string): number {
  const n = SPACING.get(name);
  if (n === undefined) throw new Error(`tokens.css has no --${name}`);
  return n;
}

/** A `0`, an `Npx` or a `var(--sp-N)` as px, or a throw naming what failed. */
function px(value: string | null, what: string): number {
  if (value === null) throw new Error(`${what}: nothing is declared`);
  const token = value.match(/^var\(--(sp-\d+)\)$/);
  if (token) return rung(token[1]);
  if (value === "0") return 0;
  const literal = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (literal) return Number(literal[1]);
  throw new Error(`${what}: cannot resolve "${value}" to px`);
}

/** Every rule in the ./styles/ sheets app.css @imports, in import order. */
const SHEETS = [...app.matchAll(/@import\s+"\.\/styles\/([^"]+)"/g)].map((m) => m[1]);
const ALL_RULES = SHEETS.flatMap((name) => rules(name, read(`./${name}`, import.meta.url)));

type Side = "top" | "right" | "bottom" | "left";
const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

/**
 * The four sides of `padding` or `margin` for one exact selector, read across
 * ALL_RULES in order: a shorthand sets all four, a `-top` style longhand sets
 * one, and a later declaration replaces an earlier one.
 */
function box(selector: string, prop: "padding" | "margin"): Record<Side, string | null> {
  const out: Record<Side, string | null> = { top: null, right: null, bottom: null, left: null };
  const matching = ALL_RULES.filter((r) => r.selector === selector);
  if (matching.length === 0) throw new Error(`no sheet in app.css declares ${selector}`);
  for (const rule of matching) {
    for (const decl of rule.body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (name === prop) {
        const parts = value.split(/\s+(?![^(]*\))/);
        const four = {
          1: [parts[0], parts[0], parts[0], parts[0]],
          2: [parts[0], parts[1], parts[0], parts[1]],
          3: [parts[0], parts[1], parts[2], parts[1]],
          4: parts,
        }[parts.length];
        if (four === undefined) throw new Error(`${selector} ${prop} has ${parts.length} parts`);
        SIDES.forEach((side, i) => (out[side] = four[i]));
      } else {
        for (const side of SIDES) if (name === `${prop}-${side}`) out[side] = value;
      }
    }
  }
  return out;
}

/** The last value ALL_RULES declares for a plain property on one exact selector, or null. */
function last(selector: string, prop: string): string | null {
  let value: string | null = null;
  for (const rule of ALL_RULES.filter((r) => r.selector === selector)) {
    for (const decl of rule.body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon >= 0 && decl.slice(0, colon).trim() === prop) value = decl.slice(colon + 1).trim();
    }
  }
  return value;
}

describe("the band above the message field is smaller (card 408)", () => {
  it("gives .composer a padding-top of --sp-2", () => {
    const top = px(box(".composer", "padding").top, ".composer padding-top");
    expect(top, ".composer padding-top").toBe(rung("sp-2"));
  });

  it("gives the walk counter slot no bottom margin", () => {
    const bottom = px(box(".composer-history", "margin").bottom, ".composer-history margin-bottom");
    expect(bottom, ".composer-history margin-bottom").toBe(0);
  });

  it("leaves .composer's padding-bottom at --sp-3, the value card 383's reach math reads", () => {
    const bottom = px(box(".composer", "padding").bottom, ".composer padding-bottom");
    expect(bottom, ".composer padding-bottom").toBe(rung("sp-3"));
  });

  it("leaves .composer's side padding at --sp-4", () => {
    const sides = box(".composer", "padding");
    expect(px(sides.left, ".composer padding-left"), ".composer padding-left").toBe(rung("sp-4"));
    expect(px(sides.right, ".composer padding-right"), ".composer padding-right").toBe(rung("sp-4"));
  });
});

describe("the status bar is lower (card 408)", () => {
  it("gives .usage-footer a padding of --sp-1 on top and bottom", () => {
    const sides = box(".usage-footer", "padding");
    expect(px(sides.top, ".usage-footer padding-top"), ".usage-footer padding-top").toBe(rung("sp-1"));
    expect(px(sides.bottom, ".usage-footer padding-bottom"), ".usage-footer padding-bottom").toBe(
      rung("sp-1"),
    );
  });

  it("leaves the side padding at --sp-4 and the font size at --fs-12", () => {
    const sides = box(".usage-footer", "padding");
    expect(px(sides.left, ".usage-footer padding-left"), ".usage-footer padding-left").toBe(rung("sp-4"));
    expect(px(sides.right, ".usage-footer padding-right"), ".usage-footer padding-right").toBe(rung("sp-4"));
    expect(last(".usage-footer", "font-size"), ".usage-footer font-size").toBe("var(--fs-12)");
  });
});

/** A side a sheet leaves undeclared counts as 0 px. */
function orZero(value: string | null, what: string): number {
  return value === null ? 0 : px(value, what);
}

/** The top edge of one exact selector's border: width, style and colour as declared. */
interface Edge {
  width: string;
  style: string;
  color: string;
}

const STYLES = /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/;

/**
 * A `border` or `border-top` shorthand as its three parts. A part the
 * shorthand leaves out takes its initial value, as in CSS: medium, none,
 * currentcolor.
 */
function edgeOf(value: string, what: string): Edge {
  const out: Edge = { width: "medium", style: "none", color: "currentcolor" };
  if (value === "0") return { ...out, width: "0" };
  for (const part of value.split(/\s+(?![^(]*\))/)) {
    if (STYLES.test(part)) out.style = part;
    else if (/^(0|thin|medium|thick|\d+(?:\.\d+)?px|var\(--sp-\d+\))$/.test(part)) out.width = part;
    else if (part) out.color = part;
    else throw new Error(`${what}: empty part in "${value}"`);
  }
  return out;
}

/**
 * The top border of one exact selector, read across ALL_RULES in order. It
 * reads `border`, `border-top` and the three `border-top-*` longhands, and
 * throws on any other declaration that can set the top edge (the four-sided
 * `border-width`, `border-style` and `border-color`, and the logical
 * `border-block*`), so a rewrite into one of those fails here instead of
 * reading as no border.
 */
function topEdge(selector: string): Edge {
  let out: Edge = { width: "medium", style: "none", color: "currentcolor" };
  const matching = ALL_RULES.filter((r) => r.selector === selector);
  if (matching.length === 0) throw new Error(`no sheet in app.css declares ${selector}`);
  for (const rule of matching) {
    for (const decl of rule.body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (name === "border" || name === "border-top") out = edgeOf(value, `${selector} ${name}`);
      else if (name === "border-top-width") out = { ...out, width: value };
      else if (name === "border-top-style") out = { ...out, style: value };
      else if (name === "border-top-color") out = { ...out, color: value };
      else if (/^border-(width|style|color)$/.test(name) || name.startsWith("border-block")) {
        throw new Error(`${selector} ${name}: this file does not read it`);
      }
    }
  }
  return out;
}

/** The top edge's width in px: 0 for a style that draws nothing, 3 for medium. */
function edgeWidth(edge: Edge, what: string): number {
  if (edge.style === "none" || edge.style === "hidden") return 0;
  const named: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
  return named[edge.width] ?? px(edge.width, what);
}

/**
 * Whether the top edge paints a line. A colour counts as invisible only when
 * it is the keyword `transparent` or an rgba() or hsla() with alpha 0. A
 * var() colour counts as visible: this file does not resolve colour tokens.
 */
function paintsLine(edge: Edge, what: string): boolean {
  if (edgeWidth(edge, what) === 0) return false;
  if (edge.color === "transparent") return false;
  if (/^(rgba|hsla)\(.*[,/]\s*0(?:\.0+)?\s*\)$/.test(edge.color)) return false;
  return true;
}

/** Every value the sheets declare for a background property on one exact selector. */
function backgrounds(selector: string): string[] {
  return ALL_RULES.filter((r) => r.selector === selector).flatMap((rule) =>
    rule.body.split(";").flatMap((decl) => {
      const colon = decl.indexOf(":");
      if (colon < 0) return [];
      return decl.slice(0, colon).trim().startsWith("background") ? [decl.slice(colon + 1).trim()] : [];
    }),
  );
}

describe("the working folder row has the same room above and below (card 441)", () => {
  /** From the composer's top line down to the row: what the column declares above it. */
  function roomAbove(): number {
    expect(last(".composer-history", "white-space"), "the walk counter slot is one line").toBe("nowrap");
    const slotMargin = box(".composer-history", "margin");
    const slot =
      orZero(slotMargin.top, ".composer-history margin-top") +
      Math.max(
        px(last(".composer-history", "min-height"), ".composer-history min-height"),
        px(last(".composer-history", "line-height"), ".composer-history line-height"),
      ) +
      orZero(slotMargin.bottom, ".composer-history margin-bottom");
    return (
      px(box(".composer", "padding").top, ".composer padding-top") +
      orZero(box(".composer-column", "padding").top, ".composer-column padding-top") +
      slot +
      orZero(box(".ws-chooser", "margin").top, ".ws-chooser margin-top")
    );
  }

  /** From the row down to the input box: the row's margin-bottom and the box's margin-top. */
  function roomBelow(): number {
    return (
      orZero(box(".ws-chooser", "margin").bottom, ".ws-chooser margin-bottom") +
      orZero(box(".composer-inner", "margin").top, ".composer-inner margin-top")
    );
  }

  it("puts as much room below the row as the column puts above it", () => {
    expect(roomAbove(), "room above the row").toBeGreaterThan(0);
    expect(roomBelow(), "room below the row").toBe(roomAbove());
  });

  it("is no longer the 4px of card 389", () => {
    expect(roomBelow(), "room below the row").not.toBe(rung("sp-1"));
  });

  it("takes the room below from the spacing ladder, --sp-5", () => {
    expect(box(".ws-chooser", "margin").bottom, ".ws-chooser margin-bottom").toBe("var(--sp-5)");
  });
});

describe("the input area and the status bar read as one piece (card 441)", () => {
  it("draws no line on top of the status bar", () => {
    expect(paintsLine(topEdge(".usage-footer"), ".usage-footer border-top")).toBe(false);
  });

  it("keeps the composer's own top line, between the history and the input", () => {
    expect(paintsLine(topEdge(".composer"), ".composer border-top")).toBe(true);
  });

  it("keeps the status bar's top edge 1px wide, so nothing above it moves", () => {
    const edge = topEdge(".usage-footer");
    expect(edge.style, ".usage-footer border-top-style").toBe("solid");
    expect(px(edge.width, ".usage-footer border-top-width"), ".usage-footer border-top-width").toBe(1);
  });

  it("gives the status bar no background of its own, as the composer has none", () => {
    const clear = (value: string) => /^(none|transparent)$/.test(value);
    expect(backgrounds(".usage-footer").filter((v) => !clear(v)), ".usage-footer background").toEqual([]);
    expect(backgrounds(".composer").filter((v) => !clear(v)), ".composer background").toEqual([]);
  });
});
