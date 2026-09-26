// Card 431, criteria 2 and 3: the loading surface stays invisible for a fast
// open and moves on the compositor alone. Read off disk, because the claims are
// about the stylesheet and about what the component does NOT do.

import { describe, expect, it } from "vitest";
import { blockOf, read, stripComments } from "../testkit/source";

const css = read("./opening.css", import.meta.url);
const shell = read("./shell.css", import.meta.url);
const component = stripComments(read("../components/OpeningSurface.tsx", import.meta.url));

/** The declarations of one property in a block, trimmed. */
function prop(block: string, name: string): string | null {
  const m = block.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`));
  return m === null ? null : m[1].trim();
}

/** The body of `@keyframes name { ... }`, braces balanced. */
function keyframes(name: string): string {
  const at = css.indexOf(`@keyframes ${name} {`);
  if (at < 0) throw new Error(`no @keyframes ${name}`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  throw new Error(`@keyframes ${name} never closes`);
}

/** Every property a keyframes body sets. */
const animated = (body: string): string[] => [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);

/** The body of the one reduced-motion media block. */
function reducedMotion(): string {
  const at = css.indexOf("@media (prefers-reduced-motion: reduce) {");
  if (at < 0) throw new Error("no reduced-motion block");
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  throw new Error("the reduced-motion block never closes");
}

describe("the sign waits before it shows (criterion 2, owner call 1)", () => {
  const surface = blockOf(css, ".opening-surface");

  it("fades in with a 150 ms animation-delay", () => {
    expect(prop(surface, "animation-name")).toBe("opening-fade");
    expect(prop(surface, "animation-delay")).toBe("150ms");
  });

  it("holds the first keyframe during the delay, so the wait is invisible", () => {
    // `backwards` (inside `both`) is what applies the 0 opacity while the delay
    // runs. Without it the surface would sit fully drawn for the first 150 ms.
    expect(prop(surface, "animation-fill-mode")).toBe("both");
    expect(keyframes("opening-fade")).toMatch(/from\s*\{\s*opacity:\s*0;\s*\}/);
  });

  it("fades opacity and nothing else", () => {
    expect(new Set(animated(keyframes("opening-fade")))).toEqual(new Set(["opacity"]));
  });
});

describe("the sign lies over the view it may replace (owner call 2)", () => {
  it("covers the main column, dimmed", () => {
    const surface = blockOf(css, ".opening-surface");
    expect(prop(surface, "position")).toBe("absolute");
    expect(prop(surface, "inset")).toBe("0");
    expect(prop(surface, "background")).toBe("var(--scrim)");
    expect(prop(blockOf(shell, ".main-col"), "position")).toBe("relative");
  });
});

describe("the spinner turns on the compositor (criterion 3)", () => {
  // The base rule, read with the reduced-motion block cut out: blockOf refuses
  // a selector that is declared twice, and that block declares it again.
  const spinner = blockOf(css.replace(`@media (prefers-reduced-motion: reduce) {${reducedMotion()}}`, ""), ".opening-spinner");

  it("turns with a transform animation that never ends", () => {
    expect(prop(spinner, "animation-name")).toBe("opening-spin");
    expect(prop(spinner, "animation-iteration-count")).toBe("infinite");
    expect(new Set(animated(keyframes("opening-spin")))).toEqual(new Set(["transform"]));
    expect(keyframes("opening-spin")).toMatch(/transform:\s*rotate\(360deg\)/);
  });

  it("stands still under reduced motion, where the text carries the state", () => {
    expect(prop(blockOf(reducedMotion(), ".opening-spinner"), "animation-name")).toBe("none");
  });

  it("is driven by no JavaScript timer", () => {
    expect(component).toContain("opening-spinner");
    expect(component).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });
});
