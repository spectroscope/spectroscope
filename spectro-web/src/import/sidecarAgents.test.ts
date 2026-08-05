// Card 177: the index the work panel asks about the agents beside a session.

import { describe, expect, it, vi, afterEach } from "vitest";
import { loadSidecarAgents, NO_SIDECARS } from "./sidecarAgents";

const answer = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) } as unknown as Response)),
  );
};

afterEach(() => vi.unstubAllGlobals());

describe("loadSidecarAgents", () => {
  const rows = [
    {
      agentId: "direct1",
      path: "p/s/subagents/agent-direct1.jsonl",
      runId: null,
      bytes: 2048,
      modifiedAt: 1,
    },
    {
      agentId: "aaa",
      path: "p/s/subagents/workflows/wf_x/agent-aaa.jsonl",
      runId: "wf_x",
      bytes: 1024,
      modifiedAt: 2,
    },
    {
      agentId: "bbb",
      path: "p/s/subagents/workflows/wf_x/agent-bbb.jsonl",
      runId: "wf_x",
      bytes: 512,
      modifiedAt: 3,
    },
    {
      agentId: "ccc",
      path: "p/s/subagents/workflows/wf_y/agent-ccc.jsonl",
      runId: "wf_y",
      bytes: 256,
      modifiedAt: 4,
    },
  ];

  it("groups the agents by the run that produced them", async () => {
    answer({ agents: rows });
    const index = await loadSidecarAgents("p/s.jsonl");
    expect(index.forRun("wf_x").map((a) => a.agentId)).toEqual(["aaa", "bbb"]);
    expect(index.forRun("wf_y").map((a) => a.agentId)).toEqual(["ccc"]);
    expect(index.all).toHaveLength(4);
  });

  it("says nothing about a run it has never heard of", async () => {
    // A launch whose folder was deleted, or a Monitor with no run at all. The
    // panel keeps its refusal for those rows, which is the honest reading.
    answer({ agents: rows });
    const index = await loadSidecarAgents("p/s.jsonl");
    expect(index.forRun("wf_gone")).toEqual([]);
  });

  it("finds a direct spawn by the id its filename carries", async () => {
    answer({ agents: rows });
    const index = await loadSidecarAgents("p/s.jsonl");
    expect((await index.byAgentId("direct1"))?.path).toContain("agent-direct1.jsonl");
    expect(index.byAgentId("nobody")).toBeUndefined();
  });

  it("answers the empty index when the store cannot be reached", async () => {
    // A panel that cannot ask must say what it always said. Reporting "no
    // agents" would be a claim about the session, from a failure about us.
    answer({}, false);
    expect(await loadSidecarAgents("p/s.jsonl")).toBe(NO_SIDECARS);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    expect(await loadSidecarAgents("p/s.jsonl")).toBe(NO_SIDECARS);
  });

  it("drops a row the server did not name properly rather than inventing one", async () => {
    answer({ agents: [{ runId: "wf_x" }, rows[1]] });
    const index = await loadSidecarAgents("p/s.jsonl");
    expect(index.all.map((a) => a.agentId)).toEqual(["aaa"]);
  });
});
