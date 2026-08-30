// CARD 319, the load-bearing pin: the agent card must be the SAME BOX on every
// step. The owner's words: "it really goes back and forth, flick, flick, flick,
// it flickers the whole time when you step through, depending on how big the
// command is."
//
// WHAT THIS FILE CAN AND CANNOT SEE, said plainly, because the honest half
// matters more than the assertion.
//
// It cannot see a pixel. The gate runs on node with no layout engine, so a
// height here would be a number I typed, and a geometry assertion against
// invented numbers is not a test. The pixels are measured in a real browser by
// cardStillness.ts's arm (cardStillness.test.ts), which reads the rectangles
// React Flow measured and says so out loud when they move.
//
// What it CAN see is the thing the browser turns into a height: WHAT THE CARD
// RENDERS. The measurement pass says that is very nearly the whole story: over
// the owner's own 3328 steps the card's height changed on 931, and the
// tool-call panel — created on `tool_call`, destroyed on `tool_result` —
// changed on 929 of those 931 (99.8 %). The picture shelf changed on 2. No
// other region changed on any step.
//
// So this file steps a REAL recording through the REAL fold and renders the
// REAL component, and measures what came out. Nothing is asserted about a
// style property: `min-height: 780px` typed onto `.pf-agent` would leave every
// assertion below exactly as red as it was, because the panel would still
// appear and disappear inside it.
//
// WHERE THE CENSUS STOPS, and why it was WRONG when this file was written.
//
// The first draft read the whole card and demanded one composition for the
// whole run, on the sentence "a card whose composition changes between two
// steps cannot have the same height on both". That sentence is false, and the
// fix for this card is what makes it false: a region with a FIXED height and a
// scroll can change everything inside it and cannot move the card by a pixel.
//
// It is also unreachable as written, which is how the error showed itself.
// Over this recording the card takes four compositions, and two of them differ
// ONLY inside `.json-*` — one `run_command` JSON tree against another. The only
// way to make that markup constant is to stop rendering the tool call as a tree
// at all, which would take card 120's two faces off the hub card. A proxy that
// can only be satisfied by deleting a feature is a bad proxy for "the card does
// not move", which is what AC 1 actually asks and what the browser actually
// measures.
//
// So the census now folds a RESERVE into a single entry: it counts the reserved
// box itself — so a region appearing or vanishing is still caught, and that is
// the defect — and does not descend into it. Which classes those are is DERIVED
// from flowmap.css (a fixed `height` plus a scroll, inside the expanded hub's
// own scope), never listed here, and two cases below prove the rule is doing
// something: the JSON tree is in the markup and is not in the census.
//
// THE RECORDING. docs/sample-runs/workflow-phases.en.jsonl — 196 frames, the
// one transcript that ships with the repo, so CI can step it. It is NOT the
// owner's own run: his is 11.8 MB with pictures attached, and the measurement
// pass found this sample reproduces only part of his complaint (its tool names
// are short, so the status band never wraps). It does carry the mechanism —
// 31 tool_call/tool_result pairs — and stepping it moves the card on eleven of
// its 195 clicks, which is what the cases below are about. (An earlier draft
// read more into that than was there: his run and this sample both have a step
// 18 -> 19 that moves the card, and it called that one finding confirmed twice.
// Two files, one index.) The picture shelf gets its own stepping case, built on
// the real attachment_image shape, because the shipped sample has none.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { agentDirectory } from "../agentDirectory";
import { foldSeatPool } from "./workerGrid";
import { MAX_CARD_SHOTS, deriveDetail, sceneToFlow } from "./sceneToFlow";
import { ExpandAllContext } from "./expandContext";

// The canvas package needs its store; these pins are about OUR markup, so the
// handles are stubbed exactly as nodeCards.test.tsx stubs them.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { AgentCardBody, type AgentData } from "./nodes";

const SAMPLE = new URL("../../../../docs/sample-runs/workflow-phases.en.jsonl", import.meta.url);
const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
const CSS = read("flowmap.css");

/** Both spellings a container's class can take in these files: a plain string,
 *  and a template literal whose literal head runs until its first `$`. Built
 *  from a string rather than written as a literal so the backtick reads without
 *  escaping — the same matcher agentCardRegions.test.ts derives its regions
 *  with, and blind to neither spelling for the same reason. */
