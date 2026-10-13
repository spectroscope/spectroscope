// Card 593: one agent choice per record in view, resolved against the roster.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "./reducer";
import { initialState } from "./reducer";
import {
  __resetShownAgentForTests,
  closedViewKeys,
  figuresOf,
  forgetShownAgent,
  ringOf,
  rootAgentIdOf,
  setShownAgent,
  shownAgentOf,
  useShownAgent,
} from "./shownAgent";

afterEach(() => __resetShownAgentForTests());

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  parentId,
  label: null,
  task: "",
  state: "working",
  lastStatus: null,
  inTokens: 0,
  outTokens: 0,
  ...extra,
});
const roster = [
  row("main", null),
  row("explore-1", "main", { task: "look around" }),
  row("session-title", null),
];
const state = { ...initialState, rootAgentId: "main", agents: roster };

function Probe({ k }: { k: string }) {
  return <i>{useShownAgent(k) ?? "root"}</i>;
}
const read = (k: string): string => renderToStaticMarkup(<Probe k={k} />);

describe("the store", () => {
  it("keeps one choice per view key and forgets it on request", () => {
    expect(read("live:a")).toBe("<i>root</i>");
    setShownAgent("live:a", "explore-1");
    setShownAgent("live:b", "worker-2");
    expect(read("live:a")).toBe("<i>explore-1</i>");
    expect(read("live:b")).toBe("<i>worker-2</i>");
    forgetShownAgent("live:a");
    expect(read("live:a")).toBe("<i>root</i>");
    expect(read("live:b")).toBe("<i>worker-2</i>");
    setShownAgent("live:b", null);
    expect(read("live:b")).toBe("<i>root</i>");
  });

  it("names the live view keys whose record closed, and only those", () => {
    expect(closedViewKeys(["live:a", "live:b", "live:c"], ["live:b", "live:d"])).toEqual([
      "live:a",
      "live:c",
    ]);
    expect(closedViewKeys([], ["live:a"])).toEqual([]);
    expect(closedViewKeys(["live:a"], ["live:a"])).toEqual([]);
  });
});

describe("the resolver", () => {
  it("shows the root for no choice, with its roster row", () => {
    const shown = shownAgentOf(state, null);
    expect(shown).toMatchObject({ id: "main", rootId: "main", isRoot: true, missing: null });
    expect(shown.row?.id).toBe("main");
  });

  it("shows a helper for its id", () => {
    const shown = shownAgentOf(state, "explore-1");
    expect(shown).toMatchObject({ id: "explore-1", rootId: "main", isRoot: false, missing: null });
    expect(shown.row?.task).toBe("look around");
  });

  it("treats the root's own id as the root", () => {
    expect(shownAgentOf(state, "main").isRoot).toBe(true);
  });

  it("resolves a choice outside the roster to the root and says which id is gone", () => {
    expect(shownAgentOf(state, "worker-9")).toMatchObject({ id: "main", isRoot: true, missing: "worker-9" });
  });

  it("never shows the parentless session-title row and never takes it for the root", () => {
    expect(shownAgentOf(state, "session-title")).toMatchObject({
      id: "main",
      isRoot: true,
      missing: "session-title",
    });
    const titleFirst = { ...initialState, rootAgentId: "main", agents: [roster[2], roster[0]] };
    expect(rootAgentIdOf(titleFirst)).toBe("main");
    // Before the root run has named itself, the title row is skipped too.
    const titleFirstNoRun = { ...initialState, agents: [roster[2], roster[0]] };
    expect(rootAgentIdOf(titleFirstNoRun)).toBe("main");
  });

  it("takes the root from rootAgentId on a standalone subagent transcript", () => {
    const standalone = { ...initialState, rootAgentId: "worker-3", agents: [row("worker-3", null)] };
    expect(shownAgentOf(standalone, null).id).toBe("worker-3");
  });

  it("falls back to the first parentless row, then to main, before any run", () => {
    expect(rootAgentIdOf({ ...initialState, agents: [row("main", null)] })).toBe("main");
    expect(rootAgentIdOf(initialState)).toBe("main");
    expect(shownAgentOf(initialState, null)).toMatchObject({
      id: "main",
      isRoot: true,
      row: null,
      missing: null,
    });
  });
});

describe("the figures", () => {
  const figured = {
    ...state,
    lastInputTokens: 1000,
    helpers: {
      "explore-1": {
        lastInputTokens: 350,
        context: null,
        announcedWindow: { contextWindow: 200_000, thresholdSource: "model" as const },
      },
    },
  };

  it("reads the root's three fields for the root", () => {
    expect(figuresOf(figured, shownAgentOf(figured, null))).toEqual({
      lastInputTokens: 1000,
      context: null,
      announcedWindow: null,
    });
  });

  it("reads a helper's slot for a helper, and zeros for a helper without one", () => {
    expect(figuresOf(figured, shownAgentOf(figured, "explore-1")).lastInputTokens).toBe(350);
    const fresh = { ...figured, agents: [...roster, row("worker-2", "main", { state: "submitted" })] };
    expect(figuresOf(fresh, shownAgentOf(fresh, "worker-2"))).toEqual({
      lastInputTokens: 0,
      context: null,
      announcedWindow: null,
    });
  });

  it("builds the ring's view only where App handed a selection", () => {
    expect(ringOf(undefined, figured)).toBeUndefined();
    expect(ringOf({}, figured)).toBeUndefined();
    const onPick = (): void => {};
    const ring = ringOf({ shown: shownAgentOf(figured, "explore-1"), onPickAgent: onPick }, figured);
    expect(ring?.picker.agents).toBe(figured.agents);
    expect(ring?.picker.onPick).toBe(onPick);
    expect(ring?.figures.lastInputTokens).toBe(350);
  });
});
