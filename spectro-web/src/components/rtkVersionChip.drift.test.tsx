// Card 416, criterion 6: the rtk version chip stays on one line.
//
// The wave V0 browser check (2026-09-24) saw the chip in the rtk section head
// break into "FOUND: RTK" and "0.45.0" at 390px. It wore `.wsg-proto`, the
// prototype tag of the disclosure menu, which may shrink with the flex row and
// wraps at its spaces when it does. The chip now has a class of its own that
// neither shrinks nor wraps. The geometry itself is a browser reading; this
// file pins the rule that produces it, found by its exact selector.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RtkFilterSection } from "./RtkFilterSection";
import { t } from "../i18n/i18n";
import { read, rules } from "../testkit/source";

const STYLES = fileURLToPath(new URL("../styles/", import.meta.url));

/** Every rule of every stylesheet under src/styles, labelled by file. */
const ALL = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .flatMap((f) => rules(f, read(`../styles/${f}`, import.meta.url)));

/** The classes of the span that prints the version, read off the markup. */
function chipClasses(): string[] {
  const version = "rtk 9.9.9-probe";
  const html = renderToStaticMarkup(
    <RtkFilterSection
      lang="en"
      rtk={{ on: true, available: true, version, error: null, setOn: () => {}, setError: () => {} }}
    />,
  );
  const printed = t("en", "rtk.version", { v: version });
  const m = new RegExp(`<span class="([^"]+)">${printed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`).exec(
    html,
  );
  if (m === null) throw new Error("the section printed no version chip");
  return m[1].split(/\s+/);
}

/** The declared value of `prop` in a rule body, or null. */
function declared(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m === null ? null : m[1].trim();
}

describe("the rtk version chip", () => {
  it("wears a class of its own, not the prototype tag", () => {
    const classes = chipClasses();
    expect(classes).not.toContain("wsg-proto");
    expect(classes).toHaveLength(1);
  });

  it("has one unscoped rule, and that rule forbids wrapping and shrinking", () => {
    const [cls] = chipClasses();
    const own = ALL.filter((r) => r.selector === `.${cls}`);
    expect(own.map((r) => r.rel)).toHaveLength(1);
    expect(declared(own[0].body, "white-space")).toBe("nowrap");
    expect(declared(own[0].body, "flex-shrink")).toBe("0");
  });

  it("is not given a wrapping white-space anywhere else", () => {
    const [cls] = chipClasses();
    const others = ALL.filter((r) => r.subject.split(/(?=[.:#[])/).includes(`.${cls}`));
    for (const rule of others) {
      const ws = declared(rule.body, "white-space");
      if (ws !== null)
        expect({ selector: rule.selector, ws }).toEqual({ selector: rule.selector, ws: "nowrap" });
    }
  });
});
