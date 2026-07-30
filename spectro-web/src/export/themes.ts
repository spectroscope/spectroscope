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
// which block a value really came from. That is not bookkeeping: `still`
// declares no spectral ramp at all, so inheriting would hand a white document
// espresso's ramp — and the export colours CODE with those tokens, not just the
// mark. Espresso's teal on still's ground measures 1.83:1. Paper's measures
// 3.33:1. So `still` borrows paper's ramp, deliberately, and the contrast floor
// in themes.test.ts fails the day someone points it back at the dark one.

import type { DesignId } from "../state/designPrefs";
import type { Lang } from "../i18n/i18n";

/** The tokens that colour CODE rather than decoration. They carry meaning about
 *  what the characters are, so they answer to a contrast floor; --text-faint
 *  (comments) does not, because being quiet is its job. */
export const CODE_TOKENS = ["sp-violet", "sp-teal", "sp-ocean"] as const;

/** WCAG's floor for large text, which is what highlighted code inside a <pre>
 *  behaves like. Paper's teal on paper clears it by 0.13 — thin, and the reason
 *  the number is measured here rather than eyeballed. */
export const MIN_CODE_CONTRAST = 3;

/** The spectral tokens `still` never declares. Borrowed from paper because a
 *  light theme needs a light-ground ramp; see the file header for the numbers. */
export const STILL_BORROWS_FROM_PAPER = ["sp-red", "sp-amber", "sp-teal", "sp-ocean", "sp-violet"] as const;

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
 * status colours and agent accents derived from them, and the typography. In
 * the app these simply inherit from :root; a file has nothing to inherit from,
 * which is why they are written out here and named to their source.
 */
export const GRAPHITE_BORROWS_FROM_ESPRESSO = [
  "shade",
  "sand",
  "sp-red",
  "sp-amber",
  "sp-teal",
  "sp-ocean",
  "sp-violet",
  "ok",
  "warn",
  "error",
  "agent-root",
  "agent-explore",
  "agent-worker",
  "agent-extra",
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
  "font-ui": FONT_UI,
  "font-mono": FONT_MONO,
} as const;

const PAPER_RAMP = {
  "sp-red": "#c24b3e",
  "sp-amber": "#a9762a",
  "sp-teal": "#0f9d77",
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
      ...PAPER_RAMP,
      ok: "#0f9d77",
      warn: "#a9762a",
      error: "#c24b3e",
      "agent-root": "#0f9d77",
      "agent-explore": "#0b8799",
      "agent-worker": "#6c5ce7",
      "agent-extra": "#a9762a",
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
      ...PAPER_RAMP,
      ok: "#248a3d",
      warn: "#c07600",
      error: "#d70015",
      "agent-root": "#0071e3",
      "agent-explore": "#248a3d",
      "agent-worker": "#8944ab",
      "agent-extra": "#c07600",
      "font-ui": 'Geist, Inter, "Helvetica Neue", Helvetica, system-ui, sans-serif',
      "font-mono": FONT_MONO,
    },
    borrows: {
      "sp-red": "paper",
      "sp-amber": "paper",
      "sp-teal": "paper",
      "sp-ocean": "paper",
      "sp-violet": "paper",
      "font-mono": "spectroscope",
    },
  },
  {
    id: "graphite",
    name: { en: "graphite", de: "Graphit" },
    colorScheme: "dark",
    tokens: {
      bg: "#101415",
      surface: "#151b1c",
      "surface-2": "#1c2324",
      "surface-3": "#1f282a",
      border: "#232c2e",
      "border-strong": "#485557",
      shade: ESPRESSO.shade,
      text: "#bbbfc0",
      "text-dim": "#868d8e",
      "text-faint": "#485557",
      // The accent is the ocean line itself, as espresso's is the amber one.
      accent: "#2cb1c4",
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