const CLASS_NAME = new RegExp('className=(?:"([^"{}]*)"|\\{`([^`$]*))', "g");

/** The pane the measurement pass ran on: 1600x900 window, .pf-flow 1272x581. */
const PANE_ASPECT = 1272 / 581;

/**
 * Class tokens that cannot move a box, and are therefore not composition.
 *
 * ONE entry, and it is PINNED rather than trusted — the test below reads
 * `.pf-pulse` out of flowmap.css and fails if it ever grows a property with a
 * box in it. Without the exclusion this census reports the status dot starting
 * and stopping its pulse as a change of shape, which is a false red: the dot is
 * the same 7x7 span either way. An exclusion list nobody checks is how a census
 * goes quietly blind, so this one is checked.
 */
const NO_BOX_TOKENS = ["pf-pulse"];

/**
 * The boxes the card RESERVES — a class flowmap.css gives a fixed height AND a
 * scroll, inside the expanded hub's own scope. The census counts such a box and
 * does not look inside it, because nothing inside it can move the card.
 *
 * DERIVED, and it has to be. A list typed here would be the card-312 defect
 * word for word — "a hand list, guarded by a test that types the same hand
 * list, is not a guard, it is two copies of the same lie" — and the day someone
 * reserves a fifth region the census would go on reporting its contents as a
 * change of shape, red about something that cannot happen.
 *
 * A `height`, never a `max-height`: a max-height still collapses when its
 * region is empty, and a region that collapses is a region that moves the card.
 * That is exactly the difference between the shelf before this card and after.
 */
const RESERVED_BOXES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  // Comments off FIRST — the scrubKeepsItsWidth lesson: a `}` inside a comment
  // ends an extracted rule early, and everything judged after it is judged on a
  // rule that is not there.
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(bare)) !== null) {
    const selector = m[2].trim();
    const body = m[3];
    if (!selector.includes(".pf-agent--wide")) continue;
    if (!/(^|[\s;])height:\s*\d/.test(body)) continue;
    if (!/overflow(-y)?:\s*(auto|scroll)/.test(body)) continue;
    for (const token of (selector.split(/\s+/).pop() ?? "").split(".")) {
      if (token !== "") out.add(token);
    }
  }
  return out;
})();

/** React renders these without a closing tag, so they never open a level. */
const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "source"]);

/** One element, by tag and by the classes that carry its box.
 *
 *  BEM modifiers (`--`) are dropped on purpose and the rule is structural, not
 *  a convenience: `pf-chip--on` and `pf-row--lit` recolour an element that is
 *  already there, while `pf-panelbox` and `pf-ctx__row` ARE the element. */
function boxOf(tag: string, attrs: string): string {
  const cls = /class="([^"]*)"/.exec(attrs);
  const tokens = (cls?.[1] ?? "")
    .split(/\s+/)
    .filter((c) => c !== "" && !c.includes("--") && !NO_BOX_TOKENS.includes(c))
    .sort();
  return tokens.length === 0 ? tag : `${tag}.${tokens.join(".")}`;
}

/**
 * What the card RENDERS, as a string: every element in order, down to the
 * reserved boxes and no further.
 *
 * Text and every attribute except class are dropped — a longer command inside
 * the same box is the browser's business, not the composition's.
 */
function composition(markup: string): string[] {
  const out: string[] = [];
  const token = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let depth = 0;
  /** The depth the current reserve was opened at, or null outside one. */
  let reservedAt: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = token.exec(markup)) !== null) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing === "/") {
      depth--;
      if (reservedAt !== null && depth <= reservedAt) reservedAt = null;
      continue;
    }
    if (reservedAt === null) out.push(boxOf(tag, attrs));
    if (selfClose === "/" || VOID_TAGS.has(tag)) continue;
    if (reservedAt === null) {
      const classes = (/class="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/);
      if (classes.some((c) => RESERVED_BOXES.has(c))) reservedAt = depth;
    }
    depth++;
  }
  return out;
}

/** The first place two compositions part company, as something a reader can act on. */
function firstDifference(a: string[], b: string[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `at element ${i}: ${a[i] ?? "(nothing)"} -> ${b[i] ?? "(nothing)"}`;
  }
  return "(identical)";
}

const readSample = (): RunEvent[] =>
  readFileSync(SAMPLE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);

