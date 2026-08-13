// Card 175. The system context is the APP's, not the record's.
//
// It is uploaded with every request as the "system" role but is not a wire
// event, so the trace prepends one synthetic row for it. The fetch used to ride
// TraceView's mount — which was once per press, then once per app, and once the
// warm gate keys on the record that arrived, once per session opened. None of
// those is what the thing being fetched is: the operator's configuration does
// not change when a reader opens a different transcript.
//
// Measured on the branch before this: build A, one fetch after two session
// opens; build D, four fetches after three. The fix is not a cache with a
// lifetime, it is asking once.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { forgetTraceContext, loadTraceContext } from "./traceContext";

const answer = {
  systemPrompt: "you are spectro",
  tools: [{ name: "read" }],
  skills: [{ name: "kanban" }],
  mcpServers: ["board"],
};

beforeEach(() => {
  forgetTraceContext();
  vi.unstubAllGlobals();
});

describe("loadTraceContext", () => {
  it("asks the server once, however many views ask it", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => answer }));
    vi.stubGlobal("fetch", fetchMock);
    const [a, b] = await Promise.all([loadTraceContext(), loadTraceContext()]);
    expect(await loadTraceContext()).toEqual(answer);
    expect(a).toEqual(answer);
    expect(b).toEqual(answer);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/context");
  });

  it("answers null when the server refuses, and does not keep asking", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => answer }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadTraceContext()).toBeNull();
    expect(await loadTraceContext()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers null when the server cannot be reached at all", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    // A trace that threw here would render nothing at all — the synthetic row
    // is worth losing, the 9,320 real ones are not.
    expect(await loadTraceContext()).toBeNull();
  });
});
