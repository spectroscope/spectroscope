// Card 503, criteria 7 and 9 in the reducer: a sixth Turn kind, `message`,
// folded from the socket-only peer_message frame and from the agent_message
// records with role peer, one block per msgId, live and replayed through the
// same case.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, type Turn, type UiState } from "./reducer";
import { mergePeerFrames, parseReturnedLine } from "./peerMessages";
import { chatBody } from "../export/html";
import { read } from "../testkit/source";
import { t } from "../i18n/i18n";

const frame = (fields: Record<string, unknown>): RunEvent =>
  ({ type: "peer_message", ...fields }) as unknown as RunEvent;

function fold(events: RunEvent[], from: UiState = initialState): UiState {
  return events.reduce(reduce, from);
}

function messages(state: UiState): Extract<Turn, { kind: "message" }>[] {
  return state.turns.filter((t): t is Extract<Turn, { kind: "message" }> => t.kind === "message");
}

const RUN: RunEvent = { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 } as RunEvent;

describe("the message turn", () => {
  it("draws a received peer message as one block with sender, time, status and text", () => {
    const state = fold([
      frame({
        kind: "message",
        direction: "received",
        msgId: "m1",
        name: "Other-01",
        from: "Other-01",
        fromSession: "s2",
        summary: "which files?",
        text: "which files did you touch?",
        ts: 1_800_000_000_000,
      }),
    ]);
    const [turn] = messages(state);
    expect(turn).toEqual({
      kind: "message",
      direction: "received",
      from: "Other-01",
      to: "",
      fromSession: "s2",
      time: 1_800_000_000_000,
      status: "received",
      summary: "which files?",
      text: "which files did you touch?",
      msgId: "m1",
    });
  });

  it("keeps one block per msgId as a held message is held and then delivered", () => {
    const state = fold([
      frame({
        kind: "held",
        direction: "received",
        msgId: "m1",
        name: "Other-01",
        from: "Other-01",
        text: "push",
        status: "held",
        ts: 5,
      }),
      frame({
        kind: "message",
        direction: "received",
        msgId: "m1",
        name: "Other-01",
        from: "Other-01",
        text: "push",
        ts: 4,
      }),
      {
        type: "agent_message",
        from: "Other-01",
        to: "main",
        role: "peer",
        state: "received",
        text: "push",
        label: "m1",
        ts: 9,
      } as RunEvent,
    ]);
    const all = messages(state);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("delivered");
  });

  it("folds a sent record and its delivery notice into one block", () => {
    const state = fold([
      RUN,
      {
        type: "agent_message",
        from: "main",
        to: "Other-01",
        role: "peer",
        state: "sent",
        text: "hi",
        label: "m2",
        ts: 2,
      } as RunEvent,
      frame({
        kind: "message",
        direction: "sent",
        msgId: "m2",
        name: "Other-01",
        text: "hi",
        summary: "hi",
        ts: 2,
      }),
      frame({
        kind: "status",
        direction: "sent",
        msgId: "m2",
        name: "Other-01",
        status: "held",
        reason: "other class",
        ts: 3,
      }),
    ]);
    const all = messages(state);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      direction: "sent",
      from: "main",
      to: "Other-01",
      status: "held",
      text: "hi",
    });
  });

  it("puts a message between the parent and a child in that child's thread", () => {
    const state = fold([
      RUN,
      { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "look", ts: 2 } as RunEvent,
      {
        type: "agent_message",
        from: "explore-1",
        to: "parent",
        role: "peer",
        state: "sent",
        text: "found it",
        label: "m3",
        ts: 3,
      } as RunEvent,
      {
        type: "agent_message",
        from: "explore-1",
        to: "main",
        role: "peer",
        state: "received",
        text: "found it",
        label: "m3",
        ts: 4,
      } as RunEvent,
    ]);
    const all = messages(state);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ agentId: "explore-1", status: "delivered", from: "explore-1" });
  });

  it("does not move a delivered message back to an earlier state", () => {
    const state = fold([
      frame({ kind: "status", direction: "sent", msgId: "m4", name: "B", status: "delivered", ts: 2 }),
      frame({ kind: "message", direction: "sent", msgId: "m4", name: "B", text: "x", ts: 1 }),
    ]);
    expect(messages(state)[0].status).toBe("delivered");
  });

  it("turns an operator send that failed into a warning line", () => {
    const state = fold([
      frame({
        kind: "send_failed",
        direction: "sent",
        name: "nobody",
        reason: "Not sent: no agent named 'nobody'",
        ts: 1,
      }),
    ]);
    expect(messages(state)).toHaveLength(0);
    const line = state.turns[0];
    expect(line).toMatchObject({ kind: "info", tone: "warn", infoKey: "msg.sendFailed" });
  });

  it("adds the block on the frame that brings it, with no timer", () => {
    const before = initialState;
    const after = reduce(
      before,
      frame({ kind: "message", direction: "received", msgId: "m5", from: "A", text: "t", ts: 1 }),
    );
    expect(messages(after)).toHaveLength(1);
    expect(messages(before)).toHaveLength(0);
  });
});

