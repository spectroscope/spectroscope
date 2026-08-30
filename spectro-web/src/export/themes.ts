// The palette an exported file carries with it.
//
// An export has no stylesheet to link to and no <html data-design> above it, so
// the tokens have to be literals inside the document. That makes this a COPY of
// tokens.css and designs.css, and a copy drifts — themes.drift.test.ts reads
// both stylesheets off disk and holds every value here to them.
//
// WHY EACH THEME NAMES ITS SOURCE PER TOKEN. In the app a skin overrides some
// tokens and inherits the rest from :root. A file cannot inherit from an app it
// is no longer inside, so each theme here is COMPLETE, and `borrows` records
// which block a value really came from.
//
// `still` was the headline case, and is worth keeping as the cautionary one. It
// declared no spectral ramp, so this file handed it paper's rather than let a
// white document print espresso's — and for a long time that made the EXPORT
// the only place the rule existed. The app had nothing to lend itself: every
// var(--sp-*) fell through to :root, and the default light design rendered code
// at 1.56:1. Card 325 moved the rule into designs.css, so `still` now DECLARES
// the ramp and borrows none of it, and the drift guard turned around with it —
// themes.drift.test.ts asks that the ramp be PRESENT, where it used to insist
// it was absent. The lesson the file keeps: a rule that lives only in the
// exporter is a rule the product does not have.

import type { DesignId } from "../state/designPrefs";
import type { Lang } from "../i18n/i18n";

/** The tokens that colour CODE rather than decoration. They carry meaning about
 *  what the characters are, so they answer to a contrast floor; --text-faint
 *  (comments) does not, because being quiet is its job. */
export const CODE_TOKENS = ["sp-violet", "sp-teal", "sp-ocean"] as const;

/** WCAG's floor for large text, which is what highlighted code inside a <pre>
 *  behaves like. One number for two guards, deliberately: themes.test.ts next
 *  door measures an exported document's ink on its --bg, and
 *  styles/codeContrast.test.ts measures the app's ink on a code well, where a
 *  translucent --shade composites the ground darker and the same ramp has less
 *  room. Two floors that could disagree would be two floors nobody trusts. */
export const MIN_CODE_CONTRAST = 3;

/** The five spectral lines: the ramp a design declares whole or not at all.
 *  Named once because three guards ask about it — the export's borrow list
 *  below, the drift test's check that `still` really declares its own, and the
 *  app-side contrast floor in styles/codeContrast.test.ts. */
export const SPECTRAL_TOKENS = ["sp-red", "sp-amber", "sp-teal", "sp-ocean", "sp-violet"] as const;

/**
 * What `graphite` never declares, and takes from espresso instead.
 *
 * The opposite case to `still`, and worth the contrast. `still` borrows because
 * its ground MOVED: a ramp built for L* 6 measures 1.83:1 on white, so it needs
 * a ramp of its own and takes paper's. Graphite's ground did not move — it is
 * espresso's ladder at a different temperature, same lightness rung for rung —
 * so espresso's ramp lands within 0.03 of its own contrast there, and a second
 * set of near-identical hexes would be two things to retune instead of one.
 *
 * So the list is longer than `still`'s: not just the spectral lines but the
 * status colours, the agent accents and the five handle slots derived from
 * them, and the typography. In
 * the app these simply inherit from :root; a file has nothing to inherit from,
 * which is why they are written out here and named to their source.
 */
export const GRAPHITE_BORROWS_FROM_ESPRESSO = [
  "shade",
  "sand",
  ...SPECTRAL_TOKENS,
  "ok",
  "warn",
  "error",
  "agent-root",
  "agent-explore",
  "agent-worker",
  "agent-extra",
  "agent-w1",
  "agent-w2",
  "agent-w3",
  "agent-w4",
  "agent-w5",
  "font-ui",
  "font-mono",
] as const;

export interface ExportTheme {
  id: DesignId;
  /** The word the document's meta line prints, so the header stops claiming
   *  "dark" for a file that is not. */
  name: Record<Lang, string>;
  colorScheme: "dark" | "light";
  tokens: Readonly<Record<string, string>>;
  /** token -> the design whose stylesheet block actually declares it. Empty for
   *  a theme that declares everything itself. */
  borrows: Readonly<Partial<Record<string, DesignId>>>;
}

