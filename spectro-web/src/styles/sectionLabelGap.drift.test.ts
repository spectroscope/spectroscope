// Card 407: a section heading may not overlap what it introduces.
//
// `.settings-label` carries a negative bottom margin, calc(8px - 24px), sized
// for a flex column with a 24px gap: the margin eats 16px of that gap and
// leaves 8px under the heading. The rule's comment names `.settings-body`; the
// settings page's headings sit one level down today, in `.settings-tabpanel`,
// which has the same 24px gap. The slash picker reused the class
// in `.wsg-pop.slash-pop`, whose gap is 8px, so the same margin pulled the
// first row 8px UP into the heading, and the focused row's background painted
// over the lower half of SKILLS (owner's screenshot, 2026-09-24). The
// description flyout beside it, `.wsg-pop.slash-tip`, had the same arithmetic.
// Card 224 met the same class in `.skset`, a block box with no gap at all.
//
// So this asks one question of every element in the tree that wears the
// class: is the space between the heading and the next box, the container's
// row gap plus the heading's own bottom margin, at least zero?
//
// HOW IT ANSWERS. There is no DOM in this suite (house rule) and no CSSOM in
// node, so both halves are read off disk and resolved here:
//
//   - The markup side walks the TypeScript syntax tree of every .tsx under
//     src/ from each heading up to the host elements above it. It sees through
//     fragments, conditionals and .map callbacks, follows a component to every
//     place it is mounted by tag, a local variable to where it is placed, a
//     hook's returned property to where the caller places it, and a wrapper
//     component to where it places its children.
//   - The stylesheet side parses the sheets main.tsx loads, in load order, and
//     resolves the four properties it needs (margin-bottom, row-gap, display,
//     flex-direction) with selector matching, specificity and source order,
//     then var() and calc() down to pixels. Every @media, @supports and
//     @container block that sets one of the four is tried on its own, on top
//     of the unconditional rules.
//
// Where it cannot decide, it says so instead of guessing: a rule whose
// selector might match (an id, an attribute, a pseudo-class, a sibling
// combinator, a class a conditional or a template literal might produce, an
// ancestor above where the walk stopped), a rule in a sheet whose place in the
// cascade it does not know, or a place in the markup it cannot follow. Each of
// those is a finding, and the suite is red on any of them. One exception: a
// rule that might set `display: none` on the container is skipped, because a
// hidden container draws no heading to overlap.
//
// What it does not read: rules outside src/ (the React Flow sheet), inline
// style attributes, a class added at run time through classList, and the next
// sibling's own top margin, which in a block container collapses with the
// heading's bottom margin.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { blankBlockComments } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";

const SRC = fileURLToPath(new URL("..", import.meta.url));

const FILES = srcFiles(SRC);

// ---- three-valued answers ----------------------------------------------------

/** No, maybe, yes. AND is Math.min and OR is Math.max over these. */
const NO = 0;
const MAYBE = 1;
const YES = 2;
type Tri = typeof NO | typeof MAYBE | typeof YES;

// ---- the stylesheet side -----------------------------------------------------

/** One declaration as a rule states it. */
interface Decl {
  value: string;
  important: boolean;
}

/** One selector of one style rule, and where it sits in the cascade. */
interface Rule {
  where: string;
  selector: string;
  /** The @media, @supports and @container preludes around it; "" when none. */
  condition: string;
  /** Load position; null for a sheet main.tsx does not load itself. */
  order: number | null;
  decls: Map<string, Decl>;
}

/** Splits `text` where `isSep` says, outside parentheses, brackets and quotes. */
function splitTop(text: string, isSep: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      cur += ch;
      if (ch === "\\") cur += text[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && isSep(ch)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** The declarations of one rule body, one entry per property, in the order
 *  of the declaration that counts. A repeated property moves to where it is
 *  set again, unless the earlier one is important and the repeat is not; then
 *  the earlier one stays where it was. */
function declsOf(body: string): Map<string, Decl> {
  const out = new Map<string, Decl>();
  for (const part of splitTop(body, (c) => c === ";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const raw = part.slice(0, colon).trim();
    const prop = raw.startsWith("--") ? raw : raw.toLowerCase();
    let value = part.slice(colon + 1).trim();
    const important = /!\s*important$/i.test(value);
    if (important) value = value.replace(/!\s*important$/i, "").trim();
    if (out.get(prop)?.important === true && !important) continue;
    out.delete(prop);
    out.set(prop, { value, important });
  }
  return out;
}

/** Blocks whose rules style an element only under a condition. */
const CONDITIONAL = /^@(media|supports|container)\b/;
/** Blocks whose inner rules style no element at all. */
const INERT = /^@(keyframes|font-face|property)\b/;

/**
 * Every style rule of one sheet, one entry per selector in a comma list.
 *
 * @throws Error on an at-rule this guard does not read (a layer would change
 *   the cascade) and on a nested rule
 */
function parseSheet(rel: string, css: string, order: number | null): Rule[] {
  const text = blankBlockComments(css);
  const out: Rule[] = [];
  const open: string[] = [];
  let start = 0;
  let seq = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ";") {
      start = i + 1;
      continue;
    }
    if (ch === "}") {
      if (open.pop() === undefined) throw new Error(`${rel}: a } at offset ${i} closes nothing`);
      start = i + 1;
      continue;
    }
    if (ch !== "{") continue;
    const prelude = text.slice(start, i).trim();
    if (prelude.startsWith("@")) {
      if (!CONDITIONAL.test(prelude) && !INERT.test(prelude)) {
        throw new Error(`${rel}: "${prelude}" is an at-rule this guard does not read`);
      }
      open.push(prelude);
      start = i + 1;
      continue;
    }
    const close = text.indexOf("}", i);
    const body = text.slice(i + 1, close);
    if (body.includes("{")) throw new Error(`${rel}: "${prelude}" nests a rule, which this guard does not read`);
    if (!open.some((p) => INERT.test(p))) {
      const lead = text.slice(start, i).length - text.slice(start, i).trimStart().length;
      const line = text.slice(0, start + lead).split("\n").length;
      const decls = declsOf(body);
      for (const selector of splitTop(prelude, (c) => c === ",")) {
        out.push({
          where: `${rel}:${line}`,
          selector,
          condition: open.join(" "),
          order: order === null ? null : order * 100000 + seq++,
          decls,
        });
      }
    }
    i = close;
    start = close + 1;
  }
  if (open.length > 0) throw new Error(`${rel}: ${open.join(", ")} is never closed`);
  return out;
}

/** The sheets main.tsx loads, in load order: an @import comes before the
 *  rules of the sheet that imports it. Paths are relative to src/. */
function loadOrder(): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const css = blankBlockComments(readFileSync(abs, "utf8"));
    for (const m of css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g)) {
      visit(resolve(dirname(abs), m[1]));
    }
    out.push(relative(SRC, abs));
  };
  const main = readFileSync(join(SRC, "main.tsx"), "utf8");
  for (const m of main.matchAll(/^import\s+["'](\.[^"']+\.css)["'];/gm)) visit(join(SRC, m[1]));
  return out;
}

