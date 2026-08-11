// The demo scenarios: real runs of the Java engine, bundled the way the
// reference run always was, and offered the way the agent scenarios are — a
// named list, one click each. Four shapes worth teaching plus the reference:
// the linear rag, the corrective loop, a two-turn conversation on one thread,
// and a run that dies honestly.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SCENARIOS, StateGraphPane } from "./StateGraphPane";
import { readStateGraphRun } from "./artifact";
import { DEFAULT_VIEW } from "./viewState";

describe("the scenario shelf", () => {
  it("carries the reference and the four generated demos", () => {
    expect(SCENARIOS.map((s) => s.source)).toEqual([
      "crag-payload.graph.jsonl",
      "simple-rag.graph.jsonl",
      "crag.graph.jsonl",
      "react-tools.graph.jsonl",
      "failing-run.graph.jsonl",
    ]);
  });

  it("every scenario parses as a real pair with a drawable topology", () => {
    for (const s of SCENARIOS) {
      const loaded = s.run();
      const parsed = readStateGraphRun(loaded.graphJsonl, loaded.stateJsonl);
      expect(parsed.topology.nodes.length, s.source).toBeGreaterThan(2);
      expect(parsed.records.length, s.source).toBeGreaterThan(4);
      expect(parsed.badLines, s.source).toBe(0);
    }
  });

  it("tells the four stories they were generated to tell", () => {
    const bySource = new Map(SCENARIOS.map((s) => [s.source, s.run()]));
    const react = readStateGraphRun(
      bySource.get("react-tools.graph.jsonl")!.graphJsonl,
      bySource.get("react-tools.graph.jsonl")!.stateJsonl,
    );
    expect(react.records.filter((r) => r.type === "graph_start")).toHaveLength(2);
    expect(react.threadId).toBe("t-react-demo");

    const failing = readStateGraphRun(bySource.get("failing-run.graph.jsonl")!.graphJsonl, null);
    expect(failing.records.some((r) => r.type === "node_error")).toBe(true);

    const rag = bySource.get("simple-rag.graph.jsonl")!;
    expect(rag.stateJsonl).toContain('"sampled":3');
  });

  it("the demos SHOW documents — an empty strip would teach the wrong lesson", () => {
    // The reference fixture keeps demonstrating honest absence (docs off the
    // allow list, byte-pinned). The generated demos are the opposite lesson:
    // the strip with real contents, including a sampled kept-of-N marker.
    const bySource = new Map(SCENARIOS.map((s) => [s.source, s.run()]));
    const crag = bySource.get("crag.graph.jsonl")!.stateJsonl!;
    expect(crag).toContain('"docs"');
    expect(crag).toContain("ops-handbook");
    expect(crag).toContain('"sampled":3');

    const failing = bySource.get("failing-run.graph.jsonl")!.stateJsonl!;
    expect(failing).toContain('"docs"');
    expect(failing).toContain("cafeteria");
  });

  it("the empty state offers every scenario as its own button", () => {
    const html = renderToStaticMarkup(
      <StateGraphPane run={null} onRun={() => {}} view={DEFAULT_VIEW} onView={() => {}} />,
    );
    for (const s of SCENARIOS) {
      expect(html).toContain(s.source.replace(".graph.jsonl", ""));
    }
    expect(html).toContain("sg-empty-scenarios");
  });
});
