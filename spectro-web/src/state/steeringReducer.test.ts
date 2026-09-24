import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce } from "./reducer";

/**
 * Card 380, criterion 6: a sentence typed into a running turn reads back as the
 * OPERATOR, not as the model.
 *
 * This is the defect card 141 fixed on the import path: operator words that
 * arrive as model output are unrecoverable afterwards, because nothing in the
 * record says which they were.
 */
const taken = (text: string): RunEvent =>
  ({ type: "steering_message", agentId: "main", text, taken: true, turn: 2, ts: 5 }) as RunEvent;

const refused = (text: string): RunEvent =>
  ({ type: "steering_message", agentId: "main", text, taken: false, turn: 15, ts: 6 }) as RunEvent;

describe("the steering message in the transcript", () => {
  it("draws as an operator turn and never as the agent's own text", () => {
    const state = reduce(initialState, taken("use the cached list, not the API"));

    const last = state.turns[state.turns.length - 1];
    expect(last).toBeDefined();
    expect(last.kind).toBe("user");
    expect(last.kind === "user" ? last.text : "").toBe("use the cached list, not the API");

    // The pin that matters: not an assistant turn, whatever else it is.
    expect(state.turns.some((t) => t.kind === "assistant")).toBe(false);
  });

  it("says so when the turn cap refused it, beside the sentence itself", () => {
    const state = reduce(initialState, refused("too late"));

    const kinds = state.turns.map((t) => t.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("info");
    const note = state.turns.find((t) => t.kind === "info");
    expect(note?.kind === "info" ? note.infoKey : "").toBe("chat.steerNotTaken");
    expect(note?.kind === "info" ? note.tone : "").toBe("warn");
  });

  it("adds no note when the run read it", () => {
    // Paired with the test above: without this half, an implementation that
    // always drew the note would pass it.
    const state = reduce(initialState, taken("read me"));

    expect(state.turns.some((t) => t.kind === "info")).toBe(false);
  });

  // Fix round 2026-09-24, item 2: the drawn turn says which of the two it was,
  // in the bubble itself, so a sentence the run read and one it missed never
  // look the same once the pending row is gone.
  it("marks the operator turn as delivered when the run read it", () => {
    const state = reduce(initialState, taken("read me"));

    const last = state.turns[state.turns.length - 1];
    expect(last.kind === "user" ? last.steer : undefined).toBe("delivered");
  });

  it("marks the operator turn as not delivered when the run ended first", () => {
    const state = reduce(initialState, refused("too late"));

    const said = state.turns.find((t) => t.kind === "user");
    expect(said?.kind === "user" ? said.steer : undefined).toBe("undelivered");
    expect(said?.kind === "user" ? said.text : "").toBe("too late");
  });

  it("leaves an ordinary prompt unmarked", () => {
    // The positive pair of the two above: a mark on every user turn would pass
    // them both.
    const state = reduce(initialState, {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "an ordinary prompt",
      ts: 1,
    } as RunEvent);

    const said = state.turns.find((t) => t.kind === "user");
    expect(said?.kind === "user" ? said.text : "").toBe("an ordinary prompt");
    expect(said?.kind === "user" ? said.steer : "absent").toBeUndefined();
  });
});