/** Fonts name local families and never fetch: @font-face with a url() would be
 *  a network request, and the whole point of the file is that it opens offline. */
const FONT_UI =
  '"Inter Variable", Inter, Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_MONO =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const ESPRESSO = {
  bg: "#17120d",
  surface: "#201913",
  "surface-2": "#292019",
  "surface-3": "#2e251c",
  border: "#33291f",
  "border-strong": "#5c5142",
  shade: "rgba(0, 0, 0, 0.18)",
  text: "#ede7dc",
  "text-dim": "#a2988a",
  "text-faint": "#5c5142",
  accent: "#ce9440",
  sand: "#8b7cf0",
  "sp-red": "#c05a4c",
  "sp-amber": "#ce9440",
  "sp-teal": "#2dd4a7",
  "sp-ocean": "#2cb1c4",
  "sp-violet": "#8b7cf0",
  ok: "#2dd4a7",
  warn: "#ce9440",
  error: "#c05a4c",
  "agent-root": "#2dd4a7",
  "agent-explore": "#2cb1c4",
  "agent-worker": "#8b7cf0",
  "agent-extra": "#ce9440",
  // The handle ramp (card 298). It rides along because an exported document has
  // no stylesheet: a slot missing here is an invalid declaration in the file,
  // silently thrown away, and the badge inherits whatever is above it.
  "agent-w1": "#2cb1c4",
  "agent-w2": "#8b7cf0",
  "agent-w3": "#ce9440",
  "agent-w4": "#2dd4a7",
  "agent-w5": "#c05a4c",
  "font-ui": FONT_UI,
  "font-mono": FONT_MONO,
} as const;

/** The light-ground ramp. BOTH light designs declare it now — paper in
 *  tokens.css, still in designs.css — so one constant here keeps the exported
 *  copies of two blocks from drifting apart. themes.drift.test.ts still holds
 *  each theme to its OWN stylesheet, so the day the two blocks genuinely
 *  diverge this constant has to be split rather than quietly averaged. */
const LIGHT_RAMP = {
  "sp-red": "#c24b3e",
  "sp-amber": "#a9762a",
  // Card 325: darkened from #0f9d77, which cleared the floor on the page
  // (3.13:1) but not in a code well (2.71:1, floor 3). This reads 3.28:1 there.
  "sp-teal": "#0e8d6b",
  "sp-ocean": "#0b8799",
  "sp-violet": "#6c5ce7",
} as const;

