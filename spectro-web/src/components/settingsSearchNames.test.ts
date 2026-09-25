// Card 394, wave H3d: the settings search finds a field by the name the page
// draws beside it.
//
// The browser stage of wave H3c typed "tokens per subagent" and "tokens pro
// subagent" into the box and got no hit for the field; only the key
// subagentBudgetTokens found it, and "time per subagent" found nothing either.
// A field entry carried its key and its section heading, never its own name.
//
// The name of a field is a dictionary key. For most fields it is `set.<key>`;
// the fields that draw another one, or none, are listed in settingsSearch.ts.
// This file checks each name against the page source: the name has to be drawn
// inside the reach block that names the field, and where a labelled element
// carries the key as a literal, it has to be that element's name.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  SECTION_SETTING_KEYS,
  SETTING_FIELD_LABEL_EXCEPTIONS,
  buildSettingsManifest,
  matchSettings,
  settingFieldLabelKey,
} from "./settingsSearch";
import { dict, type Lang } from "../i18n/i18n";
import type { GoverningNumber } from "../state/governingNumbers";
import { read } from "../testkit/source";

const REGISTRY = "../../../spectro-core/src/main/resources/governing/numbers.json";
const registry: GoverningNumber[] = JSON.parse(read(REGISTRY, import.meta.url)) as GoverningNumber[];

const LANGS: readonly Lang[] = ["en", "de"];
const manifests: Record<Lang, ReturnType<typeof buildSettingsManifest>> = {
  en: buildSettingsManifest("en", registry),
  de: buildSettingsManifest("de", registry),
};

/** Every key the settings page draws a field for, off the placement table. */
const PAGE_KEYS: string[] = Object.values(SECTION_SETTING_KEYS).flat();

function findsField(lang: Lang, query: string, key: string): boolean {
  return matchSettings(manifests[lang], query).some((hit) => hit.origin === "field" && hit.key === key);
}

// ---- what the reader types -------------------------------------------------

describe("a field is found by the name the page draws beside it", () => {
  it("finds the two subagent budgets by the queries the wave H3c browser stage typed", () => {
    const cases: [Lang, string, string][] = [
      ["en", "tokens per subagent", "subagentBudgetTokens"],
      ["de", "tokens pro subagent", "subagentBudgetTokens"],
      ["en", "time per subagent", "subagentBudgetSeconds"],
      ["de", "zeit pro subagent", "subagentBudgetSeconds"],
    ];
    for (const [lang, query, key] of cases) {
      expect(findsField(lang, query, key), `${lang}: "${query}" does not find ${key}`).toBe(true);
    }
  });

  it("finds every field that draws a name of its own by that name, in English and in German", () => {
    const named = PAGE_KEYS.filter((key) => typeof settingFieldLabelKey(key) === "string");
    // The positive half: fields named by the rule and by the list are both in.
    expect(named).toContain("subagentBudgetTokens");
    expect(named).toContain("subagentBudgetSeconds");
    expect(named).toContain("imageProvider");
    for (const key of named) {
      const entry = dict[settingFieldLabelKey(key) as string];
      for (const lang of LANGS) {
        const name = entry[lang];
        expect(findsField(lang, name, key), `${lang}: "${name}" does not find ${key}`).toBe(true);
      }
    }
  });

  it("names a field on its result row in the reader's language, with the key after it", () => {
    for (const lang of LANGS) {
      const hit = manifests[lang].find((h) => h.id === "field:subagentBudgetTokens");
      expect(hit, "the field is missing from the manifest").toBeDefined();
      expect(hit?.title).toBe(`${dict["set.subagentBudgetTokens"][lang]} · subagentBudgetTokens`);
    }
    // A field without a name of its own keeps its key: its section heading is
    // on the same row already.
    const bare = PAGE_KEYS.find((key) => settingFieldLabelKey(key) === null);
    expect(bare, "no field is listed without a name of its own").toBeDefined();
    const hit = manifests.en.find((h) => h.id === `field:${bare as string}`);
    expect(hit?.title).toBe(bare);
  });

  it("still finds a field by its settings key", () => {
    for (const lang of LANGS) {
      expect(findsField(lang, "subagentBudgetTokens", "subagentBudgetTokens")).toBe(true);
    }
  });
});

