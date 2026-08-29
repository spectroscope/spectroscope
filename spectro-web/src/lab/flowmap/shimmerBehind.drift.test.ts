// Card 308 — the coloured shimmer paints BEHIND the thing it belongs to, so
// only the rim breathes.
//
// The owner's words (2026-08-23): the waft of the LLM node is too crass; less
// opacity, or put it in the background so that only the frames waft. Three
// facts carry that, and each of them is invisible to a component test because
// vitest renders no pixels and jsdom resolves no cascade:
//
//   1. `z-index: -1` on the halo does the work. `.pf-llm` is
//      `position: relative` with no z-index, so it opens NO stacking context;
//      a negative-z child therefore paints before its parent's own background
//      rather than after it. `.pf-card` paints an opaque background over it,
//      and what survives is the 18px the halo overhangs — a breathing RIM.
//   2. THE KEYFRAMES ARE RE-POINTED, NOT OVERRIDDEN. A running animation beats
//      a declared value for every property its keyframes set, so lowering
//      `opacity` on the rule alone would be ignored for the whole cycle. The
//      numbers have to come down inside `@keyframes`. The declared value is
//      still worth setting — it is exactly what a reduced-motion reader sees.
//   3. Reduced motion still wins, and it wins because no rule here carries
//      `!important`: the stylesheet's own prefers-reduced-motion block sets
//      `animation: none !important`, and `!important` beside it would be the
//      one thing able to fight it.
//
// The pins below read NUMBERS out of the declarations, never the text of a
// declaration. A test that matches `scale(1.06)` as a string pins nothing the
// moment someone writes `scale(1.06, 1.06)` or folds the stop into another.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Comments first, for the reason scrubKeepsItsWidth.drift.test.ts gives: a
 *  `}` inside prose ends an extracted rule early, and the cut can hide the
 *  very declaration a `not.toMatch` is hunting for — a false green. */
