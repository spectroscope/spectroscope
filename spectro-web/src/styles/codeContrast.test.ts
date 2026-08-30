// Card 325. The floor the EXPORT has enforced since card 297, asked of the APP.
//
// export/themes.ts already decided this: code is coloured with the spectral
// ramp, a ramp built for one ground is unreadable on another, and
// themes.test.ts holds every exported theme to MIN_CODE_CONTRAST. The app never
// got the same question, and the answer differs — an exported `still` document
// prints paper's ramp, while the app's `still` inherits espresso's onto white
// and renders --sp-teal at 1.57:1. The same session, the same code, two
// palettes, and only the file is legible.
//
// Two things this measures that the export's guard does not, both of which make
// it the stricter number:
//
//   - THE GROUND IS COMPOSITED. The export measures ink on --bg because an
//     exported document paints its <pre> straight onto the page. In the app a
//     code well is `background: var(--shade)`, and --shade is translucent — so
//     the real ground is shade OVER bg, which on a light design is DARKER than
//     bg and costs contrast. Measuring against --bg here would flatter every
//     light theme by about 0.5 and pass a ramp nobody can read.
//   - THE SUBJECTS ARE READ OFF THE STYLESHEET. Which classes colour code, and
//     which token each one uses, come from panels.css; the ground comes from the
//     rules that draw the wells. A hand-typed list here would be a second copy
//     of the same claim, and the day a fifth .hl- rule lands the copy would go
//     on passing. Add `.hl-type { color: var(--sp-amber) }` and this fails until
//     amber clears the floor on all four grounds.
//
// The known limit: the wells are named below rather than discovered, because
// "which container does a highlighted span land in" is a DOM question and this
// is a text test. It holds them to a SHARED ground instead, so moving one well
// off --shade fails here rather than drifting quietly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODE_TOKENS, MIN_CODE_CONTRAST, contrastRatio } from "../export/themes";
import { DESIGN_IDS, type DesignId } from "../state/designPrefs";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

const tokensCss = read("tokens.css");
const designsCss = read("designs.css");
const panelsCss = read("styles/panels.css");
const toolcardCss = read("styles/toolcard.css");
const chatCss = read("styles/chat.css");

/**
 * The custom properties one selector's block declares.
 *
 * A hand-rolled reader rather than a CSS parser, for the reason
 * themes.drift.test.ts gives: the files are ours, the shape is one flat block
 * per selector, and a parser here would be a dependency shipped to every user.
 *
 * @param css      the stylesheet text
 * @param selector the exact selector line to open, e.g. `[data-design="paper"]`
 * @return token name (without the leading dashes) to declared value
 */
function blockTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no such selector in the stylesheet: ${selector}`);
  const open = css.indexOf("{", start);
  const body = css.slice(open + 1, css.indexOf("}", open));
  const out: Record<string, string> = {};
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const match = /^\s*--([a-z0-9-]+)\s*:\s*([\s\S]+)$/i.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/\s+/g, " ");
  }
  return out;
}

/** Where each design's block lives. `spectroscope` IS `:root` — it is the
 *  default the other three override, not a skin of its own. */
const BLOCK: Record<DesignId, Record<string, string>> = {
  spectroscope: blockTokens(tokensCss, ":root"),
  paper: blockTokens(tokensCss, '[data-design="paper"]'),
  still: blockTokens(designsCss, '[data-design="still"]'),
  graphite: blockTokens(designsCss, '[data-design="graphite"]'),
};

/** What the browser resolves `var(--token)` to under `data-design=<id>`: the
 *  design's own declaration, or :root's when the design leaves it undeclared.
 *  That fallback is the whole defect — it is how a white ground gets a ramp
 *  tuned for L* 6. */
function resolve(design: DesignId, token: string): string {
  const value = BLOCK[design][token] ?? BLOCK.spectroscope[token];
  if (value === undefined) throw new Error(`no design declares --${token}, not even :root`);
  return value;
}

/** `.hl-<class>` to the token that colours it, read from the stylesheet that
 *  really paints them. */
function highlightRules(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, cls, body] of css.matchAll(/\.hl-([a-z0-9-]+)\s*\{([^}]*)\}/gi)) {
    const colour = /(?:^|[;{\s])color\s*:\s*var\(\s*--([a-z0-9-]+)\s*\)/i.exec(body);
    if (colour) out.set(cls, colour[1]);
  }
  return out;
}

/** The token a well paints its background with, e.g. `shade` for
 *  `background: var(--shade)`. */
function backgroundToken(css: string, selector: string): string {
  const rule = new RegExp(`^\\s*\\${selector}\\s*\\{([^}]*)\\}`, "m").exec(css);
  if (rule === null) throw new Error(`no such rule: ${selector}`);
  const match = /background\s*:\s*var\(\s*--([a-z0-9-]+)\s*\)/i.exec(rule[1]);
  if (match === null) throw new Error(`${selector} does not paint a var() background`);
  return match[1];
}

/** The containers a highlighted span lands in: the tool card's well (a lifted
 *  file body, a command, a workflow script) and a fenced block in an answer. */
const CODE_WELLS = [
  { name: ".tv-well", token: backgroundToken(toolcardCss, ".tv-well") },
  { name: ".md-pre", token: backgroundToken(chatCss, ".md-pre") },
];

// ---- colour ------------------------------------------------------------------

/** One `rgba()`/`rgb()` or six-digit hex, as channels plus alpha. */
function parseColour(value: string): { rgb: [number, number, number]; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff], alpha: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i.exec(
    value.trim(),
  );
  if (fn === null) throw new Error(`cannot read as a colour: ${value}`);
  return {
    rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])],
    alpha: fn[4] === undefined ? 1 : Number(fn[4]),
  };
}

const toHex = (rgb: readonly number[]): string =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

/** `over` seen through `top`: the opaque colour a reader's eye actually meets.
 *  Source-over compositing, which is what the browser does with a translucent
 *  background on an opaque one. */
function composite(top: string, over: string): string {
  const front = parseColour(top);
  const back = parseColour(over);
  return toHex(front.rgb.map((c, i) => front.alpha * c + (1 - front.alpha) * back.rgb[i]));
}

/** The ground a code well presents under `design`: its translucent fill
 *  composited onto the page. */
function wellGround(design: DesignId, wellToken: string): string {
  return composite(resolve(design, wellToken), resolve(design, "bg"));
}

// ---- the tests ----------------------------------------------------------------

const RULES = highlightRules(panelsCss);

describe("the walk found its subjects", () => {
  // Every assertion below loops. A loop over nothing is green, and green over
  // nothing is the failure mode this whole file exists to catch elsewhere.
  it("reads the highlight rules out of panels.css", () => {
    expect(RULES.size, "no .hl- rules found: the rest of this file is vacuous").toBeGreaterThan(0);
    expect(RULES.get("keyword")).toBe("sp-violet");
    expect(RULES.get("string")).toBe("sp-teal");
    expect(RULES.get("number")).toBe("sp-ocean");
  });

  it("covers every design the picker offers", () => {
    expect(Object.keys(BLOCK).sort()).toEqual([...DESIGN_IDS].sort());
  });

  it("finds a translucent ground under the code wells", () => {
    // If --shade were opaque the compositing step would be a no-op and this
    // file would silently become the export's weaker test.
    for (const well of CODE_WELLS) {
      for (const design of DESIGN_IDS) {
        expect(parseColour(resolve(design, well.token)).alpha, `${well.name} on ${design}`).toBeLessThan(1);
      }
    }
  });

  it("draws both code wells on the same ground", () => {
    // Named rather than discovered (see the header). Holding them equal is what
    // keeps one well from drifting to another fill unmeasured.
    expect(new Set(CODE_WELLS.map((w) => w.token)).size, "the code wells no longer agree").toBe(1);
  });
});

describe("code stays readable in every design", () => {
  // The app-side twin of themes.test.ts. Same constant, deliberately: two
  // floors that can disagree are two floors nobody trusts.
  for (const design of DESIGN_IDS) {
    for (const [cls, token] of RULES) {
      // Comments answer to no floor — being quiet is their job — so the subject
      // is the ramp the export already calls code, not every coloured span.
      if (!(CODE_TOKENS as readonly string[]).includes(token)) continue;
      it(`${design}: .hl-${cls} clears the floor on the well it is printed on`, () => {
        const ink = resolve(design, token);
        const ground = wellGround(design, CODE_WELLS[0].token);
        const ratio = contrastRatio(ink, ground);
        expect(
          ratio,
          `--${token} ${ink} on ${ground} reads ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(MIN_CODE_CONTRAST);
      });
    }
  }
});

describe("the app and the export colour code with the same tokens", () => {
  it("uses no spectral line the export does not count as code", () => {
    // The link that makes the two floors one rule. A new `.hl-` class painted
    // from --sp-amber has to be added to CODE_TOKENS, which puts it under the
    // export's floor as well as this one.
    const spectral = [...RULES.values()].filter((t) => t.startsWith("sp-"));
    expect(spectral.length, "no spectral token colours code any more").toBeGreaterThan(0);
    for (const token of spectral) {
      expect(CODE_TOKENS as readonly string[], `panels.css colours code with --${token}`).toContain(
        token,
      );
    }
  });
});