export const EXPORT_THEMES: readonly ExportTheme[] = [
  {
    id: "spectroscope",
    name: { en: "espresso", de: "Espresso" },
    colorScheme: "dark",
    tokens: ESPRESSO,
    borrows: {},
  },
  {
    id: "paper",
    name: { en: "paper", de: "Papier" },
    colorScheme: "light",
    tokens: {
      bg: "#f6f4ee",
      surface: "#efece3",
      "surface-2": "#e9e5d8",
      "surface-3": "#e2dccc",
      border: "#ddd8cb",
      "border-strong": "#c4bcad",
      shade: "rgba(23, 22, 26, 0.07)",
      text: "#17161a",
      "text-dim": "#6a665d",
      "text-faint": "#a39e92",
      accent: "#2e7ea6",
      sand: "#6c5ce7",
      ...LIGHT_RAMP,
      ok: "#0f9d77",
      warn: "#a9762a",
      error: "#c24b3e",
      "agent-root": "#0f9d77",
      "agent-explore": "#0b8799",
      "agent-worker": "#6c5ce7",
      "agent-extra": "#a9762a",
      "agent-w1": "#0b8799",
      "agent-w2": "#6c5ce7",
      "agent-w3": "#a9762a",
      "agent-w4": "#0f9d77",
      "agent-w5": "#c24b3e",
      "font-ui": FONT_UI,
      "font-mono": FONT_MONO,
    },
    // The brand light theme retunes colour and leaves typography to :root.
    borrows: { "font-ui": "spectroscope", "font-mono": "spectroscope" },
  },
  {
    id: "still",
    name: { en: "white", de: "Weiß" },
    colorScheme: "light",
    tokens: {
      bg: "#fbfbfd",
      surface: "#ffffff",
      "surface-2": "#f2f2f5",
      "surface-3": "#e5e5ea",
      border: "rgba(0, 0, 0, 0.11)",
      "border-strong": "rgba(0, 0, 0, 0.22)",
      shade: "rgba(0, 0, 0, 0.07)",
      text: "#1d1d1f",
      "text-dim": "#808085",
      "text-faint": "rgba(29, 29, 31, 0.38)",
      accent: "#0071e3",
      sand: "#6e6e73",
      ...LIGHT_RAMP,
      ok: "#248a3d",
      warn: "#c07600",
      error: "#d70015",
      "agent-root": "#0071e3",
      "agent-explore": "#248a3d",
      "agent-worker": "#8944ab",
      "agent-extra": "#c07600",
      "agent-w1": "#248a3d",
      "agent-w2": "#8944ab",
      "agent-w3": "#c07600",
      "agent-w4": "#0071e3",
      "agent-w5": "#d70015",
      "font-ui": 'Geist, Inter, "Helvetica Neue", Helvetica, system-ui, sans-serif',
      "font-mono": FONT_MONO,
    },
    // The ramp is no longer borrowed: designs.css declares it here, so the
    // drift test holds these five to still's OWN block (card 325).
    borrows: { "font-mono": "spectroscope" },
  },
  {
    id: "graphite",
    name: { en: "graphite", de: "Graphit" },
    colorScheme: "dark",
    tokens: {
      bg: "#262624",
      surface: "#2e2e2c",
      "surface-2": "#363634",
      "surface-3": "#3e3e3b",
      border: "#464643",
      "border-strong": "#6b6b67",
      shade: ESPRESSO.shade,
      text: "#ffffff",
      "text-dim": "#c2c2be",
      "text-faint": "#8f8f8b",
      // Owner 2026-07-30: still's blue, verbatim — graphite is its dark twin.
      // Only espresso keeps a spectral-line accent; the ramp is untouched.
      accent: "#0071e3",
      sand: ESPRESSO.sand,
      "sp-red": ESPRESSO["sp-red"],
      "sp-amber": ESPRESSO["sp-amber"],
      "sp-teal": ESPRESSO["sp-teal"],
      "sp-ocean": ESPRESSO["sp-ocean"],
      "sp-violet": ESPRESSO["sp-violet"],
      ok: ESPRESSO.ok,
      warn: ESPRESSO.warn,
      error: ESPRESSO.error,
      "agent-root": ESPRESSO["agent-root"],
      "agent-explore": ESPRESSO["agent-explore"],
      "agent-worker": ESPRESSO["agent-worker"],
      "agent-extra": ESPRESSO["agent-extra"],
      "agent-w1": ESPRESSO["agent-w1"],
      "agent-w2": ESPRESSO["agent-w2"],
      "agent-w3": ESPRESSO["agent-w3"],
      "agent-w4": ESPRESSO["agent-w4"],
      "agent-w5": ESPRESSO["agent-w5"],
      "font-ui": FONT_UI,
      "font-mono": FONT_MONO,
    },
    borrows: Object.fromEntries(GRAPHITE_BORROWS_FROM_ESPRESSO.map((k) => [k, "spectroscope"])),
  },
];

/**
 * The theme behind an id, defaulting to the app's own default.
 *
 * @param id an id from the dialog or from a stored preference; may be anything
 * @return the named theme, or espresso when the id is not one we ship
 */
export function themeById(id: string): ExportTheme {
  return EXPORT_THEMES.find((th) => th.id === id) ?? EXPORT_THEMES[0];
}

/** The `:root` block for an exported document: every token, plus the colour
 *  scheme so the browser's own scrollbars and form controls match the page. */
export function themeCss(theme: ExportTheme): string {
  const lines = Object.entries(theme.tokens).map(([key, value]) => `  --${key}: ${value};`);
  return `:root{\n${lines.join("\n")}\n  color-scheme: ${theme.colorScheme};\n}`;
}

// ---- contrast ---------------------------------------------------------------

/** sRGB channel to linear light, per WCAG 2.x. */
function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) throw new Error(`not a six-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/**
 * WCAG contrast between two opaque colours.
 *
 * Measured rather than asserted: the reason `still` borrows a ramp is a number,
 * and a number that is recomputed cannot rot the way a comment can.
 *
 * @param a one six-digit hex colour
 * @param b the other
 * @return the ratio, 1 to 21, order-independent
 */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
