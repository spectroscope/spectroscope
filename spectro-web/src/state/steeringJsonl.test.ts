// Card 380, criterion 6: a steering sentence read back from a session file
// draws as the operator, not as the model.
//
// The file is the one SessionStore.append writes: SteeringJsonlRoundTripTest
// (spectro-core) pins the writer's bytes to this same fixture. Here it goes
// through the page's JSONL import (detectAndLoad) and the reducer, folded the
// way App's foldArchive folds an import: normalizeReplay(reduceAll(...)).
// That one line is repeated here, not imported, because foldArchive is local
// to App.tsx.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectAndLoad } from "../import/detect";
import { initialState, normalizeReplay, reduceAll } from "./reducer";

const FIXTURE = "spectro-core/src/test/resources/steering/steered-session.jsonl";

const text = readFileSync(fileURLToPath(new URL(`../../../${FIXTURE}`, import.meta.url)), "utf8");

const READ = "use the cached list, not the API";
const MISSED = "skip the slow ones";

describe("a steering sentence in a session file (card 380, criterion 6)", () => {
  const loaded = detectAndLoad(text);
  const state = normalizeReplay(reduceAll(initialState, loaded.events));

  it("imports as a spectroscope session with every line as an event", () => {
    expect(loaded.kind).toBe("spectroscope");
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    expect(loaded.events.length).toBe(lines.length);
    expect(loaded.events.filter((e) => e.type === "steering_message").length).toBe(2);
  });

  it("draws both sentences as operator turns, marked delivered and not delivered", () => {
    const said = state.turns.flatMap((t) => (t.kind === "user" ? [{ text: t.text, steer: t.steer }] : []));

    expect(said).toEqual([
      { text: "list the files", steer: undefined },
      { text: READ, steer: "delivered" },
      { text: "and now the tests", steer: undefined },
      { text: MISSED, steer: "undelivered" },
    ]);
  });

  it("puts neither sentence into the model's own text", () => {
    const modelText = state.turns.flatMap((t) => (t.kind === "assistant" ? [t.text] : [])).join("\n");

    // The positive half first: the model's own lines are there, so the
    // negatives below are not green on a transcript with no assistant turn.
    expect(modelText).toContain("Looking at the API.");
    expect(modelText).toContain("Using the cached list.");
    expect(modelText).not.toContain(READ);
    expect(modelText).not.toContain(MISSED);
  });

  it("says once that the second run ended before it read its sentence", () => {
    const notes = state.turns.filter((t) => t.kind === "info" && t.infoKey === "chat.steerNotTaken");
    expect(notes.length).toBe(1);
  });
});
