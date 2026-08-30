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
// It stops at a SECOND kind of box since the 0.11.0 merge, and for the same
// reason: a fixed-column grid whose height is its row count. That one is card
// 321's tenth chip against this card's proxy, and the whole story is at
// CELL_GRIDS below.
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
import { agentBelt } from "./belt";
import { foldSeatPool } from "./workerGrid";
import { MAX_CARD_SHOTS, deriveDetail, sceneToFlow } from "./sceneToFlow";
import { ExpandAllContext } from "./expandContext";
import { type Scope, type ScopedRule, gridsOf, keptToOneLine, reservesOf, rulesOf } from "./cssScope";

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
 * scroll. The census counts such a box and does not look inside it, because
 * nothing inside it can move the card.
 *
 * DERIVED, and it has to be. A list typed here would be the card-312 defect
 * word for word — "a hand list, guarded by a test that types the same hand
 * list, is not a guard, it is two copies of the same lie" — and the day someone
 * reserves a fifth region the census would go on reporting its contents as a
 * change of shape, red about something that cannot happen.
 *
 * PER SCOPE, and that is the correction the 0.11.0 merge review forced. The
 * first cut of this derivation demanded `.pf-agent--wide` in the selector and
 * then applied the answer by class token — so a box the stylesheet reserves for
 * the EXPANDED card was folded away on the compact one too, which wears no such
 * ancestor. It was inert only because the compact card keeps those regions
 * inside a closed disclosure and never rendered one. `cssScope.ts` reads the
 * ancestor instead of dropping it; the whole story is there.
 */
const RESERVED_BOXES: ReadonlySet<string> = reservesOf(CSS, "wide");

/** Does flowmap.css give `.<token>` this declaration ANYWHERE it names it?
 *
 *  An "anywhere" question, and only questions that stay true under "anywhere"
 *  may be asked through it: `scrolls()` at the bottom of this file asks whether
 *  a region scrolls at all, and the chip case below asks whether ANY rule lets
 *  a chip span. A question of the form "and no rule takes it back" cannot be
 *  asked here — that one is `keptToOneLine` in `cssScope.ts`, which reads every
 *  rule instead of returning on the first that agrees.
 *
 *  The `\b` after the token is what makes a BEM modifier count as the same box
 *  — `.pf-chip--foreign` answers for `pf-chip`, `.pf-ctx__row` does not answer
 *  for `pf-ctx` — which is the rule `boxOf` already reads the markup by. */
function declares(token: string, prop: RegExp): boolean {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`(^|[\\s,>+~])\\.${token}\\b[^{}]*\\{([^}]*)\\}`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) if (prop.test(m[2])) return true;
  return false;
}

/** The stylesheet as each card wears it, read once. */
const RULES: Record<Scope, ScopedRule[]> = { wide: rulesOf(CSS, "wide"), compact: rulesOf(CSS, "compact") };

