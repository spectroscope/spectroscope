// Card 458: one row per session. The rail merges the stored list with the
// sessions this page holds a socket to, and a click decides what opens.

import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../events";
import {
  deleteQuestion,
  heldRunState,
  mergeHeldRows,
  openDecision,
  replayComposer,
  type HeldRow,
} from "./sessionRows";

const stored = (id: string, startedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  startedAt,
  firstPrompt: `prompt ${id}`,
  tokens: 10,
  stopReason: "end_turn",
  ...extra,
});

const held = (id: string, extra: Partial<HeldRow> = {}): HeldRow => ({
  id,
  firstPrompt: `held ${id}`,
  startedAt: 5_000,
  running: false,
  attention: null,
  ...extra,
});

describe("mergeHeldRows", () => {
  it("lists a held session that is also stored exactly once", () => {
    const rows = mergeHeldRows([stored("a", 3), stored("b", 2)], [held("a")]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows.filter((r) => r.id === "a")).toHaveLength(1);
  });

  it("puts a held session whose file is not listed yet at the top, titled by its first prompt", () => {
    const rows = mergeHeldRows([stored("a", 3)], [held("fresh", { firstPrompt: "Hallo Welt" })]);
    expect(rows.map((r) => r.id)).toEqual(["fresh", "a"]);
    expect(rows[0].firstPrompt).toBe("Hallo Welt");
  });

  it("keeps the stored row's own fields (title, pin) for a held session", () => {
    const rows = mergeHeldRows([stored("a", 3, { title: "Named", pinned: true })], [held("a")]);
    expect(rows[0].title).toBe("Named");
    expect(rows[0].pinned).toBe(true);
  });

  it("gives back the stored list itself when nothing is held", () => {
    const list = [stored("a", 3)];
    expect(mergeHeldRows(list, [])).toBe(list);
  });
});

describe("heldRunState", () => {
  it("pulses a held session that runs and holds still for one that does not", () => {
    expect(heldRunState(held("a", { running: true }))).toBe("running");
    expect(heldRunState(held("a", { running: false }))).toBe("live");
  });
});

describe("openDecision", () => {
  it("selects a session this page already holds instead of opening it again", () => {
    expect(openDecision("a", { held: [held("a")] })).toEqual({ kind: "select", id: "a" });
  });

  it("opens any other stored session", () => {
    expect(openDecision("b", { held: [held("a")] })).toEqual({ kind: "open", id: "b" });
  });

  it("never locks a row because another session runs (card 459 lifted card 458's step 1)", () => {
    expect(openDecision("b", { held: [held("a", { running: true })] })).toEqual({ kind: "open", id: "b" });
    expect(openDecision("a", { held: [held("a", { running: true })] })).toEqual({ kind: "select", id: "a" });
  });
});

describe("replayComposer", () => {
  it("offers the composer for a stored session nobody else holds", () => {
    expect(replayComposer("s-1", { liveElsewhere: [] })).toEqual({ kind: "continue" });
  });

  it("keeps an import and a scenario read-only and says which", () => {
    expect(replayComposer("import:claude-code:x.jsonl", { liveElsewhere: [] })).toEqual({
      kind: "readOnly",
      reason: "import",
    });
    expect(replayComposer("scenario:demo", { liveElsewhere: [] })).toEqual({
      kind: "readOnly",
      reason: "scenario",
    });
  });

  it("keeps a session another window holds read-only", () => {
    expect(replayComposer("s-1", { liveElsewhere: ["s-1"] })).toEqual({
      kind: "readOnly",
      reason: "elsewhere",
    });
    expect(replayComposer("s-2", { liveElsewhere: ["s-1"] })).toEqual({ kind: "continue" });
  });
});

describe("deleteQuestion (card 459)", () => {
  it("asks to stop a running session this page holds before deleting it", () => {
    expect(deleteQuestion("a", { held: [held("a", { running: true })], liveElsewhere: [] })).toBe(
      "stopFirst",
    );
  });

  it("lets an idle held session go before deleting it, without the stop question", () => {
    expect(deleteQuestion("a", { held: [held("a")], liveElsewhere: [] })).toBe("releaseFirst");
  });

  it("refuses a session another window holds and deletes a stored one plainly", () => {
    expect(deleteQuestion("x", { held: [], liveElsewhere: ["x"] })).toBe("refused");
    expect(deleteQuestion("y", { held: [], liveElsewhere: ["x"] })).toBe("plain");
  });
});
