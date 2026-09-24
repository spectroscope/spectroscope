// Card 381, the copy prompt half: a row of the limits list hands the operator a
// finished sentence to paste at an agent.
//
// The one thing this file refuses to do is enumerate the kinds by hand. The
// mapping under test is keyed off `GOVERNING_KINDS`, which
// `governingNumbers.drift.test.tsx` already holds to the constants of
// `Governs.Kind` in Java, so a ninth kind reaches this suite as a missing
// mapping rather than as a row that silently draws no button.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_REFERENCE_PATH, governingPrompt, governingPromptKey } from "./settingsPrompt";
import { GOVERNING_KINDS, ownerSimpleName, type GoverningNumber } from "../state/governingNumbers";
import { dict } from "../i18n/i18n";
import { blockOf, read, stripComments } from "../testkit/source";

const REGISTRY = "../../../spectro-core/src/main/resources/governing/numbers.json";
const registry: GoverningNumber[] = JSON.parse(read(REGISTRY, import.meta.url)) as GoverningNumber[];

/** A row the test owns, so the assertions below do not move when the registry
 *  does. Only the ALIAS cases read real rows: one by name, one by the shape of
 *  the expression. */
function row(over: Partial<GoverningNumber>): GoverningNumber {
  return {
    owner: "dev.spectroscope.core.agent.Agent",
    field: "DEFAULT_MAX_TURNS",
    value: "150",
    expression: "150",
    kind: "SETTABLE",
    unit: "TURNS",
    key: "maxTurns",
    explanation: "How many turns one run may take before the agent stops.",
    ...over,
  };
}

describe("every kind has a decided behaviour, and the decision is the enum's", () => {
  it("maps PLUMBING to no button and every other kind to a prompt", () => {
    for (const kind of GOVERNING_KINDS) {
      const key = governingPromptKey(kind);
      if (kind === "PLUMBING") {
        expect(key, "plumbing governs nothing, so no honest sentence exists").toBeNull();
        continue;
      }
      expect(key, `${kind} has no prompt template`).not.toBeNull();
      expect(dict[key as string], `${kind} names a dict key that does not exist`).toBeDefined();
    }
  });

  it("draws no prompt for a PLUMBING row", () => {
    expect(governingPrompt(row({ kind: "PLUMBING", key: "", unit: "BYTES" }), "en")).toBeNull();
    expect(governingPrompt(row({ kind: "PLUMBING", key: "", unit: "BYTES" }), "de")).toBeNull();
  });

  it("produces a non-empty sentence in both languages for every other kind", () => {
    for (const kind of GOVERNING_KINDS) {
      if (kind === "PLUMBING") continue;
      for (const lang of ["de", "en"] as const) {
        const text = governingPrompt(row({ kind }), lang);
        expect(text, `${kind}/${lang}`).toBeTruthy();
        // A template whose placeholders never got filled is worse than none:
        // it reads like a finished sentence and names nothing.
        expect(text as string, `${kind}/${lang} left a placeholder standing`).not.toMatch(/\{[a-z]+\}/i);
      }
    }
  });
});

describe("a settable number's prompt names the lever", () => {
  it("carries the key, the constant, the value and the unit", () => {
    const number = row({});
    for (const lang of ["de", "en"] as const) {
      const text = governingPrompt(number, lang) as string;
      expect(text, "key").toContain("maxTurns");
      expect(text, "field").toContain("DEFAULT_MAX_TURNS");
      expect(text, "value").toContain("150");
      expect(text, "unit").toContain(dict["set.gnUnit.TURNS"][lang]);
    }
  });
});

