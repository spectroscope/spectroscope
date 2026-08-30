// The LLM field gives every agent a lane (card 327).
//
// THE SHIPPED DEFECT THIS OPENS WITH. `streamsOf` builds its roster as
// `[detail.root, ...scene.subagents.map((c) => c.id)]`. Those two halves come
// from two different sources that do not agree: `deriveDetail` takes the root
// from the FIRST run_start's agentId (sceneToFlow.ts:571), while `advanceScene`
// hardcodes `MAIN = ROOT_AGENT = "main"` (labScene.ts:72-73). On a transcript
// whose root is not called "main" — a standalone subagent, which is 87.5 % of
// the Claude Code transcripts on this machine — the root ALSO lands in
// scene.subagents, so the roster lists it TWICE: two React children with the
// same `key`, and the root wearing the subagent treatment.
//
// WHY IT COMES FIRST. Criterion 4 orders lanes "root first, then scene order",
// and an ordering written on top of a duplicated roster inherits the duplicate.
// Fixing the render without fixing the roster would hide it rather than end it.
//
// WHAT THE SURVEY KILLED, so nobody rebuilds the card's first draft:
//   · "a lane vanishes mid-step" — measured over all 975 steps of all 17 shipped
//     scenarios, the lane count never shrinks mid-run; the only 12 shrink events
//     in the corpus are run_end. What the filter really does is stop a lane ever
//     APPEARING (73.8 % of think slots, 62.0 % of answer slots suppressed).
//   · "six agents" — the roster on a 295-agent import reaches 295 and is above
//     five on 99.8 % of steps; the card already draws up to 234 answer lanes.
//   · "the last state" — `CAP = 420` (sceneToFlow.ts:457) and real data sits ON
//     the cap: 91.1 % of native thinking_delta events leave the string at
//     exactly 420. Every height number starts there, not at unbounded text.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, EXPANDED_CARD, llmLanes, sceneToFlow, LANE_CAP } from "./sceneToFlow";

const T = 1700000000000;

const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

const runStart = (agentId: string): RunEvent =>
  ev({ type: "run_start", runId: "r1", agentId, prompt: "hi", provider: "anthropic", ts: T });
const spawn = (agentId: string, parentId: string): RunEvent =>
  ev({ type: "agent_spawn", agentId, parentId, task: `task ${agentId}`, ts: T });
const think = (agentId: string, text: string): RunEvent =>
  ev({ type: "thinking_delta", agentId, text, ts: T });
const answer = (agentId: string, text: string): RunEvent => ev({ type: "text_delta", agentId, text, ts: T });

function fold(events: RunEvent[]) {
  const scene = events.reduce(advanceScene, initialScene());
  return { scene, detail: deriveDetail(events) };
}

const laneIds = (events: RunEvent[]): string[] => {
  const { scene, detail } = fold(events);
  return llmLanes(scene, detail).lanes.map((l) => l.agent);
};

