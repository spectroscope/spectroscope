// Card 605: the credential rules of the files report are a twin of
// Redaction.java. The rule table, the reviewed vectors of RedactionTest.java
// and the size bands of Redaction.bucket are read here from the Java source, so
// a rule changed on one side turns this suite red.

import { describe, expect, it } from "vitest";
import { read } from "../testkit/source";
import { REDACTION_RULES, findCredentials, sizeBand } from "./secrets";

const GRAPH = "../../../spectro-core/src/main/java/dev/spectroscope/core/graph";
const SOURCE = stripJavaComments(read(`${GRAPH}/Redaction.java`, import.meta.url));
const TEST = stripJavaComments(
  read(`${GRAPH.replace("src/main", "src/test")}/RedactionTest.java`, import.meta.url),
);

/** Java source with every comment removed; string and char literals stay as they are. */
function stripJavaComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const JAVA_ESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  "'": "'",
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
};

/** The value of one Java string literal body (between the quotes). */
function unescapeJava(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
    if (e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    const v = JAVA_ESCAPES[e];
    if (v === undefined) throw new Error(`unsupported Java escape \\${e}`);
    return v;
  });
}

const LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;
const CONCAT = new RegExp(String.raw`^\s*${LITERAL}(?:\s*\+\s*${LITERAL})*\s*$`);

/** The value of an expression made only of string literals joined by `+`, or null for anything else. */
function literalValue(expr: string): string | null {
  if (!CONCAT.test(expr)) return null;
  return [...expr.matchAll(new RegExp(LITERAL, "g"))].map((m) => unescapeJava(m[0].slice(1, -1))).join("");
}

/** The text between the parenthesis at `open` and the one that closes it, string-aware. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`no closing parenthesis for the one at ${open}`);
}

/** Top-level comma-separated parts of an argument list, string- and paren-aware. */
function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < args.length && args[j] !== c) j += args[j] === "\\" ? 2 : 1;
      i = j;
    } else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(from, i));
      from = i + 1;
    }
  }
  const last = args.slice(from);
  if (last.trim() !== "") parts.push(last);
  return parts;
}

/** Every `new <ctor>(` call inside `src`, as its argument list. */
function calls(src: string, ctor: string): string[] {
  return [...src.matchAll(new RegExp(String.raw`\bnew ${ctor}\(`, "g"))].map((m) =>
    argsAt(src, (m.index ?? 0) + m[0].length - 1),
  );
}

/** The argument list of `<name> = List.of(...)`. */
function listOf(src: string, name: string): string {
  const m = new RegExp(String.raw`\b${name}\s*=\s*List\.of\(`).exec(src);
  if (m === null) throw new Error(`no ${name} = List.of( in the source`);
  return argsAt(src, m.index + m[0].length - 1);
}

interface JavaRule {
  name: string;
  source: string;
  ignoreCase: boolean;
}

/** The rules of Redaction.java in their order, `(?i)` lifted into a flag (B3). */
function javaRules(): JavaRule[] {
  return calls(listOf(SOURCE, "RULES"), "Rule").map((args) => {
    const [nameExpr, patternExpr] = splitArgs(args);
    const name = literalValue(nameExpr);
    const compile = /^\s*Pattern\.compile\(([\s\S]*)\)\s*$/.exec(patternExpr ?? "");
    const raw = compile === null ? null : literalValue(compile[1]);
    if (name === null || raw === null) throw new Error(`a Redaction.java rule is not a literal: ${args}`);
    const ignoreCase = raw.startsWith("(?i)");
    return { name, source: ignoreCase ? raw.slice(4) : raw, ignoreCase };
  });
}

/** Constructs Java reads differently from JavaScript, beyond the `(?i)` that B3 translates. */
function javaOnly(source: string): string | null {
  try {
    // Unicode mode rejects the escapes only Java knows (\A, \Z, \z, \Q, \E, \h, \R, \G),
    // possessive quantifiers and inline flags.
    new RegExp(source, "u");
  } catch (e) {
    return (e as Error).message;
  }
  if (/\\[pP]\{/.test(source)) return "a \\p{...} class, which Java and JavaScript define differently";
  if (source.includes("&&")) return "&& inside a class is an intersection in Java and two characters here";
  return null;
}

describe("the twin of Redaction.java", () => {
  it("the twin carries every Redaction.java rule in its order", () => {
    const java = javaRules();
    // Positive guard: the parser read every rule the list constructs, and at least the twelve of today.
    expect(java.length).toBe(calls(SOURCE, "Rule").length);
    expect(java.length).toBeGreaterThanOrEqual(12);
    expect(REDACTION_RULES.map((r) => r.name)).toEqual(java.map((r) => r.name));
    java.forEach((rule, i) => {
      const twin = REDACTION_RULES[i];
      expect(javaOnly(rule.source), rule.name).toBeNull();
      // The engine writes a source with `/` escaped; building the Java string through it
      // compares both in that one spelling.
      expect(twin.pattern.source, rule.name).toBe(new RegExp(rule.source).source);
      expect(twin.pattern.flags, rule.name).toBe(rule.ignoreCase ? "i" : "");
    });
  });

  it("every reviewed vector of RedactionTest fires its own rule", () => {
    const firstRule = (value: string) => REDACTION_RULES.find((r) => r.pattern.test(value))?.name ?? null;

    const rows = calls(listOf(TEST, "REVIEWED_CREDENTIALS"), "Row");
    let skipped = 0;
    const parsed: { value: string; rule: string }[] = [];
    for (const args of rows) {
      const [valueExpr, ruleExpr, ...rest] = splitArgs(args);
      const value = literalValue(valueExpr ?? "");
      const rule = literalValue(ruleExpr ?? "");
      if (value === null || rule === null || rest.length > 0) skipped++;
      else parsed.push({ value, rule });
    }
    // Positive guard against a parser that reads nothing.
    expect(parsed.length, `${skipped} rows could not be read statically`).toBeGreaterThanOrEqual(12);
    parsed.forEach(({ value, rule }, i) => {
      expect(firstRule(value), `reviewed row ${i + 1} (${rule})`).toBe(rule);
    });

    const misses = splitArgs(listOf(TEST, "NEAR_MISSES"))
      .map(literalValue)
      .filter((v): v is string => v !== null);
    expect(misses.length).toBeGreaterThanOrEqual(5);
    misses.forEach((value, i) => {
      expect(firstRule(value), `near miss ${i + 1}`).toBeNull();
      expect(findCredentials(value).hits, `near miss ${i + 1}`).toEqual([]);
    });
  });

  it("sizeBand keeps the bands of Redaction.bucket", () => {
    const body = /String bucket\(String value\)\s*\{([\s\S]*?)\n {4}\}/.exec(SOURCE)?.[1] ?? "";
    const steps = [...body.matchAll(/bytes <= (\d+)\)\s*\{\s*return "([^"]+)";/g)].map((m) => ({
      limit: Number(m[1]),
      band: m[2],
    }));
    const last = /return "([^"]+)";\s*$/.exec(body.trim())?.[1];
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(last).toBeDefined();
    steps.forEach(({ limit, band }, i) => {
      expect(sizeBand("a".repeat(limit)), `${limit} bytes`).toBe(band);
      expect(sizeBand("a".repeat(limit + 1)), `${limit + 1} bytes`).toBe(steps[i + 1]?.band ?? last);
    });
  });
});
