// Card 302: a workflow run read as a state graph. THE PHASE IS THE NODE and
// the edge means what follows what — main → phase 1 → phase 2 → …, a straight
// chain, with the agents living inside the phase box they belong to.
//
// Every fixture here is invented; nothing is copied out of a recording. Only
// the SHAPE travels, and a shape is numbers: five phases, thirteen agents,
// occupancy 1/5/1/1/5.

import { describe, expect, it } from "vitest";
import { lifecycleAt } from "../stategraph/artifact";
import { layoutStateGraph } from "../stategraph/layout";
import {
  WORKFLOW_LIFECYCLE,
  declarationFor,
  foldPhase,
  phaseHeight,
  phaseNodeId,
  readWorkflowState,
  unplacedNodeId,
  workflowGraph,
  type PhaseMember,
} from "./workflowGraph";

const TITLES = ["scope", "probe", "merge", "draft", "audit"];

/** The measured shape of a real run, rebuilt from nothing but its numbers.
 *  `phaseIndex` is ONE-based in the file — measured, not assumed. */
function sample(): string {
  const phases = TITLES.map((title, i) => ({ title, detail: `what ${title} is for`, index: i + 1 }));
  const widths = [1, 5, 1, 1, 5];
  const agents: unknown[] = [];
  let n = 0;
  widths.forEach((w, p) => {
    for (let k = 0; k < w; k++) {
      n += 1;
      agents.push({
        type: "workflow_agent",
        index: n,
        agentId: `a${n}`,
        label: `agent ${n}`,
        phaseIndex: p + 1,
        phaseTitle: phases[p].title,
        model: "some-model",
        state: "done",
        queuedAt: 1000 + n,
        startedAt: 1100 + n,
        durationMs: 50,
      });
    }
  });
  return JSON.stringify({
    workflowName: "a run",
    agentCount: n,
    status: "completed",
    phases: phases.map((p) => ({ title: p.title, detail: p.detail })),
    workflowProgress: [
      ...phases.map((p) => ({ type: "workflow_phase", index: p.index, title: p.title })),
      ...agents,
    ],
  });
}

const read = (json: string) => declarationFor(readWorkflowState(json)!);
const graph = (json: string) => workflowGraph(read(json), "main");

describe("readWorkflowState", () => {
  it("reads the declared phases and the run's agents", () => {
    const s = readWorkflowState(sample())!;
    expect(s.name).toBe("a run");
    expect(s.phases.map((p) => p.title)).toEqual(TITLES);
    expect(s.phases[0].detail).toBe("what scope is for");
    expect(s.agents).toHaveLength(13);
  });

  it("is null for anything that is not a JSON object, and empty for one with nothing in it", () => {
    expect(readWorkflowState("not json")).toBeNull();
    expect(readWorkflowState("[1,2]")).toBeNull();
    const bare = readWorkflowState("{}")!;
    expect(bare.phases).toEqual([]);
    expect(bare.agents).toEqual([]);
  });
});

describe("the phase is the node", () => {
  it("draws five phases and nothing else — the thirteen agents are not nodes", () => {
    const g = graph(sample());
    expect(g.topo.nodes.map((n) => n.id)).toEqual(["main", ...TITLES.map((_, i) => phaseNodeId("main", i))]);
    expect(g.topo.nodes.map((n) => n.label)).toEqual(["main", ...TITLES]);
  });

  it("holds its agents INSIDE it, 1/5/1/1/5, with label, state and model", () => {
    const run = read(sample());
    expect(run.phases.map((p) => p.members.length)).toEqual([1, 5, 1, 1, 5]);
    expect(run.phases[1].members.map((m) => m.label)).toEqual([2, 3, 4, 5, 6].map((n) => `agent ${n}`));
    expect(run.phases[1].members[0].state).toBe("done");
    expect(run.phases[1].members[0].model).toBe("some-model");
  });

  it("states a height that grows with what the box holds", () => {
    const g = graph(sample());
    const one = g.topo.heights!.get(phaseNodeId("main", 0))!;
    const five = g.topo.heights!.get(phaseNodeId("main", 1))!;
    expect(five).toBeGreaterThan(one);
    expect(five).toBe(phaseHeight(5));
  });
});

