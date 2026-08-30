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
// RENDERS. A card whose composition changes between two steps cannot have the
// same height on both, so a still composition is necessary for a still box —
// and the measurement pass says composition is very nearly the whole story:
// over the owner's own 3328 steps the card's height changed on 931, and the
// tool-call panel — created on `tool_call`, destroyed on `tool_result` —
// changed on 929 of those 931 (99.8 %). The picture shelf changed on 2. No
// other region changed on any step.
//
// So this file steps a REAL recording through the REAL fold and renders the
// REAL component, and measures what came out. Nothing is asserted about a
// style property: `min-height: 780px` typed onto `.pf-agent` would leave every
// assertion below exactly as red as it is now, because the panel would still
// appear and disappear inside it.
//
// THE RECORDING. docs/sample-runs/workflow-phases.en.jsonl — 196 frames, the
// one transcript that ships with the repo, so CI can step it. It is NOT the
// owner's own run: his is 11.8 MB with pictures attached, and the measurement
// pass found this sample reproduces only part of his complaint (its tool names
// are short, so the status band never wraps). It does carry the mechanism —
// 31 tool_call/tool_result pairs — and it lands on his worst step by itself:
// the measurement named step 18 -> 19 as the click where his card's box moved
// 180.6 px, and 18 -> 19 is one of the steps this file reports below. The
// picture shelf gets its own stepping case, built on the real attachment_image
// shape, because the shipped sample has none.
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
const CSS = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");

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
 * What the card RENDERS, as a string: every element in order, by tag and by the
 * classes that carry its box.
 *
 * BEM modifiers (`--`) are dropped on purpose and the rule is structural, not a
 * convenience: `pf-chip--on` and `pf-row--lit` recolour an element that is
 * already there, while `pf-panelbox` and `pf-ctx__row` ARE the element. Text
 * and every attribute except class are dropped too — a longer command inside
 * the same box is the browser's business, not the composition's.
 */
function composition(markup: string): string[] {
  const out: string[] = [];
  const tag = /<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(markup)) !== null) {
    const cls = /class="([^"]*)"/.exec(m[2]);
    const tokens = (cls?.[1] ?? "")
      .split(/\s+/)
      .filter((c) => c !== "" && !c.includes("--") && !NO_BOX_TOKENS.includes(c))
      .sort();
    out.push(tokens.length === 0 ? m[1] : `${m[1]}.${tokens.join(".")}`);
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

/** The agent hub's card, as the expanded map renders it after `applied`. */
function agentCardAfter(applied: RunEvent[]): string[] {
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
  return composition(
    renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <AgentCardBody data={agent!.data as unknown as AgentData} />
      </ExpandAllContext.Provider>,
    ),
  );
}

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
  it("tells two differently composed cards apart", () => {
    const base: AgentData = {
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
    const withTool: AgentData = { ...base, tool: { name: "run_command", input: { command: "ls" } } };
    const render = (d: AgentData) =>
      composition(
        renderToStaticMarkup(
          <ExpandAllContext.Provider value={true}>
            <AgentCardBody data={d} />
          </ExpandAllContext.Provider>,
        ),
      );
    expect(render(base).join(" ")).not.toBe(render(withTool).join(" "));
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
  // card under his cursor. Today 11 of 195, and step 18 -> 19 is among them —
  // the click the measurement pass clocked at 180.6 px of movement, found
  // independently there and here.
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
    const last = agentCardAfter(events);
    expect(last.filter((e) => e === "figure.pf-shot")).toHaveLength(MAX_CARD_SHOTS);
  });

  it("holds the same card while the pictures arrive", () => {
    expect(moves(stepThrough(events))).toEqual([]);
  });
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