// ---- where the name comes from ---------------------------------------------

describe("the name of each field comes from the dictionary", () => {
  it("resolves every field the page draws to a dictionary key in both languages, or to none", () => {
    for (const key of PAGE_KEYS) {
      const name = settingFieldLabelKey(key);
      expect(name, `${key} has no name: add set.${key} or list what the page draws`).not.toBeUndefined();
      if (typeof name === "string") {
        expect(dict[name], `${key} points at the missing dict key ${name}`).toBeDefined();
        expect(dict[name].en.trim(), `${name} has no English text`).not.toBe("");
        expect(dict[name].de.trim(), `${name} has no German text`).not.toBe("");
      }
    }
  });

  it("uses the rule set.<key> for every field not listed, and lists only what the rule cannot answer", () => {
    const listed = SETTING_FIELD_LABEL_EXCEPTIONS as Record<string, string | null>;
    for (const key of PAGE_KEYS) {
      if (Object.hasOwn(listed, key)) continue;
      expect(settingFieldLabelKey(key), key).toBe(`set.${key}`);
    }
    for (const [key, name] of Object.entries(listed)) {
      expect(PAGE_KEYS, `${key} is listed but the page draws no field for it`).toContain(key);
      expect(name, `${key} is listed with the name the rule gives anyway`).not.toBe(`set.${key}`);
      expect(settingFieldLabelKey(key)).toBe(name);
    }
  });
});

// ---- the page source, read as a syntax tree --------------------------------

const COMPONENTS = fileURLToPath(new URL(".", import.meta.url));

function parse(name: string, text: string): ts.SourceFile {
  const kind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
}

function nodesOf(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    all.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return all;
}

/** The .ts or .tsx file a relative import names; null for any other file. */
function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return /\.tsx?$/.test(candidate) ? candidate : null;
    }
  }
  throw new Error(`${from}: the import "${spec}" names no file`);
}

/** SettingsPanel.tsx and every .tsx it reaches through relative imports. */
function pageFiles(): ts.SourceFile[] {
  const seen = new Map<string, ts.SourceFile>();
  const todo = [join(COMPONENTS, "SettingsPanel.tsx")];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    const sf = parse(file, readFileSync(file, "utf8"));
    seen.set(file, sf);
    for (const node of sf.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const spec = node.moduleSpecifier.text;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const next = resolveImport(file, spec);
      if (next !== null) todo.push(next);
    }
  }
  return [...seen.values()].filter((sf) => sf.fileName.endsWith(".tsx"));
}

/** The dict key a `t(lang, x)` call draws for `key`: a literal as written, a
 *  template with one hole filled with `key`. null for anything else. */
function tKey(node: ts.Node, key: string): string | null {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "t") {
    return null;
  }
  const arg = node.arguments[1];
  if (arg === undefined) return null;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isTemplateExpression(arg) && arg.templateSpans.length === 1) {
    return arg.head.text + key + (arg.templateSpans[0] as ts.TemplateSpan).literal.text;
  }
  return null;
}

function attributesOf(node: ts.Node): ts.JsxAttributes | null {
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  return null;
}

function tagOf(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

/** An attribute's value when it is a string, written plain or in braces. */
function literalValue(attribute: ts.JsxAttribute): string | null {
  const value = attribute.initializer;
  if (value === undefined) return null;
  if (ts.isStringLiteral(value)) return value.text;
  if (
    ts.isJsxExpression(value) &&
    value.expression !== undefined &&
    ts.isStringLiteralLike(value.expression)
  ) {
    return value.expression.text;
  }
  return null;
}

function attribute(node: ts.Node, name: string): ts.JsxAttribute | null {
  for (const one of attributesOf(node)?.properties ?? []) {
    if (ts.isJsxAttribute(one) && one.name.getText() === name) return one;
  }
  return null;
}

/** The class names an element carries, including the fixed head of a template. */
function classesOf(node: ts.Node): string[] {
  const value = attribute(node, "className")?.initializer;
  if (value === undefined) return [];
  let text = "";
  if (ts.isStringLiteral(value)) text = value.text;
  else if (ts.isJsxExpression(value) && value.expression !== undefined) {
    const expression = value.expression;
    if (ts.isStringLiteralLike(expression)) text = expression.text;
    else if (ts.isTemplateExpression(expression)) text = expression.head.text;
  }
  return text.split(/\s+/).filter(Boolean);
}

/** An element that draws a field's name: a settings field, or a switch's label. */
function isNamed(node: ts.Node): node is ts.JsxElement {
  return (
    ts.isJsxElement(node) && classesOf(node).some((c) => c === "settings-field" || c === "fx-switch-label")
  );
}

/** The first `t(...)` call inside an element, in source order. */
function firstName(element: ts.JsxElement, key: string): string | null {
  for (const child of element.children) {
    for (const node of nodesOf(child)) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        return tKey(node, key);
      }
    }
  }
  return null;
}

