// Card 446: the microphone menu opens to the left. The owner, testing the
// 0.14.0-beta app: "Die Mikrofonoptionen sollten nach links aufgehen und nicht
// nach rechts. So sieht man sie nicht mehr." The caret sits near the right end
// of the composer row, and its menu hung from the caret's LEFT edge and grew to
// the right, past the window.
//
// The two menus at the row's right end, the microphone's and the gear's, take
// the ROW as their frame. Framed by their own anchors they grew left by a fixed
// width, and with the sidebar collapsed and a panel docked the chat narrows to
// its floor at the window's left edge: measured 2026-09-26, the microphone
// menu then began 24px left of the window at 1024 px and 60px left at 800 px.
// Framed by the row, their widths are percentages of it, so this file checks
// the row at every width from the narrowest chat column the layout accepts up
// to the window: the lab's chat column at the floor layout.ts clamps it to, or
// the main chat beside a docked panel, whichever is narrower, less the
// composer's padding.
//
// Read off the sheets (no DOM in this suite). The side a popover takes is not
// one rule but the cascade of every rule that reaches its classes, so this file
// resolves that cascade for the properties in WEIGHED: over the rules made of
// the element's classes only, in every sheet the entry point loads, in load
// order, by !important, then the number of classes, then source order (the
// last declaration of a rule last), with each @media evaluated at the width
// asked for. The logical insets are read for a left-to-right, horizontal page.
// Rules it does not resolve and that set one of those properties, or that set
// a property in MOVERS or FRAMERS, are listed by `unweighed`, and a case fails
// on any. Rules whose subject names none of the element's classes (type,
// universal and id selectors) are not read. The wave's browser stage measures
// the drawn result.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { WIDTH_FIELDS } from "../state/layout";
import { blankBlockComments } from "../testkit/source";

const SRC = fileURLToPath(new URL("..", import.meta.url));

interface Decl {
  prop: string;
  value: string;
  important: boolean;
}

interface Rule {
  sheet: string;
  /** The at-rule preludes around the rule, outermost first. */
  at: string[];
  selector: string;
  decls: Decl[];
  /** Position in the whole load order, for the last tie-break. */
  order: number;
}

/** The local stylesheets main.tsx loads, in load order, each @import expanded in place. */
function entrySheets(): string[] {
  const main = readFileSync(join(SRC, "main.tsx"), "utf8");
  const out: string[] = [];
  const expand = (path: string): void => {
    if (out.includes(path)) return;
    const css = blankBlockComments(readFileSync(path, "utf8"));
    for (const m of css.matchAll(/@import\s+["']([^"']+)["']\s*;/g)) expand(resolve(dirname(path), m[1]));
    out.push(path);
  };
  for (const m of main.matchAll(/^import\s+"(\.[^"]+\.css)";/gm)) expand(resolve(SRC, m[1]));
  return out;
}

/** Every .css file under src, wherever it lives. */
function allSheets(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allSheets(path));
    else if (entry.name.endsWith(".css")) out.push(path);
  }
  return out;
}

/** One sheet's style rules, one entry per selector of a comma list, with the at-rules around them. */
function parse(sheet: string, css: string, start: number): Rule[] {
  const src = blankBlockComments(css);
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  let order = start;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        continue;
      }
      // A style rule: its body runs to the next closing brace outside a string.
      let j = i + 1;
      let quote: string | null = null;
      for (; j < src.length; j++) {
        const d = src[j];
        if (quote !== null) {
          if (d === quote) quote = null;
        } else if (d === '"' || d === "'") quote = d;
        else if (d === "}") break;
      }
      const decls = src
        .slice(i + 1, j)
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d.includes(":"))
        .map((d) => {
          const k = d.indexOf(":");
          const raw = d.slice(k + 1).trim();
          const important = /!\s*important$/.test(raw);
          return {
            prop: d.slice(0, k).trim(),
            value: raw.replace(/!\s*important$/, "").replace(/\s+/g, " ").trim(),
            important,
          };
        });
      for (const one of prelude.split(",")) {
        out.push({ sheet, at: [...stack], selector: one.trim(), decls, order: order++ });
      }
      i = j;
    } else if (c === "}") {
      stack.pop();
      buf = "";
    } else if (c === ";" && buf.trim().startsWith("@")) {
      buf = "";
    } else {
      buf += c;
    }
  }
  return out;
}

