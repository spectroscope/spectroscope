// Card 504, hub and spoke review round 2: the web twin of PairSafeCutDriftTest.
// In state/ and in the two trace views (TraceView, LabTrace) a text cut at the
// head goes through pairSafeCut, so an emoji across the cap never leaves half
// a surrogate pair on the page.
//
// What is read: every call `x.slice(0, end)`, `x.substring(0, end)` and
// `x.substr(0, end)` whose receiver the type checker calls a string. Two ends
// may stay raw, because they cannot fall inside a pair: a position the code
// found in the text (a local set from indexOf, lastIndexOf, search or
// findIndex), and an end built only from `.length` reads (a known suffix taken
// off). Every other end is flagged, a constant, a number, a parameter and a
// computed `Math.min(...)` alike. Tail cuts (`slice(-n)`, `slice(len - n)`)
// are not read. The state files are listed from the folder, so a new one is
// checked without a list to update.

import ts from "typescript";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(SRC, "..");

const STATE_FILES = readdirSync(join(SRC, "state"))
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => join(SRC, "state", name));
const FILES = [...STATE_FILES, join(SRC, "components", "TraceView.tsx"), join(SRC, "lab", "LabTrace.tsx")];

const CUTS = new Set(["slice", "substring", "substr"]);
const FOUND = /\b(?:indexOf|lastIndexOf|search|findIndex)\(/;

/** An end made only of `.length` reads, with + and - and parentheses. */
function lengthsOnly(end: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(end)) return lengthsOnly(end.expression);
  if (ts.isPropertyAccessExpression(end)) return end.name.text === "length";
  if (ts.isPrefixUnaryExpression(end))
    return end.operator === ts.SyntaxKind.MinusToken && lengthsOnly(end.operand);
  if (ts.isBinaryExpression(end)) {
    const op = end.operatorToken.kind;
    return (
      (op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.PlusToken) &&
      lengthsOnly(end.left) &&
      lengthsOnly(end.right)
    );
  }
  return false;
}

/** A local whose declaration found the position in a text. */
function foundPosition(end: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(end)) return false;
  const declarations = checker.getSymbolAtLocation(end)?.declarations ?? [];
  return declarations.some(
    (d) => ts.isVariableDeclaration(d) && d.initializer !== undefined && FOUND.test(d.initializer.getText()),
  );
}

function isStringLike(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Any)) !== 0;
}

interface Scan {
  /** Raw head cuts of a text at an end that may fall inside a pair. */
  raw: string[];
  /** Calls of pairSafeCut seen. */
  safe: number;
  /** Raw head cuts let through as found positions or length arithmetic. */
  exempt: number;
}

function scan(files: string[], options: ts.CompilerOptions, base: string): Scan {
  const program = ts.createProgram(files, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const out: Scan = { raw: [], safe: 0, exempt: 0 };
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (sf === undefined) throw new Error(`not in the program: ${file}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && callee.text === "pairSafeCut") out.safe += 1;
        if (
          ts.isPropertyAccessExpression(callee) &&
          CUTS.has(callee.name.text) &&
          node.arguments.length === 2 &&
          node.arguments[0].getText(sf) === "0" &&
          isStringLike(checker.getTypeAtLocation(callee.expression))
        ) {
          const end = node.arguments[1];
          if (lengthsOnly(end) || foundPosition(end, checker)) {
            out.exempt += 1;
          } else {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            out.raw.push(`${relative(base, file)}:${line} ${node.getText(sf)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function appOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(WEB, "tsconfig.app.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  if (parsed === undefined) throw new Error("tsconfig.app.json did not parse");
  return parsed.options;
}

/** A throwaway file of sample code, scanned on its own. */
function sample(code: string): Scan {
  const dir = mkdtempSync(join(tmpdir(), "pair-safe-cut-"));
  const file = join(dir, "sample.ts");
  writeFileSync(file, code);
  return scan([file], { strict: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"] }, dir);
}

describe("a head cut of a text in state/ and the trace views keeps surrogate pairs whole", () => {
  it("flags no raw cut, and sees the pair-safe cuts and the exempt ones", () => {
    expect(STATE_FILES.length, "positive: the state folder is listed").toBeGreaterThan(50);
    const found = scan(FILES, appOptions(), SRC);
    expect(found.raw).toEqual([]);
    expect(found.safe, "positive: the cuts this card moved onto pairSafeCut").toBeGreaterThanOrEqual(21);
    expect(found.exempt, "positive: the found positions and suffix cuts are seen").toBeGreaterThanOrEqual(11);
  }, 60_000);

  it("flags each shape of a raw cut at an end that is not a found position", () => {
    const found = sample(
      [
        "declare function pairSafeCut(text: string, end: number): string;",
        "const CAP = 200;",
        "export const a = (s: string): string => s.slice(0, CAP);",
        "export const b = (s: string): string => s.slice(0, 200);",
        "export const c = (s: string): string => s.substring(0, CAP - 1);",
        "export const d = (s: string): string => s.slice(0, Math.min(s.length, CAP));",
        "export const e = (s: string, n: number): string => s.slice(0, n);",
        "export const f = (s: string): string => String(s).substr(0, 9);",
        "",
      ].join("\n"),
    );
    expect(found.raw.length, found.raw.join("\n")).toBe(6);
    expect(found.raw[0]).toContain("sample.ts:3");
  });

  it("lets through pairSafeCut, a found position, a suffix taken off and an array", () => {
    const found = sample(
      [
        "declare function pairSafeCut(text: string, end: number): string;",
        "const CAP = 200;",
        "const SUFFIX = '.events';",
        "export const a = (s: string): string => pairSafeCut(s, CAP);",
        "export function b(s: string): string { const at = s.indexOf('='); return s.slice(0, at); }",
        "export function c(s: string): string { const at = Math.max(s.lastIndexOf('/'), 0); return s.slice(0, at); }",
        "export const d = (s: string): string => s.slice(0, -SUFFIX.length);",
        "export const e = (s: string, t: string): string => s.slice(0, s.length - t.length);",
        "export const f = (xs: number[]): number[] => xs.slice(0, CAP);",
        "",
      ].join("\n"),
    );
    expect(found.raw).toEqual([]);
    expect(found.safe).toBe(1);
    expect(found.exempt, "positive: the four exempt string cuts are seen").toBe(4);
  });
});