/** The keys an element and its subtree carry as literal `field` or
 *  `data-...-field` attributes. */
function literalFields(element: ts.Node): string[] {
  const out: string[] = [];
  for (const node of nodesOf(element)) {
    if (!ts.isJsxAttribute(node)) continue;
    const name = node.name.getText();
    if (name !== "field" && !/^data-[a-z-]+-field$/.test(name)) continue;
    const value = literalValue(node);
    if (value !== null) out.push(value);
  }
  return out;
}

/** The components a file declares, by name. */
function componentsOf(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      out.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          out.set(declaration.name.text, init);
        }
      }
    }
  }
  return out;
}

/** What one reach block draws for one key: every name it draws, and the
 *  names of the elements that carry the key as a literal. */
interface Drawn {
  names: string[];
  pinned: string[];
}

/**
 * Every reach block in `files` that names `key`, each with what it draws. A
 * block's extent is the block element plus the components of the same file
 * that it renders, followed transitively.
 */
function drawnFor(files: readonly ts.SourceFile[], key: string): Drawn[] {
  const out: Drawn[] = [];
  for (const sf of files) {
    const components = componentsOf(sf);
    for (const block of nodesOf(sf)) {
      if (tagOf(block) !== "ReachBlock") continue;
      const fields = attribute(block, "fields")?.initializer;
      if (fields === undefined || !ts.isJsxExpression(fields) || fields.expression === undefined) continue;
      if (!ts.isArrayLiteralExpression(fields.expression)) continue;
      const listed = fields.expression.elements.filter(ts.isStringLiteralLike).map((e) => e.text);
      if (!listed.includes(key)) continue;
      const roots: ts.Node[] = [block];
      const followed = new Set<string>();
      for (let i = 0; i < roots.length; i++) {
        for (const node of nodesOf(roots[i] as ts.Node)) {
          const tag = tagOf(node);
          if (tag === null || followed.has(tag) || !components.has(tag)) continue;
          followed.add(tag);
          roots.push(components.get(tag) as ts.Node);
        }
      }
      const drawn: Drawn = { names: [], pinned: [] };
      for (const root of roots) {
        for (const node of nodesOf(root)) {
          if (isNamed(node)) {
            const name = firstName(node, key);
            if (name !== null) drawn.names.push(name);
            if (name !== null && literalFields(node).includes(key)) drawn.pinned.push(name);
          } else if (ts.isJsxAttribute(node) && node.name.getText() === "label") {
            const value = node.initializer;
            if (value !== undefined && ts.isJsxExpression(value) && value.expression !== undefined) {
              const name = tKey(value.expression, key);
              if (name !== null) drawn.names.push(name);
            }
          }
        }
      }
      out.push(drawn);
    }
  }
  return out;
}

