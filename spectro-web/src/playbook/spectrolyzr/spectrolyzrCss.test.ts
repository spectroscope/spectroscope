// Card 484, Task 11: the wizard's stylesheet takes its colours from tokens
// only. No hex literal, no rgb(); and, so that an empty or colourless sheet
// cannot pass, it must hold colour, background and border declarations, and
// every one of them must read a var(--token).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHEET = fileURLToPath(new URL("../../styles/spectrolyzr.css", import.meta.url));
const APP = fileURLToPath(new URL("../../app.css", import.meta.url));

/** The sheet with its block comments blanked, so prose cannot count. */
function code(): string {
  return readFileSync(SHEET, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every declaration as [property, value]. */
function declarations(css: string): [string, string][] {
  return [...css.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)].map((m) => [m[1], m[2].trim()]);
}

const COLOURED = /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?)$/;

describe("styles/spectrolyzr.css", () => {
  it("is imported by app.css", () => {
    expect(readFileSync(APP, "utf8")).toMatch(/@import "\.\/styles\/spectrolyzr\.css";/);
  });

  it("holds no hex colour and no rgb literal", () => {
    const css = code();
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it("reads a token in every colour, background and border declaration", () => {
    const coloured = declarations(code()).filter(([p]) => COLOURED.test(p));
    const props = new Set(coloured.map(([p]) => p));
    expect(props.has("color")).toBe(true);
    expect(props.has("background")).toBe(true);
    expect([...props].some((p) => p.startsWith("border"))).toBe(true);
    for (const [p, v] of coloured) expect(v, `${p}: ${v}`).toContain("var(--");
  });
});