const ORDER = loadOrder();
const RULES: Rule[] = FILES.filter((f) => f.endsWith(".css")).flatMap((f) => {
  const rel = relative(SRC, f);
  const at = ORDER.indexOf(rel);
  return parseSheet(rel, srcText(f), at < 0 ? null : at);
});

/** Whether a rule is the unconditional `:root` of a loaded sheet. */
const isRoot = (r: Rule): boolean => r.selector === ":root" && r.condition === "" && r.order !== null;

/** Per rule set: the custom properties `:root` declares, in load order, and
 *  every other place that sets one. Cached, because every declaration read
 *  goes through it. */
const VARS = new WeakMap<Rule[], { root: Map<string, string>; elsewhere: Map<string, string[]> }>();

function varsOf(rules: Rule[]): { root: Map<string, string>; elsewhere: Map<string, string[]> } {
  const hit = VARS.get(rules);
  if (hit !== undefined) return hit;
  const root = new Map<string, string>();
  const elsewhere = new Map<string, string[]>();
  const roots = rules.filter(isRoot).sort((a, b) => (a.order as number) - (b.order as number));
  for (const r of roots) for (const [k, d] of r.decls) if (k.startsWith("--")) root.set(k, d.value);
  for (const r of rules) {
    if (isRoot(r)) continue;
    for (const k of r.decls.keys()) if (k.startsWith("--")) elsewhere.set(k, [...(elsewhere.get(k) ?? []), r.where]);
  }
  const out = { root, elsewhere };
  VARS.set(rules, out);
  return out;
}

/** Replaces every var() with its :root value, recursively.
 *  @throws Error when a name has no :root value, or has another value
 *    somewhere else in the tree, which a :root lookup would miss */
function substitute(value: string, rules: Rule[], where: string, depth = 0): string {
  if (depth > 10) throw new Error(`${where}: var() nests deeper than ten`);
  const { root, elsewhere } = varsOf(rules);
  const out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name: string, fallback?: string) => {
    const other = elsewhere.get(name);
    if (other !== undefined) throw new Error(`${where}: ${name} is also set at ${other.join(", ")}`);
    const v = root.get(name) ?? fallback;
    if (v === undefined) throw new Error(`${where}: ${name} has no :root value`);
    return substitute(v, rules, where, depth + 1);
  });
  if (out.includes("var(")) throw new Error(`${where}: cannot resolve "${value}"`);
  return out;
}

/** A length in pixels: `0`, `Npx`, or calc() over those with + - * /.
 *  @throws Error on any other unit or form */
function px(value: string, where: string): number {
  const toks = value.match(/-?\d*\.?\d+(?:px)?|calc|[()+\-*/]|\S+/g) ?? [];
  let at = 0;
  const fail = (): never => {
    throw new Error(`${where}: "${value}" is not a pixel length this guard reads`);
  };
  type Q = { n: number; dim: 0 | 1 };
  const factor = (): Q => {
    const t = toks[at++];
    if (t === undefined) return fail();
    if (t === "calc") {
      if (toks[at++] !== "(") fail();
      const q = expr();
      if (toks[at++] !== ")") fail();
      return q;
    }
    if (t === "(") {
      const q = expr();
      if (toks[at++] !== ")") fail();
      return q;
    }
    const m = /^(-?\d*\.?\d+)(px)?$/.exec(t);
    if (m === null) return fail();
    return { n: Number(m[1]), dim: m[2] === "px" ? 1 : 0 };
  };
  const term = (): Q => {
    let q = factor();
    while (toks[at] === "*" || toks[at] === "/") {
      const op = toks[at++];
      const r = factor();
      if (op === "*") q = { n: q.n * r.n, dim: (q.dim + r.dim) as 0 | 1 };
      else if (r.dim === 0) q = { n: q.n / r.n, dim: q.dim };
      else fail();
      if (q.dim > 1) fail();
    }
    return q;
  };
  const expr = (): Q => {
    let q = term();
    while (toks[at] === "+" || toks[at] === "-") {
      const op = toks[at++];
      const r = term();
      if (q.dim !== r.dim && q.n !== 0 && r.n !== 0) fail();
      const dim = (q.n === 0 && q.dim === 0 ? r.dim : q.dim) as 0 | 1;
      q = { n: op === "+" ? q.n + r.n : q.n - r.n, dim };
    }
    return q;
  };
  const q = expr();
  if (at !== toks.length) fail();
  if (q.dim === 0 && q.n !== 0) fail();
  return q.n;
}

/** The four properties this guard resolves. */
type Prop = "margin-bottom" | "row-gap" | "display" | "flex-direction";

/** The declarations that can set each one, shorthands included. */
const SETTERS: Record<Prop, string[]> = {
  "margin-bottom": ["margin", "margin-block", "margin-block-end", "margin-bottom"],
  "row-gap": ["grid-gap", "gap", "grid-row-gap", "row-gap"],
  display: ["display"],
  "flex-direction": ["flex-flow", "flex-direction"],
};

/** What `rule` declares for `prop`, shorthands expanded, var() resolved.
 *  @return the value and whether it is important, or undefined */
function declared(rule: Rule, prop: Prop, rules: Rule[]): Decl | undefined {
  const d = rule.decls;
  const pick = (name: string, index: (parts: string[]) => string | undefined): Decl | undefined => {
    const hit = d.get(name);
    if (hit === undefined) return undefined;
    const parts = splitTop(substitute(hit.value, rules, rule.where), (c) => /\s/.test(c));
    const v = index(parts);
    if (v === undefined) throw new Error(`${rule.where}: cannot read ${name}: ${hit.value}`);
    return { value: v, important: hit.important };
  };
  // Within one rule an important declaration beats a normal one, and between
  // two of the same importance the later wins. declsOf keeps each property at
  // the place of the declaration that counts, so the answer is the last
  // important candidate present, or else the last candidate present.
  const last = (cands: [string, () => Decl | undefined][]): Decl | undefined => {
    let normal: Decl | undefined;
    let important: Decl | undefined;
    for (const key of d.keys()) {
      const hit = cands.find(([name]) => name === key)?.[1]();
      if (hit?.important === true) important = hit;
      else if (hit !== undefined) normal = hit;
    }
    return important ?? normal;
  };
  if (prop === "margin-bottom") {
    return last([
      ["margin", () => pick("margin", (p) => [p[0], p[0], p[2], p[2]][p.length - 1])],
      ["margin-block", () => pick("margin-block", (p) => p[p.length - 1])],
      ["margin-block-end", () => pick("margin-block-end", (p) => p[0])],
      ["margin-bottom", () => pick("margin-bottom", (p) => p[0])],
    ]);
  }
  if (prop === "row-gap") {
    return last([
      ["grid-gap", () => pick("grid-gap", (p) => p[0])],
      ["gap", () => pick("gap", (p) => p[0])],
      ["grid-row-gap", () => pick("grid-row-gap", (p) => p[0])],
      ["row-gap", () => pick("row-gap", (p) => p[0])],
    ]);
  }
  if (prop === "flex-direction") {
    return last([
      ["flex-flow", () => pick("flex-flow", (p) => p.find((x) => /^(row|column)(-reverse)?$/.test(x)) ?? "row")],
      ["flex-direction", () => pick("flex-direction", (p) => p[0])],
    ]);
  }
  return last([["display", () => pick("display", (p) => p.join(" "))]]);
}

