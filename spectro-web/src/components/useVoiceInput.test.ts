// Card 527, fix round: the real voice hook, followed across a recording.
//
// voiceTake.test.ts pins TakeGate and startFinish on their own; this file pins
// that useVoiceInput uses them: finish() commits the capture, the send waits
// one chunk step plus the last run and no longer, every take gets a fresh
// gate, and a ready that never comes ends as the warm up error with the
// microphone idle.
//
// Fix round 2 adds the two other ways the hook takes a send. The batch route
// (live off, criterion 5): finish() stops the MediaRecorder, keeps the
// finishing phase through onstop, waits for the /api/transcribe answer with no
// bound and hands it to the send, never to the draft. The hosted live route
// (criterion 3, "the same path"): the microphone waits for ready there too,
// partials append, and the send waits the hosted ceiling of 3000 ms.
//
// The hook runs in testkit/hookHost.ts (React's hooks swapped for a host that
// renders again on every state change, so the awaits of the hook land). The
// socket, the microphone and Web Audio are fakes on the globals the hook and
// liveCapture.ts read; the timers are vitest's.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookHost } from "../testkit/hookHost";
import { useVoiceInput, type VoiceInput, type VoiceRoute } from "./useVoiceInput";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

/** A WebSocket the test opens and speaks through. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  /** The server accepted the connection. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** The server sent a frame. */
  frame(f: object): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

/** Web Audio as far as liveCapture.ts uses it. No analyser: the meter stays flat. */
class FakeAudioContext {
  audioWorklet = { addModule: async (): Promise<void> => {} };
  constructor(readonly options?: { sampleRate?: number }) {}
  createMediaStreamSource(): { connect(): void } {
    return { connect: () => {} };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeWorkletNode {
  port: { onmessage: unknown } = { onmessage: null };
  disconnect(): void {}
}

/** A MediaRecorder as far as the batch path uses it. stop() fires onstop on a
 *  later task, as a browser does. */
class FakeRecorder {
  static all: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  stops = 0;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: MediaStream) {
    FakeRecorder.all.push(this);
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.stops++;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])]) });
    queueMicrotask(() => this.onstop?.());
  }
}

/** Decoding as far as wavClip.ts's browserAudio uses it: one channel already at
 *  16 kHz, so no resampling pass. */
class FakeOfflineAudioContext {
  async decodeAudioData(): Promise<object> {
    return {
      numberOfChannels: 1,
      sampleRate: 16000,
      duration: 0.01,
      getChannelData: () => new Float32Array(160),
    };
  }
}

/** One /api/transcribe call the test answers when it wants to. */
interface PendingFetch {
  url: string;
  answer(body: object): void;
  failWith(error: Error): void;
}

let getUserMedia: ReturnType<typeof vi.fn>;
let heard: string[] = [];
let fetches: PendingFetch[] = [];

/** Lets the hook's awaits run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function host(where: VoiceRoute): HookHost<VoiceInput> {
  return new HookHost(() => useVoiceInput((text) => void heard.push(text), true, where));
}

/** Live off: the batch path of a local user (criterion 5). */
function batchHost(): HookHost<VoiceInput> {
  return new HookHost(() =>
    useVoiceInput((text) => void heard.push(text), false, { route: "local", chunkMs: 2000 }),
  );
}

const LOCAL: VoiceRoute = { route: "local", chunkMs: 2000, warmupTimeoutMs: 5000 };

/** Press the microphone, open the socket and say ready; returns the socket. */
async function arm(h: HookHost<VoiceInput>): Promise<FakeSocket> {
  const press = h.value.toggleMic();
  await flush();
  const socket = FakeSocket.all[FakeSocket.all.length - 1];
  socket.open();
  await flush();
  socket.frame({ type: "ready", warmupMs: 400 });
  await flush();
  await press;
  expect(h.value.micPhase, "the take is recording after ready").toBe("recording");
  return socket;
}

