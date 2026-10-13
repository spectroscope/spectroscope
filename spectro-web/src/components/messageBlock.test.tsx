// Card 503, criteria 7 and 8: the chat's message block. Sender, time and
// status on every block; Deliver and Decline on a held one while it is live;
// Reply on every received one. Server renderer, no DOM.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll, type Turn } from "../state/reducer";
import { groupTurnsV2 } from "../state/threads";
import { clockTime } from "../format";
import { MessageBlock, decisionFrame, replyFrame, type MessageTurn } from "./MessageBlock";
import { Chat } from "./Chat";
import { readFileSync } from "node:fs";

const received: MessageTurn = {
  kind: "message",
  direction: "received",
  from: "Other-01",
  to: "",
  fromSession: "20261011-090500-bbbbbbbb",
  time: 1_800_000_000_000,
  status: "received",
  summary: "which files?",
  text: "which files did you touch?",
  msgId: "m1",
};

function html(turn: MessageTurn, live = true, lang: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <MessageBlock turn={turn} lang={lang} live={live} onDecide={() => {}} onReply={() => {}} />,
  );
}

describe("the message block", () => {
  it("shows the sender, the time, the status and the text of a received message, with Reply", () => {
    const out = html(received);
    expect(out).toContain("From Other-01");
    expect(out).toContain(clockTime(received.time));
    expect(out).toContain("received");
    expect(out).toContain("which files did you touch?");
    expect(out).toContain('data-action="reply"');
    expect(out).not.toContain('data-action="deliver"');
  });

  it("offers Deliver and Decline on a held message while the session is live", () => {
    const out = html({ ...received, status: "held" });
    expect(out).toContain('data-action="deliver"');
    expect(out).toContain('data-action="decline"');
    expect(out).toContain("held for you");
  });

  it("offers no decision on a held message of a stored session or after a decision", () => {
    expect(html({ ...received, status: "held", replay: true })).not.toContain('data-action="deliver"');
    expect(html({ ...received, status: "held" }, false)).not.toContain('data-action="deliver"');
    expect(html({ ...received, status: "delivered" })).not.toContain('data-action="decline"');
  });

  it("names the recipient of a sent message and offers no Reply", () => {
    const out = html({ ...received, direction: "sent", from: "main", to: "Other-01", status: "queued" });
    expect(out).toContain("To Other-01");
    expect(out).toContain("queued");
    expect(out).not.toContain('data-action="reply"');
  });

  it("says a sent message is held there, not held for this operator", () => {
    // Found in the live check of 2026-10-11: the sender's own block read
    // "held for you" while the message waited for the OTHER operator.
    const out = html({ ...received, direction: "sent", from: "main", to: "Other-01", status: "held" });
    expect(out).toContain("held there");
    expect(out).not.toContain("held for you");
    expect(
      html({ ...received, direction: "sent", from: "main", to: "B", status: "held" }, true, "de"),
    ).toContain("wartet dort");
  });

  it("speaks German", () => {
    const out = html({ ...received, status: "held" }, true, "de");
    expect(out).toContain("Von Other-01");
    expect(out).toContain("Zustellen");
    expect(out).toContain("Ablehnen");
    expect(out).toContain("Antworten");
  });

  it("says a message came back unread, in both languages (card 594)", () => {
    const back = {
      ...received,
      direction: "sent" as const,
      from: "main",
      to: "explore-2",
      status: "returned",
    };
    expect(html(back)).toContain("returned unread");
    expect(html(back, true, "de")).toContain("ungelesen zurück");
    expect(html(back)).not.toContain("msg.status.");
  });

  it("sends peer_message_decision for Deliver and Decline", () => {
    expect(decisionFrame("m1", true)).toEqual({ type: "peer_message_decision", msgId: "m1", deliver: true });
    expect(decisionFrame("m1", false)).toEqual({
      type: "peer_message_decision",
      msgId: "m1",
      deliver: false,
    });
  });

  it("sends send_peer_message to the sender of the message a Reply answers, as the operator", () => {
    expect(replyFrame({ name: "Other-01", toSession: "s2" }, " thanks ")).toEqual({
      type: "send_peer_message",
      to: "Other-01",
      toSession: "s2",
      text: "thanks",
    });
    expect(replyFrame({ name: "explore-1" }, "stop")).toEqual({
      type: "send_peer_message",
      to: "explore-1",
      text: "stop",
    });
    expect(replyFrame({ name: "x" }, "   ")).toBeNull();
  });

  it("is what the composer's submit sends while a reply is pinned", () => {
    const chat = readFileSync(new URL("./Chat.tsx", import.meta.url), "utf8");
    const submit = chat.slice(
      chat.indexOf("const submit = (): void => {"),
      chat.indexOf("const lastUserText"),
    );
    expect(submit).toContain("replyFrame(replyTo, draft)");
    expect(submit).toContain("props.sendClient(");
  });
});

describe("messages between the parent and a child", () => {
  const events: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 } as RunEvent,
    { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "look", ts: 2 } as RunEvent,
    { type: "text_delta", agentId: "explore-1", text: "reading", ts: 3 } as RunEvent,
    {
      type: "agent_message",
      from: "explore-1",
      to: "parent",
      role: "peer",
      state: "sent",
      text: "found it",
      label: "m3",
      ts: 4,
    } as RunEvent,
  ];

  it("sit in the child's thread and once in the main thread", () => {
    const state = reduceAll(initialState, events);
    const blocks = groupTurnsV2(state.turns, state.cards, state.agents);
    const chip = blocks.find((b) => b.kind === "chip");
    expect(chip && chip.kind === "chip" ? chip.threads["explore-1"].map((i) => i.turn.kind) : []).toContain(
      "message",
    );
    const mainLine = blocks.filter(
      (b): b is { kind: "turn"; turn: Turn; index: number } => b.kind === "turn" && b.turn.kind === "message",
    );
    expect(mainLine).toHaveLength(1);
  });
});

describe("in light mode", () => {
  afterEach(async () => {
    const viewMode = await import("../state/viewMode");
    viewMode.setViewMode("learn");
  });

  it("the chat renders a received message, and the block is not a lazy chunk", async () => {
    const viewMode = await import("../state/viewMode");
    const store = new Map<string, string>();
    viewMode.__setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
    viewMode.setViewMode("light");
    const state = reduceAll(initialState, [
      {
        type: "peer_message",
        kind: "message",
        direction: "received",
        msgId: "m9",
        from: "Other-01",
        text: "hello from the other session",
        ts: 5,
      } as unknown as RunEvent,
    ]);
    const out = renderToStaticMarkup(
      <Chat
        state={state}
        liveView={true}
        onSend={() => {}}
        onReturnToLive={() => {}}
        sendClient={() => true}
      />,
    );
    expect(viewMode.currentViewMode()).toBe("light");
    expect(out).toContain("hello from the other session");
    expect(out).toContain('data-action="reply"');
    const chunks = readFileSync(new URL("../state/surfaceChunks.ts", import.meta.url), "utf8");
    expect(chunks).not.toContain("MessageBlock");
    expect(readFileSync(new URL("./Chat.tsx", import.meta.url), "utf8")).toMatch(
      /^import \{[^}]*MessageBlock[^}]*\} from "\.\/MessageBlock";$/m,
    );
  });
});