// ---- selectors ---------------------------------------------------------------

/** One compound selector: `div.a.b:hover`. */
interface Compound {
  tag: string | null;
  classes: string[];
  ids: string[];
  /** Attributes and pseudo-classes: nothing here models them. */
  opaque: string[];
  /** A pseudo-element styles a box of its own, never the element. */
  pseudoElement: boolean;
}

/** A compound and the combinator that joins it to the compound on its left. */
interface Part {
  compound: Compound;
  combinator: " " | ">" | "+" | "~" | null;
}

/** @throws Error on a compound this parser cannot take apart */
function compoundOf(text: string, selector: string): Compound {
  const c: Compound = { tag: null, classes: [], ids: [], opaque: [], pseudoElement: false };
  let rest = text;
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(rest);
  if (tag !== null) {
    c.tag = tag[1].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest !== "") {
    const m = /^(\.[\w-]+|#[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?)/.exec(rest);
    if (m === null) throw new Error(`cannot read "${text}" in "${selector}"`);
    const t = m[1];
    if (t.startsWith(".")) c.classes.push(t.slice(1));
    else if (t.startsWith("#")) c.ids.push(t.slice(1));
    else if (t.startsWith("::")) c.pseudoElement = true;
    else c.opaque.push(t);
    rest = rest.slice(t.length);
  }
  return c;
}

/** @return the compounds of `selector`, left to right */
function partsOf(selector: string): Part[] {
  const out: Part[] = [];
  let cur = "";
  let depth = 0;
  let pending: Part["combinator"] = null;
  const flush = (): void => {
    if (cur === "") return;
    out.push({ compound: compoundOf(cur, selector), combinator: out.length === 0 ? null : (pending ?? " ") });
    cur = "";
    pending = null;
  };
  for (const ch of selector.trim()) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && /\s/.test(ch)) {
      flush();
      continue;
    } else if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) {
      flush();
      pending = ch;
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

/** (ids, classes + attributes + pseudo-classes, types + pseudo-elements). */
function specificity(parts: Part[]): number {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const { compound } of parts) {
    a += compound.ids.length;
    b += compound.classes.length + compound.opaque.length;
    c += (compound.tag !== null && compound.tag !== "*" ? 1 : 0) + (compound.pseudoElement ? 1 : 0);
  }
  return a * 10000 + b * 100 + c;
}

// ---- elements and matching ---------------------------------------------------

/** A class a template literal can produce: a fixed start or end around a
 *  substitution. A substitution with space on both sides is ("", ""), which
 *  could be any class. */
interface Pattern {
  prefix: string;
  suffix: string;
}

/** One host element, as the markup states it. */
interface El {
  tag: string;
  classes: Set<string>;
  /** Classes a conditional may or may not add. */
  maybe: Set<string>;
  patterns: Pattern[];
  /** The id, "?" when it is computed, null when there is none. */
  id: string | null;
  where: string;
}

/** An element and its host ancestors, nearest first. */
interface Chain {
  els: El[];
  /** Why the walk stopped before the document root; null when it did not. */
  open: string | null;
}

/** @return whether `el` may carry `cls` */
function hasClass(el: El, cls: string): Tri {
  if (el.classes.has(cls)) return YES;
  if (el.maybe.has(cls)) return MAYBE;
  const fits = el.patterns.some(
    (p) => cls.length > p.prefix.length + p.suffix.length && cls.startsWith(p.prefix) && cls.endsWith(p.suffix),
  );
  return fits ? MAYBE : NO;
}

function matchCompound(c: Compound, el: El): Tri {
  if (c.pseudoElement) return NO;
  if (c.tag !== null && c.tag !== "*" && c.tag !== el.tag) return NO;
  let r: Tri = YES;
  for (const cls of c.classes) {
    r = Math.min(r, hasClass(el, cls)) as Tri;
    if (r === NO) return NO;
  }
  for (const id of c.ids) {
    if (el.id === null || (el.id !== "?" && el.id !== id)) return NO;
    if (el.id === "?") r = Math.min(r, MAYBE) as Tri;
  }
  if (c.opaque.length > 0) r = Math.min(r, MAYBE) as Tri;
  return r;
}

/** Whether parts[0..k] match with parts[k] standing on chain.els[i]. */
function matchAt(parts: Part[], k: number, chain: Chain, i: number): Tri {
  const el = chain.els[i];
  if (el === undefined) return chain.open === null ? NO : MAYBE;
  const here = matchCompound(parts[k].compound, el);
  if (here === NO || k === 0) return here;
  const comb = parts[k].combinator;
  if (comb === ">") return Math.min(here, matchAt(parts, k - 1, chain, i + 1)) as Tri;
  if (comb === " ") {
    let best: Tri = NO;
    for (let j = i + 1; j <= chain.els.length && best !== YES; j++) {
      best = Math.max(best, matchAt(parts, k - 1, chain, j)) as Tri;
    }
    return Math.min(here, best) as Tri;
  }
  // Siblings are not modelled.
  return Math.min(here, MAYBE) as Tri;
}

const PARTS = new Map<string, Part[]>();

/** partsOf, cached: the same few hundred selectors are matched many times. */
function partsCached(selector: string): Part[] {
  let parts = PARTS.get(selector);
  if (parts === undefined) {
    parts = partsOf(selector);
    PARTS.set(selector, parts);
  }
  return parts;
}

function matches(selector: string, chain: Chain): Tri {
  const parts = partsCached(selector);
  return matchAt(parts, parts.length - 1, chain, 0);
}

/** How an element names itself in a finding. */
function describeEl(el: El): string {
  const cls = [...el.classes].map((c) => `.${c}`).join("");
  return `${el.tag}${cls} (${el.where})`;
}

/**
 * The value of `prop` on chain.els[0], or null for the initial value.
 *
 * @param condition the one conditional block taken to apply, "" for none
 * @param problems  where an undecidable rule is reported
 */
