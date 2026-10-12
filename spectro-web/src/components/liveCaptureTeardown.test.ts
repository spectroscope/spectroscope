// Card 527, found in the live check: every send gesture ended with a page
// error, "Cannot close a closed AudioContext". The commit closes the capture's
// AudioContext, and the close after the wire frame closed it a second time.
// The teardown now closes it once. Driven with fake browser objects, since
// this suite has no DOM.

import { afterEach, describe, expect, it, vi } from "vitest";
import { startLiveCapture } from "./liveCapture";

class FakeContext {
  static made: FakeContext[] = [];
  closes = 0;
  state = "running";
  sampleRate: number;
  audioWorklet = { addModule: async () => {} };
  constructor(opts: { sampleRate: number }) {
    this.sampleRate = opts.sampleRate;
    FakeContext.made.push(this);
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  close(): Promise<void> {
    this.closes++;
    if (this.state === "closed") return Promise.reject(new Error("Cannot close a closed AudioContext."));
    this.state = "closed";
    return Promise.resolve();
  }
}

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  onclose: unknown = null;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeContext.made = [];
});

describe("the live capture's teardown", () => {
  it("closes its AudioContext once, after a commit and a close", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:8201" } });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal(
      "AudioWorkletNode",
      class {
        port = { onmessage: null };
        disconnect() {}
      },
    );
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });

    const capture = await startLiveCapture({} as MediaStream, () => {}, 16000);
    capture.commit();
    capture.close();

    expect(FakeContext.made).toHaveLength(1);
    expect(FakeContext.made[0].sampleRate, "the route's rate reaches the capture").toBe(16000);
    expect(FakeContext.made[0].closes).toBe(1);
  });
});

describe("a failed audio graph in attach() (card 528 criterion 9)", () => {
  function stubs(worklet: { addModule(): Promise<void> }, node: unknown): void {
    vi.stubGlobal("window", { location: { origin: "http://localhost:8201" } });
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "AudioContext",
      class extends FakeContext {
        audioWorklet = worklet;
      },
    );
    vi.stubGlobal("AudioWorkletNode", node);
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  }

  it("closes the AudioContext when the worklet does not load", async () => {
    stubs(
      { addModule: async () => Promise.reject(new Error("worklet blocked")) },
      class {
        port = { onmessage: null };
        disconnect() {}
      },
    );

    await expect(startLiveCapture({} as MediaStream, () => {}, 16000)).rejects.toThrow("worklet blocked");

    expect(FakeContext.made).toHaveLength(1);
    expect(FakeContext.made[0].closes, "the context of a failed attach is closed").toBe(1);
  });

  it("closes the AudioContext when the worklet node cannot be built", async () => {
    stubs(
      { addModule: async () => {} },
      class {
        constructor() {
          throw new Error("no such processor");
        }
      },
    );

    await expect(startLiveCapture({} as MediaStream, () => {}, 16000)).rejects.toThrow("no such processor");

    expect(FakeContext.made[0].closes).toBe(1);
  });
});
