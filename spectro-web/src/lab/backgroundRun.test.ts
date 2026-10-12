// Card 505, criteria 8 and 9: a recorded background run, as the session file
// holds it. A parent spawns two helpers in the background, asks the second one
// "status?", the helper answers through send_message to parent, and the parent
// collects both results with wait_agents.
//
// The recording comes from BackgroundFanOutTest's criterion 6 run, written by
// SPECTRO_CAPTURE_BACKGROUND_RUN (testkit/backgroundRun.jsonl).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { foldArchiveDeferred } from "../state/archiveFold";
import { initialState, reduce, type Turn } from "../state/reducer";
import { groupTurnsV2 } from "../state/threads";
import { messageLanes } from "./messageLane";
import { spawnTree } from "./spawnTree";

const EVENTS: RunEvent[] = readFileSync(
  fileURLToPath(new URL("../testkit/backgroundRun.jsonl", import.meta.url)),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as RunEvent);

type MessageTurn = Extract<Turn, { kind: "message" }>;

const live = () => EVENTS.reduce(reduce, initialState);
const messagesOf = (turns: Turn[]): MessageTurn[] =>
  turns.filter((t): t is MessageTurn => t.kind === "message");

describe("a recorded background run", () => {
  it("is the run the test recorded: two background helpers and one status exchange", () => {
    expect(EVENTS.filter((e) => e.type === "agent_spawn").map((e) => e.agentId)).toEqual([
      "explore-1",
      "explore-2",
    ]);
    const peer = EVENTS.filter((e) => e.type === "agent_message" && e.role === "peer");
    expect(peer.map((e) => (e.type === "agent_message" ? `${e.from}>${e.to}:${e.state}` : ""))).toEqual([
      "main>explore-2:sent",
      "main>explore-2:received",
      "explore-2>parent:sent",
      "explore-2>main:received",
    ]);
  });

  it("draws the question and the answer as message blocks in the helper's thread and once in the main thread", () => {
    const state = live();
    const messages = messagesOf(state.turns);
    expect(messages.map((m) => m.text)).toEqual(["status?", "two of five files read"]);
    for (const m of messages) expect(m.agentId).toBe("explore-2");

    const blocks = groupTurnsV2(state.turns, state.cards, state.agents);
    const inMain = blocks.filter((b) => b.kind === "turn" && b.turn.kind === "message");
    expect(inMain).toHaveLength(2);
    const thread = blocks
      .filter((b) => b.kind === "chip")
      .flatMap((b) => (b.kind === "chip" ? (b.threads["explore-2"] ?? []) : []))
      .map((item) => item.turn)
      .filter((t): t is MessageTurn => t.kind === "message")
      .map((t) => t.text);
    expect(thread).toEqual(["status?", "two of five files read"]);
  });

  it("places both helpers in the Lab's spawn tree under the parent", () => {
    const tree = spawnTree(EVENTS);
    expect(tree.reported).toBe(2);
    expect(tree.resolved).toBe(2);
    expect(tree.knownAgents).toEqual(new Set(["explore-1", "explore-2"]));
    expect(tree.topo.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual([
      "main>explore-1",
      "main>explore-2",
    ]);
  });

  it("draws the question down and the answer up as handovers the tree decided, one per message", () => {
    const peer = messageLanes(EVENTS).messages.filter((m) => m.role === "peer");
    expect(peer.map((m) => `${m.from}>${m.to}:${m.direction}:${m.fromTree}`)).toEqual([
      "main>explore-2:down:true",
      "explore-2>main:up:true",
    ]);
    expect(peer.map((m) => m.text)).toEqual(["status?", "two of five files read"]);
    expect(peer.every((m) => m.answers === null)).toBe(true);
  });

  it("shows the same blocks and the same roster when it is replayed as when it ran", () => {
    const running = live();
    const replayed = foldArchiveDeferred(EVENTS).state;
    expect(replayed.turns).toEqual(running.turns);
    expect(replayed.agents).toEqual(running.agents);
    expect(messagesOf(replayed.turns)).toHaveLength(2);
  });
});
