// Card 527 criteria 3 and 5: Enter or Send while recording stops the capture,
// waits for the last words within a bound, and takes them; a transcript that
// arrives after the send never reaches the draft. Driven through a fake socket:
// the frames a server sends are pushed into the same handler the hook uses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_FINISH_MS,
  LOCAL_RUN_FALLBACK_MS,
  TakeGate,
  finishBoundMs,
  liveTakeHandler,
  startFinish,
} from "./voiceTake";
import type { LiveText } from "./liveSession";

/** A live socket and capture, as far as the composer can see them. */
class FakeSocket {
  commits = 0;
  closes = 0;
  micReleased = 0;
  transcripts: string[] = [];
  states: LiveText[] = [];
  readonly gate = new TakeGate();
  readonly handler = liveTakeHandler({
    gate: this.gate,
    onTranscript: (text) => this.transcripts.push(text),
    onState: (state) => this.states.push(state),
    noteWire: () => {},
    releaseMicrophone: () => {
      this.micReleased++;
    },
    close: () => {
      this.closes++;
    },
  });
  readonly capture = {
    commit: () => {
      this.commits++;
    },
    close: () => {
      this.closes++;
    },
  };

  /** The server says something. */
  says(frame: unknown): void {
    this.handler.onFrame(frame);
  }

  heard(): string {
    const last = this.states[this.states.length - 1];
    return last === undefined ? "" : [last.settled, last.provisional].filter((s) => s !== "").join(" ");
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the bound on waiting for the last words", () => {
  it("is one chunk step plus the last measured run on the local route", () => {
    expect(finishBoundMs("local", 2000, 812)).toBe(2812);
  });

  it("falls back to the measured slowest run before any run reported", () => {
    expect(finishBoundMs("local", 2000, null)).toBe(2000 + LOCAL_RUN_FALLBACK_MS);
  });

  it("is a fixed ceiling on the hosted route", () => {
    expect(finishBoundMs("hosted", 2000, 812)).toBe(HOSTED_FINISH_MS);
  });
});

describe("Enter while recording on the live route", () => {
  it("stops the capture, waits for the final and takes it", async () => {
    const socket = new FakeSocket();
    socket.says({ type: "ready" });
    socket.says({ type: "partial", text: "please open the", replace: true, durationMs: 700 });

    const sent = startFinish({
      gate: socket.gate,
      capture: socket.capture,
      heard: () => socket.heard(),
      boundMs: 2700,
    });
    expect(socket.commits, "the capture stopped and asked for the last window").toBe(1);
    socket.says({ type: "final", text: "Please open the settings." });

    await expect(sent).resolves.toBe("Please open the settings.");
    expect(socket.transcripts, "the final went to the send, not to the draft").toEqual([]);
    expect(socket.micReleased).toBe(1);
  });

  it("takes the heard text as it stands when the final does not come within the bound", async () => {
    const socket = new FakeSocket();
    socket.says({ type: "partial", text: "please open the", replace: true });

    const sent = startFinish({
      gate: socket.gate,
      capture: socket.capture,
      heard: () => socket.heard(),
      boundMs: 2700,
    });
    vi.advanceTimersByTime(2700);

    await expect(sent).resolves.toBe("please open the");
    expect(socket.closes, "a session nobody waits for any more is closed").toBe(1);
  });

  it("a transcript after the send never lands in the composer", async () => {
    const socket = new FakeSocket();
    socket.says({ type: "partial", text: "please open the", replace: true });
    const sent = startFinish({
      gate: socket.gate,
      capture: socket.capture,
      heard: () => socket.heard(),
      boundMs: 2700,
    });
    vi.advanceTimersByTime(2700);
    await sent;

    socket.says({ type: "final", text: "Please open the settings." });

    expect(socket.transcripts).toEqual([]);
  });

  it("joins the closed windows and the last one", async () => {
    const socket = new FakeSocket();
    socket.says({ type: "final", text: "Good morning.", more: true });
    socket.says({ type: "partial", text: "please open", replace: true });
    const sent = startFinish({
      gate: socket.gate,
      capture: socket.capture,
      heard: () => socket.heard(),
      boundMs: 2700,
    });
    socket.says({ type: "final", text: "Please open the settings." });

    await expect(sent).resolves.toBe("Good morning. Please open the settings.");
  });

  it("a failed session hands over what was heard", async () => {
    const socket = new FakeSocket();
    socket.says({ type: "partial", text: "half a sentence", replace: true });
    const sent = startFinish({
      gate: socket.gate,
      capture: socket.capture,
      heard: () => socket.heard(),
      boundMs: 2700,
    });
    socket.says({ type: "error", reason: "upstream" });

    await expect(sent).resolves.toBe("half a sentence");
    expect(socket.transcripts).toEqual([]);
  });
});

describe("the microphone button without a send", () => {
  it("puts the final into the draft as before", () => {
    const socket = new FakeSocket();
    socket.says({ type: "partial", text: "hello", replace: true });
    socket.says({ type: "final", text: "Hello." });

    expect(socket.transcripts).toEqual(["Hello."]);
    expect(socket.micReleased).toBe(1);
  });

  it("closes the socket once the record has announced itself", () => {
    const socket = new FakeSocket();
    socket.says({ type: "final", text: "Hello." });
    socket.says({ type: "wire", xid: "x1" });

    expect(socket.closes).toBe(1);
  });
});

describe("Enter while recording on the batch route (criterion 5)", () => {
  it("waits for the batch answer without a bound and takes it", async () => {
    const gate = new TakeGate();
    const sent = gate.finish(() => "", null);
    vi.advanceTimersByTime(60_000);
    expect(gate.offer("Hello from the batch route.")).toBe(true);

    await expect(sent).resolves.toBe("Hello from the batch route.");
  });

  it("an answer that comes with nobody waiting goes to the draft", () => {
    expect(new TakeGate().offer("Hello.")).toBe(false);
  });

  it("a failed batch request still lets the message go with what was typed", async () => {
    const gate = new TakeGate();
    const sent = gate.finish(() => "", null);
    gate.fail();

    await expect(sent).resolves.toBe("");
    expect(gate.offer("late"), "and a late answer is swallowed").toBe(true);
  });
});
