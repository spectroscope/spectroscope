// CARD 319, AC 7 — every part of the agent card that grows with its data has
// a STATED BOUND, and the list of those parts is read out of the component
// rather than typed here.
//
// Why derived, and why that is the whole point. The house record from card 312:
// "a hand list, guarded by a test that types the same hand list, is not a
// guard — it is two copies of the same lie". A test that named
// `.pf-ctx`, `.pf-shots`, `.pf-tools`, `.pf-phases__list` and checked those
// four would be green forever the day someone adds a fifth region, which is
// exactly how the card grew two unbounded ones without anything going red.
// So the list comes from `AgentCardBody` itself, and THE BITE for this file is
// to plant a fifth region in nodes.tsx and demand red — if it stays green, the
// derivation is a hand list with a loop around it and has to be rewritten.
//
// WHAT WAS UNBOUNDED WHEN THIS FILE WAS WRITTEN, measured in the browser. Both
// are bounded now — this is the disease, kept because it is what the rules
// below were derived from, not a report of what the card does today:
//
//   .pf-shots      the hub's picture shelf, uncapped in CSS by design, with the
//                  exemption stated in words in nodes.tsx; only
//                  `.pf-sub--full .pf-agent__genfull` carried card 296's 172.
//                  Its only bound was the TypeScript MAX_CARD_SHOTS = 6, which
//                  bounds the COUNT and not the pixels: measured 0 -> 187.7
//                  (one row) -> 330.9 (two rows). It now sits inside a shelf
//                  whose height is fixed, and states 331 of its own.
//   .pf-ctx        the context bars. No bound of any kind, 22.27 px per row,
//                  forever. Seven more rows took a measured card from 1188.29
//                  to 1344.20 — which is why the seat in agentCardSeat.test.ts
//                  stops at the bounded regions and says so. It states 134 now.
//
// A BOUND MUST NOT BECOME A CLIP, and that is two separate obligations, both
// checked below because the first pass of this file only checked one.
//
//   1. What is past the bound has to be REACHABLE. flowmap.css says it itself,
//      at the workflow box: "content is capped and CLIPPED — a max-height alone
//      stops the box growing".
//   2. And the reader's wheel has to get there. A scroll region inside the
//      canvas needs `nowheel`, or React Flow zooms the map instead: measured on
//      the running card with `.pf-tools` forced to overflow, one wheel over its
//      centre took the map 0.2683 -> 0.1541 and left `scrollTop` at 0, while
//      the same wheel over `.pf-toolbody` (which carries `nowheel`) moved
//      nothing. `overflow-y: auto` on a region the canvas eats the wheel over
//      is a clip with a scrollbar drawn on it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
const NODES = read("nodes.tsx");
/** Comments off FIRST — the scrubKeepsItsWidth lesson: a `}` inside a comment
 *  ends an extracted rule early and the assertion below it then judges a rule
 *  that is not there. */
