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
// WHAT IS UNBOUNDED TODAY, measured in the browser:
//
//   .pf-shots      the hub's picture shelf. Uncapped in CSS by design and
//                  nodes.tsx:170 states the exemption in words ("The agent hub's
//                  shelf is uncapped and stays a plain block"); only
//                  `.pf-sub--full .pf-agent__genfull` carries card 296's 172 cap.
//                  Its only bound is the TypeScript MAX_CARD_SHOTS = 6, which
//                  bounds the COUNT and not the pixels: measured 0 -> 187.7
//                  (one row) -> 330.9 (two rows).
//   .pf-ctx        the context bars. No bound of any kind, 22.27 px per row,
//                  forever. Seven more rows took a measured card from 1188.29
//                  to 1344.20 — which is why the seat in agentCardSeat.test.ts
//                  stops at the bounded regions and says so.
//
// A BOUND MUST NOT BECOME A CLIP. flowmap.css says it itself, at the workflow
// box: "content is capped and CLIPPED — a max-height alone stops the box
// growing". A budgeted card that hides the command the owner is looking at is
// a worse defect than the flicker it fixed, so every bound here has to come
// with a way to reach what is past it.
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
    for (const token of (cls![1] ?? cls![2]).split(/\s+/)) if (token !== "") out.add(token);
  }
  return [...out].sort();
}

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
    // stack 330.9 px in two rows. A shelf bound under that turns the sixth
    // picture into a scroll nobody knows is there.
    const shelf = cssBoundOf("pf-shots");
    expect(shelf, ".pf-shots must state a bound before this can be judged").not.toBeNull();
    expect(shelf).toBeGreaterThanOrEqual(330.9);
  });
});