const commits = (socket: FakeSocket): number =>
  socket.sent.filter((f) => (f as { type?: string }).type === "commit").length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  FakeSocket.all = [];
  heard = [];
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => {} }] }));
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } });
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:1" },
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    matchMedia: () => ({ matches: true }),
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  FakeRecorder.all = [];
  fetches = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise((resolve, reject) => {
          fetches.push({
            url,
            answer: (body) => resolve({ ok: true, status: 200, json: async () => body }),
            failWith: (error) => reject(error),
          });
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useVoiceInput on the local live route (card 527)", () => {
  it("finish() commits the capture and resolves with the last final, never touching the draft", async () => {
    const h = host(LOCAL);
    const socket = await arm(h);
    socket.frame({ type: "partial", text: "hello there", replace: true, durationMs: 700 });

    const sending = h.value.finish();
    await flush();

    expect(commits(socket), "the send stops the capture with a commit").toBe(1);
    expect(h.value.micPhase).toBe("finishing");
    socket.frame({ type: "final", text: "hello there friend", durationMs: 650 });
    await expect(sending).resolves.toBe("hello there friend");
    expect(heard, "the claimed final does not land in the draft").toEqual([]);
    expect(h.value.micPhase).toBe("idle");
  });

  it("waits one chunk step plus the last run's wall time, then takes what was heard", async () => {
    const h = host(LOCAL);
    const socket = await arm(h);
    socket.frame({ type: "partial", text: "hello there", replace: true, durationMs: 700 });

    let sent: string | null = null;
    void h.value.finish().then((text) => {
      sent = text;
    });
    await vi.advanceTimersByTimeAsync(2699);
    expect(sent, "still waiting inside 2000 + 700 ms").toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toBe("hello there");
    expect(socket.readyState, "the bound passed, so the capture is closed").toBe(FakeSocket.CLOSED);
  });

  it("gives every take a fresh gate, so a spent one never swallows the next transcript", async () => {
    const h = host(LOCAL);
    const first = await arm(h);
    first.frame({ type: "partial", text: "first take", replace: true, durationMs: 600 });
    const sending = h.value.finish();
    await flush();
    first.frame({ type: "final", text: "first take", durationMs: 600 });
    await expect(sending).resolves.toBe("first take");
    first.frame({ type: "wire" });
    await flush();

    const second = await arm(h);
    second.frame({ type: "partial", text: "second take", replace: true, durationMs: 600 });
    await h.value.toggleMic(); // the second press of the microphone: stop, no send
    await flush();
    expect(commits(second)).toBe(1);
    second.frame({ type: "final", text: "second take", durationMs: 600 });
    await flush();

    expect(heard, "with nobody sending, the final goes to the draft").toEqual(["second take"]);
  });

  it("ends a ready that never comes as the warm up error, with the microphone idle", async () => {
    const h = host(LOCAL);
    const press = h.value.toggleMic();
    await flush();
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await flush();
    expect(h.value.micPhase).toBe("warming");

    await vi.advanceTimersByTimeAsync(5000);
    await press;

    expect(h.value.micError).toBe("warmupTimeout");
    expect(h.value.micPhase).toBe("idle");
    expect(getUserMedia, "the microphone was never opened").not.toHaveBeenCalled();
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
  });

  it("an audio graph that fails after ready stops the microphone, closes the socket and says the request failed", async () => {
    // Fix round 3: the microphone is open by the time the worklet loads. A
    // failed load used to leave the tracks running and the socket open.
    let stopped = 0;
    getUserMedia.mockImplementation(async () => ({ getTracks: () => [{ stop: () => stopped++ }] }));
    vi.stubGlobal(
      "AudioContext",
      class extends FakeAudioContext {
        audioWorklet = {
          addModule: async (): Promise<void> => {
            throw new Error("addModule failed");
          },
        };
      },
    );
    const h = host(LOCAL);
    const press = h.value.toggleMic();
    await flush();
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await flush();
    socket.frame({ type: "ready", warmupMs: 400 });
    await flush();
    await press;

    expect(getUserMedia, "premise: the microphone was opened").toHaveBeenCalledTimes(1);
    expect(stopped, "the microphone is stopped").toBe(1);
    expect(socket.readyState, "the socket is closed").toBe(FakeSocket.CLOSED);
    expect(h.value.micError).toBe("requestFailed");
    expect(h.value.micPhase).toBe("idle");
  });
});

