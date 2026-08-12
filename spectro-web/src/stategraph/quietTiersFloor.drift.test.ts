// The state graph's quiet text still speaks. Read off disk.
//
// Owner call 2026-08-12: inside the state graph view, the faint and dim tiers
// carry FACTS — "not recorded", "never entered", the step numbers — and a fact
// a reader cannot read is not quieter, it is gone. WCAG AA wants 4.5:1 for
// text this small (10.5 px), and the design literals sit far below it: the
// "still" design's faint measured 2.3:1 live, espresso's dark-brown-on-dark
// about the same. The app-wide tokens stay as the designs drew them — absence
// staying quieter than value is the view's own lesson — so the floor is view
// scoped: `.sg` derives both tiers from the design's own --text and --bg with
// color-mix, and this test resolves that arithmetic against every design's
// real palette, on both grounds a line can sit on (--bg cards, --surface
// panel). A design added later fails here instead of shipping unreadable.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const stategraphCss = read("../styles/stategraph.css");
const tokensCss = read("../tokens.css");
const designsCss = read("../designs.css");

type Rgb = [number, number, number];

/** Parses #rgb, #rrggbb, rgb(), rgba() — alpha is composited over `ground`. */
function color(value: string, ground: Rgb): Rgb {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex !== null) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 1, 2].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)) as Rgb;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v);
  if (fn === null) throw new Error(`unparsable color: ${value}`);
  const parts = fn[1].split(",").map((p) => Number(p.trim()));
  const a = parts.length === 4 ? parts[3] : 1;
  return [0, 1, 2].map((i) => parts[i] * a + ground[i] * (1 - a)) as Rgb;
}

/** The declarations of one `selector { … }` block, name → raw value. */
function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`block not found: ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  return out;
}

/** A design's palette: its own block over the :root defaults. */
function palette(own: Map<string, string>): { text: Rgb; bg: Rgb; surface: Rgb } {
  const root = block(tokensCss, ":root");
  const raw = (name: string): string => own.get(name) ?? root.get(name) ?? "";
  const bg = color(raw("--bg"), [255, 255, 255]);
  return { text: color(raw("--text"), bg), bg, surface: color(raw("--surface"), bg) };
}

const luminance = ([r, g, b]: Rgb): number => {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The view-scoped share of --text that `.sg` gives a tier, from the CSS itself. */
function mixShare(tier: "--text-faint" | "--text-dim"): number {
  const sg = block(stategraphCss, ".sg");
  const decl = sg.get(tier);
  if (decl === undefined) throw new Error(`.sg does not floor ${tier}`);
  const m = /^color-mix\(in srgb, var\(--text\) (\d+)%, var\(--bg\)\)$/.exec(decl);
  if (m === null) throw new Error(`${tier} must be color-mix of --text toward --bg, was: ${decl}`);
  return Number(m[1]) / 100;
}

const DESIGNS = [
  ["espresso (default)", block(tokensCss, ":root")],
  ["paper", block(tokensCss, '[data-design="paper"]')],
  ["graphite", block(designsCss, '[data-design="graphite"]')],
  ["still", block(designsCss, '[data-design="still"]')],
] as const;

describe("the state graph's quiet tiers meet the AA floor in every design", () => {
  for (const [name, own] of DESIGNS) {
    for (const tier of ["--text-faint", "--text-dim"] as const) {
      it(`${tier} on ${name} reads at 4.5:1 on both grounds`, () => {
        const { text, bg, surface } = palette(own);
        const share = mixShare(tier);
        const mixed = [0, 1, 2].map((i) => text[i] * share + bg[i] * (1 - share)) as Rgb;
        expect(contrast(mixed, bg), `${tier} on ${name} --bg`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(mixed, surface), `${tier} on ${name} --surface`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("dim stays stronger than faint, so the two tiers stay two", () => {
    expect(mixShare("--text-dim")).toBeGreaterThan(mixShare("--text-faint"));
  });
});