/**
 * The grids whose HEIGHT IS THEIR ROW COUNT, by class -> columns. The census
 * prices such a grid by its rows and does not descend into it.
 *
 * THIS IS THE SEAM BETWEEN CARD 321 AND CARD 319, and the second way a change
 * of composition can fail to be a change of shape.
 *
 * Card 321 gives a running tool that matches no chip a chip of its own, so the
 * belt is nine chips between calls and ten while such a call is in flight —
 * 184 of this recording's 196 steps, because no chip on the belt answers for
 * any of the five tools it runs. Card 319 reads composition as its proxy for
 * height, and read those crossings as the card changing shape ten times. Both
 * halves are right about their own half. The belt is a two-column grid, nine
 * chips leave half of the last row empty, and the tenth sits in a row that is
 * already there — so nothing moved, measured in both scopes:
 *
 *    expanded    9 chips   belt 179.23   card 1178.59
 *               10         belt 179.23   card 1178.59    +0.00
 *               11         belt 216.28   card 1178.59    +0.00
 *    compact     9 chips   belt 179.23   card  394.02
 *               10         belt 179.23   card  394.02    +0.00
 *               11         belt 216.28   card  431.06   +37.04
 *
 *   npx vite --port 5233, the lab's own "Declared workflow · 5 phases, 13
 *   agents" (which IS this recording), 1600x900, both fonts loaded, frames
 *   counted before anything was believed — 1 per 600 ms, so a screenshot was
 *   taken to force the render and the second read came back byte-identical.
 *   getBoundingClientRect on `.pf-flow > .react-flow__node-agent > .pf-card`
 *   and its `.pf-tools`, divided by the viewport transform's scale; the
 *   eleventh chip cloned into the live belt and removed again.
 *
 * WHICH grid is read out of flowmap.css — a class it gives a literal
 * `grid-template-columns` — never listed here, for the reason RESERVED_BOXES
 * gives above. `repeat()` is refused because a repeat count is not a track
 * count, and a wrong column count would price the rows wrong.
 *
 * THREE CONDITIONS, all read and not assumed, because rows only price a grid
 * whose rows are ONE height:
 *
 *   - every cell is the same box. A context row is a label, a bar and a
 *     number, so it fails this one and is read element by element as before.
 *   - the stylesheet keeps that box to one line, in EVERY rule that touches it
 *     (`keptToOneLine`, not "some rule says nowrap" — a modifier can take it
 *     back, and `.pf-chip--foreign` is exactly the chip that would want to).
 *   - no cell can SPAN a second column, which the count never priced. The case
 *     below holds that door for the belt's own chips — `cardGeometry.test.ts`'s
 *     pin on `.pf-chip--foreign`, widened to every chip because the census
 *     prices the whole belt and not one cell of it.
 *
 * And the cells are DEDUPLICATED rather than dropped: a chip landing in a row
 * that is already there is a cell shape the census has already seen, while
 * anything appearing INSIDE a cell is a shape it has not — and a block child in
 * a one-line cell is a second line box. The first cut of this fold threw the
 * cells' contents away and was measured green while a region came and went
 * inside every chip.
 *
 * AND IT IS DELIBERATELY NOT THE RESERVE RULE ABOVE. `.pf-agent--wide
 * .pf-tools` states a `max-height`, which that rule refuses on purpose, and
 * promoting it to a `height` would have been the wrong repair twice over: in
 * compact this grid computes `max-height: none; overflow-y: visible` and really
 * does move the card, 394.02 -> 431.06 on a sixth row. A green there would be
 * green about something that can happen.
 *
 * Rows are true on the compact card as well — but because `cssScope.ts` asks
 * the stylesheet per scope and gets an answer, NOT because someone checked once
 * that the columns are declared without one. Move that declaration under
 * `.pf-agent--wide` and the compact walk below goes red, which is the bite.
 */
const CELL_GRIDS: ReadonlyMap<string, number> = gridsOf(CSS, "wide");

/** React renders these without a closing tag, so they never open a level. */
const VOID_TAGS = new Set(["img", "br", "hr", "input", "meta", "link", "source"]);

/** One element, by tag and by the classes that carry its box.
 *
 *  BEM modifiers (`--`) are dropped on purpose and the rule is structural, not
 *  a convenience: a modifier says the element is ALREADY THERE and dressed
 *  differently, while `pf-panelbox` and `pf-ctx__row` ARE the element. That is
 *  a statement about presence and no more than that — a modifier can change
 *  layout, and one here does (`.pf-chip--launch` sets `display: flex`), which
 *  is why the fold's "one line" condition is read out of the stylesheet across
 *  every modifier rather than inferred from this line. */
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
 * boxes whose height this file can state and no further.
 *
 * Text and every attribute except class are dropped — a longer command inside
 * the same box is the browser's business, not the composition's.
 *
 * Two boxes it stops at, and each states its height a different way. A RESERVE
 * states it outright, so its entry is the box itself. A CELL GRID states it as
 * a row count, so its entry carries that count — `…pf-tools:5rows` — and a
 * chip that lands in a row already there reads the same, while a chip that
 * opens a sixth row does not.
 */
