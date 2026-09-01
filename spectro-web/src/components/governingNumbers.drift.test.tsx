// Card 357: the settings room draws the registry, and the registry is the Java
// source tree. This file is the web half of that claim.
//
// WHAT IT DELIBERATELY DOES NOT DO: it does not type a constant, a value, a
// unit or a reason and then assert the page shows it. That shape — a hand-list
// guarded by a test typing the same hand-list — is the canon's most-repeated
// defect, found three times in ONE card (312) and again in 314. Every
// expectation below is derived from something else: the generated registry
// itself, the Java enums it was classified with, or the controller's own
// mapping.
//
// The sharpest case is the last one. It reads every constant name out of the
// generated registry and demands that NONE of them appears in the page's own
// source. A room that mentions a constant has started keeping a second list,
// and the day the source moves that list is a lie nobody can see.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoverningNumbersList } from "./GoverningNumbersBlock";
import {
  GOVERNING_KINDS,
  GOVERNING_UNITS,
  NOT_GOVERNING_KINDS,
  governingKindLabelKey,
  governingKindWhyKey,
  governingUnitLabelKey,
  governs,
  type GoverningKind,
  type GoverningNumber,
} from "../state/governingNumbers";
import { dict } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";

const GOVERNS_JAVA =
  "../../../spectro-core/src/main/java/dev/spectroscope/core/config/governing/Governs.java";
const REGISTRY = "../../../spectro-core/src/main/resources/governing/numbers.json";
const CONTROLLER =
  "../../../spectro-server/src/main/java/dev/spectroscope/server/settings/GoverningNumbersController.java";

/** The generated registry, exactly as the server answers it. */
const registry: GoverningNumber[] = JSON.parse(read(REGISTRY, import.meta.url)) as GoverningNumber[];

/** Markup with its entities put back, so a javadoc containing an apostrophe
 *  can be searched for as the text a reader sees. */
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The inverse of {@link decode} for the five characters React escapes — used
 *  to read a value back out of the cell it was rendered into. */
function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** The constants of one enum nested in Governs.java, in declaration order. */
function javaEnumConstants(name: string): string[] {
  const source = stripComments(read(GOVERNS_JAVA, import.meta.url));
  const at = source.indexOf(`enum ${name} {`);
  expect(at, `Governs.java declares no enum ${name}`).toBeGreaterThan(-1);
  const body = source.slice(at + `enum ${name} {`.length);
  const close = body.search(/^\s{4}}/m);
  expect(close, `enum ${name} never closes`).toBeGreaterThan(-1);
  // Constants run to the first `;` when the enum has a body after them (Kind
  // has a method), and to the closing brace when it has not (Unit does not).
  // A regex that demanded the trailing comma would have lost the LAST constant
  // of every enum, which is the one a new kind would be added as.
  const semicolon = body.slice(0, close).indexOf(";");
  const constants = body.slice(0, semicolon < 0 ? close : semicolon);
  return constants
    .split(",")
    .map((token) => token.trim())
    .filter((token) => /^[A-Z][A-Z0-9_]*$/.test(token));
}

describe("the room's vocabulary is the Java enum's", () => {
  it("knows exactly the kinds Governs.Kind declares", () => {
    // Not a subset check in either direction: a ninth kind added in Java would
    // reach the browser as a bare enum name under no heading, and a kind
    // dropped in Java would leave a dead group here forever.
    expect([...GOVERNING_KINDS].sort()).toEqual(javaEnumConstants("Kind").sort());
  });

  it("knows exactly the units Governs.Unit declares", () => {
    expect([...GOVERNING_UNITS].sort()).toEqual(javaEnumConstants("Unit").sort());
  });

  it("excludes from governing exactly what the Java predicate excludes", () => {
    // Governs.Kind#governs() is one line, and it is the ONE definition of what
    // counts as governing (card 357 criterion 6). Read that line rather than
    // restating its answer, so widening it on one side alone turns this red.
    const source = stripComments(read(GOVERNS_JAVA, import.meta.url));
    const line = /return\s+(this\s*!=\s*[A-Z_]+(?:\s*&&\s*this\s*!=\s*[A-Z_]+)*)\s*;/.exec(source);
    expect(line, "Governs.Kind#governs() no longer reads as a list of exclusions").not.toBeNull();
    const excluded = [...(line as RegExpExecArray)[1].matchAll(/!=\s*([A-Z_]+)/g)].map((m) => m[1]);
    expect([...NOT_GOVERNING_KINDS].sort()).toEqual(excluded.sort());
    for (const kind of GOVERNING_KINDS) {
      expect(governs(kind), kind).toBe(!excluded.includes(kind));
    }
  });

  it("gives every kind and every unit a label in both languages", () => {
    for (const kind of GOVERNING_KINDS) {
      for (const key of [governingKindLabelKey(kind), governingKindWhyKey(kind)]) {
        expect(dict[key], `${key} is missing`).toBeDefined();
        expect(dict[key]?.de.length ?? 0, `${key} has no German`).toBeGreaterThan(0);
        expect(dict[key]?.en.length ?? 0, `${key} has no English`).toBeGreaterThan(0);
      }
    }
    for (const unit of GOVERNING_UNITS) {
      const key = governingUnitLabelKey(unit);
      expect(dict[key], `${key} is missing`).toBeDefined();
      expect(dict[key]?.de.length ?? 0, `${key} has no German`).toBeGreaterThan(0);
      expect(dict[key]?.en.length ?? 0, `${key} has no English`).toBeGreaterThan(0);
    }
  });
});

