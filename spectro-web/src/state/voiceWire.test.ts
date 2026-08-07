// Card 184 leg 2b: the voice exchange reaches the trace through the answer to
// this browser's own POST, because there is no session socket to mirror it on.

import { beforeEach, describe, expect, it } from "vitest";
import { clearVoiceExchanges, currentVoiceExchanges, noteVoiceExchange, readVoiceWire } from "./voiceWire";

const wire = (over: Record<string, unknown> = {}) => ({
  session: "stt-2026-08-07",
  xid: "x1",
  agentId: "composer",
  kind: "stt",
  provider: "whisper-cpp",
  model: "ggml-small.bin",
  url: "process://whisper-cli",
  status: 200,
  requestBytes: 40120,
  responseBytes: 18,
  responseLines: 0,
  aborted: false,
  fidelity: "encoded",
  durationMs: 900,
  ts: 1000,
  ...over,
});

describe("the wire record a transcribe answer carries", () => {
  beforeEach(() => clearVoiceExchanges());

  it("keeps the sidecar id, because for voice it is NOT the session's", () => {
    expect(readVoiceWire(wire())?.wireSession).toBe("stt-2026-08-07");
  });

  it("keeps the sizes a row can print without fetching anything", () => {
    const x = readVoiceWire(wire());
    expect(x?.requestBytes).toBe(40120);
    expect(x?.durationMs).toBe(900);
    expect(x?.kind).toBe("stt");
  });

  // The honest shape of "no record": a run that never got as far as an exchange
  // sends no `wire` at all, and a reader must not draw a row for one.
  it("refuses an answer with no record behind it", () => {
    expect(readVoiceWire(undefined)).toBeNull();
    expect(readVoiceWire({})).toBeNull();
    expect(readVoiceWire(wire({ session: "" }))).toBeNull();
    expect(readVoiceWire(wire({ xid: "" }))).toBeNull();
    expect(readVoiceWire(wire({ ts: "later" }))).toBeNull();
  });

  it("remembers each call once, so a retry does not draw it twice", () => {
    noteVoiceExchange(wire());
    noteVoiceExchange(wire());
    expect(currentVoiceExchanges()).toHaveLength(1);
    noteVoiceExchange(wire({ xid: "x2", ts: 2000 }));
    expect(currentVoiceExchanges().map((x) => x.xid)).toEqual(["x1", "x2"]);
  });

  it("remembers nothing at all when the answer carried no record", () => {
    noteVoiceExchange({ text: "hallo" });
    expect(currentVoiceExchanges()).toHaveLength(0);
  });
});
