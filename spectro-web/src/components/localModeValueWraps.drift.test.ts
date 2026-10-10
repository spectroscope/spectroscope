// Card 493: the Local mode row "Tool groups off" prints the whole list the
// switch wrote. In German the label takes two lines and the list had the
// rest of the row; with `white-space: nowrap` and an ellipsis it read
// "browser, launch, image…" and the fourth group was not on the screen
// (live capture of 2026-10-10, gear-on-spectroscope-de.png). The list has to
// wrap instead. jsdom lays nothing out, so the stylesheet is the subject.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

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
  for (const rule of rules) rule.walkDecls(prop, (d) => values.push(d.value.trim()));
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