describe("a message that came back unread (card 594)", () => {
  // The line the sender's model reads, as PeerNotices.returned writes it in
  // Java; PeerNoticesTest pins the same file from that side.
  const LINE = read("../testkit/returnedLine.txt", import.meta.url).trim();
  const REASON = "ended by cancellation of the parent run while it waited for a free slot";
  const SPAWN = {
    type: "agent_spawn",
    agentId: "explore-2",
    parentId: "main",
    task: "look",
    ts: 2,
  } as RunEvent;
  const SENT = {
    type: "agent_message",
    from: "main",
    to: "explore-2",
    role: "peer",
    state: "sent",
    text: "status?",
    label: "m9",
    ts: 3,
  } as RunEvent;
  const RETURNED = {
    type: "agent_message",
    from: "explore-2",
    to: "main",
    role: "peer",
    state: "returned",
    text: LINE,
    label: "m9",
    ts: 4,
  } as RunEvent;

  it("reads the helper, the reason and the start out of the line the Java side writes", () => {
    expect(parseReturnedLine(LINE)).toEqual({ reason: REASON, start: "status?" });
    const cut = LINE.replace("\u00abstatus?\u00bb", "\u00ablong\u2026\u00bb").replace(
      REASON,
      "out of budget (derived)",
    );
    expect(parseReturnedLine(cut)).toEqual({ reason: "out of budget (derived)", start: "long\u2026" });
    expect(parseReturnedLine("something else")).toBeNull();
  });

  it("marks the message's block returned and draws the line in the chat's language", () => {
    const state = fold([RUN, SPAWN, SENT, RETURNED]);
    const all = messages(state);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      msgId: "m9",
      direction: "sent",
      status: "returned",
      text: "status?",
      agentId: "explore-2",
    });
    expect(state.turns.filter((t) => t.kind === "info" && t.text === LINE)).toEqual([
      {
        kind: "info",
        text: LINE,
        tone: "warn",
        infoKey: "msg.returned",
        infoVars: { helper: "explore-2", reason: REASON, start: "status?" },
      },
    ]);
    const vars = { helper: "explore-2", reason: REASON, start: "status?" };
    expect(t("en", "msg.returned", vars)).toContain("explore-2");
    expect(t("de", "msg.returned", vars)).toContain("Nicht an explore-2 zugestellt");
    expect(t("de", "msg.returned", vars)).toContain("\u00abstatus?\u00bb");
  });

  it("marks a block that appears only after the line, and makes no empty block before it", () => {
    // A stop between a delivery and its sent record, or an operator's reply whose frame comes late.
    const early = fold([RUN, SPAWN, RETURNED]);
    expect(messages(early)).toHaveLength(0);
    expect(early.turns.filter((t) => t.kind === "info" && t.infoKey === "msg.returned")).toHaveLength(1);
    const late = fold([SENT], early);
    expect(messages(late)).toHaveLength(1);
    expect(messages(late)[0]).toMatchObject({ msgId: "m9", status: "returned", text: "status?" });
    const fromFrame = fold(
      [frame({ kind: "message", direction: "sent", msgId: "m9", name: "explore-2", text: "status?", ts: 5 })],
      early,
    );
    expect(messages(fromFrame)[0]).toMatchObject({ msgId: "m9", status: "returned" });
    const thenDelivered = fold(
      [
        frame({
          kind: "status",
          direction: "sent",
          msgId: "m9",
          name: "explore-2",
          status: "delivered",
          ts: 6,
        }),
      ],
      late,
    );
    expect(messages(thenDelivered)[0].status).toBe("returned");
  });

  it("draws a line it cannot read as written", () => {
    const state = fold([RUN, SPAWN, { ...RETURNED, text: "an older wording" } as RunEvent]);
    expect(state.turns.filter((t) => t.kind === "info" && t.text === "an older wording")).toEqual([
      { kind: "info", text: "an older wording", tone: "warn" },
    ]);
  });

  it("is in the export in the export's language", () => {
    expect(chatBody([RUN, SPAWN, SENT, RETURNED]).body).toContain("explore-2");
    const de = chatBody([RUN, SPAWN, SENT, RETURNED], { lang: "de" }).body;
    expect(de).toContain("Nicht an explore-2 zugestellt");
    expect(de).toContain(REASON);
  });
});