const CSS = read("flowmap.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Both spellings a container's class can take in this file: a plain string,
 *  and a template literal whose literal head runs until its first `$`
 *  (`pf-agent__genfull` is written the second way). Built from a string rather
 *  than written as a literal so the backtick reads without escaping. */
const CLASS_NAME = new RegExp('className=(?:"([^"{}]*)"|\\{`([^`$]*))', "g");

/** The agent card's own markup, and nothing else's. */
function agentCardSource(): string {
  const from = NODES.indexOf("export function AgentCardBody(");
  const to = NODES.indexOf("export function AgentNode(");
  expect(from, "AgentCardBody must exist").toBeGreaterThan(-1);
  expect(to, "AgentNode must follow it").toBeGreaterThan(from);
  return NODES.slice(from, to);
}

/**
 * Every container in the agent card whose children come from a list.
 *
 * The rule is what the region IS rather than how it happens to be spelled: a
 * `.map(` whose callback opens a JSX tag renders one element per item, so its
 * container grows with the data. `Math.max(1, ...(d.ctxParts ?? []).map((p) =>
 * p.estTokens))` is a map too and renders nothing, so it is not a region.
 *
 * THE FIRST CUT OF THIS FUNCTION MATCHED `{word.map(` AND THE BITE CAUGHT IT.
 * A fifth region planted as `{(d.ctxParts ?? []).map((p) => (<span .../>))}`
 * went straight past it — the expression starts with a bracket, not a word —
 * so the derivation was narrower than the sentence above it and would have
 * shipped as a hand list with a loop around it. The rule is now the callback,
 * not the spelling of the thing being mapped.
 */
function growthRegions(): string[] {
  const src = agentCardSource();
  const out = new Set<string>();
  const re = /\.map\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // The callback has to open an element: `=> (` then a tag, or `=> <`.
    if (!/^\s*(\([^)]*\)|[\w$]+)\s*=>\s*\(?\s*</.test(src.slice(re.lastIndex, re.lastIndex + 120))) {
      continue;
    }
    const before = src.slice(0, m.index);
    // Both spellings a container's class can take here — a plain string and a
    // template literal (`.pf-agent__genfull` is written the second way). A
    // matcher blind to one of them would credit the map to whatever classed
    // element came before, which is a wrong answer wearing a right one's face.
    const cls = [...before.matchAll(CLASS_NAME)].pop();
    expect(cls, `the map at index ${m.index} must sit inside a classed container`).toBeDefined();
    for (const token of (cls![1] ?? cls![2]).split(/\s+/)) {
      if (token !== "" && !CANVAS_MARKERS.includes(token)) out.add(token);
    }
  }
  return [...out].sort();
}

/** React Flow's own markers. They ride on the same `className` as the region
 *  they govern and they are not regions: they tell the canvas to keep its hands
 *  off a wheel or a drag, and this stylesheet never styles them. Pinned below,
 *  because an exclusion nobody checks is how a derivation goes quietly blind. */
const CANVAS_MARKERS = ["nowheel", "nodrag"];

/** The px bound flowmap.css puts on a class, wherever it puts it. */
function cssBoundOf(token: string): number | null {
  const re = new RegExp(`(^|[\\s,>+~])\\.${token}\\b[^{}]*\\{([^}]*)\\}`, "gm");
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) {
    const cap = /(?:^|\s)(?:max-)?height:\s*(\d+(?:\.\d+)?)px/.exec(m[2]);
    if (cap !== null) best = best === null ? Number(cap[1]) : Math.min(best, Number(cap[1]));
  }
  return best;
}

/** Whether what is past that bound can still be reached. */
function scrollsPastItsBound(token: string): boolean {
  const re = new RegExp(`(^|[\\s,>+~])\\.${token}\\b[^{}]*\\{([^}]*)\\}`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS)) !== null) {
    if (/overflow(-y)?:\s*(auto|scroll)/.test(m[2])) return true;
  }
  return false;
}

describe("the derivation, before it is believed", () => {
  // A derivation that finds nothing would make every assertion below vacuously
  // green — the failure mode this whole file is built against. These four are
  // the regions the measurement pass walked; the derivation has to at least
  // reach them, and it is free to find more.
  it("finds the regions the browser was measured on", () => {
    expect(growthRegions()).toEqual(
      expect.arrayContaining(["pf-tools", "pf-phases__list", "pf-ctx", "pf-shots"]),
    );
  });

  // The other direction: a derivation that swept up every `.map(` in the file
  // would report the token arithmetic in the card's head as a region and send
  // whoever reads this on a hunt for a bound that makes no sense. The card's
  // head is the nearest classed container above that line, so it is what a
  // too-eager rule reports.
  it("does not mistake a map that renders nothing for a region", () => {
    expect(agentCardSource()).toContain("(d.ctxParts ?? []).map((p) => p.estTokens)");
    expect(growthRegions()).not.toContain("pf-agent__head");
  });

  it("reads the agent card and not the worker card that shares its markup", () => {
    expect(agentCardSource()).not.toContain("export function SubagentNode");
  });

  // The exclusion, checked rather than trusted: the moment one of these markers
  // is given a box, dropping it from the derivation is hiding a real region.
  it.each(CANVAS_MARKERS)("only ever drops .%s, which this stylesheet never styles", (marker) => {
    expect(CSS, `.${marker} has grown a rule and can no longer be treated as a marker`).not.toMatch(
      new RegExp(`(^|[\\s,>+~])\\.${marker}\\b[^{}]*\\{`, "m"),
    );
  });
});

