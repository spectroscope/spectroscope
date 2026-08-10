import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildSpectrum } from "./spectrumModel";

/** A model exchange as the session now records it (card 184 leg 3). */
const exchange = (agentId: string, xid: string, ts: number, over: Partial<Record<string, unknown>> = {}) =>
  ({
    type: "llm_exchange",
    xid,
    agentId,
    turn: 1,
    kind: "chat",
    provider: "anthropic",
    model: "claude-opus-5",
    transport: "sdk",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    requestBytes: 9162,
    responseBytes: 4820,
    responseLines: 24,
    aborted: false,
    fidelity: "sdk-json",
    durationMs: 1704,
    ts,
    ...over,
  }) as unknown as RunEvent;

const start = (agentId: string, ts: number) =>
  ({ type: "run_start", runId: "r1", agentId, prompt: "go", ts }) as RunEvent;
const text = (agentId: string, ts: number) => ({ type: "text_delta", agentId, text: "hi", ts }) as RunEvent;

describe("the second line under an agent (card 184 leg 4)", () => {
  it("draws the exchanges on their own track, not among the app's marks", () => {
    // The whole point of two lines: the app protocol above, the conversation
    // with the model below. Mixing them into one row is the picture the owner
    // asked NOT to have — "oben und unten", so the interaction is visible.
    const model = buildSpectrum([start("main", 100), text("main", 150), exchange("main", "x-1", 200)]);
    const lane = model.lanes.find((l) => l.id === "main");
    expect(lane?.wire).toHaveLength(1);
    expect(lane?.ticks.some((t) => t.kind === "token")).toBe(true);
    // and the exchange left no mark on the upper line
    expect(lane?.ticks).toHaveLength(2); // run_start lifecycle + the token
  });

  it("carries the xid, because that is what the join is FOR", () => {
    // A mark you cannot follow back to its record is decoration. The xid is the
    // sidecar's key, so a click on this tick can ask for the bodies.
    const lane = buildSpectrum([start("main", 100), exchange("main", "x-7", 200)]).lanes[0];
    expect(lane.wire[0].xid).toBe("x-7");
  });

  it("puts each exchange on the same time axis as the line above it", () => {
    // Both tracks are normalized against the SAME t0/t1, which is what makes
    // "above and below" mean anything: a mark below sits under the moment it
    // happened.
    const model = buildSpectrum([
      start("main", 1000),
      exchange("main", "x-1", 1000),
      exchange("main", "x-2", 2000),
      text("main", 2000),
    ]);
    const lane = model.lanes[0];
    expect(lane.wire.map((w) => w.x)).toEqual([0, 1]);
    expect(model.t0).toBe(1000);
    expect(model.t1).toBe(2000);
  });

  it("keeps every agent's exchanges on that agent's own line", () => {
    const model = buildSpectrum([
      start("main", 100),
      exchange("main", "x-1", 150),
      exchange("worker", "x-2", 160),
    ]);
    expect(model.lanes.find((l) => l.id === "main")?.wire.map((w) => w.xid)).toEqual(["x-1"]);
    expect(model.lanes.find((l) => l.id === "worker")?.wire.map((w) => w.xid)).toEqual(["x-2"]);
  });

  it("says when a call never answered instead of drawing it as a success", () => {
    // status null is a transport failure: nothing came back. Rendering that the
    // same as a 200 would be the record lying in a picture.
    const lane = buildSpectrum([
      start("main", 100),
      exchange("main", "x-1", 150, { status: undefined, aborted: true }),
    ]).lanes[0];
    expect(lane.wire[0].status).toBeNull();
    expect(lane.wire[0].aborted).toBe(true);
  });

  it("gives a lane with no model call an empty second line, never a missing one", () => {
    // An agent that only ran tools has a line with nothing on it, and that is a
    // fact worth seeing. `undefined` would make every renderer guard for it.
    const lane = buildSpectrum([start("main", 100), text("main", 150)]).lanes[0];
    expect(lane.wire).toEqual([]);
  });

  it("sorts the second line by time, like the first", () => {
    // The slicer binary-searches the upper track and will do the same here.
    const lane = buildSpectrum([
      start("main", 100),
      exchange("main", "late", 900),
      exchange("main", "early", 200),
    ]).lanes[0];
    expect(lane.wire.map((w) => w.xid)).toEqual(["early", "late"]);
  });
});