function loadedRules(): Rule[] {
  const out: Rule[] = [];
  for (const path of entrySheets()) out.push(...parse(path, readFileSync(path, "utf8"), out.length));
  return out;
}

/**
 * Whether an at-rule prelude holds at a viewport width, for a desktop pointer.
 * `undefined` for a condition this reader does not know.
 */
function holds(prelude: string, width: number): boolean | undefined {
  if (prelude.startsWith("@supports")) return true;
  if (!prelude.startsWith("@media")) return undefined;
  const query = prelude.slice("@media".length).trim();
  let any: boolean | undefined = false;
  for (const alt of query.split(",")) {
    let all: boolean | undefined = true;
    for (const part of alt.split(/\band\b/)) {
      const p = part.trim().replace(/\s+/g, " ");
      let v: boolean | undefined;
      const max = /^\(max-width: ?(\d+(?:\.\d+)?)px\)$/.exec(p);
      const min = /^\(min-width: ?(\d+(?:\.\d+)?)px\)$/.exec(p);
      if (max) v = width <= Number(max[1]);
      else if (min) v = width >= Number(min[1]);
      else if (p === "screen" || p === "all") v = true;
      else if (p === "(hover: none)" || p === "(pointer: coarse)") v = false;
      else if (p === "(hover: hover)" || p === "(pointer: fine)") v = true;
      else v = undefined;
      if (v === false) all = false;
      else if (v === undefined && all !== false) all = undefined;
    }
    if (all === true) any = true;
    else if (all === undefined && any === false) any = undefined;
  }
  return any;
}

/** The classes of a selector made of class tokens only, else null. */
function classCompound(selector: string): string[] | null {
  return /^(\.[A-Za-z0-9_-]+)+$/.test(selector) ? selector.slice(1).split(".") : null;
}

/** The values of a shorthand, split on the spaces outside parentheses. */
function values(value: string): string[] {
  return value.split(/\s+(?![^(]*\))/);
}

/**
 * The physical sides `inset` and each logical inset set, with the value each
 * side takes, on a left-to-right, horizontal page.
 */
const INSETS: Record<string, (v: string[]) => [string, string][]> = {
  inset: (v) => [
    ["top", v[0]],
    ["right", v[1] ?? v[0]],
    ["bottom", v[2] ?? v[0]],
    ["left", v[3] ?? v[1] ?? v[0]],
  ],
  "inset-block": (v) => [
    ["top", v[0]],
    ["bottom", v[1] ?? v[0]],
  ],
  "inset-inline": (v) => [
    ["left", v[0]],
    ["right", v[1] ?? v[0]],
  ],
  "inset-block-start": (v) => [["top", v[0]]],
  "inset-block-end": (v) => [["bottom", v[0]]],
  "inset-inline-start": (v) => [["left", v[0]]],
  "inset-inline-end": (v) => [["right", v[0]]],
};

/** Every declaration a rule makes, in order, with each form in INSETS spelled out as physical sides. */
function longhands(rule: Rule): Decl[] {
  const out: Decl[] = [];
  for (const d of rule.decls) {
    const sides = INSETS[d.prop];
    if (sides === undefined) out.push(d);
    else for (const [prop, value] of sides(values(d.value))) out.push({ ...d, prop, value });
  }
  return out;
}

const RULES = loadedRules();

/**
 * The value that wins for `prop` on an element carrying exactly `classes`, at
 * a viewport width. Only rules whose whole selector is a compound of those
 * classes count; `unweighed` lists the rest. Within one rule the later
 * declaration wins, as in the browser.
 */