/** The agent hub's card as the expanded map renders it after `applied`, as
 *  markup — for the few cases that have to see INSIDE a reserve. */
function agentCardMarkup(applied: RunEvent[]): string {
  const scene = applied.reduce(advanceScene, initialScene());
  const flow = sceneToFlow(scene, deriveDetail(applied), {
    provider: "ollama",
    model: "m",
    expanded: true,
    paneAspect: PANE_ASPECT,
    pool: foldSeatPool(applied),
    dir: agentDirectory(applied),
    systemPrompt: "you are a careful agent",
  });
  const agent = flow.nodes.find((n) => n.id === "agent");
  expect(agent, "the map always has an agent hub").toBeDefined();
  return renderToStaticMarkup(
    <ExpandAllContext.Provider value={true}>
      <AgentCardBody data={agent!.data as unknown as AgentData} />
    </ExpandAllContext.Provider>,
  );
}

/** The same card, as the census reads it. */
function agentCardAfter(applied: RunEvent[]): string[] {
  return composition(agentCardMarkup(applied));
}

/** A hub carrying nothing at all — the state the owner's run spends 6.5 % of
 *  its steps in, and the one the card used to be 364px tall in. */
const BARE: AgentData = {
  active: true,
  error: false,
  focus: "agent",
  activity: { text: "thinking", color: "var(--sand)" },
  gate: "none",
  gateNote: "ready",
  gateColor: "var(--border-strong)",
  activeTool: null,
  ctxParts: null,
  ctxTotals: null,
  prompt: "go",
  systemPrompt: "sys",
  tool: null,
  genImage: null,
  attached: null,
};

const render = (d: AgentData, budget = true) =>
  composition(
    renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <AgentCardBody data={d} budget={budget} />
      </ExpandAllContext.Provider>,
    ),
  );

/** Every step of a recording, folded the way the lab folds it: prefix by prefix. */
function stepThrough(events: RunEvent[]): string[][] {
  return events.map((_, i) => agentCardAfter(events.slice(0, i + 1)));
}

/** Each step whose card is not the card of the step before it. */
function moves(series: string[][]): string[] {
  const out: string[] = [];
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    if (a.join(" ") !== b.join(" ")) out.push(`step ${i} -> ${i + 1} ${firstDifference(a, b)}`);
  }
  return out;
}