function computed(prop: Prop, chain: Chain, condition: string, rules: Rule[], problems: string[]): Decl | null {
  let best: { decl: Decl; rank: [number, number, number] } | null = null;
  for (const rule of rules) {
    if (rule.condition !== "" && rule.condition !== condition) continue;
    if (!SETTERS[prop].some((k) => rule.decls.has(k))) continue;
    const hit = matches(rule.selector, chain);
    if (hit === NO) continue;
    const decl = declared(rule, prop, rules);
    if (decl === undefined) continue;
    if (hit === MAYBE) {
      // A rule that might hide the box cannot make a heading overlap anything:
      // hidden, nothing is drawn; shown, the other rules decide.
      if (prop === "display" && decl.value === "none") continue;
      problems.push(
        `${rule.where} "${rule.selector}" may set ${prop} on ${describeEl(chain.els[0])}` +
          (chain.open === null ? "" : `, whose ancestry stops: ${chain.open}`),
      );
      continue;
    }
    if (rule.order === null) {
      problems.push(`${rule.where} "${rule.selector}" sets ${prop} from a sheet main.tsx does not load itself`);
      continue;
    }
    const rank: [number, number, number] = [decl.important ? 1 : 0, specificity(partsCached(rule.selector)), rule.order];
    const wins =
      best === null ||
      rank[0] > best.rank[0] ||
      (rank[0] === best.rank[0] && (rank[1] > best.rank[1] || (rank[1] === best.rank[1] && rank[2] > best.rank[2])));
    if (wins) best = { decl, rank };
  }
  return best === null ? null : best.decl;
}

/** The browser's default display for the container tags this guard knows;
 *  a heading in any other tag is a finding. */
const UA_DISPLAY: Record<string, string> = {
  div: "block",
  section: "block",
  aside: "block",
  article: "block",
  main: "block",
  header: "block",
  footer: "block",
  nav: "block",
  form: "block",
  fieldset: "block",
  details: "block",
  dialog: "block",
  ul: "block",
  ol: "block",
  li: "list-item",
};

/** One heading in one place it is drawn, under one condition. */
interface Verdict {
  site: string;
  container: string;
  condition: string;
  gap: number;
  margin: number;
}

/** The space under the heading at the head of `chain`, under `condition`. */
function verdictOf(chain: Chain, condition: string, rules: Rule[], problems: string[]): Verdict | null {
  const label = chain.els[0];
  const holder: Chain = { els: chain.els.slice(1), open: chain.open };
  const box = holder.els[0];
  if (box === undefined) {
    problems.push(`${label.where}: no host element above it (${chain.open ?? "top of the tree"})`);
    return null;
  }
  const display = computed("display", holder, condition, rules, problems)?.value ?? UA_DISPLAY[box.tag];
  if (display === undefined) {
    problems.push(`${label.where}: this guard does not know how <${box.tag}> displays`);
    return null;
  }
  let gap = 0;
  if (display === "flex" || display === "inline-flex") {
    const dir = computed("flex-direction", holder, condition, rules, problems)?.value ?? "row";
    if (!dir.startsWith("column")) {
      problems.push(`${label.where}: ${describeEl(box)} is a ${dir} flex box, so the heading sits beside`);
      return null;
    }
    const g = computed("row-gap", holder, condition, rules, problems);
    gap = g === null || g.value === "normal" ? 0 : px(g.value, box.where);
  } else if (display.includes("grid") || display === "contents") {
    problems.push(`${label.where}: ${describeEl(box)} is display ${display}, which this guard does not read`);
    return null;
  }
  const m = computed("margin-bottom", chain, condition, rules, problems);
  const margin = m === null ? 0 : px(m.value, label.where);
  return { site: label.where, container: describeEl(box), condition, gap, margin };
}

// ---- the markup side ---------------------------------------------------------

/** A parsed source file and its path relative to src/. */
interface Source {
  rel: string;
  sf: ts.SourceFile;
}