describe("the roster, which is where the shipped defect lives", () => {
  it("lists a root that is not called 'main' exactly once", () => {
    // The fixture's shape: a standalone subagent transcript, whose first
    // run_start carries an engine id. advanceScene files that same id under
    // subagents because it only knows the literal "main".
    const root = "a0b476c3c018";
    const ids = laneIds([runStart(root), think(root, "reasoning")]);
    expect(ids).toEqual([root]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still lists a root called 'main' exactly once, alongside its children", () => {
    // The other direction, because a fix that dedupes by dropping the FIRST
    // entry would pass the case above and lose the root here.
    const ids = laneIds([runStart("main"), spawn("w1", "main"), spawn("w2", "main")]);
    expect(ids).toEqual(["main", "w1", "w2"]);
  });

  it("puts the root first even when the scene met a child before it", () => {
    // Criterion 4: the root leads, then scene order, and neither is activity
    // order. Bitten by giving a child the only text — an ordering that sorted
    // by who is talking would move it.
    const root = "a0b476c3c018";
    const ids = laneIds([
      runStart(root),
      spawn("w1", root),
      spawn("w2", root),
      answer("w2", "the only text in the run"),
    ]);
    expect(ids[0]).toBe(root);
    expect(ids).toEqual([root, "w1", "w2"]);
  });
});

describe("a lane per agent, and it never disappears", () => {
  it("keeps a lane for an agent that has produced nothing", () => {
    // The owner's ask, verbatim: "für alle agenten die geladen sind immer das
    // feld behalten dann sieht man immer den letzten stand". The old fold
    // dropped an agent the moment its text was empty.
    const { scene, detail } = fold([
      runStart("main"),
      spawn("w1", "main"),
      spawn("w2", "main"),
      think("main", "only main is thinking"),
    ]);
    const { lanes } = llmLanes(scene, detail);
    expect(lanes.map((l) => l.agent)).toEqual(["main", "w1", "w2"]);
    const w2 = lanes.find((l) => l.agent === "w2");
    expect(w2).toBeDefined();
    expect(w2?.think).toBe("");
    expect(w2?.answer).toBe("");
  });

  it("carries one agent's two halves in ONE lane, never crossed", () => {
    // The misreading the card exists to end: in the owner's screenshot the
    // Thinking entry was tagged MAIN and the Answer entry directly under it was
    // tagged SCOPE — two agents, stacked, reading as one.
    const { scene, detail } = fold([
      runStart("main"),
      spawn("w1", "main"),
      think("main", "MAIN-THINK"),
      answer("w1", "W1-ANSWER"),
    ]);
    const { lanes } = llmLanes(scene, detail);
    const main = lanes.find((l) => l.agent === "main");
    const w1 = lanes.find((l) => l.agent === "w1");
    expect(main?.think).toContain("MAIN-THINK");
    expect(main?.answer).toBe("");
    expect(w1?.think).toBe("");
    expect(w1?.answer).toContain("W1-ANSWER");
  });

  it("gives no lane to an agent that is not in the scene at all", () => {
    // The other direction of criterion 2. A roster that grew from the fold's
    // records rather than the scene would list every agent an import ever
    // mentioned — 295 of them on the owner's own transcript.
    const ids = laneIds([runStart("main"), spawn("w1", "main")]);
    expect(ids).not.toContain("ghost");
    expect(ids).toEqual(["main", "w1"]);
  });
});

describe("five lanes, then a count", () => {
  it("draws at most LANE_CAP lanes and says how many are below", () => {
    // Owner's choice, 2026-08-30: grow to five, then scroll. On an import this
    // is the NORMAL case, not an edge — the roster is above five on 99.8 % of
    // the steps of his own 295-agent run.
    const events: RunEvent[] = [runStart("main")];
    for (let i = 1; i <= 8; i++) events.push(spawn(`w${i}`, "main"));
    const { scene, detail } = fold(events);
    const view = llmLanes(scene, detail);
    expect(view.lanes).toHaveLength(LANE_CAP);
    expect(view.more).toBe(9 - LANE_CAP); // main + 8 children
    expect(view.lanes[0].agent).toBe("main");
  });

  it("reports no overflow when the roster fits", () => {
    const { scene, detail } = fold([runStart("main"), spawn("w1", "main")]);
    expect(llmLanes(fold([runStart("main"), spawn("w1", "main")]).scene, detail).more).toBe(0);
    expect(llmLanes(scene, detail).lanes).toHaveLength(2);
  });
});

describe("the seat does not move with the card", () => {
  it("keeps every derived seat at the same HEIGHT for a one-agent and a 300-agent scene", () => {
    // Criterion 6, and it took two wrong drafts to state correctly.
    //
    // Draft 1 compared every other node and failed honestly — the worker grid
    // grows with the roster, which is its job. Draft 2 scoped to the seats
    // downstream of the LLM card and STILL failed, for a reason worth keeping:
    // those seats move in X by 1404px between 1 and 300 agents, because the grid
    // widening pushes everything right of it. That is card 296's arithmetic, not
    // this card's.
    //
    // What this card owns is the VERTICAL spread — `L.pos.llm.y +
    // EXPANDED_CARD.llm.h + EXP_GAP - L.pos.netz.y` — so Y is the axis the seat
    // reservation is about, and every derived seat must hold its y no matter how
    // many lanes the card draws. Measured before pinning: z-outside, z-boundary,
    // netz, mcpserver and llm all sit at the same y in both scenes and differ
    // only in x.
    const DERIVED = ["z-mac", "z-os", "z-outside", "z-boundary", "netz", "mcpserver", "agent", "user"];
    const one: RunEvent[] = [runStart("main")];
    const many: RunEvent[] = [runStart("main")];
    for (let i = 1; i <= 299; i++) many.push(spawn(`w${i}`, "main"));

    const ys = (events: RunEvent[]) => {
      const { scene, detail } = fold(events);
      const flow = sceneToFlow(scene, detail, { provider: "anthropic", model: "m", expanded: true });
      return flow.nodes
        .filter((n) => DERIVED.includes(n.id))
        .map((n) => `${n.id}@y${Math.round(n.position.y)}`)
        .sort();
    };
    const small = ys(one);
    // Worthless if it is empty or one-sided.
    expect(small).toHaveLength(DERIVED.length);
    expect(ys(many)).toEqual(small);
  });

  it("sizes the seat for the cap, not for the roster", () => {
    // The seat is a CONSTANT. If a later card ever computes EXPANDED_CARD.llm.h
    // from the lane count, the neighbours start breathing with the card and
    // criterion 6 is silently gone — this is the assertion that would catch it.
    // The survey measured the headroom: with agent.h at 1200, the first llm.h
    // that moves netz is 1001, so 540 has 461px to spare.
    expect(EXPANDED_CARD.llm.h).toBe(540);
    expect(LANE_CAP).toBe(5);
  });
});