describe("an alias points at the number it restates", () => {
  it("names the restated constant and asks for no change to the alias itself", () => {
    const alias = registry.find(
      (n) => n.kind === "ALIAS" && n.field === "MAX_OUTPUT_CHARS" && n.owner.endsWith("HookRunner"),
    );
    expect(alias, "the registry no longer carries HookRunner.MAX_OUTPUT_CHARS").toBeDefined();
    const it_ = alias as GoverningNumber;
    for (const lang of ["de", "en"] as const) {
      const text = governingPrompt(it_, lang) as string;
      expect(text, "the restated constant").toContain(it_.expression);
      // The alias's own qualified name never appears, so nothing in the
      // sentence can be read as "change this one".
      expect(text, "the prompt invites a change to the alias itself").not.toContain(
        `${ownerSimpleName(it_.owner)}.${it_.field}`,
      );
    }
  });

  it("points at the named constant when the alias converts its unit", () => {
    // Card 412: a deprecated alias restates a constant in another unit, as
    // `Owner.CONSTANT * 1000L`. The expression names a constant, so the row
    // gets the sentence a bare constant gets, with the whole expression as
    // the number to change, and never the literal sentence that says there
    // is no other constant behind it. The rows are taken from the registry by
    // the shape of their expression, not by name.
    const namesAConstant = /(?<![\w$])[A-Za-z_$][\w$]*/;
    const named = registry.filter((n) => n.kind === "ALIAS" && namesAConstant.test(n.expression));
    expect(
      named.some((n) => /[*/]/.test(n.expression)),
      "the registry carries no alias that converts a constant, so this case checks nothing",
    ).toBe(true);
    for (const number of named) {
      for (const lang of ["de", "en"] as const) {
        const text = governingPrompt(number, lang) as string;
        const asBare = governingPrompt({ ...number, expression: "Owner.CONSTANT" }, lang) as string;
        expect(text, `${number.field}/${lang}: the restated expression`).toContain(number.expression);
        expect(text.split(number.expression).join("#"), `${number.field}/${lang} reads as a literal`).toBe(
          asBare.split("Owner.CONSTANT").join("#"),
        );
      }
    }
  });

  it("keeps an alias that names no constant on the literal sentence, converted or not", () => {
    // Card 412 widened what counts as a named constant. The case below this
    // one compares two sentences that differ by their expression anyway, so
    // it stayed green when a bare literal was let through as a constant
    // (kanban/evidence/412/loop/bite-9.log in the home repo). Here the
    // expression is masked out first, so only the sentence form is compared.
    const literals = registry.filter(
      (n) => n.kind === "ALIAS" && !/(?<![\w$])[A-Za-z_$][\w$]*/.test(n.expression),
    );
    expect(
      literals.length,
      "the registry carries no literal alias, so this case checks nothing",
    ).toBeGreaterThan(0);
    const cases = [
      ...literals,
      row({ kind: "ALIAS", expression: "300 * 1000L", key: "", unit: "MILLISECONDS" }),
    ];
    for (const number of cases) {
      for (const lang of ["de", "en"] as const) {
        const text = governingPrompt(number, lang) as string;
        const asBare = governingPrompt({ ...number, expression: "Owner.CONSTANT" }, lang) as string;
        expect(text, `${number.expression}/${lang}`).toContain(number.expression);
        expect(
          text.split(number.expression).join("#"),
          `${number.expression}/${lang} reads as a constant`,
        ).not.toBe(asBare.split("Owner.CONSTANT").join("#"));
      }
    }
  });

  it("says so plainly when the alias restates a literal and not a constant", () => {
    const literal = row({ kind: "ALIAS", expression: "50_000", key: "", unit: "BYTES" });
    for (const lang of ["de", "en"] as const) {
      const text = governingPrompt(literal, lang) as string;
      expect(text).toContain("50_000");
      expect(text, `${lang}: a literal alias reads like a constant alias`).not.toBe(
        governingPrompt(row({ kind: "ALIAS", expression: "ToolOutput.MAX_OUTPUT_CHARS" }), lang),
      );
    }
  });
});

describe("a number with no lever asks for a card and names the configuration reference", () => {
  // These three are the card's own list (owner call 8): the kinds where nobody
  // built a lever and the honest ask is a ticket, not an edit.
  for (const kind of ["FIXED", "UNEXAMINED", "FOREIGN_CONTRACT"] as const) {
    it(`${kind} asks for a card and names the configuration reference`, () => {
      const en = governingPrompt(row({ kind, key: "" }), "en") as string;
      const de = governingPrompt(row({ kind, key: "" }), "de") as string;
      expect(en.toLowerCase(), "the English sentence never says card").toContain("card");
      expect(de.toLowerCase(), "the German sentence never says Karte").toContain("karte");
      expect(en, "the configuration reference").toContain(CONFIG_REFERENCE_PATH);
      expect(de, "the configuration reference").toContain(CONFIG_REFERENCE_PATH);
    });
  }

  it("types no measured count into the sentence", () => {
    // Owner call 8, and the canon's fourth drift of exactly this shape: a
    // number that is derivable from a measurement does not belong in prose.
    // The survey measured fifteen touch points, nine test-enforced; neither
    // may be spelled here or in the dictionary.
    const source = stripComments(read("./settingsPrompt.ts", import.meta.url));
    for (const forbidden of ["15", "fifteen", "fünfzehn", "9 ", "nine", "neun"]) {
      expect(source.toLowerCase(), `the module types the measured count ${forbidden}`).not.toContain(
        forbidden.toLowerCase(),
      );
    }
    for (const kind of ["FIXED", "UNEXAMINED", "FOREIGN_CONTRACT"] as const) {
      const key = governingPromptKey(kind) as string;
      for (const lang of ["de", "en"] as const) {
        const text = dict[key][lang];
        expect(text, `${key}.${lang} carries a bare count`).not.toMatch(
          /\b(15|9|fifteen|nine|neun|fünfzehn)\b/i,
        );
      }
    }
  });
});