const SOURCES: Source[] = FILES.filter((f) => f.endsWith(".tsx") && !f.includes(".test.")).map((f) => ({
  rel: relative(SRC, f),
  sf: ts.createSourceFile(f, srcText(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
}));

/** Every node of a file, depth first. */
function nodesOf(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    all.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return all;
}

const NODES = new Map<ts.SourceFile, ts.Node[]>(SOURCES.map((s) => [s.sf, nodesOf(s.sf)]));

/** Every JSX element in the tree by its tag, and every call by its callee. */
const BY_TAG = new Map<string, (ts.JsxElement | ts.JsxSelfClosingElement)[]>();
const BY_CALLEE = new Map<string, ts.CallExpression[]>();
/** Every named function and arrow in the tree by the name it is known by. */
const BY_NAME = new Map<string, ts.FunctionLikeDeclaration[]>();
for (const nodes of NODES.values()) {
  for (const x of nodes) {
    if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) {
      const tag = tagText(x);
      BY_TAG.set(tag, [...(BY_TAG.get(tag) ?? []), x]);
    } else if (ts.isCallExpression(x)) {
      const callee = x.expression.getText();
      BY_CALLEE.set(callee, [...(BY_CALLEE.get(callee) ?? []), x]);
    } else if (ts.isFunctionDeclaration(x) || ts.isArrowFunction(x)) {
      const name = functionName(x);
      if (name !== undefined) BY_NAME.set(name, [...(BY_NAME.get(name) ?? []), x]);
    }
  }
}
const REL = new Map<ts.SourceFile, string>(SOURCES.map((s) => [s.sf, s.rel]));

function whereOf(node: ts.Node): string {
  const sf = node.getSourceFile();
  return `${REL.get(sf) ?? sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
type Tagged = ts.JsxElement | ts.JsxSelfClosingElement;

function openingOf(node: Tagged): Opening {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function tagText(node: Tagged): string {
  return openingOf(node).tagName.getText();
}

const isHost = (tag: string): boolean => /^[a-z]/.test(tag) && !tag.includes(".");
/** React's own components that draw no box around their children, and
 *  ChunkBoundary (card 430), a class this walk cannot read: it places its
 *  children in a Suspense, or draws a notice instead of them. */
const TRANSPARENT = new Set([
  "Fragment",
  "React.Fragment",
  "StrictMode",
  "React.StrictMode",
  "Suspense",
  "ChunkBoundary",
]);

/** Every string an expression can evaluate to, when it is built from string
 *  literals, templates and conditionals alone; null when it reads anything
 *  else. Capped, so a long chain of conditionals falls back to patterns. */
function variantsOf(expr: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isParenthesizedExpression(expr)) return variantsOf(expr.expression);
  if (ts.isConditionalExpression(expr)) {
    const a = variantsOf(expr.whenTrue);
    const b = variantsOf(expr.whenFalse);
    return a === null || b === null ? null : [...a, ...b];
  }
  if (ts.isTemplateExpression(expr)) {
    let out = [expr.head.text];
    for (const span of expr.templateSpans) {
      const sub = variantsOf(span.expression);
      if (sub === null) return null;
      out = out.flatMap((head) => sub.map((v) => head + v + span.literal.text));
      if (out.length > 64) return null;
    }
    return out;
  }
  return null;
}

/** Reads a className expression into `el`. */
function readClass(expr: ts.Expression | undefined, el: El): void {
  if (expr === undefined) return;
  const words = (s: string): string[] => s.split(/\s+/).filter((w) => w !== "");
  const variants = variantsOf(expr);
  if (variants !== null) {
    // In every variant: certain. In some: maybe.
    const sets = variants.map((v) => new Set(words(v)));
    for (const w of sets[0]) if (sets.every((set) => set.has(w))) el.classes.add(w);
    for (const set of sets) for (const w of set) if (!el.classes.has(w)) el.maybe.add(w);
    return;
  }
  if (ts.isTemplateExpression(expr)) {
    // A substitution this cannot enumerate. A word with no space between it
    // and the substitution is part of the class the substitution completes;
    // every other word is a class as is.
    const texts = [expr.head.text, ...expr.templateSpans.map((span) => span.literal.text)];
    const w = texts.map(words);
    const endGlued = texts.map((t, k) => k < texts.length - 1 && t !== "" && !/\s$/.test(t));
    const startGlued = texts.map((t, k) => k > 0 && t !== "" && !/^\s/.test(t));
    texts.forEach((_t, k) => {
      const from = startGlued[k] ? 1 : 0;
      const to = endGlued[k] ? w[k].length - 1 : w[k].length;
      for (const x of w[k].slice(from, Math.max(from, to))) el.classes.add(x);
    });
    for (let k = 0; k < texts.length - 1; k++) {
      // A word glued to a substitution on both sides has an unknown start or
      // end of its own, so it narrows nothing.
      const both = (j: number): boolean => startGlued[j] && endGlued[j] && w[j].length === 1;
      const prefix = endGlued[k] && !both(k) ? (w[k].at(-1) ?? "") : "";
      const suffix = startGlued[k + 1] && !both(k + 1) ? (w[k + 1][0] ?? "") : "";
      el.patterns.push({ prefix, suffix });
    }
    return;
  }
  // Anything else (a call, a variable, a join) could produce any class.
  el.patterns.push({ prefix: "", suffix: "" });
}

function hostEl(node: Tagged): El {
  const el: El = {
    tag: tagText(node),
    classes: new Set(),
    maybe: new Set(),
    patterns: [],
    id: null,
    where: whereOf(node),
  };
  for (const a of openingOf(node).attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      el.patterns.push({ prefix: "", suffix: "" });
      el.id = "?";
      continue;
    }
    const name = a.name.getText();
    const init = a.initializer;
    const expr = init === undefined ? undefined : ts.isJsxExpression(init) ? init.expression : init;
    if (name === "className") readClass(expr, el);
    if (name === "id") el.id = expr !== undefined && ts.isStringLiteral(expr) ? expr.text : "?";
  }
  return el;
}

/** The function a node sits in, or undefined at module level. */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n !== undefined && !ts.isSourceFile(n)) {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) {
      return n;
    }
    n = n.parent;
  }
  return undefined;
}

/** The name a function is known by: its own, or the variable it is bound to. */
function functionName(fn: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return fn.name.text;
  const p = fn.parent;
  if (p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

/** Whether `id` reads the variable, rather than naming a property. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isJsxAttribute(p)) return false;
  if (ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isImportSpecifier(p)) return false;
  return true;
}

/** Glues each inner host list onto each outer chain. */
function across(inner: El[][], outer: Chain[]): Chain[] {
  return inner.flatMap((els) => outer.map((o) => ({ els: [...els, ...o.els], open: o.open })));
}

/** Guards the walk against a component that renders itself. */
const MAX_DEPTH = 30;

/**
 * The host elements above `node`, one chain per way the tree can reach it.
 * An empty result means the value is never placed in the markup.
 *
 * @param stop a function to stop at instead of leaving it: the hosts above the
 *   node inside it are returned as one chain with open === STOPPED
 */
function above(node: ts.Node, depth: number, stop?: ts.FunctionLikeDeclaration): Chain[] {
  if (depth > MAX_DEPTH) return [{ els: [], open: `${whereOf(node)}: deeper than ${MAX_DEPTH} hops` }];
  let child: ts.Node = node;
  let n: ts.Node | undefined = node.parent;
  while (n !== undefined) {
    if (ts.isJsxElement(n) && child !== n.openingElement && child !== n.closingElement) {
      const tag = tagText(n);
      if (isHost(tag)) return prepend(hostEl(n), above(n, depth, stop));
      if (!TRANSPARENT.has(tag)) return viaWrapper(n, tag, depth, stop);
    } else if (ts.isJsxAttribute(n)) {
      return [{ els: [], open: `${whereOf(n)}: handed over as the prop ${n.name.getText()}` }];
    } else if (ts.isVariableDeclaration(n) && child === n.initializer) {
      return viaVariable(n, depth, stop);
    } else if (ts.isShorthandPropertyAssignment(n) || (ts.isPropertyAssignment(n) && child === n.initializer)) {
      return viaProperty(n, depth);
    } else if (ts.isReturnStatement(n) || ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && child === n.body)) {
      const fn = ts.isReturnStatement(n) ? enclosingFunction(n) : n;
      if (fn === undefined) return [{ els: [], open: `${whereOf(n)}: a return outside any function` }];
      if (fn === stop) return [{ els: [], open: STOPPED }];
      // A render callback (`.map((x) => <li/>)`) or a function called where it
      // stands (`{(() => ...)()}`): its result lands where the call stands, so
      // the walk goes on from there.
      const call = callOf(fn);
      if (call !== undefined) {
        child = call;
        n = call.parent;
        continue;
      }
      return viaMounts(fn, depth);
    } else if (ts.isCallExpression(n) && n.arguments.some((a) => a === child)) {
      const callee = n.expression.getText();
      if (/^createRoot\(document\.getElementById\("root"\)!?\)\.render$/.test(callee)) return [DOCUMENT_ROOT];
      return [{ els: [], open: `${whereOf(n)}: handed to ${callee}()` }];
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && child === n.right) {
      return [{ els: [], open: `${whereOf(n)}: assigned to ${n.left.getText()}` }];
    } else if (ts.isStatement(n) || ts.isSourceFile(n)) {
      // Read in a condition or a statement, not placed in the markup.
      return [];
    }
    child = n;
    n = n.parent;
  }
  return [];
}

/** The call that runs `fn` right where it is written: as an argument, or as
 *  the callee of an immediately invoked function. */
function callOf(fn: ts.FunctionLikeDeclaration): ts.CallExpression | undefined {
  let n: ts.Node = fn;
  while (n.parent !== undefined && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (p === undefined || !ts.isCallExpression(p)) return undefined;
  return p.expression === n || p.arguments.some((a) => a === n) ? p : undefined;
}

/** Marks a chain that ended at the function the walk was told to stop at. */
const STOPPED = "\u0000stopped";

/** What index.html puts above the element main.tsx renders into. */
const DOCUMENT_ROOT: Chain = {
  els: [
    { tag: "div", classes: new Set(), maybe: new Set(), patterns: [], id: "root", where: "index.html" },
    { tag: "body", classes: new Set(), maybe: new Set(), patterns: [], id: null, where: "index.html" },
    { tag: "html", classes: new Set(), maybe: new Set(), patterns: [], id: null, where: "index.html" },
  ],
  open: null,
};

function prepend(el: El, chains: Chain[]): Chain[] {
  return chains.map((c) => ({ els: [el, ...c.els], open: c.open }));
}

/** A value bound to a local variable lands wherever the variable is read. */
function viaVariable(decl: ts.VariableDeclaration, depth: number, stop?: ts.FunctionLikeDeclaration): Chain[] {
  if (!ts.isIdentifier(decl.name)) return [{ els: [], open: `${whereOf(decl)}: destructured` }];
  const name = decl.name.text;
  const scope = enclosingFunction(decl) ?? decl.getSourceFile();
  const refs = nodesOf(scope).filter((x): x is ts.Identifier => ts.isIdentifier(x) && x.text === name && isReference(x));
  return refs.flatMap((ref) => above(ref, depth + 1, stop));
}

/** A property of a returned object lands wherever a caller reads it. */
function viaProperty(prop: ts.ShorthandPropertyAssignment | ts.PropertyAssignment, depth: number): Chain[] {
  const key = prop.name.getText();
  let n: ts.Node = prop.parent;
  while (ts.isObjectLiteralExpression(n) || ts.isParenthesizedExpression(n)) n = n.parent;
  if (!ts.isReturnStatement(n)) return [{ els: [], open: `${whereOf(prop)}: an object that is not returned` }];
  const fn = enclosingFunction(n);
  const name = fn === undefined ? undefined : functionName(fn);
  if (name === undefined) return [{ els: [], open: `${whereOf(prop)}: returned from an unnamed function` }];
  const out: Chain[] = [];
  for (const call of BY_CALLEE.get(name) ?? []) {
    const bind = call.parent;
    const scope = enclosingFunction(bind) ?? call.getSourceFile();
    if (ts.isVariableDeclaration(bind) && ts.isIdentifier(bind.name)) {
      // const picker = useThing(); ... {picker.node}
      const holder = bind.name.text;
      for (const ref of nodesOf(scope)) {
        if (
          ts.isPropertyAccessExpression(ref) &&
          ts.isIdentifier(ref.expression) &&
          ref.expression.text === holder &&
          ref.name.text === key
        ) {
          out.push(...above(ref, depth + 1));
        }
      }
    } else if (ts.isVariableDeclaration(bind) && ts.isObjectBindingPattern(bind.name)) {
      // const { node } = useThing(); ... {node}
      for (const b of bind.name.elements) {
        if ((b.propertyName ?? b.name).getText() !== key) continue;
        if (!ts.isIdentifier(b.name)) {
          out.push({ els: [], open: `${whereOf(b)}: ${key} is destructured further` });
          continue;
        }
        const local = b.name.text;
        for (const ref of nodesOf(scope)) {
          if (ts.isIdentifier(ref) && ref.text === local && isReference(ref)) out.push(...above(ref, depth + 1));
        }
      }
    } else {
      out.push({ els: [], open: `${whereOf(call)}: what ${name}() returns is not bound to a name` });
    }
  }
  return out;
}

/** A component's markup lands wherever it is mounted by tag. */
function viaMounts(fn: ts.FunctionLikeDeclaration, depth: number): Chain[] {
  const name = functionName(fn);
  if (name === undefined) return [{ els: [], open: `${whereOf(fn)}: an unnamed component` }];
  const mounts: Tagged[] = BY_TAG.get(name) ?? [];
  if (mounts.length === 0) return [{ els: [], open: `${whereOf(fn)}: ${name} is mounted nowhere by tag` }];
  return mounts.flatMap((m) => above(m, depth + 1));
}

/** Children of a wrapper component land where the wrapper places them. */
function viaWrapper(wrapper: ts.JsxElement, tag: string, depth: number, stop?: ts.FunctionLikeDeclaration): Chain[] {
  const defs = BY_NAME.get(tag) ?? [];
  if (defs.length !== 1) {
    return [{ els: [], open: `${whereOf(wrapper)}: inside <${tag}>, defined ${defs.length} times in src/` }];
  }
  const fn = defs[0];
  const slots = nodesOf(fn).filter(
    (x) => ts.isJsxExpression(x) && x.expression !== undefined && /^(props\.)?children$/.test(x.expression.getText()),
  );
  if (slots.length === 0) return [{ els: [], open: `${whereOf(fn)}: <${tag}> places no {children}` }];
  const inner: El[][] = [];
  for (const slot of slots) {
    for (const c of above(slot, depth + 1, fn)) {
      if (c.open !== STOPPED) return [{ els: [], open: `${whereOf(slot)}: <${tag}>'s children leave it` }];
      inner.push(c.els);
    }
  }
  return across(inner, above(wrapper, depth + 1, stop));
}