describe("the instrument, before it is believed", () => {
  // A census that answers the same thing for every card would make every
  // assertion below green while the card flickered on. Two cards that plainly
  // differ have to come out different, or nothing here means anything.
  //
  // The control is the UNBUDGETED card — `budget={false}`, the worker card's
  // rendering and what the hub itself rendered before this card. That is the
  // point of the control: the very difference the budget removes (a tool panel
  // that is there on one step and gone on the next) has to be a difference the
  // census can still see, or a green below would mean nothing at all.
  it("tells two differently composed cards apart", () => {
    const withTool: AgentData = { ...BARE, tool: { name: "run_command", input: { command: "ls" } } };
    expect(render(BARE, false).join(" ")).not.toBe(render(withTool, false).join(" "));
  });

  // The reserve rule, bitten from both sides on a real card. Without the first
  // assertion the rule could quietly match nothing and this file would be back
  // to reading the whole card; without the second it could match the card ROOT
  // and report one entry for everything, green forever about a card that
  // flickered on.
  it("looks inside everything the stylesheet did not fix a box for", () => {
    const card = agentCardAfter(readSample());
    expect(RESERVED_BOXES.size, "no reserve derived — the rule matched nothing").toBeGreaterThan(0);
    expect(card.length, "the census folded the whole card into a stub").toBeGreaterThan(30);
    expect(card).toContain("div.pf-panelbox");
  });

  // And the bite that says the folding really happens, on the region that
  // caused 99.8 % of the movement: the tool call's JSON tree is in the markup,
  // and it is not in the census, because it sits in a box whose height is fixed.
  it("does not look inside the tool call's own box", () => {
    // A prefix with a call actually in flight — the last step of the recording
    // has none, and an empty panel would make this case agree with itself.
    const inFlight = readSample().slice(0, 5);
    expect(agentCardMarkup(inFlight), "no call in flight at this step").toContain("json-tree");
    expect(agentCardAfter(inFlight).filter((e) => e.includes(".json-"))).toEqual([]);
    expect([...RESERVED_BOXES]).toContain("pf-toolbody");
  });

  // The one class this census throws away, and the reason it is allowed to:
  // `.pf-pulse` sets an animation and the keyframes move `opacity`. The moment
  // it grows a property with a box in it, this exclusion is hiding a real
  // change of shape and has to go — so it is read out of the stylesheet rather
  // than remembered.
  it("only ever drops a class that cannot move a box", () => {
    for (const token of NO_BOX_TOKENS) {
      const at = CSS.indexOf(`\n.${token} {`);
      expect(at, `.${token} must exist in flowmap.css`).toBeGreaterThan(-1);
      const body = CSS.slice(at + 1, CSS.indexOf("}", at));
      expect(body.replace(/\s+/g, " ").trim(), `.${token}`).toMatch(/^\.[\w-]+ \{ animation: [^;]+;$/);
    }
  });
});

describe("stepping the shipped recording, the agent card is one card", () => {
  const events = readSample();
  const series = stepThrough(events);

  it("reads the whole recording — a short read would make the rest of this file cheap", () => {
    expect(events.length).toBeGreaterThanOrEqual(196);
    expect(series).toHaveLength(events.length);
  });

  // THE ONE. Distinct compositions, over the whole run.
  //
  // Today: 4. The system prompt alone; + the context bars once `context_info`
  // lands; + the tool-call panel, which then comes and goes; and the two of
  // those the run holds longest. Each is a different height, and the owner sees
  // every change between them as the card jumping.
  it("renders exactly one composition from the first step to the last", () => {
    const distinct = new Map<string, number>();
    for (const step of series) {
      const key = step.join(" ");
      distinct.set(key, (distinct.get(key) ?? 0) + 1);
    }
    expect(
      [...distinct.values()].sort((a, b) => b - a),
      `${distinct.size} distinct cards`,
    ).toEqual([series.length]);
  });

  // The same fact told the way the owner meets it: how many clicks change the
  // card under his cursor. Today 11 of 195, and step 18 -> 19 is among them.
  // The measurement pass also named a step 18 -> 19, at 180.6 px — but that was
  // his own 3328-step recording and this is the 196-frame sample, so the two
  // are the same index in two different files and not one finding confirmed
  // twice. What this list is worth is what it says: eleven clicks out of 195
  // change the card, on a recording anyone can step.
  it("never changes shape from one step to the next", () => {
    expect(moves(series)).toEqual([]);
  });

  // The mechanism, isolated, so a fix cannot be credited to something else: the
  // tool panel exists only while a call is in flight. `sceneToFlow` clears
  // `detail.tool` on `tool_result`, so the card loses a whole panel between the
  // call and its answer and grows it back on the next call.
  it("keeps the tool-call panel's box whether or not a call is in flight", () => {
    const boxes = (step: string[]) => step.filter((e) => e === "div.pf-panelbox").length;
    const counts = new Set(series.map(boxes));
    expect(
      [...counts].sort((a, b) => a - b),
      "panel boxes per step",
    ).toHaveLength(1);
  });
});

describe("stepping a recording that carries pictures", () => {
  // The shelf is the other half of the owner's run and the shipped sample has
  // none, so it is stepped here on the real `attachment_image` shape (the frame
  // `deriveDetail` reads through `asAttachment`). It is a floor-raise rather
  // than a flicker — `deriveDetail` accumulates and caps at MAX_CARD_SHOTS —
  // but a floor that arrives on step 4 still moves the card on step 4, and it
  // is what carries the card through its seat. Six shots is the cap, so six is
  // what a budgeted card has to hold from the first frame.
  const shot = (i: number): RunEvent =>
    ({
      type: "attachment_image",
      agentId: "main",
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      note: `screenshot ${i}`,
      ts: 1783000000000 + i,
    }) as unknown as RunEvent;

  const events: RunEvent[] = [
    {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "look at these",
      provider: "ollama",
      ts: 1783000000000,
    } as RunEvent,
    ...Array.from({ length: MAX_CARD_SHOTS }, (_, i) => shot(i)),
  ];

  it("arrives at the shelf's cap — otherwise this case pins nothing", () => {
    // Read out of the MARKUP, not the census: the shelf is a reserve, so the
    // census folds it into one entry and cannot see a picture inside it. That
    // is the whole point — a picture arriving cannot move a box whose height is
    // fixed — but this case still has to know the pictures really arrived, or
    // the one below it would be green about an empty shelf.
    expect(agentCardMarkup(events).match(/class="pf-shot"/g) ?? []).toHaveLength(MAX_CARD_SHOTS);
  });

  it("holds the same card while the pictures arrive", () => {
    expect(moves(stepThrough(events))).toEqual([]);
  });
});

describe("the panel a run can produce late", () => {
  // The system prompt is the one panel the stepped recording above CANNOT
  // judge: it does not come from the fold at all — FlowMap is handed it as a
  // prop, off /api/context — so every step of that walk gets the same prompt
  // and the panel is there either way. In the running app it arrives when the
  // fetch lands, which can be step 40, and unbudgeted that grew the card on
  // step 40. So it is pinned head-on instead.
  //
  // This gap was found by BITING it: removing `|| budgeted` from the system
  // panel left all 78 cases green, which is a reserve nothing was holding.
  const withPrompt = BARE;
  const without: AgentData = { ...BARE, systemPrompt: null };

  it("holds the same panels whether the system prompt has arrived or not", () => {
    expect(render(without)).toEqual(render(withPrompt));
  });

  // The bite, kept: unbudgeted it really is a different card, so the case above
  // is saying something about the budget rather than about two identical
  // inputs.
  it("and is a different card without the budget", () => {
    expect(render(without, false)).not.toEqual(render(withPrompt, false));
  });
});

// ---------------------------------------------------------------------------
// A PANEL THAT IS ALWAYS THERE IS NOT YET A PANEL THAT HOLDS ITS ROOM.
//
// The case above was the whole answer for the system prompt, and it was the
// wrong half of the answer. It compares COMPOSITIONS, and a composition drops
// text on purpose — so it is green whether the prose renders 16.50 px or
// 120.00. Measured in the running app at a 1600x900 window, with /api/context
// held back nine seconds so the fetch really landed mid-run, the same card
// that this file called still went
//
//   before the answer arrives   1075.09 world px   .pf-prose  16.50
//   after it arrives            1178.59 world px   .pf-prose 120.00
//
// and the product's own runtime arm said so, unprompted, on the shipped
// recording: "the agent card changed its box between two steps — 104.0px of
// height and 0.0px of screen top in one click."
//
//   node /tmp/c319fix/prose.mjs   # playwright + Chrome, frames counted first
//                                 # (61 per 500 ms), CTX_DELAY=9000 on the mock
//
// The cause is a CAP where the card needs a RESERVE. `.pf-prose` stated
// `max-height: 120px` and nothing else, and a max-height collapses when its
// region is short — which is the very rule RESERVED_BOXES above is written on:
// "a max-height still collapses when its region is empty, and a region that
// collapses is a region that moves the card".
//
// So the pin is not "the panel is rendered". It is: every panel the BUDGET
// forces onto the card has a body whose box is FIXED. Derived from the source,
// because a typed list of three panels would be green the day a fourth arrives
// — the exact way this one shipped.
// ---------------------------------------------------------------------------

/** The scroll regions flowmap.css declares, by class — a class it gives
 *  `overflow-y: auto|scroll` anywhere. A region that scrolls is a region whose
 *  content is bigger than its box, which is only a fact about the card's height
 *  if the box is fixed. */
/** The agent card's own markup, and nothing else's. */
function agentCardSource(): string {
  const nodes = read("nodes.tsx");
  const from = nodes.indexOf("export function AgentCardBody(");
  const to = nodes.indexOf("export function AgentNode(");
  expect(from, "AgentCardBody must exist").toBeGreaterThan(-1);
  expect(to, "AgentNode must follow it").toBeGreaterThan(from);
  return nodes.slice(from, to);
}

function scrolls(token: string): boolean {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`(^|[\\s,>+~])\\.${token}\\b[^{}]*\\{([^}]*)\\}`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) if (/overflow(-y)?:\s*(auto|scroll)/.test(m[2])) return true;
  return false;
}