function computed(classes: string[], prop: string, width: number): string | undefined {
  let best: { important: boolean; spec: number; order: number; value: string } | undefined;
  for (const rule of RULES) {
    const own = classCompound(rule.selector);
    if (own === null || !own.every((c) => classes.includes(c))) continue;
    for (const d of longhands(rule)) {
      if (d.prop !== prop) continue;
      const conds = rule.at.map((a) => holds(a, width));
      if (conds.includes(undefined)) {
        throw new Error(`${rule.sheet}: cannot evaluate "${rule.at.join(" ")}" around ${rule.selector}`);
      }
      if (conds.includes(false)) continue;
      const cand = { important: d.important, spec: own.length, order: rule.order, value: d.value };
      if (
        best === undefined ||
        Number(cand.important) > Number(best.important) ||
        (cand.important === best.important &&
          (cand.spec > best.spec || (cand.spec === best.spec && cand.order >= best.order)))
      ) {
        best = cand;
      }
    }
  }
  return best?.value;
}

/**
 * What the cases below resolve with `computed` for a popover or an anchor: its
 * position, its sides in every inset form, its widths.
 */
const WEIGHED = [
  "position",
  "top",
  "right",
  "bottom",
  "left",
  ...Object.keys(INSETS),
  "width",
  "min-width",
  "max-width",
];

/**
 * Properties that move a positioned box sideways and that no case here
 * resolves. The ones this file knows of, not every property CSS has.
 */
const MOVERS = [
  "margin",
  "margin-left",
  "margin-right",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "transform",
  "translate",
  "rotate",
  "scale",
  "animation",
  "animation-name",
  "offset",
  "offset-path",
  "zoom",
];

/**
 * Properties that make an element the frame of its absolutely positioned
 * descendants besides `position`, which no case here resolves. The ones this
 * file knows of.
 */
const FRAMERS = [
  "transform",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "filter",
  "backdrop-filter",
  "contain",
  "container-type",
  "will-change",
  "content-visibility",
];

/**
 * Rules that set one of `props` on an element carrying `classes` in a way
 * `computed` does not weigh. A rule `computed` reads (a compound of those
 * classes in a sheet the entry point loads) is listed when it sets a prop
 * outside `weighed`. Any other rule whose subject names only those classes
 * (under an ancestor, with a pseudo-class or an attribute, or in a sheet the
 * entry point does not load in a known place) is listed when it sets a prop.
 */
function unweighed(classes: string[], props: string[], weighed: string[] = WEIGHED): string[] {
  const loaded = new Set(entrySheets());
  const found: string[] = [];
  for (const path of allSheets()) {
    const rules = parse(path, readFileSync(path, "utf8"), 0);
    for (const rule of rules) {
      const parts = rule.selector.split(/\s*[>+~]\s*|\s+/);
      const subject = parts[parts.length - 1] ?? "";
      const own = (subject.match(/\.[A-Za-z0-9_-]+/g) ?? []).map((c) => c.slice(1));
      if (own.length === 0 || !own.every((c) => classes.includes(c))) continue;
      const read = classCompound(rule.selector) !== null && loaded.has(path);
      const hits = rule.decls.filter((d) => props.includes(d.prop) && !(read && weighed.includes(d.prop)));
      if (hits.length > 0) {
        found.push(`${path.slice(SRC.length)}: ${rule.selector} { ${hits.map((d) => d.prop).join(", ")} }`);
      }
    }
  }
  return found;
}

// ---- lengths -----------------------------------------------------------------

/** Every custom property tokens.css declares in px, read rather than remembered. */
const TOKENS = new Map<string, number>(
  [...readFileSync(join(SRC, "tokens.css"), "utf8").matchAll(/--([a-z0-9-]+):\s*(\d+(?:\.\d+)?)px\s*;/g)].map(
    (m) => [m[1], Number(m[2])],
  ),
);

/** A px token of tokens.css, or a throw. */
function token(name: string): number {
  const n = TOKENS.get(name);
  if (n === undefined) throw new Error(`tokens.css has no --${name} in px`);
  return n;
}

