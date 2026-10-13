// The scroll reveal (effects/scrollReveal.ts) adds the class "in" to an element
// marked data-reveal once, by hand. When React owns a computed className on
// that element, the next render writes the string back without "in", and the
// element stays at opacity 0 for good. The 0.15.4 live check measured exactly
// that: "wide" in the run view blanked the chat tab, and "small" did not bring
// it back. So an element with data-reveal carries a fixed className, and a
// changing state goes on a data attribute.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..");
const FILES = ["App.tsx"];

function revealElements(file: string): { line: number; className: ts.JsxAttribute | undefined }[] {
  const text = readFileSync(path.join(SRC, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const found: { line: number; className: ts.JsxAttribute | undefined }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      if (attrs.some((a) => a.name.getText(sf) === "data-reveal")) {
        found.push({
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          className: attrs.find((a) => a.name.getText(sf) === "className"),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("an element the scroll reveal shows keeps a fixed className", () => {
  it("App.tsx has the chat row with data-reveal", () => {
    expect(revealElements("App.tsx").length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    it(`${file}: every data-reveal element has a string literal className`, () => {
      const computed = revealElements(file).filter(
        (e) =>
          e.className !== undefined &&
          !(e.className.initializer && ts.isStringLiteral(e.className.initializer)),
      );
      expect(computed.map((e) => `${file}:${e.line}`)).toEqual([]);
    });
  }

  it("the wide run view is switched by a data attribute the stylesheet reads", () => {
    const app = readFileSync(path.join(SRC, "App.tsx"), "utf8");
    const css = readFileSync(path.join(SRC, "styles", "run-panel.css"), "utf8");
    expect(app).toContain('data-run-wide={runWide ? "" : undefined}');
    expect(css).toContain(".chat-row[data-run-wide] > :not(.run-wide-slot)");
    expect(css).not.toContain("chat-row--run-wide");
  });
});
