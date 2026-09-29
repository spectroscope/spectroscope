// Card 442 (owner, 2026-09-29): "unten links die Einstellung ... da ist
// irgendwie eine Sonne als Symbol. Ich will da wieder diesen schönen Zahnrad".
// The settings entry at the foot of the sidebar and the composer's gear draw
// one glyph from one module; neither carries a cog of its own.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GearGlyph, GEAR_PATH } from "./gearGlyph";
import { NavIcon } from "./NavRow";
import { read } from "../testkit/source";

describe("one gear, two doors", () => {
  it("draws the cog path, not rays around a dot", () => {
    const html = renderToStaticMarkup(<NavIcon id="gear" />);
    expect(html).toContain(GEAR_PATH.slice(0, 40));
    // The sun: eight short rays from a centre dot, drawn as one path of M…
    // segments; none of them is left in the nav icon.
    expect(html).not.toContain("M8 1.4v1.8");
  });

  it("is the glyph the composer's gear wears", () => {
    const composer = renderToStaticMarkup(<GearGlyph />);
    const nav = renderToStaticMarkup(<NavIcon id="gear" />);
    expect(nav).toContain(GEAR_PATH);
    expect(composer).toContain(GEAR_PATH);
  });

  it("lives in one module: no second copy of the cog in the sidebar or the composer", () => {
    for (const rel of ["./NavRow.tsx", "./ComposerGear.tsx"]) {
      const source = read(rel, import.meta.url);
      expect(source, rel).toContain('from "./gearGlyph"');
      expect(source, rel).not.toContain("a1.1 1.1 0 0 0 0.22 1.2133");
    }
  });
});
