// CARD 319 — the agent hub's SEAT against the card the browser actually draws,
// and against the neighbours that are seated off it.
//
// EVERY READING QUOTED BELOW IS FROM BEFORE THE FIX, and is kept because it is
// the evidence the seat is judged against, not a report of what the map does
// now. What it does now, measured the same way on the same recording after the
// budget landed: the card renders 1178.59 world px, ONE value over 2192 stepped
// clicks, worst single-step change 0.00, and the oversize arm says nothing
// about it. The six heights and the 828 oversize steps below are the disease.
//
// EXPANDED_CARD.agent.h has been 780 since it was written, and its own doc
// block admits what it is: agent and llm "keep an observed height plus
// headroom ... the sum would be a guess dressed as a derivation". The
// measurement pass for this card put a number on the guess, and it is wrong in
// BOTH directions at once — the same double error cardGeometry.ts records for
// the worker card's old 560:
//
//   the shipped sample recording, max            633.18   147 px of air
//   the owner's session, modal (56.3 % of steps) 706.85    73 px of air
//   the owner's session, 6.5 % of steps          363.97   416 px of air, 53 %
//   the owner's session, max                     932.98   153 px OVER the seat
//   everything at once                          1172.79   393 px OVER, +50 %
//
// The over arm is not a theory here: stepping back to a 6-pictures-plus-Bash
// state and forcing a frame, the SHIPPED runtime check said so unprompted —
// "the agent card rendered 917px tall against an envelope of 780px — every
// seat derived from it is 137px short, so cards will overlap". It fires on
// 828 of the owner's 3328 steps (24.9 %). At 932.98 the card's bottom is at
// world 1082.98 while the OS band starts at 990: 93 px of overlap, the whole
// 60 px rail room gone.
//
// HOW THESE NUMBERS WERE TAKEN — the cardGeometry.ts method, copied exactly:
// Chrome, both variable fonts loaded BEFORE the read (document.fonts.ready
// alone came out 5-9 px short every time), real markup inside
// `.pf-root > .pf-flow > .react-flow__node-agent`, through
// getBoundingClientRect. The agent hub carries no zoom, so these are world px.
// The harness was verified before it was believed: a cloned live card measured
// 917.47 against the live world height 917.47, delta 0.00.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { agentDirectory } from "../agentDirectory";
import { foldSeatPool } from "./workerGrid";
import {
  EXPANDED_CARD,
  EXP_GAP,
  UNDER_SETTLE_MS,
  UNDER_WATCHED_TYPES,
  deriveDetail,
  oversizeCards,
  resetEnvelopeMemory,
  sceneToFlow,
  underfilledCards,
} from "./sceneToFlow";

const SAMPLE = new URL("../../../../docs/sample-runs/workflow-phases.en.jsonl", import.meta.url);
const PANE_ASPECT = 1272 / 581;
const T0 = 1_700_000_000_000;

/**
 * Every distinct height the agent card rendered over the owner's own 44-hour
 * run, 3328 steps — the six states, with the share of steps each holds.
 *
 *   363.97   6.5 %  system prompt only
 *   563.66   4.6 %  + 1 picture
 *   574.60   4.4 %  + Bash tool panel, no pictures
 *   706.85  56.3 %  5 pictures, no tool
 *   917.47  21.9 %  6 pictures + Bash tool panel at its cap
 *   932.98   0.3 %  6 pictures + a long MCP tool name
 *
 * Not a fixture that decides anything: it is the evidence the seat is judged
 * against, and a seat that cannot hold the tallest of them is a seat whose
 * card draws over its neighbour.
 */
const OWNER_RUN_HEIGHTS = [363.97, 563.66, 574.6, 706.85, 917.47, 932.98] as const;
const OWNER_RUN_PEAK = 932.98;

/**
 * The tallest agent card the browser has been made to draw, composed region by
 * region in the same pass: 6 pictures + the Bash tool panel + the system
 * prompt (917.47) + the context-bars panel (+125.82) + a generated-image panel
 * (+129.50) + the longest real MCP tool name in the panel label (+15.50) =
 * 1188.29. Declared phases cost 0.00 — `.pf-agent__cols` is `align-items:
 * stretch` and the ctx column is always the taller one, so the 81.64 px phase
 * block is absorbed; that was measured by injecting it, not reasoned.
 *
 * One measured step is deliberately NOT in this number: 7 more context rows
 * took the same card to 1344.20, because `.pf-ctx` has no bound at all and
 * costs 22.27 px per row forever. A seat cannot cover an unbounded region —
 * that is what card 319's AC 7 is for (agentCardRegions.test.ts). The seat's
 * job is to cover every region that HAS a bound.
 */
