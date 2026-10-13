// Card 576: the record notes when a frame of a command typed in the composer
// left since the owner's last prompt, and an error folded meanwhile answers
// that command. The mark lives in the record's state, so a view switch and a
// wake keep it; Chat offers "Send again" under no error that carries it.
//
// Fix round (integrator decision 2): the frame says it was typed, not its
// type. The composer tags the frames of its commands (asTypedCommand); the
// same frame from the header's playbook chip or the loop chip's Stop is not
// tagged and marks nothing.

import { describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import type { ConnectOptions, Connection } from "../transport/ws";
import * as commands from "./chatCommands";
import { stopLoopFrame } from "./goalLoop";
import { initialState, noteSent, reduce, type UiState } from "./reducer";
import { SessionSet } from "./sessionSet";
import { asTypedCommand, isTypedCommand } from "./typedCommand";
import type { ViewMode } from "./viewMode";

const error = (message: string): RunEvent => ({ type: "error", message, ts: 1 }) as RunEvent;
const last = (state: UiState) => state.turns[state.turns.length - 1];

const FRAMES: ClientMessage[] = [
  commands.commandFrame("compact"),
  commands.commandFrame("clear"),
  commands.loopFrame({ intervalSeconds: 300, prompt: "check the build" }),
  commands.loopStopFrame(),
  commands.confirmPlaybookFrame(""),
  commands.startWorkflowFrame("fan", "look", "en"),
  commands.setPlaybookFrame("/pb/x"),
];

describe("a frame of a command typed in the composer", () => {
  for (const frame of FRAMES) {
    it(`${JSON.stringify(frame)}: tagged, an error after it answers the command`, () => {
      const typed = asTypedCommand({ ...frame });
      expect(isTypedCommand(typed)).toBe(true);
      const sent = noteSent(initialState, typed);
      expect(sent.afterCommand).toBe(true);
      expect(last(reduce(sent, error("refused")))).toEqual({
        kind: "error",
        text: "refused",
        afterCommand: true,
      });
    });

    it(`${JSON.stringify(frame)}: not tagged, it marks nothing`, () => {
      const plain = { ...frame };
      expect(isTypedCommand(plain)).toBe(false);
      expect(noteSent(initialState, plain)).toBe(initialState);
    });
  }

  it("the tag is the object's, not its shape: an equal copy is not tagged", () => {
    const typed = asTypedCommand(commands.setPlaybookFrame("/pb/x"));
    expect(isTypedCommand({ ...typed })).toBe(false);
    expect(asTypedCommand(typed), "returned as given").toBe(typed);
  });
});

describe("what ends the mark", () => {
  const marked = noteSent(initialState, asTypedCommand(commands.confirmPlaybookFrame("")));

  it("a user_message: its error is a failed prompt again", () => {
    const prompted = noteSent(marked, { type: "user_message", text: "go" });
    expect(prompted.afterCommand).toBeUndefined();
    expect(last(reduce(prompted, error("the provider is down")))).toEqual({
      kind: "error",
      text: "the provider is down",
    });
  });

  it("a steering_message", () => {
    expect(noteSent(marked, { type: "steering_message", text: "shorter" }).afterCommand).toBeUndefined();
  });

  it("no other frame, a header pick and the loop chip's Stop included", () => {
    const others: ClientMessage[] = [
      commands.setPlaybookFrame("/pb/y"),
      commands.noPlaybookFrame(),
      stopLoopFrame(),
      { type: "permission_response", callId: "c1", allowed: true },
      { type: "wake_session", sessionId: "s1" },
      { type: "set_permission_mode", mode: "auto" },
    ];
    for (const frame of others) {
      expect(noteSent(marked, frame), frame.type).toBe(marked);
      expect(noteSent(initialState, frame), frame.type).toBe(initialState);
    }
  });
});

describe("an error before the command", () => {
  it("keeps no mark: it answered the prompt before", () => {
    const failed = reduce(noteSent(initialState, { type: "user_message", text: "go" }), error("down"));
    const after = noteSent(failed, asTypedCommand(commands.commandFrame("compact")));
    expect(after.turns[0]).toEqual({ kind: "error", text: "down" });
  });

  it("a second typed command leaves the state as it is", () => {
    const marked = noteSent(initialState, asTypedCommand(commands.commandFrame("clear")));
    expect(noteSent(marked, asTypedCommand(commands.commandFrame("compact")))).toBe(marked);
  });
});

// The one place a frame leaves for a record (SessionSet.sendClient) notes it,
// in every mode: light keeps no trace rows, and its chat needs the mark too.
// SessionSet.command is the composer's /compact and /clear (card 471), so its
// frame is a typed one.
describe("the record a frame leaves from", () => {
  function setIn(mode: ViewMode) {
    let open = false;
    let options: ConnectOptions | null = null;
    const connect = (o: ConnectOptions): Connection => {
      options = o;
      return { send: () => open, reconnectNow: () => {}, close: () => {} };
    };
    const set = new SessionSet({ connect, mode: () => mode, traceWanted: () => true, onBatch: () => {} });
    set.start();
    set.activate();
    const status = (next: boolean) => {
      open = next;
      options?.onStatus?.(next ? "open" : "closed");
    };
    return { set, status };
  }

  for (const mode of ["learn", "light"] as ViewMode[]) {
    it(`notes a typed command when it hit the wire, in ${mode}`, () => {
      const { set, status } = setIn(mode);
      const key = set.viewKey();
      status(false);
      expect(set.sendClient(key, asTypedCommand(commands.confirmPlaybookFrame(""))), "premise: down").toBe(
        false,
      );
      expect(set.view().state.afterCommand, "a frame that did not leave notes nothing").toBeUndefined();
      status(true);
      expect(set.sendClient(key, commands.setPlaybookFrame("/pb/x"))).toBe(true);
      expect(set.view().state.afterCommand, "a header pick is no typed command").toBeUndefined();
      expect(set.sendClient(key, asTypedCommand(commands.confirmPlaybookFrame("")))).toBe(true);
      expect(set.view().state.afterCommand).toBe(true);
      expect(set.sendClient(key, { type: "user_message", text: "go" })).toBe(true);
      expect(set.view().state.afterCommand).toBeUndefined();
    });
  }

  // Second review finding 1: a stored session without a wake is continued
  // through open() with the typed frame among its first frames.
  it("notes a typed command a resume hands to a new record as its first frame", () => {
    const { set, status } = setIn("learn");
    status(true);
    const typed = asTypedCommand(commands.confirmPlaybookFrame(""));
    const key = set.open({ resumeId: "20261013-040000-open", firstFrames: [typed] });
    expect(
      set.get(key)?.state.afterCommand,
      "premise: nothing left before the socket opened",
    ).toBeUndefined();
    status(true);
    expect(set.get(key)?.state.afterCommand).toBe(true);
  });

  it("the composer's /compact and /clear mark it", () => {
    const { set, status } = setIn("learn");
    status(true);
    expect(set.command(set.viewKey(), "compact")).toBe(true);
    expect(set.view().state.afterCommand).toBe(true);
  });
});
