// Card 296, the view setting. `auto` stays the honest default: the corrected
// reserve already stacks three seats three deep at 16:9, so the preference is
// a preference and not the fix. It exists because a person looking at a run
// may want the shape held still while the seat count moves under it.
import { describe, expect, it } from "vitest";
import { rowsFor, rowsPrefFrom, SEAT_ROWS_EXPANDED } from "./workerGrid";
import { advanceScene, initialScene } from "../labScene";
import type { RunEvent } from "../../events";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";
import { foldSeatPool } from "./workerGrid";

describe("rowsPrefFrom — the read half of the stored choice", () => {
  it("takes the two forced shapes and nothing else", () => {
    expect(rowsPrefFrom("2")).toBe(2);
    expect(rowsPrefFrom("3")).toBe(3);
  });

  it("falls back to auto for absent, empty and junk values", () => {
    for (const raw of [null, "", "auto", "4", "3.5", "three", "0", "-2"]) {
      expect(rowsPrefFrom(raw), JSON.stringify(raw)).toBe("auto");
    }
  });
});

describe("rowsFor under a forced preference", () => {
  it("auto is what the map did before the setting existed", () => {
    expect(rowsFor(4, 16 / 9, "auto")).toBe(rowsFor(4, 16 / 9));
    expect(rowsFor(12, 16 / 9, "auto")).toBe(rowsFor(12, 16 / 9));
  });

  it("a forced count wins over the aspect the pane measured", () => {
    // auto puts four seats in two rows at 16:9 (measured); the preference
    // overrules exactly that.
    expect(rowsFor(4, 16 / 9)).toBe(2);
    expect(rowsFor(4, 16 / 9, 3)).toBe(3);
    expect(rowsFor(12, 16 / 9, 2)).toBe(2);
  });

  it("never asks for more rows than there are seats", () => {
    expect(rowsFor(1, 16 / 9, 3)).toBe(1);
    expect(rowsFor(2, 16 / 9, 3)).toBe(2);
  });

  it("holds on a pane that never measured — a preference is not a measurement", () => {
    // The hidden-pane trap: no aspect ever arrives, and auto falls back to the
    // constant. An explicit choice is the user's and must survive that.
    expect(rowsFor(6, null)).toBe(SEAT_ROWS_EXPANDED);
    expect(rowsFor(6, null, 2)).toBe(2);
    expect(rowsFor(6, undefined, 3)).toBe(3);
  });

  it("says nothing about a map with no workers", () => {
    expect(rowsFor(0, 16 / 9, 3)).toBe(SEAT_ROWS_EXPANDED);
  });
});

describe("the preference reaches the layout", () => {
  const T = 1;
  const events = (n: number): RunEvent[] => [
    {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "go",
      provider: "anthropic",
      ts: T,
    } as RunEvent,
    ...Array.from(
      { length: n },
      (_, i) => ({ type: "agent_spawn", agentId: `w${i}`, parentId: "main", task: "t", ts: T }) as RunEvent,
    ),
  ];
  const rowsDrawn = (n: number, rowsPref: "auto" | 2 | 3): number => {
    const evs = events(n);
    const scene = evs.reduce(advanceScene, initialScene());
    const flow = sceneToFlow(scene, deriveDetail(evs), {
      provider: "anthropic",
      model: "m",
      expanded: true,
      pool: foldSeatPool(evs),
      paneAspect: 16 / 9,
      rowsPref,
    });
    return new Set(flow.nodes.filter((node) => node.type === "subagent").map((node) => node.position.y)).size;
  };

  it("four workers stack two deep on auto and three deep when asked", () => {
    expect(rowsDrawn(4, "auto")).toBe(2);
    expect(rowsDrawn(4, 3)).toBe(3);
    expect(rowsDrawn(4, 2)).toBe(2);
  });

  it("twelve workers go four deep on auto and two deep when asked", () => {
    expect(rowsDrawn(12, "auto")).toBe(4);
    expect(rowsDrawn(12, 2)).toBe(2);
  });
});