/**
 * A length in CSS px: px, vw (against the window), % (against the containing
 * block), `var(--token)` of a px token, and `calc()` over those with + - * /
 * and parentheses. Anything else throws.
 */
function length(value: string, vw: number, cb?: number): number {
  const tokens = value.match(/calc\(|var\(--[a-z0-9-]+\)|-?\d+(?:\.\d+)?(?:px|vw|%)?|[-+*/()]/g) ?? [];
  if (tokens.join("").replace(/calc\(/g, "(") !== value.replace(/\s+/g, "").replace(/calc\(/g, "(")) {
    throw new Error(`cannot read "${value}" as a length`);
  }
  let i = 0;
  const atom = (): number => {
    const t = tokens[i++];
    if (t === "calc(" || t === "(") {
      const v = sum();
      if (tokens[i++] !== ")") throw new Error(`unbalanced "${value}"`);
      return v;
    }
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(t ?? "");
    if (ref) return token(ref[1]);
    const num = /^(-?\d+(?:\.\d+)?)(px|vw|%)?$/.exec(t ?? "");
    if (!num) throw new Error(`cannot read "${t}" in "${value}"`);
    const n = Number(num[1]);
    if (num[2] === "vw") return (n * vw) / 100;
    if (num[2] === "%") {
      if (cb === undefined) throw new Error(`"${value}" needs its containing block's width`);
      return (n * cb) / 100;
    }
    return n;
  };
  const product = (): number => {
    let v = atom();
    while (tokens[i] === "*" || tokens[i] === "/") v = tokens[i++] === "*" ? v * atom() : v / atom();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (tokens[i] === "+" || tokens[i] === "-") v = tokens[i++] === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`trailing text in "${value}"`);
  return v;
}

/** The width a popover is drawn at: its width, capped by max-width, floored by min-width. */
function usedWidth(classes: string[], vw: number, cb: number): number {
  const width = computed(classes, "width", vw);
  if (width === undefined) throw new Error(`${classes.join(".")} declares no width`);
  const max = computed(classes, "max-width", vw);
  const min = computed(classes, "min-width", vw);
  let used = length(width, vw, cb);
  if (max !== undefined && max !== "none") used = Math.min(used, length(max, vw, cb));
  if (min !== undefined) used = Math.max(used, length(min, vw, cb));
  return used;
}

/** A side of a popover in px, `auto` counted as absent. */
function side(classes: string[], prop: string, vw: number, cb: number): number | "auto" {
  const v = computed(classes, prop, vw) ?? "auto";
  return v === "auto" ? "auto" : length(v, vw, cb);
}

/** The composer's left and right padding together: the row is the bar less these. */
function composerPadding(vw: number): number {
  const short = computed(["composer"], "padding", vw);
  if (short === undefined) throw new Error(".composer declares no padding");
  const parts = values(short);
  const right = parts[1] ?? parts[0];
  const left = parts[3] ?? right;
  const own = (p: string, fallback: string): number => length(computed(["composer"], p, vw) ?? fallback, vw);
  return own("padding-left", left) + own("padding-right", right);
}

function read(component: string): string {
  return readFileSync(join(SRC, "components", component), "utf8");
}

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;

/** Every JSX element in a component file, depth first. */
function elements(component: string): Jsx[] {
  const file = ts.createSourceFile(component, read(component), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Jsx[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) out.push(node);
    node.forEachChild(walk);
  };
  walk(file);
  return out;
}

function opening(el: Jsx): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(el) ? el.openingElement : el;
}

/** An element's tag and its className when that is a string literal, as `Tag.class.class`. */
function label(el: Jsx): string {
  const tag = opening(el).tagName.getText();
  const cls = opening(el).attributes.properties.find(
    (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === "className",
  );
  const value = cls?.initializer !== undefined && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : "";
  return [tag, ...value.split(/\s+/).filter(Boolean)].join(".");
}

/** The JSX elements around `el`, outermost first; fragments and expressions are not boxes and are skipped. */
function ancestors(el: Jsx): string[] {
  const out: string[] = [];
  for (let at = el.parent; at !== undefined; at = at.parent) {
    if (ts.isJsxElement(at)) out.unshift(label(at));
  }
  return out;
}

/** The one element of a component file whose label is `wanted`, or a throw. */
function only(component: string, wanted: string): Jsx {
  const found = elements(component).filter((el) => label(el) === wanted);
  if (found.length !== 1) throw new Error(`${component} has ${found.length} ${wanted}`);
  return found[0];
}

/** The tags Chat.tsx puts in the composer row after the microphone's menu. */
function afterTheCaret(): string[] {
  const chat = readFileSync(join(SRC, "components", "Chat.tsx"), "utf8");
  const row = chat.indexOf('<div className="composer-actions">');
  if (row < 0) throw new Error("Chat.tsx no longer opens a .composer-actions div");
  const mic = chat.indexOf("<MicMenu", row);
  if (mic < 0) throw new Error("the composer row no longer mounts MicMenu");
  const end = chat.indexOf("</div>", mic);
  return [...chat.slice(mic + 1, end).matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
}

const WIDTHS = [390, 1024, 1440];

/**
 * The narrowest chat column the layout accepts: the lab's chat column at the
 * floor layout.ts clamps its stored width to, or the main chat beside a docked
 * panel (the chat reserve), whichever is narrower.
 */
function chatFloor(): number {
  const lab = WIDTH_FIELDS.find(([field]) => field === "chatW");
  if (lab === undefined) throw new Error("layout.ts no longer bounds chatW");
  return Math.min(lab[1], token("chat-reserve"));
}

/**
 * Widths of the composer row in a window `vw` wide, in 8px steps plus both
 * ends: from the narrowest chat column less the composer's padding up to the
 * full window or the wide reading width, whichever is less. The menus are
 * framed by the row, so the row's width is what decides whether they fit.
 */
function rowWidths(vw: number): number[] {
  const pad = composerPadding(vw);
  const floor = chatFloor() - pad;
  const top = Math.min(vw - pad, token("content-max-wide"));
  const out: number[] = [];
  for (let w = floor; w < top; w += 8) out.push(w);
  out.push(top);
  return out;
}

const PADDING = [
  "padding",
  "padding-left",
  "padding-right",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
];

describe("the sheets", () => {
  it("set no direction and no writing mode", () => {
    const found = allSheets().flatMap((path) =>
      parse(path, readFileSync(path, "utf8"), 0)
        .filter((rule) => rule.decls.some((d) => d.prop === "direction" || d.prop === "writing-mode"))
        .map((rule) => `${path.slice(SRC.length)}: ${rule.selector}`),
    );
    expect(found).toEqual([]);
  });
});

describe("the composer row", () => {
  it("is the frame the menus at its right end hang from", () => {
    for (const width of WIDTHS) expect(computed(["composer-actions"], "position", width)).toBe("relative");
    expect(unweighed(["composer-actions"], ["position"])).toEqual([]);
  });

  it("has its padding set by no rule this file cannot weigh", () => {
    expect(unweighed(["composer"], PADDING, ["padding", "padding-left", "padding-right"])).toEqual([]);
  });

  it("ends with the microphone's menu, the gear, and then the block of the model, thinking and ring", () => {
    // Card 463 (owner, 2026-09-29): "ganz rechts außen soll der Kontext drin
    // sein". The block holds the ring last; composerMeta.test.tsx pins that.
    expect(afterTheCaret()).toEqual(["ComposerGear", "ComposerMeta"]);
  });
});

describe("the microphone menu", () => {
  const pop = ["wsg-pop", "mic-pop"];

  it("takes the row as its frame, not the caret's anchor", () => {
    // The popover sits straight in its anchor, the anchor is MicMenu's root,
    // and Chat.tsx mounts MicMenu straight into the row.
    expect(ancestors(only("MicMenu.tsx", "div.wsg-pop.mic-pop"))).toEqual(["div.wsg-anchor.mic-anchor"]);
    const mount = only("Chat.tsx", "MicMenu");
    expect(ancestors(mount).slice(-1)).toEqual(["div.composer-actions"]);
    const anchor = ["wsg-anchor", "mic-anchor"];
    for (const width of WIDTHS) {
      expect(computed(pop, "position", width)).toBe("absolute");
      expect(computed(anchor, "position", width)).toBe("static");
    }
    expect(unweighed(anchor, ["position", ...FRAMERS])).toEqual([]);
  });

  it.each(WIDTHS)("hangs from the row's left end, beside its controls, at %i px", (width) => {
    // Card 463 (owner, 2026-09-29, after Claude Code's composer): the
    // microphone and the gear join the left group, and the right end belongs
    // to the model, thinking and ring. The menu hangs from the row's left end,
    // which is where its caret now stands, and grows to the right.
    for (const row of rowWidths(width)) {
      expect(side(pop, "left", width, row)).toBe(0);
      expect(side(pop, "right", width, row)).toBe("auto");
    }
  });

  it.each(WIDTHS)("opens upward from the composer row at %i px", (width) => {
    expect(computed(pop, "top", width)).toBe("auto");
    expect(computed(pop, "bottom", width)).toMatch(/^calc\(100% \+ \d+px\)$/);
  });

  it.each(WIDTHS)("ends inside the row at every row width of a %i px window", (width) => {
    for (const row of rowWidths(width)) {
      const left = side(pop, "left", width, row);
      if (left === "auto") throw new Error("the microphone menu has no left side");
      expect(row - left - usedWidth(pop, width, row), `row ${row}px`).toBeGreaterThanOrEqual(0);
    }
  });

  it("has none of WEIGHED and MOVERS set by a rule this file cannot weigh", () => {
    expect(unweighed(pop, [...WEIGHED, ...MOVERS])).toEqual([]);
  });
});

describe("the gear's menu", () => {
  const pop = ["wsg-pop", "gear-pop"];

  it("carries classes of its own, so its frame and width can be set without every other menu's", () => {
    expect(read("ComposerGear.tsx")).toMatch(/<div className="wsg-anchor gear-anchor" ref=\{ref\}>/);
    expect(read("ComposerGear.tsx")).toMatch(/<div className="wsg-pop gear-pop" role="dialog"/);
  });

  it("takes the row as its frame, not the gear's anchor", () => {
    expect(ancestors(only("ComposerGear.tsx", "div.wsg-pop.gear-pop"))).toEqual(["div.wsg-anchor.gear-anchor"]);
    const mount = only("Chat.tsx", "ComposerGear");
    expect(ancestors(mount).slice(-1)).toEqual(["div.composer-actions"]);
    const anchor = ["wsg-anchor", "gear-anchor"];
    for (const width of WIDTHS) {
      expect(computed(pop, "position", width)).toBe("absolute");
      expect(computed(anchor, "position", width)).toBe("static");
    }
    expect(unweighed(anchor, ["position", ...FRAMERS])).toEqual([]);
  });

  it.each(WIDTHS)("hangs from the row's left end, beside the gear, and opens upward at %i px", (width) => {
    // Card 463: the gear stands in the left group now (see the microphone's).
    expect(computed(pop, "left", width)).toBe("0");
    expect(computed(pop, "right", width) ?? "auto").toBe("auto");
    expect(computed(pop, "top", width) ?? "auto").toBe("auto");
    expect(computed(pop, "bottom", width)).toMatch(/^calc\(100% \+ \d+px\)$/);
  });

  it.each(WIDTHS)("ends inside the row at every row width of a %i px window", (width) => {
    for (const row of rowWidths(width)) {
      expect(row - usedWidth(pop, width, row), `row ${row}px`).toBeGreaterThanOrEqual(0);
    }
  });

  it("has none of WEIGHED and MOVERS set by a rule this file cannot weigh", () => {
    expect(unweighed(pop, [...WEIGHED, ...MOVERS])).toEqual([]);
  });
});