describe("the edge means what follows what", () => {
  it("is a chain of five: main → scope → probe → merge → draft → audit", () => {
    const g = graph(sample());
    const id = (i: number) => phaseNodeId("main", i);
    expect(g.topo.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      `main->${id(0)}`,
      `${id(0)}->${id(1)}`,
      `${id(1)}->${id(2)}`,
      `${id(2)}->${id(3)}`,
      `${id(3)}->${id(4)}`,
    ]);
  });

  it("lets NOTHING else fan out of the root — the defect this card exists to undo", () => {
    // The first attempt drew one edge from the root to each of the thirteen
    // agents, and thirteen arcs flew across the canvas in nested loops. The
    // root has exactly one edge out of it, into the first phase.
    const g = graph(sample());
    expect(g.topo.edges.filter((e) => e.from === "main")).toHaveLength(1);
  });

  it("draws the succession SOLID — a declared order is not a reconstruction", () => {
    expect(new Set(graph(sample()).topo.edges.map((e) => e.kind))).toEqual(new Set(["direct"]));
  });

  it("ranks the phases in the script's order, from the root at zero", () => {
    const g = graph(sample());
    expect(g.topo.ranks!.get("main")).toBe(0);
    TITLES.forEach((_, i) => expect(g.topo.ranks!.get(phaseNodeId("main", i))).toBe(i + 1));
  });

  it("captions each phase column with the script's own title and detail", () => {
    const g = graph(sample());
    expect(g.topo.rankCaptions!.get(1)).toEqual({ title: "scope", detail: "what scope is for" });
    expect(g.topo.rankCaptions!.get(5)).toEqual({ title: "audit", detail: "what audit is for" });
    expect(g.topo.rankCaptions!.get(0)).toBeUndefined();
  });

  it("carries the captions out to the layout's own rank labels", () => {
    const laid = layoutStateGraph(graph(sample()).topo, "horizontal");
    expect(laid.rankLabels.find((l) => l.rank === 2)?.caption?.title).toBe("probe");
    expect(laid.rankLabels.find((l) => l.rank === 0)?.caption).toBeUndefined();
  });
});

describe("a phase's lifecycle folds from its agents", () => {
  const m = (state: PhaseMember["state"]): PhaseMember => ({
    agentId: "x",
    label: "x",
    model: null,
    state,
    startedAt: state === "pending" ? null : 1,
    endedAt: state === "done" || state === "error" ? 2 : null,
  });

  it("any running makes the phase active", () => expect(foldPhase([m("done"), m("active")])).toBe("active"));
  it("all done makes it done", () => expect(foldPhase([m("done"), m("done")])).toBe("done"));
  it("any error makes it error", () => expect(foldPhase([m("done"), m("error")])).toBe("error"));
  it("none started leaves it pending", () => expect(foldPhase([m("pending"), m("pending")])).toBe("pending"));

  it("an error outranks a sibling that is still running", () => {
    // Named on its own because the four rules above do not settle it: a
    // failure is the fact a viewer must not lose while a neighbour runs on.
    expect(foldPhase([m("error"), m("active")])).toBe("error");
  });

  it("a phase part done and part not yet started is active, not done", () => {
    expect(foldPhase([m("done"), m("pending")])).toBe("active");
  });

  it("a declared phase with no agents at all is pending — never entered", () => {
    expect(foldPhase([])).toBe("pending");
  });
});

describe("the state vocabulary the file actually uses", () => {
  const one = (state: string | null, started: number | null = 1100): string =>
    JSON.stringify({
      phases: [{ title: "only", detail: null }],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "only" },
        {
          type: "workflow_agent",
          agentId: "a1",
          label: "a1",
          phaseIndex: 1,
          phaseTitle: "only",
          state,
          queuedAt: 1000,
          ...(started === null ? {} : { startedAt: started }),
        },
      ],
    });
  const life = (json: string) => read(json).phases[0].members[0].state;

  it("done is done", () => expect(life(one("done"))).toBe("done"));
  it("error is error", () => expect(life(one("error"))).toBe("error"));
  it("progress is active", () => expect(life(one("progress"))).toBe("active"));
  it("start is active", () => expect(life(one("start"))).toBe("active"));
  it("queued but never started is pending", () => expect(life(one("start", null))).toBe("pending"));
  it("a word the file has never used is pending, not a guess", () =>
    expect(life(one("teleported", null))).toBe("pending"));
});

describe("the phase is lit through the SHARED fold, in its own vocabulary", () => {
  it("agrees with foldPhase on every one of the four answers", () => {
    // The seam card 302 bought by generalising lifecycleAt: the workflow's
    // own three record names light a phase exactly as the fold reads it. If
    // these two ever disagree, one of them is drawing a lie.
    const json = JSON.stringify({
      phases: ["ran", "failed", "running", "never"].map((title) => ({ title, detail: null })),
      workflowProgress: [
        ...["ran", "failed", "running", "never"].map((title, i) => ({
          type: "workflow_phase",
          index: i + 1,
          title,
        })),
        ...[
          { title: "ran", state: "done", startedAt: 10 },
          { title: "failed", state: "error", startedAt: 20 },
          { title: "running", state: "progress", startedAt: 30 },
        ].map((a, i) => ({
          type: "workflow_agent",
          agentId: `a${i}`,
          label: `a${i}`,
          phaseIndex: ["ran", "failed", "running", "never"].indexOf(a.title) + 1,
          phaseTitle: a.title,
          state: a.state,
          startedAt: a.startedAt,
          durationMs: 5,
        })),
        {
          type: "workflow_agent",
          agentId: "queued",
          label: "queued",
          phaseIndex: 4,
          phaseTitle: "never",
          state: "start",
          queuedAt: 40,
        },
      ],
    });
    const run = read(json);
    const g = workflowGraph(run, "main");
    const last = g.records.length - 1;
    ["done", "error", "active", "pending"].forEach((want, i) => {
      expect(foldPhase(run.phases[i].members)).toBe(want);
      expect(lifecycleAt(g.records, last, phaseNodeId("main", i), WORKFLOW_LIFECYCLE)).toBe(want);
    });
  });

  it("keeps the records in time order and names them in its own dialect", () => {
    const g = graph(sample());
    expect(g.records.map((r) => r.ts)).toEqual([...g.records.map((r) => r.ts)].sort((a, b) => a - b));
    expect(new Set(g.records.map((r) => r.type))).toEqual(
      new Set([WORKFLOW_LIFECYCLE.start, WORKFLOW_LIFECYCLE.end]),
    );
  });
});