const AGENT_COMPOSED_WORST = 1188.29;

const agentCard = (h: number) => ({ id: "agent", type: "agent", h });

/** Feed a reading, then let the settle window run out and read the verdict. */
const settledVerdict = (cards: { id: string; type?: string; h: number }[], t = T0) => {
  underfilledCards(cards, t);
  return underfilledCards(cards, t + UNDER_SETTLE_MS);
};

// The envelope memory is per module — peaks and once-only locks — so a suite
// that shares the module shares them.
beforeEach(() => {
  resetEnvelopeMemory();
});

describe("the seat holds the card the browser draws", () => {
  it("covers the tallest composition ever measured, region by region", () => {
    expect(EXPANDED_CARD.agent.h).toBeGreaterThanOrEqual(Math.ceil(AGENT_COMPOSED_WORST));
  });

  // The same claim as the check that ships, run over the real run rather than
  // over a hand-picked height: not one of the six states the owner's session
  // produced may be over the seat. Today the top two are, on 828 of his 3328
  // steps.
  it("leaves the oversize arm with nothing to say about the owner's whole run", () => {
    expect(oversizeCards(OWNER_RUN_HEIGHTS.map(agentCard))).toEqual([]);
  });

  // The other direction, and it is a real risk rather than a formality: the
  // fix for this card RAISES the seat, and a seat that reserves twice its card
  // is the defect card 296 was cut for. The bound is absolute on purpose — the
  // same reason transportFit.test.ts writes NEVER_BELOW out in full: every
  // other assertion here is relative to EXPANDED_CARD.agent.h, so a seat that
  // walked off on its own would take the whole file with it.
  it("does not overshoot into a seat that reserves twice its card", () => {
    expect(EXPANDED_CARD.agent.h).toBeLessThan(2 * OWNER_RUN_PEAK);
    expect(EXPANDED_CARD.agent.h).toBeLessThan(1900);
  });
});

describe("the under-fill arm gains the envelope this card measures", () => {
  // Card 296 wrote the rule for widening it: "widening the arm belongs to
  // whichever card corrects the next envelope, one at a time, with its own
  // measurement". This card corrects the agent envelope and brings its
  // measurement, so this is that card.
  it("watches the agent, not only the worker", () => {
    expect([...UNDER_WATCHED_TYPES].sort()).toEqual(["agent", "subagent"]);
  });

  // THE BITE, and it has to come first: while `agent` is not in the watched
  // set, `underfilledCards` returns [] for every agent card there is — so the
  // silence test below would be green for the wrong reason, and would stay
  // green through a seat of any size at all. This one can only pass with the
  // arm actually live.
  it("names an agent seat that reserves twice its card, once the card has stood still", () => {
    const half = Math.floor(EXPANDED_CARD.agent.h / 2);
    expect(settledVerdict([agentCard(half)])).toEqual([
      { envelope: "agent", peak: half, bound: EXPANDED_CARD.agent.h },
    ]);
  });

  // Green today, and for the WRONG reason — an unwatched envelope returns []
  // whatever its seat is. It only becomes a statement once the bite above
  // passes, which is why the bite is written first and why this one is never
  // to be read on its own.
  it("and stays quiet at the peak the owner's run actually rendered", () => {
    expect(settledVerdict([agentCard(OWNER_RUN_PEAK)])).toEqual([]);
  });
});

