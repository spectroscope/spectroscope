// Card 506, fix round 1: the chat shows a workflow's summary as the run's
// last answer. The summariser is a child, and a message between a child and
// its parent sits in the child's thread with one line in the main thread
// (card 503). The summariser's message is the exception: its task message
// carries the label `workflow:<step>` (WorkflowRunner.SUMMARISER_LABEL_PREFIX),
// so the reducer marks its message to the parent as the run's answer and the
// main thread draws it in full. A reviewer's message stays one line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll, type Turn } from "../state/reducer";
import { WORKFLOW_SUMMARISER_LABEL_PREFIX } from "../state/peerMessages";
import { Chat } from "./Chat";

const ev = (fields: Record<string, unknown>): RunEvent => fields as unknown as RunEvent;

const SUMMARY = "# Joined Review\n\nThe exit code changed from 2 to 0 in greeter/cli.py:5.\nRequest changes.";

const RUN: RunEvent[] = [
  ev({ type: "run_start", runId: "r1", agentId: "main", prompt: "Run git diff HEAD", ts: 1 }),
  ev({ type: "text_delta", agentId: "main", text: "the diff", ts: 2 }),
  ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 }),
  ev({ type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "Review for correctness", ts: 4 }),
  ev({
    type: "agent_message",
    from: "main",
    to: "explore-1",
    role: "task",
    state: "submitted",
    text: "Review for correctness",
    ts: 4,
  }),
  ev({
    type: "agent_message",
    from: "explore-1",
    to: "main",
    role: "peer",
    state: "received",
    text: "two of five files read\nmore",
    label: "m-status",
    ts: 5,
  }),
  ev({
    type: "agent_message",
    from: "explore-1",
    to: "main",
    role: "result",
    state: "completed",
    text: "[explore-1] result: findings",
    ts: 6,
  }),
  ev({ type: "agent_spawn", agentId: "explore-4", parentId: "main", task: "Join the findings", ts: 7 }),
  ev({
    type: "agent_message",
    from: "main",
    to: "explore-4",
    role: "task",
    state: "submitted",
    text: "Join the findings",
    label: "workflow:review",
    ts: 7,
  }),
  ev({
    type: "agent_message",
    from: "explore-4",
    to: "main",
    role: "result",
    state: "completed",
    text: "[explore-4] result",
    ts: 8,
  }),
  ev({
    type: "agent_message",
    from: "explore-4",
    to: "main",
    role: "peer",
    state: "received",
    text: SUMMARY,
    label: "m-summary",
    ts: 9,
  }),
];