describe("the reader of the page source", () => {
  it("finds the names a block draws, and ignores notes, other attributes and blocks for other keys", () => {
    const fixture = parse(
      "fixture.tsx",
      [
        "function Row({ field }: { field: string }) {",
        "  return (",
        '    <label className="settings-field" data-x-field={field}>',
        "      <span>{t(lang, `set.row.${field}`)}</span>",
        '      <p className="settings-note">{t(lang, `set.row.${field}Note`)}</p>',
        "    </label>",
        "  );",
        "}",
        "export function Page() {",
        "  return (",
        "    <>",
        '      <ReachBlock lang={lang} fields={["alpha"]}>',
        '        <label className="settings-field">',
        '          <span>{t(lang, "set.alphaName")}</span>',
        '          <OriginRow field="alpha" resetTitle={t(lang, "set.alphaReset")} />',
        "        </label>",
        '        <p className="settings-note">{t(lang, "set.alphaNote")}</p>',
        "      </ReachBlock>",
        '      <ReachBlock lang={lang} fields={["beta", "gamma"]}>',
        '        {(["beta", "gamma"] as const).map((field) => <Row key={field} field={field} />)}',
        "      </ReachBlock>",
        '      <ReachBlock lang={lang} fields={["delta"]}>',
        '        <Switch label={t(lang, "set.deltaSwitch")} />',
        '        <span className="fx-switch-label">{t(lang, "set.deltaSpan")}</span>',
        "      </ReachBlock>",
        '      <ReachBlock lang={lang} fields={["epsilon"]} note="set.epsilonApplies" />',
        '      <ReachBlock lang={lang} fields={["zeta"]}>',
        '        <p className="settings-note">{t(lang, "set.zetaNote")}</p>',
        "      </ReachBlock>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );
    const files = [fixture];
    expect(drawnFor(files, "alpha")).toEqual([{ names: ["set.alphaName"], pinned: ["set.alphaName"] }]);
    expect(drawnFor(files, "gamma")).toEqual([{ names: ["set.row.gamma"], pinned: [] }]);
    expect(drawnFor(files, "delta")).toEqual([{ names: ["set.deltaSwitch", "set.deltaSpan"], pinned: [] }]);
    expect(drawnFor(files, "epsilon")).toEqual([{ names: [], pinned: [] }]);
    expect(drawnFor(files, "zeta")).toEqual([{ names: [], pinned: [] }]);
    expect(drawnFor(files, "omega")).toEqual([]);
  });

  it("reads the settings page and not the composer's menus", () => {
    const names = pageFiles().map((sf) => sf.fileName.slice(COMPONENTS.length));
    expect(names).toContain("SettingsPanel.tsx");
    expect(names).toContain("ProgressGuardSettings.tsx");
    expect(names).not.toContain("PlusMenuSettings.tsx");
    expect(names).not.toContain("RtkFilterSection.tsx");
  });
});

describe("each name is the one the page draws in the block that saves the field", () => {
  const files = pageFiles();

  it("draws a field's name inside the reach block that names the field, and on the element that carries its key", () => {
    let pinnedChecks = 0;
    for (const key of PAGE_KEYS) {
      const name = settingFieldLabelKey(key);
      if (typeof name !== "string") continue;
      const blocks = drawnFor(files, key);
      expect(blocks.length, `no reach block on the settings page names ${key}`).toBeGreaterThan(0);
      const names = blocks.flatMap((b) => b.names);
      expect(
        names,
        `${key}: the page draws ${names.join(", ") || "no name"}, the search says ${name}`,
      ).toContain(name);
      for (const pinned of blocks.flatMap((b) => b.pinned)) {
        expect(pinned, `${key}: the element that carries the key draws ${pinned}`).toBe(name);
        pinnedChecks++;
      }
    }
    // The strict half has to have run on real fields, the two budgets among them.
    expect(pinnedChecks).toBeGreaterThan(10);
    expect(drawnFor(files, "subagentBudgetTokens").flatMap((b) => b.pinned)).toEqual([
      "set.subagentBudgetTokens",
    ]);
  });

  it("puts a field listed without a name of its own in a block that draws no name", () => {
    const bare = PAGE_KEYS.filter((key) => settingFieldLabelKey(key) === null);
    expect(bare.length, "no field is listed without a name of its own").toBeGreaterThan(0);
    for (const key of bare) {
      const blocks = drawnFor(files, key);
      expect(blocks.length, `no reach block on the settings page names ${key}`).toBeGreaterThan(0);
      const names = blocks.flatMap((b) => b.names);
      expect(names, `${key} is listed without a name, and its block draws ${names.join(", ")}`).toEqual([]);
    }
  });
});