/**
 * Every panel the budget forces onto the card, with the scrolling bodies inside
 * it — read out of `AgentCardBody`, never listed here.
 *
 * A panel written `<condition> || budgeted ?` (or `budgeted || <condition> ?`)
 * is one the budgeted card renders on EVERY step, so whatever scrolls inside it
 * is carrying the card's height. A panel that renders another component hands
 * the question on, so the derivation follows that one hop and reads its file —
 * without it the tool-call panel, the region that caused 929 of the owner's 931
 * height changes, would not be judged here at all.
 */
function budgetedPanelBodies(): { panel: string; bodies: string[] }[] {
  const src = agentCardSource();
  const out: { panel: string; bodies: string[] }[] = [];
  const decl = /const (\w+) =\s*\n?\s*([^;]*?)\?\s*(\(?)/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) {
    if (!/\bbudgeted\b/.test(m[2])) continue;
    // `noToolPanel` is the mirror image — budgeted, its branch is `null`, so it
    // is a panel the budget takes AWAY and has no body to hold a box.
    if (m[3] === "" && /^\s*null\b/.test(src.slice(decl.lastIndex))) continue;
    const end = src.indexOf(": null;", decl.lastIndex);
    expect(end, `${m[1]} must end in a : null branch`).toBeGreaterThan(-1);
    let jsx = src.slice(decl.lastIndex, end);
    // One hop into a component the panel renders, so its body is judged too.
    for (const ref of new Set([...jsx.matchAll(/<([A-Z]\w+)\b/g)].map((c) => c[1]))) {
      try {
        jsx += read(`${ref}.tsx`);
      } catch {
        /* not a file of ours; its classes cannot be in flowmap.css either */
      }
    }
    const tokens = new Set<string>();
    for (const cls of jsx.matchAll(CLASS_NAME)) {
      for (const token of (cls[1] ?? cls[2]).split(/\s+/)) if (token !== "") tokens.add(token);
    }
    out.push({ panel: m[1], bodies: [...tokens].filter(scrolls).sort() });
  }
  return out;
}

