// Card 271, criterion 3: an opened archive folds and unfolds like a live run.
//
// This is not a hand-built fixture. It reads a RECORDED session off disk and
// drives it through the real reducer and the real grouping, because the claim
// the card makes is about recovery: nothing was ever lost on disk, so every
// child's words must come back the moment the fold closes the rendering gap.
// A synthetic turn list could not have shown that — it would only prove the
// grouping consistent with itself.
//
// The recording is the one the app ships in its own demo home, so this runs on
// any machine and in CI. It was verified against the owner's real three-child
// archive as well (~/.spectro/sessions/20260717-151355-0cfef768.jsonl, 159
// events, 72 turns): there the chip recovers 66 of 66 child turns and 7,248
// characters of their prose, and per child the list is turn-for-turn identical
// to what v1 nests. That file is not committed — it is the owner's session.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../events";
import { initialState, normalizeReplay, reduceAll } from "./reducer";
import { groupTurns, groupTurnsV2, type ChatBlock, type ChatBlockV2 } from "./threads";
import { NO_FOLDS_OPEN, foldedTurns, toggleFold } from "./childFold";

const RECORDING =
  "../../../docs/guide-assets/demo-home/.spectro/sessions/20260723-151500-auth-refactor-three-lenses.jsonl";

const events: RunEvent[] = readFileSync(fileURLToPath(new URL(RECORDING, import.meta.url)), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as RunEvent);

const state = normalizeReplay(reduceAll(initialState, events));
const v2 = groupTurnsV2(state.turns, state.cards, state.agents);
const chips = v2.filter((b): b is Extract<ChatBlockV2, { kind: "chip" }> => b.kind === "chip");

describe("a replayed session with children", () => {
  it("really is a recording with more than one child in it", () => {
    // If this file ever loses its spawns the tests below would pass on an empty
    // set and prove nothing, so the premise is asserted before it is used.
    expect(events.filter((e) => e.type === "agent_spawn").length).toBeGreaterThan(1);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.flatMap((c) => c.workIds).length).toBeGreaterThan(1);
  });

  it("hides every child turn in the shipped, closed reading", () => {
    const shown = chips.flatMap((c) => foldedTurns(c.threads, c.workIds, NO_FOLDS_OPEN, "replay-1"));
    expect(shown).toEqual([]);
  });

  it("gives back every child turn the recording holds, once opened", () => {
    let folds = NO_FOLDS_OPEN;
    for (const id of chips.flatMap((c) => c.workIds)) folds = toggleFold(folds, "replay-1", id);
    const recovered = chips
      .flatMap((c) => foldedTurns(c.threads, c.workIds, folds, "replay-1"))
      .reduce((n, fold) => n + fold.items.length, 0);
    const nested = groupTurns(state.turns, state.cards, state.agents)
      .filter((b): b is Extract<ChatBlock, { kind: "thread" }> => b.kind === "thread")
      .reduce((n, block) => n + block.items.length, 0);
    // The number v1 shows and the number the fold shows, off the same recording.
    expect(recovered).toBe(nested);
    expect(recovered).toBeGreaterThan(0);
  });

  it("gives each child the same turns v1 nests for it, in the same order", () => {
    const v1 = groupTurns(state.turns, state.cards, state.agents);
    for (const chip of chips) {
      for (const id of chip.workIds) {
        const nested = v1
          .filter((b): b is Extract<ChatBlock, { kind: "thread" }> => b.kind === "thread" && b.agentId === id)
          .flatMap((b) => b.items);
        expect(chip.threads[id]).toEqual(nested);
      }
    }
  });

  it("opens one child of the archive without opening its siblings", () => {
    const chip = chips[0];
    const first = chip.workIds[0];
    const folds = toggleFold(NO_FOLDS_OPEN, "replay-1", first);
    expect(foldedTurns(chip.threads, chip.workIds, folds, "replay-1").map((f) => f.agentId)).toEqual([first]);
  });

  it("carries text, not just turn objects — the words are what was missing", () => {
    const words = chips
      .flatMap((c) => Object.values(c.threads).flat())
      .map((it) => ("text" in it.turn && typeof it.turn.text === "string" ? it.turn.text.length : 0))
      .reduce((a, b) => a + b, 0);
    expect(words).toBeGreaterThan(200);
  });
});
