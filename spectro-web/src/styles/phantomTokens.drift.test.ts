// A misspelled custom property is silent. `font-size: var(--fs-18)` where no
// --fs-18 exists is not a warning and not an error: the declaration is invalid
// at computed-value time, the property is thrown away, and font-size — being
// inherited — quietly takes the parent's. Nothing in tsc, eslint, prettier or
// vite looks at it. The fleet lobby heading rendered at body size for months
// that way, and bus.css once carried 37 of these at once.
//
// The second shape is quieter still: var(--ink-dim, #9a8f80) always resolves to
// the hard-coded fallback, so the theme switch cannot reach it and the paper
// light design keeps painting an espresso-dark grey. It looks deliberate in the
// diff, which is why it survives.
//
// This asks both questions of every var() in the tree. Definitions are read
// generously, because they arrive from three directions: tokens.css and
// designs.css declare the vocabulary, a stylesheet may scope its own
// (terminal.css owns --term-bg), and a component may set one from an inline
// style object in TSX (--sidebar-w, --lvl-c). All three count. Comments do not
// — the token sheets discuss var(--token) in prose.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

/** Blank out block comments, keeping newlines so line numbers still line up. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const files = walk(SRC).map((f) => ({
  rel: f.slice(SRC.length),
  text: readFileSync(f, "utf8"),
}));

const defined = new Set<string>();
for (const { rel, text } of files) {
  if (rel.endsWith(".css"))
    // The colon must be a DECLARATION's colon, so what follows has to look like
    // a value. Without that, `.lvl-slot--line::after {` reads as a definition of
    // `--line` — a BEM modifier followed by a pseudo-element — and the guard
    // then swears a phantom token exists. That is how this guard was refuted the
    // first time it ran, and it made its own count 20 too high.
    for (const m of code(text).matchAll(/(--[a-zA-Z0-9_-]+)\s*:(?!:)\s*[^;{}]+[;}]/g))
      defined.add(m[1]);
  // `{ "--sidebar-w": x }` and `{ ["--lvl-c" as string]: x }` both count.
  if (/\.tsx?$/.test(rel))
    for (const m of text.matchAll(
      /["'](--[a-zA-Z0-9_-]+)["'](\s+as\s+string)?\s*\]?\s*:/g,
    ))
      defined.add(m[1]);
}

/**
 * @return every var() in `css` whose name nothing defines, split by whether the
 * author wrote a fallback
 */
function phantoms(css: string, rel: string) {
  const bare: string[] = [];
  const withFallback: string[] = [];
  code(css)
    .split("\n")
    .forEach((row, i) => {
      for (const m of row.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([),])/g)) {
        if (defined.has(m[1])) continue;
        const at = `${rel}:${i + 1} ${m[1]}`;
        if (m[2] === ")") bare.push(at);
        else withFallback.push(at);
      }
    });
  return { bare, withFallback };
}

const stylesheets = files.filter((f) => f.rel.endsWith(".css"));

describe("no stylesheet reaches for a token that does not exist", () => {
  it("finds the token sheets, so an empty result is not a broken walk", () => {
    expect(stylesheets.map((f) => f.rel)).toContain("tokens.css");
    expect(defined.has("--fs-14")).toBe(true);
  });

  it("resolves every var() against a real definition", () => {
    const found = stylesheets.flatMap((f) => phantoms(f.text, f.rel).bare);
    expect(found).toEqual([]);
  });

  it("leaves no var() whose fallback is the only value it can ever have", () => {
    const found = stylesheets.flatMap(
      (f) => phantoms(f.text, f.rel).withFallback,
    );
    expect(found).toEqual([]);
  });
});