describe("the doc block stops citing a cap that does not exist", () => {
  // AC 8. `EXPANDED_CARD`'s comment justifies the agent seat with the caps on
  // the regions inside it — ".pf-llm__streams 260, the tool JSON at 150,
  // .pf-prose 120" — and the middle one has been wrong since card 287:
  // ToolCallPanel.tsx says `maxHeight: 240` and says so in its own comment
  // ("240 since card 287"). There is no 150 cap anywhere in flowmap.css.
  //
  // That is not a typo in prose. It is the sentence the 780 rests on, and it
  // is stale about EXACTLY the region that causes 99.8 % of the movement this
  // card exists to stop. So the cited numbers are read out of the files that
  // own them, and changing an owner turns this red.
  const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const scene = read("sceneToFlow.ts");
  const docBlock = scene.slice(
    scene.indexOf("/**\n * The envelope every expanded card has to fit inside"),
    scene.indexOf("export const EXPANDED_CARD"),
  );

  const capIn = (source: string, pattern: RegExp, what: string): number => {
    const m = pattern.exec(source);
    expect(m, `${what} must state a cap`).not.toBeNull();
    return Number(m![1]);
  };

  it("sliced the block it is about to judge", () => {
    expect(docBlock).toContain("agent and llm keep an observed height plus headroom");
  });

  it("cites the tool panel's real cap, out of the file that sets it", () => {
    const cap = capIn(read("ToolCallPanel.tsx"), /maxHeight:\s*(\d+)/, "ToolCallPanel");
    expect(docBlock).toContain(String(cap));
  });

  // AND THE SELECTORS, not only the numbers. The rewrite of this block named
  // `.pf-shelf` as one of the classes stating a fixed box; there is no such
  // class — it is `.pf-agent__shelf` — and the number check above sailed past
  // it, because the numbers were all real. A cap that does not exist and a
  // selector that does not exist are the same defect one paragraph apart.
  it("names classes that exist in the stylesheet it is talking about", () => {
    const css = read("flowmap.css");
    const named = [...docBlock.matchAll(/`(\.[\w-]+)`/g)].map((m) => m[1]);
    expect(named.length, "the block cites no class at all — this case pins nothing").toBeGreaterThan(2);
    for (const selector of named) {
      expect(css, `${selector} is cited here and is in no rule of flowmap.css`).toMatch(
        new RegExp(`(^|[\\s,>+~])\\${selector}\\b[^{}]*\\{`, "m"),
      );
    }
  });

  it("cites the streams cap and the prose cap out of the stylesheet that sets them", () => {
    const css = read("flowmap.css");
    const capOf = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, `${selector} must exist`).toBeGreaterThan(-1);
      return capIn(css.slice(at, css.indexOf("}", at)), /max-height:\s*(\d+)px/, selector);
    };
    expect(docBlock).toContain(String(capOf(".pf-llm__streams")));
    expect(docBlock).toContain(String(capOf(".pf-prose")));
  });
});

// ---------------------------------------------------------------------------
// AC 4 — nothing below or beside the card may move either.
//
// The seat is what the OS band, the stations and the whole right-hand world
// are derived from (sceneToFlow's `vSpread` and `spread`), so raising it moves
// them ONCE and that is fine. What must never happen is that they follow the
// card's CONTENT: that would turn one restless card into a restless map.
// ---------------------------------------------------------------------------
const readSample = (): RunEvent[] =>
  readFileSync(SAMPLE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);

function flowAfter(applied: RunEvent[]) {
  const scene = applied.reduce(advanceScene, initialScene());
  return sceneToFlow(scene, deriveDetail(applied), {
    provider: "ollama",
    model: "m",
    expanded: true,
    paneAspect: PANE_ASPECT,
    pool: foldSeatPool(applied),
    dir: agentDirectory(applied),
    systemPrompt: "you are a careful agent",
  });
}

