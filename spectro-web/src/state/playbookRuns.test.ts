// Card 482: the three reads of a playbook run. The confirmation asks for the
// start preview of a folder and a workspace; the run view asks for the runs of
// a session and for the graph file of one run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRunGraph, fetchRuns, fetchStartPreview } from "./playbookRuns";

function respond(body: unknown, text = ""): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  } as unknown as Response);
}

function urlOf(call: number): string {
  return String(vi.mocked(fetch).mock.calls[call]?.[0]);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the playbook run reads", () => {
  it("asks for the start preview of a folder and a workspace", async () => {
    respond({
      dir: "/pb",
      hash: "sha256:00",
      findings: [],
      steps: [],
      skills: [],
      commands: [],
      refusals: [],
    });
    const preview = await fetchStartPreview("/pb", "/ws");
    expect(urlOf(0)).toBe("/api/playbooks/start-preview?dir=%2Fpb&workspace=%2Fws");
    expect(preview.hash).toBe("sha256:00");
  });

  it("throws when the preview is refused", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400 } as unknown as Response);
    await expect(fetchStartPreview("/pb", "/ws")).rejects.toThrow("400");
  });

  it("asks for the runs of a session", async () => {
    const rows = [
      { run: "abcdefabcdef", playbook: "spectro", startedAt: 1, stopReason: null, live: true, graph: "g" },
    ];
    respond(rows);
    expect(await fetchRuns("s1")).toEqual(rows);
    expect(urlOf(0)).toBe("/api/sessions/s1/playbook-runs");
  });

  it("asks for the graph of one run and returns its text", async () => {
    respond(null, '{"type":"graph_start"}\n');
    expect(await fetchRunGraph("s1", "abcdefabcdef")).toBe('{"type":"graph_start"}\n');
    expect(urlOf(0)).toBe("/api/sessions/s1/playbook-runs/abcdefabcdef/graph");
  });

  it("answers an empty list and an empty graph when the server refuses", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    expect(await fetchRuns("s1")).toEqual([]);
    expect(await fetchRunGraph("s1", "abcdefabcdef")).toBe("");
  });
});