describe("the loading card follows the server's loading frame (card 528 criterion 2)", () => {
  it("a press whose warm up loads the model says so until ready, then not", async () => {
    const h = host(LOCAL);
    const press = h.value.toggleMic();
    await flush();
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await flush();
    expect(h.value.micPhase).toBe("warming");
    expect(h.value.modelLoading, "nothing said yet, so no loading card").toBe(false);

    socket.frame({ type: "loading", engine: "whisper-server" });
    await flush();
    expect(h.value.modelLoading, "the server is loading the model").toBe(true);

    socket.frame({ type: "ready", warmupMs: 2100 });
    await flush();
    await press;
    expect(h.value.micPhase).toBe("recording");
    expect(h.value.modelLoading, "ready ends the loading card").toBe(false);
  });

  it("a press against a resident model never says loading", async () => {
    const h = host(LOCAL);
    const press = h.value.toggleMic();
    await flush();
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await flush();
    const seen: boolean[] = [h.value.modelLoading];
    socket.frame({ type: "ready", warmupMs: 120 });
    await flush();
    seen.push(h.value.modelLoading);
    await press;
    seen.push(h.value.modelLoading);

    expect(seen).toEqual([false, false, false]);
  });

  it("a press that times out while loading drops the loading card", async () => {
    const h = host(LOCAL);
    const press = h.value.toggleMic();
    await flush();
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await flush();
    socket.frame({ type: "loading", engine: "whisper-cli" });
    await flush();
    expect(h.value.modelLoading).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await press;

    expect(h.value.micPhase).toBe("idle");
    expect(h.value.modelLoading).toBe(false);
  });
});

describe("useVoiceInput on the batch route, live off (card 527 criterion 5)", () => {
  /** Press the microphone with live off; returns the recorder. */
  async function record(h: HookHost<VoiceInput>): Promise<FakeRecorder> {
    await h.value.toggleMic();
    await flush();
    expect(h.value.micPhase, "the batch take is recording").toBe("recording");
    expect(FakeSocket.all, "live off opens no socket").toEqual([]);
    return FakeRecorder.all[FakeRecorder.all.length - 1];
  }

  it("Enter while recording stops the recorder, keeps finishing through onstop, and sends the answer", async () => {
    const h = batchHost();
    const recorder = await record(h);

    let sent: string | null = null;
    void h.value.finish().then((text) => {
      sent = text;
    });
    await flush();

    expect(recorder.stops, "the send stops the recorder").toBe(1);
    expect(
      fetches.map((f) => f.url),
      "onstop posted the clip",
    ).toEqual(["/api/transcribe"]);
    expect(h.value.micPhase, "onstop keeps the finishing phase a waiting send set").toBe("finishing");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent, "no bound on the batch route: still waiting after 60 s").toBeNull();
    expect(h.value.micPhase).toBe("finishing");

    fetches[0].answer({ text: "the whole batch answer" });
    await flush();
    expect(sent).toBe("the whole batch answer");
    expect(heard, "the claimed answer never reaches the draft").toEqual([]);
    expect(h.value.micPhase).toBe("idle");
  });

  it("a failed request resolves the send with an empty string and leaves the mic idle", async () => {
    const h = batchHost();
    await record(h);

    const sending = h.value.finish();
    await flush();
    fetches[0].failWith(new Error("offline"));
    await expect(sending).resolves.toBe("");
    await flush();
    expect(heard).toEqual([]);
    expect(h.value.micError).toBe("requestFailed");
    expect(h.value.micPhase).toBe("idle");
  });

  it("with nobody sending, the second press transcribes and the answer goes to the draft", async () => {
    const h = batchHost();
    const recorder = await record(h);

    await h.value.toggleMic();
    await flush();
    expect(recorder.stops).toBe(1);
    expect(h.value.micPhase).toBe("transcribing");
    fetches[0].answer({ text: "for the draft" });
    await flush();
    expect(heard).toEqual(["for the draft"]);
    expect(h.value.micPhase).toBe("idle");
  });
});

describe("useVoiceInput on the hosted live route (card 527 criterion 3, the same path)", () => {
  const HOSTED: VoiceRoute = { route: "hosted", warmupTimeoutMs: 5000 };

  it("opens the microphone only after ready, appends partials, and waits 3000 ms for the last words", async () => {
    const h = host(HOSTED);
    const press = h.value.toggleMic();
    await flush();
    const socket = FakeSocket.all[FakeSocket.all.length - 1];
    socket.open();
    await flush();
    expect(h.value.micPhase).toBe("warming");
    expect(getUserMedia, "no microphone before the hosted ready").not.toHaveBeenCalled();
    socket.frame({ type: "ready" });
    await flush();
    await press;
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.value.micPhase).toBe("recording");

    socket.frame({ type: "partial", text: "hello" });
    socket.frame({ type: "partial", text: " there" });
    await flush();
    expect(h.value.provisional, "hosted partials append").toBe("hello there");

    let sent: string | null = null;
    void h.value.finish().then((text) => {
      sent = text;
    });
    await flush();
    expect(commits(socket)).toBe(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(sent, "still waiting inside the hosted 3000 ms").toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toBe("hello there");
    expect(heard).toEqual([]);
    expect(h.value.micPhase).toBe("idle");
  });
});