describe("replay", () => {
  it("rebuilds as many blocks from a stored session as its sidecar holds messages", () => {
    // A recorded session: the file's events, and the sidecar's frames as
    // GET /api/sessions/{id}/messages serves them.
    const events: RunEvent[] = [
      RUN,
      { type: "text_delta", agentId: "main", text: "working", ts: 10 } as RunEvent,
      {
        type: "agent_message",
        from: "Other-01",
        to: "main",
        role: "peer",
        state: "received",
        text: "which files?",
        label: "m1",
        ts: 30,
      } as RunEvent,
      {
        type: "agent_message",
        from: "main",
        to: "Other-01",
        role: "peer",
        state: "sent",
        text: "Parser.java",
        label: "m2",
        ts: 40,
      } as RunEvent,
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 50 } as RunEvent,
    ];
    const sidecar = [
      {
        type: "peer_message",
        kind: "message",
        direction: "received",
        msgId: "m1",
        name: "Other-01",
        from: "Other-01",
        fromSession: "s2",
        text: "which files?",
        ts: 20,
        replay: true,
      },
      {
        type: "peer_message",
        kind: "status",
        direction: "received",
        msgId: "m1",
        status: "delivered",
        ts: 31,
        replay: true,
      },
      {
        type: "peer_message",
        kind: "message",
        direction: "sent",
        msgId: "m2",
        name: "Other-01",
        text: "Parser.java",
        ts: 40,
        replay: true,
      },
      {
        type: "peer_message",
        kind: "status",
        direction: "sent",
        msgId: "m2",
        status: "delivered",
        ts: 45,
        replay: true,
      },
      {
        type: "peer_message",
        kind: "message",
        direction: "received",
        msgId: "m6",
        name: "Third",
        from: "Third",
        text: "held one",
        ts: 60,
        replay: true,
      },
      {
        type: "peer_message",
        kind: "status",
        direction: "received",
        msgId: "m6",
        status: "held",
        ts: 61,
        replay: true,
      },
    ];
    const merged = mergePeerFrames(events, sidecar);
    expect(merged.map((e) => (e as { ts: number }).ts)).toEqual(
      [...merged.map((e) => (e as { ts: number }).ts)].sort((a, b) => a - b),
    );
    const state = fold(merged);
    const ids = new Set(sidecar.filter((l) => l.kind === "message").map((l) => l.msgId));
    expect(messages(state)).toHaveLength(ids.size);
    expect(messages(state).map((m) => m.status)).toEqual(["delivered", "delivered", "held"]);
    // a replayed held message offers nothing: the decision was taken or expired then
    expect(messages(state)[2].replay).toBe(true);
  });

  it("leaves the events alone when there is no sidecar", () => {
    const events: RunEvent[] = [RUN];
    expect(mergePeerFrames(events, [])).toBe(events);
  });
});