describe("a copied prompt works in the reader's own checkout (card 413)", () => {
  // The reader pastes the prompt at an agent in a checkout of the public
  // repository. A path into the private product home, or a number off its
  // board, sends that agent looking for a file it cannot open.
  const REPO_ROOT = new URL("../../../", import.meta.url);
  /** The two keys card 413 names as the shape a new settings key follows. */
  const SHAPE_KEYS = ["subagentBudgetSeconds", "maxTurns"] as const;
  const KEY_TABLE_ANCHOR = 'id="ch-config-keys"';

  /** The keys of the "Every key" table, read the way KnownKeysDriftTest reads
   *  them: from the anchor to the next `</table>`, one key per row that opens
   *  with `<tr><td><code>KEY</code>`. A `<code>KEY</code>` in the prose of
   *  another row is a mention, not a row, and is not returned. */
  function keyTableRows(reference: string): string[] {
    const start = reference.indexOf(KEY_TABLE_ANCHOR);
    const end = reference.indexOf("</table>", start);
    const table = reference.slice(start, end);
    return [...table.matchAll(/<tr><td><code>([^<]+)<\/code>/g)].map((m) => m[1]);
  }

  for (const kind of GOVERNING_KINDS) {
    if (kind === "PLUMBING") continue;
    for (const lang of ["de", "en"] as const) {
      it(`${kind}/${lang} names no private path and no card number`, () => {
        const text = governingPrompt(row({ kind, key: "" }), lang) as string;
        expect(text, "there is a sentence to read").toBeTruthy();
        expect(text, "the prompt names the private board").not.toContain("kanban/");
        expect(text, "the prompt names an evidence folder").not.toContain("evidence/");
        expect(text, "the prompt names a card by number").not.toMatch(/\b(cards?|karten?)\s+\d/i);
      });
    }
  }

  for (const kind of ["FIXED", "UNEXAMINED", "FOREIGN_CONTRACT"] as const) {
    for (const lang of ["de", "en"] as const) {
      it(`${kind}/${lang} names a docs file this checkout has, and the two keys to copy`, () => {
        const text = governingPrompt(row({ kind, key: "" }), lang) as string;
        const paths = (text.match(/\bdocs\/[\w./-]+/g) ?? []).map((p) => p.replace(/[.,;:]+$/, ""));
        expect(paths, "the prompt names exactly one file under docs/").toHaveLength(1);
        const file = fileURLToPath(new URL(paths[0], REPO_ROOT));
        expect(existsSync(file), `${paths[0]} is not in this checkout`).toBe(true);
        const reference = readFileSync(file, "utf8");
        expect(reference, `${paths[0]} has no "Every key" table`).toContain(KEY_TABLE_ANCHOR);
        const rows = keyTableRows(reference);
        for (const key of SHAPE_KEYS) {
          expect(text, `the prompt does not name ${key}`).toContain(key);
          expect(rows, `${paths[0]} has no row for ${key} in its "Every key" table`).toContain(key);
        }
      });
    }
  }

  it("the two example keys are settable keys of the registry", () => {
    for (const key of SHAPE_KEYS) {
      expect(
        registry.some((n) => n.kind === "SETTABLE" && n.key === key),
        `${key} is not a settable key in the registry`,
      ).toBe(true);
    }
  });
});

describe("the button a reader can actually see", () => {
  // Found by looking, after a scripted click had already reported success: the
  // clipboard answers a click on an element at opacity 0, so the copy "worked"
  // in every DOM reading while nothing was drawn on the row.
  it("pins the shared chip into the row, because the shared chip hides itself", () => {
    // The positive control first. If the shared rule ever stops hiding the
    // chip, the correction below is dead weight and this test says so rather
    // than passing on a rule that no longer does anything.
    const shared = blockOf(read("../styles/toolcard.css", import.meta.url), ".copy");
    expect(shared, "the shared chip no longer hides itself").toMatch(/opacity:\s*0/);
    expect(shared, "the shared chip no longer leaves the flow").toMatch(/position:\s*absolute/);

    // blockOf matches the WHOLE selector: a substring search for `.copy` would
    // have returned the shared rule and called it this one.
    const row = blockOf(read("../styles/settings.css", import.meta.url), ".gn-head .copy");
    expect(row, "the copy button is invisible on a reference row").toMatch(/opacity:\s*1/);
    expect(row, "the copy button is out of flow on a reference row").toMatch(/position:\s*static/);
  });
});

describe("the row copies through the shared button", () => {
  it("GoverningNumbersBlock imports CopyButton and reaches no clipboard itself", () => {
    // The file is named on purpose: SettingsPanel.tsx already imports
    // CopyButton for the Langfuse command, so a scan aimed there is green
    // today and proves nothing about this card.
    const block = stripComments(read("./GoverningNumbersBlock.tsx", import.meta.url));
    expect(block).toContain('from "./CopyButton"');
    for (const rel of ["./GoverningNumbersBlock.tsx", "./settingsPrompt.ts", "./settingsSearch.ts"]) {
      expect(stripComments(read(rel, import.meta.url)), `${rel} reaches the clipboard itself`).not.toContain(
        "navigator.clipboard",
      );
    }
  });
});