/** Every distinct world position each of these nodes was given, over a run. */
function seatsOver(events: RunEvent[], ids: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (let i = 1; i <= events.length; i++) {
    for (const node of flowAfter(events.slice(0, i)).nodes) {
      const seen = out.get(node.id);
      if (seen !== undefined) seen.add(`${node.position.x},${node.position.y}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AC 2's FIRST HALF, which nothing in this repo held. The owner asked for the
// card "a bit higher so it does not keep popping around at the bottom", the
// seat moved from world y 150 to 48, and then: dropping the hub 60 world px
// back down left the WHOLE gate green, and the only thing that ever went red
// further down was a COLLISION check — "the OS band sits below the tall agent
// card", which is about the card landing ON its neighbour, not about it
// sitting high.
//
// WHAT THE GATE CAN HOLD, and what it cannot. The ceiling the card proposes is
// 64 SCREEN px (cardStillness.AGENT_TOP_CEILING_PX), and screen px are not a
// property of the seat: `fitView` scales the world into whatever pane it is
// given, and most of the measured 45.44 at a 1600x900 window is that fit's own
// padding rather than the card's air. Turning 64 into a world number here would
// mean re-implementing React Flow's fit, and a pin built on a model of someone
// else's code lies the first time the model drifts.
//
// So the gate holds the SHAPE of the placement, in world units, where the
// answer does not depend on the pane at all — and the screen half stays where
// it belongs, measured in a browser with the window it was measured at named
// beside it.
// ---------------------------------------------------------------------------
describe("the hub sits at the top of the machine it belongs to", () => {
  const world = () => {
    const flow = flowAfter(readSample());
    const at = (id: string) => {
      const node = flow.nodes.find((n) => n.id === id);
      expect(node, `${id} must be on the map`).toBeDefined();
      return node!;
    };
    const frame = at("z-mac");
    const frameH = (frame.style as { height?: number } | undefined)?.height;
    expect(frameH, "the machine frame must state a height").toBeGreaterThan(0);
    const agent = at("agent");
    return {
      nodes: flow.nodes,
      airAbove: agent.position.y - frame.position.y,
      airBelow: frame.position.y + frameH! - (agent.position.y + EXPANDED_CARD.agent.h),
      railBelow: at("z-os").position.y - (agent.position.y + EXPANDED_CARD.agent.h),
    };
  };

  // THE ONE. "High in the frame" said as something the fold produces: the hub
  // is nearer the top of the machine than it is to the band underneath it.
  // Measured today: 24 world px above, 60 below — and 60 is EXP_GAP, the rail
  // room the layout leaves between any two cards, so the card is as close to
  // the frame's edge as anything on this map gets to anything.
  //
  // It is what the collision checks could not say. Dropping the seat 40 px
  // leaves every one of them green and puts 64 above the card against 20 below
  // it, which is the card floating in the middle again.
  it("is closer to the frame above it than to the band below it", () => {
    const w = world();
    expect(w.railBelow, "the band has moved up against the card").toBeGreaterThan(0);
    expect(
      w.airAbove,
      `the hub sits ${w.airAbove} world px below the top of the machine and only ` +
        `${w.railBelow} above the band — that is the middle, not the top`,
    ).toBeLessThan(w.railBelow);
  });

  // AC 2's own second half, in the units that survive a zoom: "the air above
  // the card is no more than one third of the air below it". Today 24 against
  // 520. A ratio is pane-independent, so this one holds at every window.
  it("keeps the air above it under a third of the air below it", () => {
    const w = world();
    expect(w.airBelow).toBeGreaterThan(0);
    expect(w.airAbove * 3).toBeLessThanOrEqual(w.airBelow);
  });

  // And nothing is seated above it — a hub at the top of a frame with a card
  // over its head is not at the top of anything.
  it("has nothing over its head", () => {
    const w = world();
    const agentY = w.nodes.find((n) => n.id === "agent")!.position.y;
    const over = w.nodes.filter((n) => n.type !== "zone" && n.position.y < agentY).map((n) => n.id);
    expect(over).toEqual([]);
  });
});

const BELOW = ["z-os", "os-disk", "os-shell", "os-mcp", "os-net", "z-mac"] as const;
const BESIDE = ["z-boundary", "z-outside", "llm", "netz", "mcpserver"] as const;

describe("the map under and beside the card", () => {
  const events = readSample();

  // The numbers moved ONCE with the seat, which the block above says is fine —
  // that is what "raising it moves them once" means, and the claim this case
  // makes is the ONE VALUE, not the value. Both halves are derived and can be
  // recomputed from the constants rather than remembered:
  //
  //   vSpread = EXPANDED_AGENT_Y 48 + EXPANDED_CARD.agent.h 1200 + EXP_GAP 60
  //             - OS_BAND_TOP 668                                       = 640
  //   z-os    = OS_BAND_TOP 668 + 640                                   = 1308
  //   stations = 748 + 640                                              = 1388
  //
  // Before this card: agent y 150 and seat 780 gave vSpread 322, z-os 990 and
  // the stations 1070. z-mac's own top does not move at all and must not — it
  // is the edge EXPANDED_AGENT_Y is derived from.
  it("gives everything below the card one world y for the whole run", () => {
    const ys = new Map<string, Set<number>>();
    for (const [id, seats] of seatsOver(events, BELOW)) {
      ys.set(id, new Set([...seats].map((s) => Number(s.split(",")[1]))));
    }
    expect(Object.fromEntries([...ys].map(([id, s]) => [id, [...s]]))).toEqual({
      "z-os": [1308],
      "os-disk": [1388],
      "os-shell": [1388],
      "os-mcp": [1388],
      "os-net": [1388],
      "z-mac": [24],
    });
  });

  // NARROWED, deliberately, and this says which direction and why — the house
  // rule for a claim the coverage cannot reach is to make the sentence as
  // narrow as the coverage and write down which way you went.
  //
  // The claim written here first was ONE world x for the whole run. It is not
  // reachable without making every map worse, and that was MEASURED rather than
  // argued. `spread` puts the whole right-hand world past the worker grid's
  // right edge, and the grid's column count is only ever known from the prefix
  // folded so far — so the only way to hold it still is to reserve the widest
  // grid the pane can seat in advance. At this pane `rowsFor` puts twelve seats
  // in three rows, hence four columns: 1872 world px, reserved on every run
  // including one with no workers at all. The owner's own 44-hour session is
  // exactly that run — maxSubs 0, not one pixel of horizontal motion in it —
  // so the reserve would buy him nothing and cost him a mac frame drawn 1872px
  // wider than anything standing in it.
  //
  // So the horizontal half stays open, as card 319 already says it may: it is a
  // fold-driven mechanism, not the agent card's height, and it is splittable
  // into its own card. What this case does instead is pin the MECHANISM, so
  // that card starts from a measurement and so anything else that starts moving
  // these nodes sideways turns it red. Today, over this recording, every one of
  // them takes four x values exactly 468 apart: 1554, 2022, 2490, 2958.
  it("moves everything beside the card by whole worker columns, and by nothing else", () => {
    const step = EXPANDED_CARD.subagent.w + EXP_GAP;
    expect(step, "the column pitch these seats are judged against").toBe(468);
    const seen = seatsOver(events, BESIDE);
    expect([...seen.keys()].sort(), "the derivation must find every node").toEqual([...BESIDE].sort());
    for (const [id, seats] of seen) {
      const xs = [...new Set([...seats].map((s) => Number(s.split(",")[0])))].sort((a, b) => a - b);
      expect(xs.length, `${id} was never laid out`).toBeGreaterThan(0);
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      expect(
        gaps.filter((g) => g % step !== 0),
        `${id} moved by something that is not a column`,
      ).toEqual([]);
    }
  });
});

describe("the neighbours do not follow the agent card's content", () => {
  // Two flows over the SAME event prefix, differing only in what the agent
  // card is carrying: a tool call in flight, and pictures on its shelf. Every
  // other node has to land on the same seat. This is green today — the seats
  // derive from the constant, not from the card — and it is here because the
  // obvious fix for card 319 is the one that breaks it: seat the band off the
  // card's MEASURED height and the whole map starts breathing with the panel.
  const events = readSample();
  const upTo = 40;

  const shot = (i: number): RunEvent =>
    ({
      type: "attachment_image",
      agentId: "main",
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      note: `screenshot ${i}`,
      ts: 1783000000000 + i,
    }) as unknown as RunEvent;

  const seats = (evts: RunEvent[]) =>
    flowAfter(evts)
      .nodes.filter((n) => n.id !== "agent")
      .map((n) => `${n.id} ${n.position.x},${n.position.y}`)
      .sort();

  it("seats every other node identically with and without pictures on the shelf", () => {
    const bare = events.slice(0, upTo);
    const laden = [...bare, ...Array.from({ length: 6 }, (_, i) => shot(i))];
    expect(seats(laden)).toEqual(seats(bare));
  });

  // The bite on the instrument above: `seats` has to be able to report a
  // difference at all. A worker column opening moves five nodes by 468, and
  // if this comes back equal then the test above is comparing nothing.
  it("and would report it if a seat really did move", () => {
    const one = events.slice(0, 12);
    const many = events.slice(0, events.length);
    expect(seats(many)).not.toEqual(seats(one));
  });
});
