// Reading a run's two artifacts, against the real files rather than a fixture.
//
// Two sibling JSONL files share a stem and join on (runId, node, superstep).
// `<stem>.graph.jsonl` carries the topology and the lifecycle — it must stay
// safe to attach to a bug report, so it never holds a caller's values.
// `<stem>.state.jsonl` is the only file that may. Keeping the two apart is the
// whole safety story, and the reader must not quietly merge them into one bag.
//
// Three facts stay distinguishable here on purpose, because a viewer that fuses
// them starts lying: what a node WROTE (updateKeys / updateBytes), what was
// RECORDED (a payload's channels), and WHY they differ (the policy).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStateGraphRun, channelAbsence, type Marker } from "./artifact";

const DIR = new URL("../../../docs/graph-view-reference/", import.meta.url).pathname;
const GRAPH = readFileSync(DIR + "crag-payload.graph.jsonl", "utf8");
const STATE = readFileSync(DIR + "crag-payload.state.jsonl", "utf8");

const run = readStateGraphRun(GRAPH, STATE);

describe("the topology, which is known before the first token", () => {
  it("reads every node and edge the compiler declared", () => {
    expect(run.topology.nodes.map((n) => n.id)).toEqual([
      "__start__", "router", "retrieve", "rerank", "grade",
      "rewrite", "web", "generate", "verify", "__end__",
    ]);
    expect(run.topology.edges).toHaveLength(14);
    // `entry` names the first REAL node, not the virtual __start__ — measured
    // on the artifact rather than assumed. A layout that seeded its BFS from
    // `entry` alone would therefore skip the start box entirely.
    expect(run.topology.entry).toBe("router");
  });

  it("keeps a conditional edge marked as one", () => {
    // A branch the compiler knew about is drawn differently from a fixed edge,
    // and "not taken" only means anything for the conditional ones.
    const cond = run.topology.edges.filter((e) => e.kind === "conditional");
    expect(cond).toHaveLength(8);
    expect(run.topology.edges.find((e) => e.from === "retrieve")!.kind).toBe("direct");
  });
});

describe("the run that walks it", () => {
  it("counts what actually happened", () => {
    expect(run.runId).toBe("bbf32a7d7199");
    // The writer's own count, from graph_end. The superstep FIELD runs 0..11,
    // which is twelve values — deriving the count from the maximum would print
    // one more step than the run took, and the footer would disagree with the
    // reference viewer.
    expect(run.supersteps).toBe(11);
    expect(run.records.length).toBeGreaterThan(30);
  });

  it("orders the records as the transport will step through them", () => {
    expect(run.records[0].type).toBe("graph_start");
    expect(run.records[run.records.length - 1].type).toBe("graph_end");
    for (let i = 1; i < run.records.length; i++) {
      expect(run.records[i].ts).toBeGreaterThanOrEqual(run.records[i - 1].ts);
    }
  });

  it("knows which node ran, how long, and how often", () => {
    const generate = run.nodes.get("generate")!;
    expect(generate.entered).toBeGreaterThanOrEqual(1);
    expect(generate.updateKeys).toContain("answer");
    expect(generate.updateBytes).toBeGreaterThan(0);
    expect(generate.lastSuperstep).not.toBeNull();
  });

  it("counts a re-entered node rather than overwriting it", () => {
    // The CRAG loop runs the router more than once. A viewer that shows "×2"
    // needs the count, and a viewer that shows a duration needs it not to be
    // the first visit's.
    const rerun = [...run.nodes.values()].filter((n) => n.entered > 1);
    expect(rerun.length).toBeGreaterThan(0);
  });

  it("records which edges were actually taken, leaving the rest visible", () => {
    // The whole difference from a trace: the path NOT taken stays on the canvas.
    expect(run.taken.size).toBeGreaterThan(0);
    expect(run.taken.size).toBeLessThan(run.topology.edges.length);
    expect(run.taken.has("__start__->router")).toBe(true);
  });

  it("leaves a node that never ran without a lifecycle", () => {
    const untouched = run.topology.nodes.filter((n) => !run.nodes.has(n.id));
    expect(untouched.length).toBeGreaterThan(0);
  });
});

