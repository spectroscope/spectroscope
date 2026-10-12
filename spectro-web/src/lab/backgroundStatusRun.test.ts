// Card 505, criterion 9, fix round: a recorded background run in which a
// helper's status line and its result reach the parent through the inbox, and
// a second helper's result arrives through the join at the parent's end_turn.
// Each of the three is written as agent_message role peer, state received; the
// chat draws a block for each, and the replayed run shows the same blocks.
//
// The recording comes from BackgroundFanOutTest's criterion 9 run, written by
// SPECTRO_CAPTURE_BACKGROUND_STATUS_RUN (testkit/backgroundStatusRun.jsonl),
// one event per line with a plain ObjectMapper as SessionStore.append writes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { foldArchiveDeferred } from "../state/archiveFold";
import { initialState, reduce, type Turn } from "../state/reducer";

const EVENTS: RunEvent[] = readFileSync(
  fileURLToPath(new URL("../testkit/backgroundStatusRun.jsonl", import.meta.url)),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as RunEvent);

type MessageTurn = Extract<Turn, { kind: "message" }>;

const messagesOf = (turns: Turn[]): MessageTurn[] =>
  turns.filter((t): t is MessageTurn => t.kind === "message");
const firstLine = (text: string) => text.split("\n")[0];

describe("a recorded background run with a status line and two results", () => {
  it("is the run the test recorded: three peer messages the parent received", () => {
    const peer = EVENTS.filter((e) => e.type === "agent_message" && e.role === "peer");
    expect(
      peer.map((e) =>
        e.type === "agent_message" ? `${e.from}>${e.to}:${e.state}:${firstLine(e.text)}` : "",
      ),
    ).toEqual([
      "explore-1>main:received:Status of explore-1: reading the parser",
      "explore-1>main:received:Result of explore-1 (completed):",
      "explore-2>main:received:Result of explore-2 (completed):",
    ]);
  });

  it("draws a message block for the status line and for each result", () => {
    const state = EVENTS.reduce(reduce, initialState);
    expect(messagesOf(state.turns).map((m) => firstLine(m.text))).toEqual([
      "Status of explore-1: reading the parser",
      "Result of explore-1 (completed):",
      "Result of explore-2 (completed):",
    ]);
  });

  it("shows the same blocks when it is replayed as when it ran", () => {
    const running = EVENTS.reduce(reduce, initialState);
    const replayed = foldArchiveDeferred(EVENTS).state;
    expect(replayed.turns).toEqual(running.turns);
    expect(replayed.agents).toEqual(running.agents);
    expect(messagesOf(replayed.turns)).toHaveLength(3);
  });
});