describe("every growth region states a bound", () => {
  it.each(growthRegions())("%s is bounded in the stylesheet", (token) => {
    expect(cssBoundOf(token), `.${token} must state a height bound`).not.toBeNull();
  });
});

describe("a bound is not allowed to be a clip", () => {
  // The rule, and the reason it is a rule rather than a preference: the tool
  // panel is the region that causes 99.8 % of this card's movement, and it is
  // also the region carrying the command the owner is reading when he steps.
  // Budgeting it and then cutting it off would trade a card that jumps for a
  // card that lies.
  it.each(growthRegions())("%s hands back what is past its bound", (token) => {
    expect(scrollsPastItsBound(token), `.${token} caps its content without a way to reach it`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The second obligation: the reader's wheel has to reach what the bound put
// past the edge. Derived from the stylesheet, so a region bounded next year is
// judged the same way — and it has to be derived, because the sentence at the
// head of flowmap.css's own budget block already claimed this ("the ones the
// reader's pointer can land in carry `nowheel`") while two of the regions it
// was written about did not carry it.
// ---------------------------------------------------------------------------

/** Every class the budgeted card gives a scroll to, out of the stylesheet. */
function budgetedScrollRegions(): string[] {
  const out = new Set<string>();
  const rule = /(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(CSS)) !== null) {
    if (!m[2].includes(".pf-agent--wide")) continue;
    if (!/overflow(-y)?:\s*(auto|scroll)/.test(m[3])) continue;
    for (const token of (m[2].trim().split(/\s+/).pop() ?? "").split(".")) if (token !== "") out.add(token);
  }
  out.delete("pf-agent--wide");
  return [...out].sort();
}

/** The markup of the card and of the panels it renders — one file is not
 *  enough: `.pf-toolbody`, the region that caused 99.8 % of the movement, lives
 *  in ToolCallPanel.tsx. */
const CARD_MARKUP = () => agentCardSource() + read("ToolCallPanel.tsx");

/** Every class list the markup gives an element carrying `token`. */
function classListsFor(token: string): string[] {
  const out: string[] = [];
  for (const m of CARD_MARKUP().matchAll(CLASS_NAME)) {
    const list = m[1] ?? m[2];
    if (list.split(/\s+/).includes(token)) out.push(list);
  }
  return out;
}

describe("a bound the wheel cannot reach past is a clip with a scrollbar on it", () => {
  it("finds the regions the stylesheet gives a scroll to", () => {
    const found = budgetedScrollRegions();
    expect(found.length, "no scroll region derived — everything below is vacuous").toBeGreaterThan(3);
    expect(found).toEqual(expect.arrayContaining(["pf-ctx", "pf-toolbody", "pf-tools"]));
  });

  it.each(budgetedScrollRegions())("%s keeps the canvas off the reader's wheel", (token) => {
    const lists = classListsFor(token);
    expect(lists, `.${token} scrolls but nothing in the card renders it`).not.toEqual([]);
    for (const list of lists) {
      expect(
        list.split(/\s+/),
        `.${token} scrolls, and a wheel over it zooms the map instead of scrolling it`,
      ).toContain("nowheel");
    }
  });
});

// ---------------------------------------------------------------------------
// The panel labels. `.pf-agent--wide .pf-panelbox__label` holds each of them to
// ONE line, and that declaration is load-bearing: its own comment records the
// two steps out of 300 where a long MCP tool name wrapped `Tool call · <name>`
// and took the budgeted card 1178.59 -> 1194.09. Nothing held it — deleting the
// rule outright left all 80 cases of this card green — and nothing held the
// other half either: clipping a label to one line loses the end of it, and only
// the tool panel's label handed the whole string back in a `title`. Measured on
// the shipped Image-generation scenario, the context panel's own label rendered
// "CONTEXT SENT TO THE LLM · 1,091 / 100,000 T…" — the panel whose entire job is
// that number, cut off inside the number.
// ---------------------------------------------------------------------------
describe("a label held to one line still reads whole", () => {
  const labelRule = () => {
    const at = CSS.indexOf(".pf-agent--wide .pf-panelbox__label");
    expect(at, "the budgeted card must hold its panel labels to one line").toBeGreaterThan(-1);
    return CSS.slice(at, CSS.indexOf("}", at));
  };

  it("holds every panel label to one line", () => {
    expect(labelRule()).toMatch(/white-space:\s*nowrap/);
    expect(labelRule()).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("and hands back what the ellipsis took", () => {
    const markup = CARD_MARKUP();
    const opens = [
      ...markup.matchAll(/<(\w+)([^<>]*\bclassName="[^"]*\bpf-panelbox__label\b[^"]*"[^<>]*)>/g),
    ];
    expect(opens.length, "no panel label found — this case would pin nothing").toBeGreaterThan(2);
    for (const open of opens) {
      expect(open[2], `a panel label is clipped to one line with no way to read the rest`).toMatch(
        /\btitle=/,
      );
    }
  });
});

describe("nothing that is legible today gets smaller", () => {
  // Every bound that exists NOW is a floor for the bound that replaces it. A
  // budget is allowed to reserve more room; it is not allowed to take reading
  // room away, and "the card stopped moving" is no defence for "the command no
  // longer fits". Each number is read out of the file that owns it, so this
  // stays true when the owner moves.
  const capIn = (source: string, pattern: RegExp, what: string): number => {
    const m = pattern.exec(source);
    expect(m, `${what} must state a cap`).not.toBeNull();
    return Number(m![1]);
  };

  it("keeps the tool-call panel at least as tall as it reads today", () => {
    // 240 since card 287 — "the widened stations and worker cards afford a
    // panel a person can actually read".
    expect(capIn(read("ToolCallPanel.tsx"), /maxHeight:\s*(\d+)/, "ToolCallPanel")).toBeGreaterThanOrEqual(
      240,
    );
  });

  it("keeps the system prompt and the LLM streams at least as tall as they read today", () => {
    expect(cssBoundOf("pf-prose")).toBeGreaterThanOrEqual(120);
    expect(cssBoundOf("pf-llm__streams")).toBeGreaterThanOrEqual(260);
  });

  it("still shows every picture the card is allowed to hold", () => {
    // MAX_CARD_SHOTS bounds the COUNT, and the measurement says six of them
    // stack 330.9 px in two rows. A bound on the STRIP under that would cut the
    // sixth picture off inside its own row.
    //
    // The strip is not the only box between the reader and that picture, and
    // this case does not claim it is: `.pf-shots` sits inside
    // `.pf-agent__shelf`, which reserves 380 and also holds the generated-
    // picture panel, so a run carrying both reaches the last of the six by
    // scrolling the shelf. That is a declared scroll with `nowheel` on it,
    // judged by the wheel cases above — not a picture nobody can get to.
    const strip = cssBoundOf("pf-shots");
    expect(strip, ".pf-shots must state a bound before this can be judged").not.toBeNull();
    expect(strip).toBeGreaterThanOrEqual(330.9);
  });
});