describe("the client asks the address the server answers", () => {
  it("fetches the path the controller maps", () => {
    const mapping = /@GetMapping\("([^"]+)"\)/.exec(stripComments(read(CONTROLLER, import.meta.url)));
    expect(mapping, "the controller no longer carries a @GetMapping").not.toBeNull();
    const client = stripComments(read("../state/governingNumbers.ts", import.meta.url));
    expect(client).toContain(`activeFetch("${(mapping as RegExpExecArray)[1]}")`);
  });
});

describe("the room draws the registry", () => {
  it("has a registry to draw at all", () => {
    // A scan that found nothing passes every assertion below it. The floor is a
    // floor and not a total, per the canon's rule after the StateGraph refusal
    // count was wrong four times.
    expect(registry.length).toBeGreaterThanOrEqual(100);
    expect(registry.filter((n) => governs(n.kind)).length).toBeGreaterThanOrEqual(80);
  });

  it("shows every constant the build carries, with its value and EVERY paragraph of its reason", () => {
    // Review finding F2. This used to render the whole list once and ask
    // `toContain` three questions of a 21 000-character page, which is far
    // weaker than it reads:
    //
    //   - the value: 37 of the entries have a value one or two characters
    //     long, and `4` is a substring of `16_384` two rows up, so the check
    //     passed for reasons that had nothing to do with the row;
    //   - the reason: it asserted the first five words of the FIRST paragraph,
    //     and 14 entries have more than one — 7 872 of 21 783 explanation
    //     characters sit below the first. Changing the row to render
    //     `.slice(0, 1)` of the paragraphs left the suite green.
    //
    // So each entry is now rendered ALONE (the list is a pure function, so
    // this costs nothing) and each field is read out of its own element:
    // the value out of its own cell, the reason paragraph for paragraph,
    // compared to the registry's text in full rather than by containment.
    for (const number of registry) {
      const html = renderToStaticMarkup(<GoverningNumbersList numbers={[number]} lang="en" />);
      expect(decode(html), `${number.field} is not on the page`).toContain(number.field);

      const cell = html.indexOf('<span class="gn-value"');
      expect(cell, `${number.field} has no value cell`).toBeGreaterThan(-1);
      const opens = html.indexOf(">", cell) + 1;
      const escaped = escapeText(number.value);
      expect(html.slice(opens, opens + escaped.length), `${number.field} shows the wrong value`).toBe(
        escaped,
      );

      // Entities put back first — React escapes an apostrophe to &#x27;, and
      // reading the raw markup would quietly excuse every javadoc with one.
      const paragraphs = [...html.matchAll(/<p class="gn-why">([\s\S]*?)<\/p>/g)].map((match) =>
        decode(match[1] as string),
      );
      expect(paragraphs, `${number.field} lost part of its reason`).toEqual(number.explanation.split("\n\n"));
    }
  });

  it("draws one group per kind the registry actually uses, and none it does not", () => {
    // Review finding F5: all eight kinds are in use in the shipped registry,
    // so `used.has(kind)` was true on every iteration and the second half of
    // this name had never run. The list is a pure function, so the absent
    // direction costs one more render — of the registry with one kind taken
    // out. WHICH kind is derived from the data rather than typed, so it stays
    // a real case as the classifications move.
    const heading = (kind: GoverningKind) =>
      `<h4 class="gn-kind">${dict[governingKindLabelKey(kind)]?.en as string}<`;
    const used = [...new Set(registry.map((n) => n.kind))];
    expect(used.length, "the registry uses one kind or none — drop-one proves nothing").toBeGreaterThan(1);
    const absent = used[used.length - 1] as GoverningKind;

    for (const [numbers, missing] of [
      [registry, null],
      [registry.filter((n) => n.kind !== absent), absent],
    ] as const) {
      const html = renderToStaticMarkup(<GoverningNumbersList numbers={numbers} lang="en" />);
      for (const kind of GOVERNING_KINDS) {
        const shown = numbers.some((n) => n.kind === kind);
        expect(html.includes(heading(kind)), `${kind} heading present: ${shown} (dropped ${missing})`).toBe(
          shown,
        );
      }
    }
  });

  it("names the settings key of every settable number and of nothing else", () => {
    const html = renderToStaticMarkup(<GoverningNumbersList numbers={registry} lang="en" />);
    const settable = registry.filter((n) => n.key !== "");
    expect(settable.length).toBeGreaterThan(0);
    for (const number of settable) {
      expect(html, `${number.field} hides its key`).toContain(`<code>${number.key}</code>`);
    }
    // The count of key badges equals the count of entries that have one — a
    // page that printed a key for a fixed number would promise a control that
    // does not reach it, which is the mistake this page exists to expose.
    const badges = html.match(/settings key <code>/g) ?? [];
    expect(badges.length).toBe(settable.length);
  });

  it("keeps no list of its own — neither file names a constant", () => {
    const page = stripComments(read("./GoverningNumbersBlock.tsx", import.meta.url));
    const client = stripComments(read("../state/governingNumbers.ts", import.meta.url));
    // Word boundaries, not substrings: `BYTES_PER_GIB` in the formatter is not
    // a copy of HeapBudget#GIB, and a guard that could not tell them apart
    // would have been paid for by weakening it everywhere else.
    const named = registry
      .map((n) => n.field)
      .filter((field) => {
        const at = new RegExp(`\\b${field}\\b`);
        return at.test(page) || at.test(client);
      });
    expect(named, "the room started keeping its own copy of the constants").toEqual([]);
  });
});
