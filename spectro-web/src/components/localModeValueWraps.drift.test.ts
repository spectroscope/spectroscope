// Card 493: the Local mode row "Tool groups off" prints the whole list the
// switch wrote. In German the label takes two lines and the list had the
// rest of the row; with `white-space: nowrap` and an ellipsis it read
// "browser, launch, image…" and the fourth group was not on the screen
// (live capture of 2026-10-10, gear-on-spectroscope-de.png). The list has to
// wrap instead. jsdom lays nothing out, so the stylesheet is the subject.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Rule } from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalModeSection } from "./LocalModeSection";

const sheet = postcss.parse(readFileSync(join(__dirname, "..", "styles", "workspace-gear.css"), "utf8"));

/** Every rule whose selector list styles `.wsg-lm-value` itself, scoped or not. */
function rulesFor(className: string): Rule[] {
  const out: Rule[] = [];
  sheet.walkRules((rule) => {
    const hits = rule.selectors.some((sel) => {
      const last =
        sel
          .trim()
          .split(/\s+|>|\+|~/)
          .filter(Boolean)
          .pop() ?? "";
      return last.split(/(?=[.#:[])/).includes(`.${className}`);
    });
    if (hits) out.push(rule);
  });
  return out;
}

function declared(rules: Rule[], prop: string): string[] {
  const values: string[] = [];
  for (const rule of rules) {
    rule.walkDecls(prop, (d) => {
      values.push(d.value.trim());
    });
  }
  return values;
}

describe("the Local mode value shows the whole list", () => {
  const rules = rulesFor("wsg-lm-value");

  it("styles the value at all", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("lets a long list break onto a second line", () => {
    expect(declared(rules, "overflow-wrap")).toContain("anywhere");
  });

  it("neither forbids the break nor cuts the list with an ellipsis", () => {
    expect(declared(rules, "white-space")).not.toContain("nowrap");
    expect(declared(rules, "text-overflow")).not.toContain("ellipsis");
  });
});

/** The class lists of the elements that enclose the first element carrying
 *  `className`, outermost first, read off rendered markup. */
function ancestorClasses(html: string, className: string): string[][] {
  const VOID = new Set(["input", "br", "hr", "img"]);
  const open: string[][] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|[^">])*)(\/?)>/g)) {
    const name = (m[2] ?? "").toLowerCase();
    if (m[1] === "/") {
      open.pop();
      continue;
    }
    const classes = (/\bclass="([^"]*)"/.exec(m[3] ?? "")?.[1] ?? "").split(/\s+/).filter(Boolean);
    if (classes.includes(className)) return open.map((c) => [...c]);
    if (m[4] !== "/" && !VOID.has(name)) open.push(classes);
  }
  throw new Error(`no element carries ${className}`);
}

/** Declarations that clip a box or cut its text, as "prop: value". */
function clipping(rules: Rule[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    rule.walkDecls((d) => {
      const prop = d.prop.toLowerCase();
      const value = d.value.trim().toLowerCase();
      const clips =
        (/^overflow(-x|-y)?$/.test(prop) && /\b(hidden|clip)\b/.test(value)) ||
        prop === "max-height" ||
        prop === "height" ||
        /line-clamp$/.test(prop) ||
        (prop === "white-space" && value.includes("nowrap")) ||
        (prop === "text-overflow" && value.includes("ellipsis"));
      if (clips) out.push(`${rule.selector} { ${d.prop}: ${d.value} }`);
    });
  }
  return out;
}

describe("nothing around the Local mode value cuts it off", () => {
  const groups = ["browser", "launch", "images", "roles"];
  const html = renderToStaticMarkup(
    createElement(LocalModeSection, {
      lang: "de",
      info: {
        on: true,
        rows: [{ key: "toolGroupsOff", value: groups, preset: groups, changed: false, floor: null }],
      },
      toolUse: null,
      model: "some-model",
      onSwitch: () => {},
      onEdit: () => {},
      onReset: () => {},
    }),
  );
  const ancestors = ancestorClasses(html, "wsg-lm-value");

  it("reads the enclosing elements off the rendered row", () => {
    const flat = ancestors.flat();
    expect(flat).toContain("wsg-local-mode");
    expect(flat).toContain("wsg-lm-line");
  });

  it("finds a clip when one is declared", () => {
    const fixture = postcss.parse(".a { overflow: hidden } .b { max-height: 2em } .c { overflow: auto }");
    expect(clipping(fixture.nodes as Rule[])).toEqual([".a { overflow: hidden }", ".b { max-height: 2em }"]);
  });

  it("declares no clip, no fixed height and no cut text on the value or any element around it", () => {
    const classes = [...new Set([...ancestors.flat(), "wsg-lm-value"])];
    const found = classes.flatMap((c) => clipping(rulesFor(c)));
    expect(found).toEqual([]);
  });
});