function messages(turns: Turn[]): Extract<Turn, { kind: "message" }>[] {
  return turns.filter((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message");
}

function chat(events: RunEvent[], grouping: "v1" | "v2", live = true): string {
  return renderToStaticMarkup(
    <Chat
      state={reduceAll(initialState, events)}
      liveView={live}
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
      grouping={grouping}
    />,
  );
}

/** Whether the element at `at` sits inside a child's thread section. */
function inThread(out: string, at: number): boolean {
  const before = out.slice(0, at);
  const open = before.split('<section class="chat-thread').length - 1;
  const closed = before.split("</section>").length - 1;
  return open > closed;
}

/** The markup of the block that carries `data-msg-id="<id>"`, from its opening tag. */
function block(out: string, id: string): string {
  const at = out.indexOf(`data-msg-id="${id}"`);
  const from = out.lastIndexOf("<div", at);
  return out.slice(from, out.indexOf("</div></div>", at) + 12);
}

describe("a workflow's summary in the chat", () => {
  it("is folded as the run's answer of the main thread; a reviewer's message to the parent is not", () => {
    const all = messages(reduceAll(initialState, RUN).turns);
    const summary = all.find((m) => m.msgId === "m-summary");
    expect(summary).toMatchObject({ answer: true, from: "explore-4", to: "main" });
    expect(summary?.agentId).toBeUndefined();
    const status = all.find((m) => m.msgId === "m-status");
    expect(status?.answer).toBeUndefined();
    expect(status?.agentId).toBe("explore-1");
  });

  for (const grouping of ["v1", "v2"] as const) {
    it(`is drawn in full in the main thread (${grouping}), outside every child's thread`, () => {
      const out = chat(RUN, grouping);
      const at = out.indexOf('data-msg-id="m-summary"');
      expect(at).toBeGreaterThan(-1);
      expect(out.indexOf('data-msg-id="m-summary"', at + 1)).toBe(-1);
      expect(inThread(out, at)).toBe(false);
      const summary = block(out, "m-summary");
      expect(summary).toContain("msg-block--answer");
      expect(summary).not.toContain("msg-line");
      expect(summary).toContain("The exit code changed from 2 to 0 in greeter/cli.py:5.");
      expect(summary).toContain("Request changes.");
    });

    it(`offers no Reply on it, the summariser has ended (${grouping})`, () => {
      expect(block(chat(RUN, grouping), "m-summary")).not.toContain('data-action="reply"');
    });

    it(`is drawn the same on a stored session (${grouping})`, () => {
      const out = chat(RUN, grouping, false);
      expect(inThread(out, out.indexOf('data-msg-id="m-summary"'))).toBe(false);
      expect(block(out, "m-summary")).toContain("Request changes.");
    });
  }

  it("leaves a reviewer's message as one line in the main thread (v2)", () => {
    const out = chat(RUN, "v2");
    const at = out.indexOf('data-msg-id="m-status"');
    expect(inThread(out, at)).toBe(false);
    expect(block(out, "m-status")).toContain("msg-line");
    expect(block(out, "m-status")).not.toContain("more");
  });

  it("leaves a summariser's message to a sibling in the threads, not as the run's answer", () => {
    // Fix round 2: only a message the parent received is the run's answer.
    const toSibling = ev({
      type: "agent_message",
      from: "explore-4",
      to: "explore-1",
      role: "peer",
      state: "received",
      text: "did you read cli.py?",
      label: "m-sibling",
      ts: 8,
    });
    const all = messages(reduceAll(initialState, [...RUN.slice(0, -1), toSibling]).turns);
    const sibling = all.find((m) => m.msgId === "m-sibling");
    expect(sibling).toBeDefined();
    expect(sibling?.answer).toBeUndefined();
    expect(sibling?.agentId).toBe("explore-4");
  });

  it("never takes the session's own agent for a summariser, whatever label reached it", () => {
    // Fix round 2: a summariser is a child; a root agent that a task message
    // labelled `workflow:` is not one.
    const events: RunEvent[] = [
      ...RUN.slice(0, -1),
      ev({
        type: "agent_message",
        from: "fleet",
        to: "main",
        role: "task",
        state: "submitted",
        text: "Review the release",
        label: "workflow:review",
        ts: 10,
      }),
      ev({
        type: "agent_message",
        from: "main",
        to: "operator",
        role: "peer",
        state: "received",
        text: "a note from the main agent",
        label: "m-root",
        ts: 11,
      }),
    ];
    const state = reduceAll(initialState, events);
    expect(state.agents.find((a) => a.id === "main")?.label).toBe("workflow:review");
    const root = messages(state.turns).find((m) => m.msgId === "m-root");
    expect(root).toBeDefined();
    expect(root?.answer).toBeUndefined();
  });

  it("needs the label the Java runner writes", () => {
    const java = readFileSync(
      fileURLToPath(
        new URL(
          "../../../spectro-core/src/main/java/dev/spectroscope/core/playbook/run/WorkflowRunner.java",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const m = /SUMMARISER_LABEL_PREFIX = "([^"]+)";/.exec(java);
    expect(m?.[1]).toBe(WORKFLOW_SUMMARISER_LABEL_PREFIX);
  });
});