describe("the panel derivation, before it is believed", () => {
  it("finds the three panels the budget forces on, and a body in each", () => {
    const found = budgetedPanelBodies();
    expect(found.map((p) => p.panel).sort()).toEqual(["ctxBarsPanel", "sysPanel", "toolPanel"]);
    for (const p of found) expect(p.bodies, `${p.panel} has no scrolling body`).not.toEqual([]);
  });

  // The other direction: a derivation that called every classed element a body
  // would demand a fixed height for the panel frame itself and for the label
  // inside it, and this file would be red about boxes that cannot move.
  it("does not mistake the panel frame for the body that carries its height", () => {
    const all = budgetedPanelBodies().flatMap((p) => p.bodies);
    expect(all).not.toContain("pf-panelbox");
    expect(all).not.toContain("pf-panelbox__label");
  });
});

describe("every panel the budget forces on states a fixed box", () => {
  it.each(budgetedPanelBodies().flatMap((p) => p.bodies.map((b) => [p.panel, b] as const)))(
    "%s's .%s is a reserve and not a cap",
    (panel, body) => {
      expect(
        RESERVED_BOXES.has(body),
        `.${body} scrolls inside ${panel} but flowmap.css never fixes its height, so it ` +
          `collapses when it is short and the card moves when it fills`,
      ).toBe(true);
    },
  );
});

describe("compact is already still, and stays that way", () => {
  // Measured over the shipped recording in the browser: 394.02 px, one value,
  // zero changes — the context (and with it the tool panel) sits inside a
  // closed Disclosure, so none of this reaches the reader. The flicker is an
  // expanded-view defect, and a fix that budgets the expanded card must not
  // start moving the compact one.
  it("renders one compact card across the whole recording", () => {
    const events = readSample();
    const series = events.map((_, i) => {
      const applied = events.slice(0, i + 1);
      const scene = applied.reduce(advanceScene, initialScene());
      const flow = sceneToFlow(scene, deriveDetail(applied), {
        provider: "ollama",
        model: "m",
        pool: foldSeatPool(applied),
        dir: agentDirectory(applied),
        systemPrompt: "you are a careful agent",
      });
      const agent = flow.nodes.find((n) => n.id === "agent")!;
      return composition(renderToStaticMarkup(<AgentCardBody data={agent.data as unknown as AgentData} />));
    });
    expect(moves(series)).toEqual([]);
  });
});