describe("the values, and the policy that decided them", () => {
  it("reads the policy as a policy, never as a boolean", () => {
    expect(run.policy).not.toBeNull();
    expect(run.policy!.mode).toBe("summary");
    expect(run.policy!.redaction).toBe("patterns");
    expect(typeof run.policy!.redaction).toBe("string");
    expect(run.policy!.allowed).toContain("answer");
    expect(run.policy!.denied).toContain("principal");
  });

  it("joins a payload to its node and superstep", () => {
    const p = run.payloadFor("generate");
    expect(p).not.toBeNull();
    expect(p!.node).toBe("generate");
    expect(Object.keys(p!.channels)).toContain("answer");
    expect(typeof p!.channels.answer).toBe("string");
    expect(p!.channels.answer as string).toMatch(/maintenance window/i);
  });

  it("keeps the channel order the node wrote in", () => {
    const p = run.payloadFor("generate")!;
    expect(Object.keys(p.channels)[0]).toBe(p.writeOrder[0]);
  });

  it("tells the two absences apart", () => {
    // THE rule from the house: "not recorded" and "was empty" are different
    // statements, and so are the two reasons for not recording.
    expect(channelAbsence(run.policy!, "docs")).toEqual({
      absent: true,
      reason: "not-allowed",
      note: "not on the allow list",
    });
    expect(channelAbsence(run.policy!, "principal")).toEqual({
      absent: true,
      reason: "denied",
      note: "denied",
    });
    expect(channelAbsence(run.policy!, "answer").absent).toBe(false);
  });
});

describe("a clipped value never looks like a whole one", () => {
  const marker = (v: unknown): Marker | null =>
    typeof v === "object" && v !== null && "kind" in (v as object) ? (v as Marker) : null;

  it("recognises every marker shape by the ceiling that fired", () => {
    for (const [value, kind, omitted] of [
      [{ kind: "str", bytes: 9000, chars: 8000, omitted: "cap", head: "abc" }, "str", "cap"],
      [{ kind: "list", len: 40, bytes: 900, omitted: "cap", sampled: 3, items: [] }, "list", "cap"],
      [{ kind: "unserializable", type: "Foo", omitted: "error" }, "unserializable", "error"],
      [{ kind: "channel", bytes: 40000, omitted: "recordCap" }, "channel", "recordCap"],
    ] as const) {
      const m = marker(value)!;
      expect(m.kind).toBe(kind);
      expect(m.omitted).toBe(omitted);
    }
  });

  it("keeps the TRUE size on a clipped value, not the clipped one", () => {
    // A viewer that shows the marker's own length would report the lie.
    const m = marker({ kind: "str", bytes: 9000, chars: 8000, omitted: "cap", head: "abc" })!;
    expect(m.bytes).toBe(9000);
    expect((m as { head: string }).head).toBe("abc");
  });

  it("treats a redaction as a redaction, not as a truncation", () => {
    const m = marker({ kind: "redacted", rule: "email", bytes: "1k-4k" })!;
    expect(m.kind).toBe("redacted");
    expect(m.omitted).toBeUndefined();
  });
});

describe("what a broken file does", () => {
  it("skips a line that is not JSON and says how many", () => {
    const r = readStateGraphRun(GRAPH + "\nnot json at all\n{oops\n", STATE);
    expect(r.badLines).toBe(2);
    expect(r.topology.nodes).toHaveLength(10);
  });

  it("reads a graph file with no state file beside it", () => {
    const r = readStateGraphRun(GRAPH, null);
    expect(r.policy).toBeNull();
    expect(r.payloads).toHaveLength(0);
    expect(r.topology.nodes).toHaveLength(10);
  });

  it("refuses to take values out of the graph file", () => {
    // The safety property, enforced at the reader too: the L1 file is the one
    // that must stay attachable to a bug report. If a state_payload ever shows
    // up in it, the reader counts it and drops it rather than rendering it.
    const poisoned = GRAPH + '\n{"type":"state_payload","runId":"x","node":"n","superstep":0,"channels":{"secret":"leak"},"ts":1}\n';
    const r = readStateGraphRun(poisoned, null);
    expect(r.payloads).toHaveLength(0);
    expect(r.misfiled).toBe(1);
  });

  it("survives an empty file", () => {
    const r = readStateGraphRun("", null);
    expect(r.topology.nodes).toEqual([]);
    expect(r.records).toEqual([]);
    expect(r.runId).toBeNull();
  });
});
