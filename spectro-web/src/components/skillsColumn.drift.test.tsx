// Card 411, rule A: the Skills view reads at the settings page's width, left
// aligned. Owner, 2026-09-25: "Macht doch einfach so einen kleinen, so wie in
// den Settings oder so. Muss nicht mittig sein, es kann auch linksbündig sein."
//
// Measured in installed Chrome on the unfixed integration head 208204b4
// (kanban/evidence/411/loop/before/probe.json): the view's content box was
// 1145 px wide at a 1440 px window and 2265 px at 2560, the whole main column
// less its padding. The settings page's content box was 646 px in the room
// that does not scroll and 635 px in the five that do, where Chrome's classic
// scrollbar took 11 px inside the body.
//
// This suite has no layout engine. It pins where the column's width comes
// from: the settings page's own width, less its 1 px border and the body's
// padding on each side, in one token both surfaces read. It also pins that
// nothing else under src/ declares either token: a later declaration would
// win the cascade while the checks below read the first one.

import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillsPane } from "./SkillsPane";
import { blankBlockComments, blockOf, read, stripComments } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";

const tokens = read("../tokens.css", import.meta.url);
const settingsCss = read("../styles/settings-trace.css", import.meta.url);
const paneCss = read("../styles/skillspane.css", import.meta.url);

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? "";
const decl = (block: string, prop: string): string | undefined =>
  new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+);`).exec(block)?.[1];

const SRC = fileURLToPath(new URL("..", import.meta.url));

const FILES = srcFiles(SRC);

/**
 * Every place under src/ that can declare a custom property: in a stylesheet a
 * `prop:` outside a comment; in a non-test source file any string literal that
 * is exactly the property's name, which covers a style key and a setProperty
 * call (and would also count a read by name, erring towards red).
 */
function declarationsOf(prop: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const path of FILES) {
    let text: string;
    let pattern: RegExp;
    if (path.endsWith(".css")) {
      text = blankBlockComments(srcText(path));
      pattern = new RegExp(`${prop}\\s*:`, "g");
    } else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) {
      text = stripComments(srcText(path));
      pattern = new RegExp(`["'\`]${prop}["'\`]`, "g");
    } else {
      continue;
    }
    for (const m of text.matchAll(pattern)) {
      out.push({
        file: relative(SRC, path).split(sep).join("/"),
        line: text.slice(0, m.index).split("\n").length,
      });
    }
  }
  return out;
}

const where = (found: { file: string; line: number }[]): string =>
  found.map((d) => `${d.file}:${d.line}`).join(", ");

describe("the settings page's width is one token", () => {
  it("declares the settings width once under src/, in the :root of tokens.css, as 680px", () => {
    const found = declarationsOf("--settings-width");
    expect(
      found.map((d) => d.file),
      where(found),
    ).toEqual(["tokens.css"]);
    expect(squash(decl(rootBlock, "--settings-width") ?? "")).toBe("680px");
  });

  it("the settings page reads it", () => {
    expect(squash(decl(blockOf(settingsCss, ".settings-page"), "width") ?? "")).toBe(
      "min(var(--settings-width), 94vw)",
    );
  });

  it("derives the reading width from the page's width, its border and its body's padding", () => {
    const found = declarationsOf("--settings-measure");
    expect(
      found.map((d) => d.file),
      where(found),
    ).toEqual(["tokens.css"]);
    expect(squash(decl(rootBlock, "--settings-measure") ?? "")).toBe(
      "calc(var(--settings-width) - 2 * 1px - 2 * var(--sp-4))",
    );
    // The two facts the derivation subtracts. Changing either one without the
    // token makes the Skills view wider or narrower than the settings page.
    expect(squash(decl(blockOf(settingsCss, ".settings-page"), "border") ?? "")).toBe(
      "1px solid var(--border-strong)",
    );
    expect(squash(decl(blockOf(settingsCss, ".settings-body"), "padding") ?? "")).toBe("var(--sp-4)");
  });
});

describe("the Skills view reads at that width, from the left", () => {
  it("caps its column at the settings page's reading width", () => {
    expect(squash(decl(blockOf(paneCss, ".skills-column"), "max-width") ?? "")).toBe(
      "var(--settings-measure)",
    );
  });

  it("does not centre the column", () => {
    const column = blockOf(paneCss, ".skills-column");
    expect(column).not.toMatch(/margin[^;]*auto/);
    expect(column).not.toMatch(/justify-self|align-self|place-self/);
    expect(blockOf(paneCss, ".skills-pane")).not.toMatch(
      /align-items|justify-content|place-items|text-align/,
    );
  });

  it("puts the head and the manager inside the column", () => {
    const html = renderToStaticMarkup(<SkillsPane />);
    expect(html).toMatch(
      /^<div class="skills-pane"><div class="skills-column"><header class="skills-head">[\s\S]*<\/header><div class="skset">[\s\S]*<\/div><\/div><\/div>$/,
    );
  });
});