/** Every element in the markup that wears `.settings-label`. */
function labelSites(): { el: El; node: Tagged }[] {
  const out: { el: El; node: Tagged }[] = [];
  for (const nodes of NODES.values()) {
    for (const x of nodes) {
      if (!(ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) || !isHost(tagText(x))) continue;
      const el = hostEl(x);
      if (el.classes.has("settings-label") || el.maybe.has("settings-label")) out.push({ el, node: x });
    }
  }
  return out;
}

// ---- the answers -------------------------------------------------------------

/** Every conditional block that sets one of the four properties. */
const CONDITIONS = [
  ...new Set(
    RULES.filter(
      (r) =>
        r.condition !== "" &&
        Object.values(SETTERS).some((keys) => keys.some((k) => r.decls.has(k))),
    ).map((r) => r.condition),
  ),
];

interface Survey {
  sites: string[];
  verdicts: Verdict[];
  problems: string[];
}

/** Every heading, every place it is drawn, every condition. */
function survey(rules: Rule[]): Survey {
  const problems: string[] = [];
  const verdicts: Verdict[] = [];
  const sites: string[] = [];
  for (const { el, node } of labelSites()) {
    sites.push(el.where);
    const chains = prepend(el, above(node, 0));
    if (chains.length === 0) problems.push(`${el.where}: never placed in the markup`);
    for (const chain of chains) {
      const base = verdictOf(chain, "", rules, problems);
      if (base !== null) verdicts.push(base);
      // A condition is its own verdict only where it changes the numbers.
      for (const condition of CONDITIONS) {
        const v = verdictOf(chain, condition, rules, problems);
        if (v !== null && (base === null || v.gap !== base.gap || v.margin !== base.margin)) verdicts.push(v);
      }
    }
  }
  return { sites, verdicts, problems: [...new Set(problems)] };
}

