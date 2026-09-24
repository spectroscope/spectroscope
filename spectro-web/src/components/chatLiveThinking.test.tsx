// Card 395, wave H1c: the chat draws what the reducer holds for children who
// think at the same time. Rendered on React's server renderer (this suite has
// no DOM), so the markup is the chat's first paint for a given state: one
// Thinking block per child, and every child that is thinking marked live.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "../state/reducer";
import type { UiState } from "../state/reducer";
import { Chat } from "./Chat";

const fanOut: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "fan out", ts: 1 },
  { type: "tool_call", agentId: "main", callId: "spawn", name: "spawn_agents", input: {}, ts: 2 },
  { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "a", ts: 3 },
  { type: "agent_spawn", agentId: "explore-2", parentId: "main", task: "b", ts: 4 },
  { type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main", prompt: "a", ts: 5 },
  { type: "run_start", runId: "r3", agentId: "explore-2", parentId: "main", prompt: "b", ts: 6 },
];

function interleaved(n: number): RunEvent[] {
  const out: RunEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      { type: "thinking_delta", agentId: "explore-1", text: `a${i}|`, ts: 10 + 2 * i },
      { type: "thinking_delta", agentId: "explore-2", text: `b${i}|`, ts: 11 + 2 * i },
    );
  }
  return out;
}

function markup(state: UiState, liveView: boolean): string {
  return renderToStaticMarkup(
    <Chat
      state={state}
      liveView={liveView}
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
    />,
  );
}

/** The class attribute of every Thinking block, in document order. */
const thinkingBlocks = (html: string): string[] =>
  [...html.matchAll(/class="(thinking(?: thinking--active)?)"/g)].map((m) => m[1]);

describe("the chat draws children thinking at once (card 395)", () => {
  it("draws one Thinking block per child and marks both live while both think", () => {
    const html = markup(reduceAll(initialState, [...fanOut, ...interleaved(30)]), true);
    expect(thinkingBlocks(html)).toEqual(["thinking thinking--active", "thinking thinking--active"]);
  });

  it("keeps the live mark off a child whose answer has started", () => {
    const state = reduceAll(initialState, [
      ...fanOut,
      ...interleaved(3),
      { type: "text_delta", agentId: "explore-1", text: "answer", ts: 99 },
    ]);
    expect(thinkingBlocks(markup(state, true))).toEqual(["thinking", "thinking thinking--active"]);
  });

  it("marks nothing live in an archive", () => {
    const html = markup(reduceAll(initialState, [...fanOut, ...interleaved(3)]), false);
    expect(thinkingBlocks(html)).toEqual(["thinking", "thinking"]);
  });
});