const css = readFileSync(join(__dirname, "flowmap.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The softened band, from the reference solution the owner pointed at. These
 *  are CEILINGS, not equalities: calmer than this stays green, crasser goes
 *  red. */
const MAX_BREATHE_SCALE = 1.06;
const MAX_HALO_OPACITY = 0.48;
const MIN_BREATHE_SECONDS = 4.2;
/** The busy station (card 295) gets the same treatment at its own scale: the
 *  glow's blur radius used to swing 22px -> 46px on a 1.6s cycle. */
const MAX_STATION_BLUR_PX = 28;
const MIN_STATION_SECONDS = 2.8;

/** The body of a top-level rule, brace-matched rather than cut at the first
 *  `}` — a keyframes body contains braces of its own. */
function block(head: string): string {
  const at = css.indexOf(`\n${head} {`);
  expect(at, `${head} must exist in flowmap.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`${head} is not brace-balanced`);
}

/** Every number a `scale(...)` names inside a block. `scale(1.06, 1.06)` and
 *  `scale(1.06)` both answer 1.06, which is the point of reading it this way. */
function scales(body: string): number[] {
  const out: number[] = [];
  for (const m of body.matchAll(/scale\(([^)]*)\)/g))
    for (const n of m[1].split(",")) out.push(Number(n.trim()));
  return out;
}

function opacities(body: string): number[] {
  return [...body.matchAll(/(?:^|[;{\s])opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
}

/** The first duration in an `animation` shorthand — `s` or `ms`, in seconds. */
function animationSeconds(body: string): number {
  const decl = /animation:\s*([^;]+);/.exec(body);
  expect(decl, "the rule must declare an animation").not.toBeNull();
  const t = /(?:^|\s)([\d.]+)(ms|s)(?:\s|$)/.exec(decl![1]);
  expect(t, `no duration in "${decl![1]}"`).not.toBeNull();
  return t![2] === "ms" ? Number(t![1]) / 1000 : Number(t![1]);
}

/** Split on the commas that are not inside parentheses — `color-mix(in srgb,
 *  …)` is one shadow layer, not two. */
function topLevelCommas(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every `box-shadow` layer declared anywhere in a block, flattened. */
function shadowLayers(body: string): string[] {
  return [...body.matchAll(/box-shadow:\s*([^;]+);/g)].flatMap((m) => topLevelCommas(m[1]));
}

/** The LEADING lengths of a single shadow layer, in px, in order: x, y, blur,
 *  spread. Positional by the grammar of box-shadow itself, not by text. It
 *  stops at the first token that is not a length, so the digits inside a
 *  trailing `rgba(0, 0, 0, 0.34)` can never be mistaken for a blur radius —
 *  and a bare `0` counts, because `0` needs no unit. */
function lengths(layer: string): number[] {
  const out: number[] = [];
  for (const tok of layer.trim().split(/\s+/)) {
    if (tok === "inset") continue;
    const m = /^(-?[\d.]+)(px)?$/.exec(tok);
    if (!m) break;
    out.push(Number(m[1]));
  }
  return out;
}

describe("card 308 — the LLM halo paints behind the card", () => {
  it("gives the halo a negative z-index, which is the whole mechanism", () => {
    const m = /(?:^|[;\s])z-index:\s*(-?\d+)/.exec(block(".pf-llm__halo"));
    expect(m, ".pf-llm__halo must state a z-index").not.toBeNull();
    expect(Number(m![1]), "a halo at z-index >= 0 paints ON the card face").toBeLessThan(0);
  });

  it("leaves .pf-llm without a stacking context, or the negative z is inert", () => {
    // Any of these on the parent would trap the halo inside .pf-llm's own
    // stacking context, where it would paint AFTER the parent background and
    // the rim effect would silently disappear. Measured, not asserted in prose.
    const body = block(".pf-llm");
    expect(body).not.toMatch(/(?:^|[;\s])z-index:\s*(?!auto)/);
    expect(body).not.toMatch(
      /(?:^|[;\s])(?:isolation|transform|filter|backdrop-filter|mix-blend-mode|will-change|contain|perspective):/,
    );
    expect(body).not.toMatch(/(?:^|[;\s])opacity:/);
  });

  it("keeps an opaque card background, which is what does the occluding", () => {
    // A translucent surface would let the halo through and the rim would be a
    // wash over the whole card instead.
    const bg = /(?:^|[;\s])background:\s*([^;]+);/.exec(block(".pf-card"));
    expect(bg, ".pf-card must paint a background").not.toBeNull();
    expect(bg![1]).not.toMatch(/transparent|rgba|color-mix/);
  });

  it("holds the breathe amplitude at or under the softened scale", () => {
    const s = scales(block("@keyframes pf-breathe"));
    expect(s.length, "pf-breathe must still scale").toBeGreaterThan(0);
    expect(Math.max(...s)).toBeLessThanOrEqual(MAX_BREATHE_SCALE);
  });

  it("holds the breathe opacity band at or under the softened peak", () => {
    const o = opacities(block("@keyframes pf-breathe"));
    expect(o.length, "pf-breathe must still name its opacity").toBeGreaterThan(0);
    expect(Math.max(...o)).toBeLessThanOrEqual(MAX_HALO_OPACITY);
  });

  it("slows the cycle to at least the softened period", () => {
    expect(animationSeconds(block(".pf-llm--active .pf-llm__halo"))).toBeGreaterThanOrEqual(
      MIN_BREATHE_SECONDS,
    );
  });

  it("declares the calm opacity too, because that is the reduced-motion value", () => {
    // With `animation: none !important` the keyframes are gone and this
    // number is the only one left. `opacity: 1` here would hand a
    // reduced-motion reader the crassest frame of all, permanently.
    const o = opacities(block(".pf-llm--active .pf-llm__halo"));
    expect(o.length, "the active halo must state an opacity").toBeGreaterThan(0);
    expect(Math.max(...o)).toBeLessThanOrEqual(MAX_HALO_OPACITY);
  });
});

describe("card 308 — the busy station breathes at the same softened rate", () => {
  it("holds the glow's blur radius at or under the softened peak", () => {
    const glow = shadowLayers(block("@keyframes pf-os-busy")).filter((l) => l.includes("--pf-station-glow"));
    expect(glow.length, "the busy keyframe must still carry the station glow").toBeGreaterThan(0);
    // [x, y, blur] — the blur is the third length by the box-shadow grammar.
    expect(Math.max(...glow.map((l) => lengths(l)[2]))).toBeLessThanOrEqual(MAX_STATION_BLUR_PX);
  });

  it("slows the station cycle to at least the softened period", () => {
    expect(animationSeconds(block(".pf-os--busy"))).toBeGreaterThanOrEqual(MIN_STATION_SECONDS);
  });

  it("keeps the occupant's colour on the ring in every frame", () => {
    // --pf-station-glow is per-occupant: accent for main, the worker accent
    // for a child. Softening must not cost the rim its ability to say WHO is
    // on the station, so every keyframe stop still draws the 1px ring.
    const body = block("@keyframes pf-os-busy");
    const stops = [...body.matchAll(/box-shadow:/g)].length;
    expect(stops, "pf-os-busy must still set box-shadow at each stop").toBeGreaterThanOrEqual(2);
    const rings = shadowLayers(body).filter((l) => /var\(--pf-station\)/.test(l));
    expect(rings.length).toBe(stops);
    for (const r of rings) expect(lengths(r)[2]).toBe(0); // a line, not a glow
  });

  it("keeps the two occupant palettes distinct", () => {
    expect(block(".pf-os--busy")).toMatch(/--pf-station-glow:\s*var\(--accent-glow\)/);
    expect(block(".pf-os--worker")).toMatch(/--pf-station-glow:[^;]*--agent-worker/);
  });

  it("states a resting shadow, because that is the reduced-motion frame", () => {
    // Without one, `animation: none` drops the station back to
    // .pf-card--active's plain accent glow and a child's station stops
    // naming its occupant.
    const glow = shadowLayers(block(".pf-os--busy")).filter((l) => l.includes("--pf-station-glow"));
    expect(glow.length, ".pf-os--busy must declare a static box-shadow").toBeGreaterThan(0);
    expect(Math.max(...glow.map((l) => lengths(l)[2]))).toBeLessThanOrEqual(MAX_STATION_BLUR_PX);
  });
});

describe("card 308 — reduced motion keeps the last word", () => {
  it("lets no shimmer rule carry !important", () => {
    for (const head of [
      ".pf-llm__halo",
      ".pf-llm--active .pf-llm__halo",
      "@keyframes pf-breathe",
      ".pf-os--busy",
      ".pf-os--worker",
      "@keyframes pf-os-busy",
    ])
      expect(block(head), `${head} must not out-shout the reduced-motion block`).not.toMatch(/!important/);
  });

  it("still lists both shimmers among the animations reduced motion stops", () => {
    const body = block("@media (prefers-reduced-motion: reduce)");
    expect(body).toContain(".pf-llm--active .pf-llm__halo");
    expect(body).toContain(".pf-os--busy");
    expect(body).toMatch(/animation:\s*none\s*!important/);
  });
});