/** A verdict as one line; the condition only when it changes the answer. */
function line(v: Verdict): string {
  const when = v.condition === "" ? "" : ` under ${v.condition}`;
  return `${v.site} in ${v.container}${when}: gap ${v.gap} + margin-bottom ${v.margin} = ${v.gap + v.margin}`;
}

/** The distinct negative answers. */
function overlaps(s: Survey): string[] {
  return [...new Set(s.verdicts.filter((v) => v.gap + v.margin < 0).map(line))].sort();
}

const SURVEY = survey(RULES);

/** The verdicts for the heading at `site`, whatever the condition. */
function at(site: string): Verdict[] {
  return SURVEY.verdicts.filter((v) => v.site === site);
}

/**
 * The site of the slash picker heading whose line carries `key` (card 471,
 * round three). The picker grew twice in one day and both times the pinned
 * line number went stale; the heading is found by what it says instead.
 */
function slashHeading(key: string): string {
  const lines = srcText(join(SRC, "components/SlashPicker.tsx")).split("\n");
  const index = lines.findIndex((l) => l.includes(`className="settings-label">`) && l.includes(`"${key}"`));
  if (index < 0) throw new Error(`no settings-label heading for ${key} in SlashPicker.tsx`);
  return `components/SlashPicker.tsx:${index + 1}`;
}
const SKILLS_HEADING = slashHeading("slash.title");
const COMMANDS_HEADING = slashHeading("slash.commands");

describe("the slash picker's two headings (criteria 1 and 2)", () => {
  it("SKILLS sits 8px above the first row in .wsg-pop.slash-pop", () => {
    const vs = at(SKILLS_HEADING);
    expect(vs.length, "the heading is found and resolved").toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.container).toMatch(/^div\.wsg-pop\.slash-pop /);
      expect(v.gap, line(v)).toBe(8);
      expect(v.gap + v.margin, line(v)).toBeGreaterThanOrEqual(0);
      expect(v.gap + v.margin, line(v)).toBe(8);
    }
  });

  it("COMMANDS (card 471) sits 8px above the first row in .wsg-pop.slash-pop, like SKILLS", () => {
    const vs = at(COMMANDS_HEADING);
    expect(vs.length, "the heading is found and resolved").toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.container).toMatch(/^div\.wsg-pop\.slash-pop /);
      expect(v.gap, line(v)).toBe(8);
      expect(v.gap + v.margin, line(v)).toBe(8);
    }
  });

  it("DESCRIPTION sits 8px above the skill name in .wsg-pop.slash-tip", () => {
    const vs = at("components/SlashTip.tsx:117");
    expect(vs.length, "the heading is found and resolved").toBeGreaterThan(0);
    for (const v of vs) {
      expect(v.container).toMatch(/^div\.wsg-pop\.slash-tip /);
      expect(v.gap, line(v)).toBe(8);
      expect(v.gap + v.margin, line(v)).toBeGreaterThanOrEqual(0);
      expect(v.gap + v.margin, line(v)).toBe(8);
    }
  });
});

describe("no section heading anywhere overlaps what follows it (criterion 3)", () => {
  it("finds every heading the source names, and resolves each one", () => {
    // A plain count of the class in className strings, next to the syntax
    // walk: a walk that quietly skipped a file would otherwise report a
    // clean tree.
    let named = 0;
    for (const s of SOURCES) {
      named += [...s.sf.text.matchAll(/className=(?:"[^"]*|\{[^}]*)\bsettings-label\b/g)].length;
    }
    expect(SURVEY.sites.length).toBe(named);
    expect(named).toBeGreaterThan(20);
    for (const site of SURVEY.sites) {
      expect(at(site).length, `${site} has at least one resolved place`).toBeGreaterThan(0);
    }
  });

  it("can decide every rule and every place it walked through", () => {
    expect(SURVEY.problems).toEqual([]);
  });

  it("leaves no heading with a negative space under it", () => {
    expect(overlaps(SURVEY)).toEqual([]);
  });

  it("still lands on 8px in the settings page, the space the shared rule was sized for", () => {
    // The page's sections sit in its tab panels, flex columns with the 24px gap
    // the shared rule's negative margin was written against.
    const panel = SURVEY.verdicts.filter((v) => v.container.startsWith("div.settings-tabpanel "));
    expect(panel.length).toBeGreaterThan(10);
    for (const v of panel) expect(v.gap + v.margin, line(v)).toBe(8);
  });
});

