// Card 386, criterion 6: a new number field on the settings page cannot save
// through a bare `Number(...)` again.
//
// Eight lines of the settings page saved `Number(e.target.value)`, and
// `Number("")` is 0, so clearing any of 13 fields saved a zero. The fields now
// go through NumberField, and settingsNumberField.test.tsx pins what it does:
// it saves only a whole number at or above the key's floor.
//
// This guard does not search handlers for `Number(`. A handler hoisted out of
// the tag, or a unary plus, passes any such search. It checks structure
// instead, on the syntax tree the TypeScript parser builds: in the files the
// settings page draws, the one JSX `<input>` whose type is number is the one
// in settingsNumberField.tsx, so any other number input fails, whatever its
// handler does. The files are SettingsPanel.tsx, every .tsx it reaches
// through relative imports, and every component whose name says settings.
// Each `<input>` in them has to name its type as a string, because a type the
// guard cannot read could be number.
//
// What it does not read: a text input whose handler turns its text into a
// number, and an input made without JSX.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const COMPONENTS = fileURLToPath(new URL(".", import.meta.url));

/** A source file parsed the way the compiler parses it. */
function parse(name: string, text: string): ts.SourceFile {
  const kind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind);
}

/** Every node of `root`, depth first. */
function nodesOf(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    all.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return all;
}

/** The module names a file imports or re-exports, statically or dynamically. */
function importsOf(file: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const node of nodesOf(file)) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) names.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) names.push(arg.text);
    }
  }
  return names;
}

/** The .ts or .tsx file a relative import names; null for a stylesheet or
 *  other asset. Throws when it names no file, so a walk cannot stop short in
 *  silence. */
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

/** Every .ts and .tsx reached from `start` through relative imports, `start`
 *  included. */
function reachableFrom(start: string): string[] {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(parse(file, readFileSync(file, "utf8")))) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const next = resolveImport(file, spec);
      if (next !== null) todo.push(next);
    }
  }
  return [...seen];
}

/** The files the settings page draws, relative to src/components. */
const SETTINGS_FILES: string[] = [
  ...new Set([
    ...reachableFrom(join(COMPONENTS, "SettingsPanel.tsx"))
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => relative(COMPONENTS, file)),
    ...readdirSync(COMPONENTS).filter(
      (name) => name.endsWith(".tsx") && !name.includes(".test.") && /settings/i.test(name),
    ),
  ]),
].sort();

/** One JSX `<input>` element. */
interface InputTag {
  file: string;
  line: number;
  /** The type it names; "(none)" when it has no type attribute, which the
   *  browser draws as text; null when the guard cannot read it: a type given
   *  as an expression, or a spread attribute that could carry one. */
  type: string | null;
}

/** The type an `<input>`'s attributes name, read as InputTag.type says. */
function typeOf(attributes: ts.JsxAttributes): string | null {
  let type = "(none)";
  for (const attribute of attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) return null;
    if (attribute.name.getText() !== "type") continue;
    const value = attribute.initializer;
    if (value !== undefined && ts.isStringLiteral(value)) {
      type = value.text;
    } else if (
      value !== undefined &&
      ts.isJsxExpression(value) &&
      value.expression !== undefined &&
      ts.isStringLiteralLike(value.expression)
    ) {
      type = value.expression.text;
    } else {
      return null;
    }
  }
  return type;
}

/** Every JSX `<input>` element in `text`. */
function inputsIn(file: string, text: string): InputTag[] {
  const source = parse(file, text);
  const found: InputTag[] = [];
  for (const node of nodesOf(source)) {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) continue;
    if (node.tagName.getText() !== "input") continue;
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      type: typeOf(node.attributes),
    });
  }
  return found;
}

const INPUTS: InputTag[] = SETTINGS_FILES.flatMap((file) =>
  inputsIn(file, readFileSync(join(COMPONENTS, file), "utf8")),
);

describe("the inputs the settings page draws", () => {
  it("are read from every file the settings page draws", () => {
    // The positive half: a walk that found nothing would pass every case
    // below. providerModelField.tsx is drawn by the page and its name does
    // not say settings, so only the import walk finds it.
    for (const file of [
      "SettingsPanel.tsx",
      "ProgressGuardSettings.tsx",
      "DockWidthSettings.tsx",
      "settingsNumberField.tsx",
      "providerModelField.tsx",
    ]) {
      expect(SETTINGS_FILES).toContain(file);
    }
    expect(INPUTS.length, "no <input> was found at all").toBeGreaterThan(0);
  });

  it("take their type from a string or leave it out, never from an expression or a spread", () => {
    const unreadable = INPUTS.filter((tag) => tag.type === null).map((tag) => `${tag.file}:${tag.line}`);
    expect(unreadable, "an <input> takes its type from an expression or a spread").toEqual([]);
  });

  it("include one number input, the one in NumberField", () => {
    const numbers = INPUTS.filter((tag) => tag.type === "number").map((tag) => `${tag.file}:${tag.line}`);
    expect(numbers).toHaveLength(1);
    expect(numbers[0], "a number input outside NumberField saves without the floor check").toMatch(
      /^settingsNumberField\.tsx:\d+$/,
    );
  });

  it("are read as a string type, a string in braces or no type, and an expression or spread as unreadable", () => {
    const typeIn = (jsx: string) => inputsIn("x.tsx", `const x = ${jsx};`).map((tag) => tag.type);
    expect(typeIn('<input onChange={(e) => save(e.target.value)} type="number" />')).toEqual(["number"]);
    expect(typeIn('<input type={"number"} />')).toEqual(["number"]);
    expect(typeIn("<input type={`number`} />")).toEqual(["number"]);
    expect(typeIn('<input type="text" onChange={(e) => save({ ...patch, k: e.target.value })} />')).toEqual([
      "text",
    ]);
    expect(typeIn("<input value={v} />")).toEqual(["(none)"]);
    expect(typeIn("<input type={kind} />")).toEqual([null]);
    expect(typeIn("<input {...props} />")).toEqual([null]);
    // A comment that mentions an input is not one.
    expect(typeIn('/* <input type="number" /> */ null')).toEqual([]);
  });
});
