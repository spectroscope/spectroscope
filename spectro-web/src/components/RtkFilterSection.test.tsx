// Card 379, criteria 8 and 11: what the rtk section of the chat settings draws.
// Rendered with react-dom/server like the other view suites, no DOM.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RtkFilterSection } from "./RtkFilterSection";
import type { RtkFilterState } from "../state/rtkFilter";
import { dict, t } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";

const noop = (): void => {};

function state(over: Partial<RtkFilterState>): RtkFilterState {
  return { on: false, available: true, version: "", error: null, setOn: noop, setError: noop, ...over };
}

function render(over: Partial<RtkFilterState>): string {
  return renderToStaticMarkup(<RtkFilterSection lang="en" rtk={state(over)} />);
}

/** React escapes quotes and ampersands in text; the dictionary does not. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

describe("the rtk section", () => {
  it("prints the version the server reported, as the binary printed it", () => {
    // A version no release carries: a literal in the component cannot pass.
    const html = render({ available: true, version: "rtk 9.9.9-probe" });
    expect(html).toContain(escaped(t("en", "rtk.version", { v: "rtk 9.9.9-probe" })));
    expect(html).not.toContain("0.45.0");
  });

  it("is drawn when rtk is missing, with the row disabled and the reason under it", () => {
    const html = render({ available: false });
    expect(html).toContain(escaped(t("en", "rtk.title")));
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("wsg-mode-row--disabled");
    expect(html).toContain(escaped(t("en", "rtk.missing")));
    expect(html).not.toContain(escaped(t("en", "rtk.warning")));
  });

  it("says rtk is missing even when the saved switch is on", () => {
    // The file can say on while the machine has no rtk. The row keeps the
    // saved value and says what happens: the line runs as the model wrote it.
    const html = render({ available: false, on: true });
    expect(html).toContain(escaped(t("en", "rtk.on")));
    expect(html).toContain(escaped(t("en", "rtk.missing")));
    expect(html).not.toContain(escaped(t("en", "rtk.on.hint")));
  });

  it("draws an available row as a live checkbox with the warning under it", () => {
    const html = render({ available: true, version: "rtk 1.0.0", on: false });
    expect(html).toContain('aria-disabled="false"');
    expect(html).not.toContain("wsg-mode-row--disabled");
    expect(html).toContain(escaped(t("en", "rtk.off.hint")));
    expect(html).toContain(escaped(t("en", "rtk.warning")));
  });

  it("says when a save was refused", () => {
    const html = render({ available: true, error: "refused by the server" });
    expect(html).toContain(escaped(t("en", "rtk.saveFailed", { e: "refused by the server" })));
  });

  it("says when the switch lands, through the reach block", () => {
    const html = render({ available: true });
    expect(html).toContain('data-reach="live"');
    expect(html).toContain('data-reach-fields="rtkFilter"');
  });
});

describe("the rtk strings", () => {
  const keys = Object.keys(dict).filter((k) => k.startsWith("rtk."));

  it("exist in both languages", () => {
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      expect(dict[key]?.en.trim(), `${key} has no English text`).not.toBe("");
      expect(dict[key]?.de.trim(), `${key} has no German text`).not.toBe("");
    }
  });

  it("carry no dash characters", () => {
    for (const key of keys) {
      for (const lang of ["en", "de"] as const) {
        expect(/[\u2013\u2014]/.test(dict[key]?.[lang] ?? ""), `${key} (${lang})`).toBe(false);
      }
    }
  });

  it("name every verb spectro refuses, read from the Java constant", () => {
    // RtkFilter.DENIED_VERBS is the one list spectro owns. The hint is derived
    // from nothing at runtime, so this reads the constant and holds the prose to
    // it: a verb added there turns this red until the hint says so.
    const java = stripComments(
      read("../../../spectro-core/src/main/java/dev/spectroscope/core/tools/RtkFilter.java", import.meta.url),
    );
    const decl = /DENIED_VERBS\s*=\s*Set\.of\(([^)]*)\)/.exec(java);
    expect(decl, "RtkFilter.java no longer declares DENIED_VERBS as Set.of(...)").not.toBeNull();
    const verbs = [...(decl?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      for (const lang of ["en", "de"] as const) {
        expect(dict["rtk.on.hint"]?.[lang], `rtk.on.hint (${lang}) does not name ${verb}`).toMatch(
          new RegExp(`\\b${verb}\\b`),
        );
      }
    }
  });
});

describe("the disabled row", () => {
  it("has a rule that looks disabled, drawn from theme tokens", () => {
    const css = read("../styles/workspace-gear.css", import.meta.url);
    const rule = /\.wsg-mode-row--disabled\s*\{([^}]*)\}/.exec(css);
    expect(rule, "workspace-gear.css has no .wsg-mode-row--disabled rule").not.toBeNull();
    const body = rule?.[1] ?? "";
    expect(body).toContain("cursor: not-allowed");
    expect(body).toMatch(/color:\s*var\(--/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});