// The instrument, before it is believed. Without these the survey could answer
// "no overlap" for a tree it failed to read.
describe("the resolver itself", () => {
  const sheet = (css: string): Rule[] => parseSheet("t.css", css, 0);
  const el = (tag: string, cls: string, where = "t"): El => ({
    tag,
    classes: new Set(cls.split(" ").filter((c) => c !== "")),
    maybe: new Set(),
    patterns: [],
    id: null,
    where,
  });

  it("does pixel arithmetic through var() and calc()", () => {
    const rules = sheet(":root { --a: 8px; --b: 24px; }");
    expect(px(substitute("calc(var(--a) - var(--b))", rules, "t"), "t")).toBe(-16);
    expect(px("calc(2 * 4px + (10px - 2px) / 2)", "t")).toBe(12);
    expect(px("0", "t")).toBe(0);
    expect(() => px("1em", "t")).toThrow(/not a pixel length/);
  });

  it("expands the margin and gap shorthands, and orders one rule's own declarations, the way CSS does", () => {
    const rules = sheet(".a { margin: 1px 2px 3px 4px; } .b { margin: 5px 6px; } .c { gap: 7px 9px; }");
    expect(declared(rules[0], "margin-bottom", rules)?.value).toBe("3px");
    expect(declared(rules[1], "margin-bottom", rules)?.value).toBe("5px");
    expect(declared(rules[2], "row-gap", rules)?.value).toBe("7px");
    // Of two normal declarations in one rule the later wins, longhand or shorthand.
    const late = sheet(".a { margin-bottom: 1px; margin: 2px; } .b { margin: 2px; margin-bottom: 1px; }");
    expect(declared(late[0], "margin-bottom", late)?.value).toBe("2px");
    expect(declared(late[1], "margin-bottom", late)?.value).toBe("1px");
    // .a: a property set again after a shorthand; the repeat is the later one.
    // .b to .e: an important declaration beats a later normal one in the same
    // rule, of the same property or through a shorthand, and among important
    // ones the later wins.
    const own = sheet(
      ".a { margin-bottom: 1px; margin: 2px; margin-bottom: 3px; }" +
        " .b { margin-bottom: 1px !important; margin-bottom: 3px; }" +
        " .c { margin-bottom: 1px !important; margin: 3px; }" +
        " .d { margin: 1px !important; margin-bottom: 3px; }" +
        " .e { margin-bottom: 1px !important; margin: 2px !important; margin-bottom: 3px; }",
    );
    expect(own.map((r) => [r.selector, declared(r, "margin-bottom", own)])).toEqual([
      [".a", { value: "3px", important: false }],
      [".b", { value: "1px", important: true }],
      [".c", { value: "1px", important: true }],
      [".d", { value: "1px", important: true }],
      [".e", { value: "2px", important: true }],
    ]);
  });

  it("lets specificity beat order, and order break a tie", () => {
    const rules = sheet(
      ".box > .h { margin-bottom: 1px; } .h { margin-bottom: 2px; } .x .h { margin-bottom: 3px; } .y .h { margin-bottom: 4px; }",
    );
    const chain = (parent: string): Chain => ({ els: [el("div", "h"), el("div", parent)], open: null });
    const problems: string[] = [];
    expect(computed("margin-bottom", chain("box"), "", rules, problems)?.value).toBe("1px");
    expect(computed("margin-bottom", chain("other"), "", rules, problems)?.value).toBe("2px");
    expect(computed("margin-bottom", chain("x y"), "", rules, problems)?.value).toBe("4px");
    expect(problems).toEqual([]);
  });

  it("keeps a conditional rule out of the base answer and in its own", () => {
    const rules = sheet(".h { margin-bottom: 1px; } @media (max-width: 9px) { .h { margin-bottom: 2px; } }");
    const chain: Chain = { els: [el("div", "h"), el("div", "")], open: null };
    expect(computed("margin-bottom", chain, "", rules, [])?.value).toBe("1px");
    expect(computed("margin-bottom", chain, "@media (max-width: 9px)", rules, [])?.value).toBe("2px");
  });

  it("reports a rule it cannot decide instead of guessing", () => {
    const rules = sheet(".a:hover .h { margin-bottom: 1px; } .top .h { margin-bottom: 2px; }");
    const problems: string[] = [];
    const known: Chain = { els: [el("div", "h"), el("div", "a")], open: null };
    expect(computed("margin-bottom", known, "", rules, problems)).toBeNull();
    expect(problems).toEqual([`t.css:1 ".a:hover .h" may set margin-bottom on div.h (t)`]);
    // An ancestor above where the walk stopped could carry .top.
    const cut: Chain = { els: [el("div", "h"), el("div", "b")], open: "somewhere" };
    const more: string[] = [];
    computed("margin-bottom", cut, "", rules, more);
    expect(more.some((p) => p.includes('".top .h"') && p.includes("stops: somewhere"))).toBe(true);
  });

  it("reads a template literal's glued class as a pattern, not as any class", () => {
    const sf = ts.createSourceFile(
      "t.tsx",
      "const x = <div className={`wsg-pop slash-tip slash-tip--${side}`} />;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const node = nodesOf(sf).find((n): n is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(n));
    if (node === undefined) throw new Error("no element parsed");
    const got = hostEl(node);
    expect([...got.classes]).toEqual(["wsg-pop", "slash-tip"]);
    expect(hasClass(got, "slash-tip--right")).toBe(MAYBE);
    expect(hasClass(got, "md")).toBe(NO);
  });

  it("reads a conditional class name as certain where both sides agree", () => {
    const sf = ts.createSourceFile(
      "t.tsx",
      'const x = <main className={`chat${wide ? " chat--wide" : ""}`} />;\n' +
        'const y = <div className={drag ? "composer-inner drag-over" : "composer-inner"} />;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const [main, div] = nodesOf(sf)
      .filter((n): n is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(n))
      .map(hostEl);
    expect([...main.classes]).toEqual(["chat"]);
    expect([...main.maybe]).toEqual(["chat--wide"]);
    expect(main.patterns).toEqual([]);
    expect([...div.classes]).toEqual(["composer-inner"]);
    expect([...div.maybe]).toEqual(["drag-over"]);
  });

  // The walk, on the real tree, through each kind of hop the survey relies on.
  // Each one is a place where a walk that stopped short would still find a
  // container, just the wrong one.
  const chainsOf = (site: string): Chain[] => {
    const found = labelSites().find((s) => s.el.where === site);
    if (found === undefined) throw new Error(`no heading at ${site}`);
    return prepend(found.el, above(found.node, 0));
  };
  const path = (c: Chain): string =>
    c.els.map((e) => `${e.tag}${[...e.classes].map((k) => `.${k}`).join("")}`).join(" < ");

  it("follows a hook's returned node to where its caller places it", () => {
    const chains = [
      ...chainsOf(SKILLS_HEADING),
      ...chainsOf(COMMANDS_HEADING),
    ];
    expect(chains.length).toBeGreaterThan(1);
    for (const c of chains) {
      expect(path(c)).toMatch(/^div\.settings-label < div\.wsg-pop\.slash-pop < div\.composer-inner < /);
      // All the way up: Chat, the app shell, and index.html's root.
      expect(path(c).endsWith(" < div.layout < div < body < html"), path(c)).toBe(true);
      expect(c.open).toBeNull();
    }
  });

  it("follows a variable holding a component to where the variable is placed", () => {
    // SlashTip is mounted into `const tip`, and `tip` is placed next to the list.
    for (const c of chainsOf("components/SlashTip.tsx:117")) {
      expect(path(c)).toMatch(/^div\.settings-label < div\.wsg-pop\.slash-tip < div\.composer-inner < /);
    }
  });

  it("follows a section component to where the page mounts it, through the tab panel wrapper", () => {
    for (const site of ["components/DockWidthSettings.tsx:47", "components/SettingsPanel.tsx:724"]) {
      const chains = chainsOf(site);
      expect(chains.length, site).toBeGreaterThan(0);
      for (const c of chains) {
        expect(path(c), site).toMatch(/^div\.settings-label < div\.settings-tabpanel < div\.settings-body < /);
      }
    }
  });

  it("finds a heading whose space is negative, and only then", () => {
    const rules = [
      ...sheet(":root { --s: 8px; --l: 24px; }"),
      ...sheet(".col { display: flex; flex-direction: column; gap: var(--s); }"),
      ...sheet(".h { margin-bottom: calc(var(--s) - var(--l)); }"),
    ];
    const tight: Chain = { els: [el("div", "h", "h"), el("div", "col", "c")], open: null };
    const block: Chain = { els: [el("div", "h", "h"), el("section", "", "s")], open: null };
    const problems: string[] = [];
    expect(verdictOf(tight, "", rules, problems)).toEqual({
      site: "h",
      container: "div.col (c)",
      condition: "",
      gap: 8,
      margin: -16,
    });
    expect(verdictOf(block, "", rules, problems)?.gap).toBe(0);
    expect(problems).toEqual([]);
  });
});