describe("a declared phase no agent ever occupied", () => {
  const json = JSON.stringify({
    phases: ["a", "b", "c"].map((title) => ({ title, detail: null })),
    workflowProgress: [
      ...["a", "b", "c"].map((title, i) => ({ type: "workflow_phase", index: i + 1, title })),
      {
        type: "workflow_agent",
        agentId: "x",
        label: "x",
        phaseIndex: 1,
        phaseTitle: "a",
        state: "done",
        startedAt: 1,
        durationMs: 1,
      },
      {
        type: "workflow_agent",
        agentId: "z",
        label: "z",
        phaseIndex: 3,
        phaseTitle: "c",
        state: "done",
        startedAt: 3,
        durationMs: 1,
      },
    ],
  });

  it("is still a node, drawn and empty", () => {
    const g = workflowGraph(read(json), "main");
    expect(g.topo.nodes.map((n) => n.id)).toContain(phaseNodeId("main", 1));
    expect(read(json).phases[1].members).toEqual([]);
  });

  it("is never entered — pending, through the shared fold too", () => {
    const g = workflowGraph(read(json), "main");
    expect(lifecycleAt(g.records, g.records.length - 1, phaseNodeId("main", 1), WORKFLOW_LIFECYCLE)).toBe(
      "pending",
    );
  });

  it("keeps the chain unbroken through the gap", () => {
    const g = workflowGraph(read(json), "main");
    expect(g.topo.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      `main->${phaseNodeId("main", 0)}`,
      `${phaseNodeId("main", 0)}->${phaseNodeId("main", 1)}`,
      `${phaseNodeId("main", 1)}->${phaseNodeId("main", 2)}`,
    ]);
  });
});

describe("an agent whose phaseIndex names no declared phase", () => {
  const json = JSON.stringify({
    phases: [{ title: "only", detail: null }],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "only" },
      {
        type: "workflow_agent",
        agentId: "stray",
        label: "stray",
        phaseIndex: 9,
        phaseTitle: "nowhere",
        state: "done",
        startedAt: 1,
        durationMs: 1,
      },
    ],
  });

  it("is never dropped — it is listed as unplaced", () => {
    expect(read(json).unplaced.map((m) => m.label)).toEqual(["stray"]);
  });

  it("gets a box past the declared columns and NO edge, because nothing declared its order", () => {
    const g = workflowGraph(read(json), "main");
    expect(g.topo.nodes.map((n) => n.id)).toContain(unplacedNodeId("main"));
    expect(g.topo.ranks!.get(unplacedNodeId("main"))).toBe(2);
    expect(g.topo.edges.filter((e) => e.to === unplacedNodeId("main"))).toEqual([]);
  });

  it("leaves that column uncaptioned rather than inventing a phase for it", () => {
    expect(workflowGraph(read(json), "main").topo.rankCaptions!.get(2)).toBeUndefined();
  });
});

describe("a state file whose phase markers stop early", () => {
  // A file written mid-run has fewer markers than phases. The join goes
  // through the TITLE, and where a title cannot place a number the number
  // stays unknown rather than being taken from an array position.
  const json = JSON.stringify({
    phases: ["p1", "p2", "p3", "p4", "p5"].map((title) => ({ title, detail: null })),
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "p1" },
      { type: "workflow_phase", index: 2, title: "p2" },
      {
        type: "workflow_agent",
        agentId: "late",
        label: "late",
        phaseIndex: 3,
        phaseTitle: "p3",
        state: "done",
        startedAt: 1,
        durationMs: 1,
      },
    ],
  });

  it("puts the agent under its OWN phase's word, not the next one's", () => {
    const run = read(json);
    expect(run.phases[2].members.map((m) => m.label)).toEqual(["late"]);
    expect(run.phases[3].members).toEqual([]);
    expect(run.unplaced).toEqual([]);
  });
});

describe("a state file that gives one phase two different numbers", () => {
  const json = JSON.stringify({
    phases: [{ title: "one", detail: null }],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "one" },
      { type: "workflow_phase", index: 2, title: "one" },
      {
        type: "workflow_agent",
        agentId: "a",
        label: "a",
        phaseIndex: 1,
        phaseTitle: "one",
        state: "done",
        startedAt: 1,
        durationMs: 1,
      },
    ],
  });

  it("places nobody by the contradicted number", () => {
    const run = read(json);
    expect(run.phases[0].members).toEqual([]);
    expect(run.unplaced.map((m) => m.label)).toEqual(["a"]);
  });
});
