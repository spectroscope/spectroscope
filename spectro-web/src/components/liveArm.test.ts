// Card 527 criterion 8: on a live route the press opens the socket and waits
// for the server's ready (on the local route: after whisper has loaded the
// model) before the microphone is captured. No audio frame can leave before
// ready, and a ready that does not come in time leaves the microphone idle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArmFailure, armLive } from "./liveArm";
import type { LiveCapture, LiveSession } from "./liveCapture";

/** A live session whose ready the test resolves by hand. */
class FakeSession implements LiveSession {
  log: string[];
  readonly ready: Promise<{ warmupMs: number | null }>;
  resolveReady!: (value: { warmupMs: number | null }) => void;
  rejectReady!: (cause: Error) => void;
  closed = 0;
  constructor(log: string[]) {
    this.log = log;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A rejection nobody awaits yet must not fail the run.
    this.ready.catch(() => {});
  }
  async attach(_stream: MediaStream, rate: number): Promise<LiveCapture> {
    this.log.push(`attach@${rate}`);
    // From here the tap sends audio frames.
    this.log.push("audio");
    return { commit: () => {}, close: () => {} };
  }
  close(): void {
    this.closed++;
  }
}

let log: string[];
let session: FakeSession;
const deps = (timeoutMs = 20_000) => ({
  open: async () => {
    log.push("open");
    return session;
  },
  getMic: async () => {
    log.push("mic");
    return {} as MediaStream;
  },
  rate: 16000,
  timeoutMs,
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  session = new FakeSession(log);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("arming a live session", () => {
  it("captures the microphone only after the server said ready", async () => {
    const armed = armLive(deps());
    await flush();
    expect(log, "the socket is open and nothing else yet").toEqual(["open"]);

    session.resolveReady({ warmupMs: 450 });
    const result = await armed;

    expect(log).toEqual(["open", "mic", "attach@16000", "audio"]);
    expect(result.warmupMs).toBe(450);
  });

  it("sends no audio frame before ready", async () => {
    void armLive(deps());
    await flush();
    vi.advanceTimersByTime(19_000);
    await flush();
    expect(log).not.toContain("audio");
    expect(log).not.toContain("mic");
  });

  it("gives up after the timeout, closes the socket and never opens the microphone", async () => {
    const armed = armLive(deps(20_000));
    const failed = armed.catch((cause: unknown) => cause);
    await flush();
    vi.advanceTimersByTime(20_000);

    const cause = await failed;
    expect(cause).toBeInstanceOf(ArmFailure);
    expect((cause as ArmFailure).stage).toBe("timeout");
    expect(session.closed).toBe(1);
    expect(log).toEqual(["open"]);
  });

  it("a refusal before ready closes the socket and never opens the microphone", async () => {
    const failed = armLive(deps()).catch((cause: unknown) => cause);
    await flush();
    session.rejectReady(new Error("localRoute"));

    expect(((await failed) as ArmFailure).stage).toBe("ready");
    expect(session.closed).toBe(1);
    expect(log).toEqual(["open"]);
  });

  it("a denied microphone after ready closes the socket and says it was the microphone", async () => {
    const failed = armLive({
      ...deps(),
      getMic: async () => {
        throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      },
    }).catch((cause: unknown) => cause);
    await flush();
    session.resolveReady({ warmupMs: null });

    const cause = (await failed) as ArmFailure;
    expect(cause.stage).toBe("mic");
    expect((cause.cause as { name: string }).name).toBe("NotAllowedError");
    expect(session.closed).toBe(1);
  });

  it("an audio graph that fails after the microphone opened stops the microphone and closes the socket", async () => {
    // Fix round 3: attach() builds the AudioContext, loads the worklet and
    // connects the stream. When that rejects, the microphone is already open;
    // before this case the tracks kept running and the socket stayed open.
    let stopped = 0;
    const stream = {
      getTracks: () => [{ stop: () => stopped++ }, { stop: () => stopped++ }],
    } as unknown as MediaStream;
    session.attach = async () => {
      throw new Error("addModule failed");
    };
    const failed = armLive({ ...deps(), getMic: async () => stream }).catch((cause: unknown) => cause);
    await flush();
    session.resolveReady({ warmupMs: 300 });

    const cause = (await failed) as ArmFailure;
    expect(cause).toBeInstanceOf(ArmFailure);
    expect(cause.stage).toBe("capture");
    expect((cause.cause as Error).message).toBe("addModule failed");
    expect(stopped, "every track of the open microphone is stopped").toBe(2);
    expect(session.closed, "the socket is closed").toBe(1);
  });

  it("a socket that does not open is its own stage", async () => {
    const cause = (await armLive({
      ...deps(),
      open: async () => {
        throw new Error("the live transcription socket did not open");
      },
    }).catch((c: unknown) => c)) as ArmFailure;
    expect(cause.stage).toBe("open");
  });
});