function composition(markup: string, scope: Scope = "wide"): string[] {
  const reserved = reservesOf(CSS, scope);
  const grids = gridsOf(CSS, scope);
  const out: string[] = [];
  const token = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let depth = 0;
  /** The depth the current reserve was opened at, or null outside one. */
  let reservedAt: number | null = null;
  /**
   * The cell grid being read: the depth it opened at (-1 outside one), its
   * columns, the entry that names it, and one entry per direct cell holding
   * that cell's whole subtree. Only the outermost is priced — a grid inside a
   * grid is read as ordinary content, because its own rows are not this one's
   * rows.
   *
   * Plain fields and not one object, which is a type story and not a style
   * one: an object held in a `let` that this loop reads at the top and writes
   * at the bottom is a cycle tsc resolves by narrowing it to `never` where it
   * is read (TS2339 on every field), and vitest, which erases types, was green
   * through every round of it. Numbers and strings have no such cycle.
   */
  let gridAt = -1;
  let gridCols = 0;
  let gridHead = "";
  let gridCells: string[][] = [];
  const closeGrid = () => {
    const heads = gridCells.map((c) => c[0]);
    const cell = heads[0];
    const classes = cell === undefined ? [] : cell.split(".").slice(1);
    // Rows price a grid only when its rows are one height: one kind of cell,
    // and that kind kept to a single line by every rule that touches it.
    const priced =
      heads.length > 0 &&
      heads.every((c) => c === cell) &&
      classes.length === 1 &&
      keptToOneLine(classes[0], RULES[scope]);
    if (priced) {
      out.push(`${gridHead}:${Math.ceil(heads.length / gridCols)}rows`);
      // The cells are deduplicated, not dropped. A chip landing in a row that
      // is already there repeats a shape the census has seen; a box appearing
      // inside a cell is a shape it has not, and a block child in a one-line
      // cell is a second line box. Sorted, because a set has no order of its
      // own and the entry is about WHICH shapes, not in which order.
      out.push(...[...new Set(gridCells.map((c) => c.join(">")))].sort());
    } else out.push(gridHead, ...gridCells.flat());
    gridAt = -1;
    gridCells = [];
  };
  let m: RegExpExecArray | null;
  while ((m = token.exec(markup)) !== null) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing === "/") {
      depth--;
      if (reservedAt !== null && depth <= reservedAt) reservedAt = null;
      if (gridAt >= 0 && depth <= gridAt) closeGrid();
      continue;
    }
    const box = reservedAt === null ? boxOf(tag, attrs) : null;
    const classes = box === null ? [] : (/class="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/);
    const empty = selfClose === "/" || VOID_TAGS.has(tag);
    const reserves = classes.some((c) => reserved.has(c));
    const cols =
      box === null || empty || reserves || gridAt >= 0
        ? undefined
        : classes.map((c) => grids.get(c)).find((n) => n !== undefined);
    if (box !== null) {
      // A grid's own head waits for its rows; everything else goes out now, or
      // into the cell it is inside, in case that grid turns out not to price.
      if (gridAt < 0) {
        if (cols === undefined) out.push(box);
      } else if (depth === gridAt + 1) gridCells.push([box]);
      else gridCells[gridCells.length - 1]?.push(box);
    }
    if (empty) continue;
    if (reserves) reservedAt = depth;
    else if (cols !== undefined) {
      gridAt = depth;
      gridCols = cols;
      gridHead = box!;
    }
    depth++;
  }
  if (gridAt >= 0) closeGrid();
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

  // The distinction the doc block above rests on, bitten against a live
  // example rather than a hypothetical one. `.pf-agent--wide .pf-tools` states
  // `max-height` and a scroll — the shape of a reserve minus the one property
  // that matters — and the merge repair that promoted it to a `height` was the
  // first thing tried and the wrong answer. If the derivation ever admits a
  // cap, every "region that collapses" it was written to catch walks in.
  it("does not mistake a cap for a reserve", () => {
    const belt = /\.pf-agent--wide \.pf-tools \{([^}]*)\}/.exec(CSS);
    expect(belt, "the belt's wide rule is not where this case looks for it").not.toBeNull();
    expect(belt![1], "a cap and a scroll, which is what makes this a bite").toMatch(
      /max-height:\s*\d[^;]*;[\s\S]*overflow-y:\s*auto/,
    );
    expect([...RESERVED_BOXES], "a max-height was admitted as a reserve").not.toContain("pf-tools");
  });

  // THE OTHER FOLD, bitten the same way: it has to hide the chip that lands in
  // a row already there, and it has to show the one that opens a new row. The
  // counts are the belt's own — `agentBelt(null)` is the belt between calls,
  // and the chip card 321 adds is the one this merge went red over — so this
  // case cannot go on agreeing with itself after the belt changes size.
  const NOT_A_TOOL = "zzz-no-such-tool";
  const beltMarkup = (chips: number) =>
    `<div class="pf-tools nowheel">${'<span class="pf-chip pf-chip--tool">x</span>'.repeat(chips)}</div>`;

  it("prices the belt by its rows, and still sees a row arrive", () => {
    const cols = CELL_GRIDS.get("pf-tools");
    expect(cols, "no column count derived — the belt's grid was not read").toBeGreaterThan(0);
    const fixed = agentBelt(null).length;
    const foreign = agentBelt(NOT_A_TOOL).length;
    expect(foreign, "nothing was added, so this case measures nothing").toBe(fixed + 1);
    let sixth = foreign;
    while (Math.ceil(sixth / cols!) === Math.ceil(fixed / cols!)) sixth++;

    expect(composition(beltMarkup(foreign))).toEqual(composition(beltMarkup(fixed)));
    expect(composition(beltMarkup(sixth))).not.toEqual(composition(beltMarkup(fixed)));
    // And it is a fold, not a blindfold: the belt is its head wearing its rows
    // plus the shapes its cells take, so a belt that vanished, a belt that grew
    // a row and a chip that grew a box inside it are all still changes of shape.
    expect(composition(beltMarkup(fixed))).toEqual([
      `div.nowheel.pf-tools:${Math.ceil(fixed / cols!)}rows`,
      "span.pf-chip",
    ]);
  });

  // The half of that fold the first cut got wrong, and it was measured wrong
  // rather than argued wrong: the cells' contents were thrown away with the
  // cells, so a region appearing INSIDE every chip was invisible. The chips are
  // grid items and blockify, so a block child really is a second line box.
  it("still sees a box that appears inside the cells", () => {
    const chip = '<span class="pf-chip pf-chip--tool">x</span>';
    const hot = '<span class="pf-chip pf-chip--tool"><div class="pf-chip__hot">!</div>x</span>';
    const belt = (cells: string) => `<div class="pf-tools nowheel">${cells}</div>`;
    expect(composition(belt(chip.repeat(4)))).not.toEqual(composition(belt(hot + chip.repeat(3))));
    expect(composition(belt(chip.repeat(4)))).not.toEqual(composition(belt(hot.repeat(4))));
    // And the fold still holds where it must: the count of cells wearing a
    // shape is not the shape, so a fifth chip of a shape already there is not a
    // change — that is the whole point of pricing rows.
    expect(composition(belt(chip.repeat(4)))).toEqual(composition(belt(chip.repeat(3))));
  });

  // The refusal, on the other fixed-column grid this card renders. A context
  // row is a label, a bar and a number — three boxes of three heights — so
  // rows cannot price it, and folding it would take all three out of the
  // census. It is only ever reached inside `.pf-ctx`, which is a reserve, but
  // a rule that would be wrong there is a rule to hold off here.
  it("prices only a grid whose cells are one kind of one-line box", () => {
    expect(CELL_GRIDS.has("pf-ctx__row"), "not read as a fixed-column grid at all").toBe(true);
    const row =
      '<div class="pf-ctx__row"><span>k</span>' +
      '<span class="pf-ctx__bar"><span class="pf-ctx__fill"></span></span>' +
      '<span class="pf-ctx__tok">1</span></div>';
    expect(composition(row)).toEqual([
      "div.pf-ctx__row",
      "span",
      "span.pf-ctx__bar",
      "span.pf-ctx__fill",
      "span.pf-ctx__tok",
    ]);
  });

  // Columns are a TRACK LIST and not a word count. The belt's `1fr 1fr` reads
  // the same either way, so nothing above would notice a splitter that counted
  // words — and it would price every grid whose tracks carry a function. The
  // two in this stylesheet that do are read here, against what they declare.
  it("counts a grid's columns as tracks", () => {
    expect(CELL_GRIDS.get("pf-ctx__row"), "84px minmax(0, 1fr) auto").toBe(3);
    expect(CELL_GRIDS.get("pf-disc__body"), "minmax(0, 1fr)").toBe(1);
  });

  // The condition rows rest on that the code above cannot check per element: a
  // cell that spans two columns is a row the count never priced. This holds the
  // door for the belt's own cells and says no more than that — the same door
  // `cardGeometry.test.ts` holds for `.pf-chip--foreign`, widened to every
  // chip, because the census prices the whole belt and not one cell of it.
  it("and only while no chip can span a second column", () => {
    expect(
      declares("pf-chip", /grid-(column|area)/),
      "a chip that spans is a belt row ceil(chips / columns) does not price",
    ).toBe(false);
  });

  // The other condition, and the way it was asked wrong first. "Does some rule
  // say nowrap" is answered by `.pf-chip` and never reaches the modifier that
  // takes it back — and `.pf-chip--foreign` is precisely the chip that could
  // want to wrap, since its text is an arbitrary wire name. Both directions, on
  // a stylesheet written here so the second one is reachable at all, and then
  // the live one so the case is about the belt and not about a fixture.
  it("reads every white-space the cell wears, not the first one", () => {
    const said = ".pf-chip { white-space: nowrap; }\n";
    const takenBack = `${said}.pf-chip--foreign { white-space: normal; }\n`;
    expect(keptToOneLine("pf-chip", rulesOf(said, "wide"))).toBe(true);
    expect(keptToOneLine("pf-chip", rulesOf(takenBack, "wide"))).toBe(false);
    expect(keptToOneLine("pf-chip", rulesOf(".pf-chip { padding: 6px; }\n", "wide"))).toBe(false);
    expect(keptToOneLine("pf-chip", RULES.wide), "the belt's chips today").toBe(true);
  });

  // THE SCOPE, which is the merge review's finding and the reason `cssScope.ts`
  // exists. A selector is a claim about an ancestor, and `AgentCardBody`'s
  // markup has none: `pf-agent--wide` lives on `AgentNode`'s root, one level up.
  // A derivation that keeps only the last component of the selector credits a
  // rule written for the expanded card to the compact one — which is where the
  // belt has no cap and really does grow a row at a time.
  it("credits a rule only to the card whose ancestors can satisfy it", () => {
    // Both halves read out of the live stylesheet, so neither can go vacuous.
    expect(CSS, "the rule this case rests on").toMatch(/\.pf-agent--wide \.pf-toolbody \{/);
    expect(CSS, "the belt's columns are stated for every card").toMatch(
      /\n\.pf-tools \{[^}]*grid-template-columns/,
    );
    expect(reservesOf(CSS, "wide"), "a wide reserve").toContain("pf-toolbody");
    expect(
      reservesOf(CSS, "compact"),
      "and it is not a reserve on a card without that ancestor",
    ).not.toContain("pf-toolbody");
    expect(gridsOf(CSS, "compact").get("pf-tools"), "the belt prices on both cards").toBe(
      gridsOf(CSS, "wide").get("pf-tools"),
    );
    // And an ancestor no card here can have reaches neither.
    expect(rulesOf(".a .b .c { height: 1px; overflow-y: auto; }\n", "wide")).toEqual([]);
    expect(rulesOf(".pf-agent--wide .x { height: 1px; }\n", "compact")).toEqual([]);
  });

  // On the real card, not a probe: ten chips come out as the two shapes a chip
  // takes, and the belt is still one entry wearing its rows.
  it("folds the belt on the card the recording renders", () => {
    const markup = agentCardMarkup(readSample().slice(0, 5));
    const card = agentCardAfter(readSample().slice(0, 5));
    expect((markup.match(/class="pf-chip/g) ?? []).length, "no belt at this step").toBeGreaterThan(5);
    // A chip, and the launch chip with the fan-out mark inside it. Two shapes
    // for however many chips the belt is carrying — which is the fold — and no
    // third shape, which is what says the fold is reading and not guessing.
    expect(card.filter((e) => e.startsWith("span.pf-chip"))).toEqual([
      "span.pf-chip",
      "span.pf-chip>span.pf-chip__fan",
    ]);
    expect(card.filter((e) => e.includes("pf-tools"))).toHaveLength(1);
    expect(card.find((e) => e.includes("pf-tools"))).toMatch(/:\d+rows$/);
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
  return declares(token, /overflow(-y)?:\s*(auto|scroll)/);
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

describe("compact, with its disclosure shut, is already still and stays that way", () => {
  // Measured over the shipped recording in the browser: 394.02 px, one value,
  // zero changes. That is the card AS IT ARRIVES — the context, and with it the
  // tool panel, sits inside a Disclosure whose `open` is false — and this walk
  // renders it the same way, without ExpandAllContext, so the panels are not in
  // the markup at all.
  //
  // WHAT THIS SAYS AND WHAT IT DOES NOT, because the first cut of this comment
  // claimed the second and the merge review caught it. It said the panels sit
  // in a closed disclosure "so none of this reaches the reader". They reach him
  // the moment he clicks the `pf-disc__btn` this card renders on every step:
  // `budgeted` is `budget && expandAll` (nodes.tsx), so nothing is budgeted in
  // compact, and the panels come and go inside the open disclosure exactly as
  // they did on the expanded card before card 319.
  //
  // MEASURED, both ways, driving the lab's own "Step forward" through all 196
  // frames of this recording at a 1600x900 viewport with both fonts loaded and
  // 74 frames counted per 600 ms before anything was believed (a screenshot
  // forced the render mid-walk and the reading came back byte-identical). World
  // px: `.pf-flow .react-flow__node-agent .pf-card` over the viewport
  // transform's scale, and compact is the segment the lab OPENS on.
  //
  //   disclosure shut   394.02                                one value,  0 moves
  //   disclosure open   420.06 / 547.88 / 664.97 / 703.02     four,      11 moves
  //
  // The moving region is `.pf-toolbody`, arriving and leaving under the heights
  // (null -> 57.59 at step 4 -> 5, back to null at 18 -> 19, 172.76 at 19 -> 20).
  //
  // So this case is about the compact card's DEFAULT state, and card 319
  // budgets the expanded hub. Compact-with-the-disclosure-open is a card of its
  // own and is not claimed here.
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
      // Read in the COMPACT scope: this card wears no `.pf-agent--wide`, so a
      // box the stylesheet fixes only for the expanded one is not fixed here.
      return composition(
        renderToStaticMarkup(<AgentCardBody data={agent.data as unknown as AgentData} />),
        "compact",
      );
    });
    expect(moves(series)).toEqual([]);
  });
});
