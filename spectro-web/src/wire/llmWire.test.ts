// The llm-wire sidecar at the browser boundary: the socket frame read into a
// meta record, the one-line row summary built from NOTHING but that record,
// and the merge that folds a reopened session's index back into its trace.
// The bodies live behind the exchange endpoint and never touch any of this —
// card 179's lesson: the summary is also the row's search text.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import type { TraceEntry } from "../state/reducer";
import {
  fidelityKey,
  llmExchangeSummary,
  mergeLlmExchanges,
  readExchange,
  type LlmExchangeMeta,
  readExchangeDetail,
  traceWithVoice,
  llmRequestSummary,
  withResponseRows,
} from "./llmWire";

/** One frame the server would push, with room to disagree per test. */
const frame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "llm_exchange",
  xid: "x1",
  agentId: "main",
  turn: 1,
  kind: "chat",
  provider: "anthropic",
  model: "claude-sonnet-5",
  url: "https://api.anthropic.com/v1/messages",
  status: 200,
  requestBytes: 49357,
  responseBytes: 12390,
  responseLines: 42,
  aborted: false,
  fidelity: "bytes",
  durationMs: 3400,
  ts: 1000,
  ...over,
});

const meta = (over: Record<string, unknown> = {}): LlmExchangeMeta => {
  const read = readExchange(frame(over));
  if (read === null) throw new Error("fixture frame did not read");
  return read;
};

describe("readExchange", () => {
  it("reads the frame the server pushes", () => {
    const x = meta();
    expect(x.xid).toBe("x1");
    expect(x.provider).toBe("anthropic");
    expect(x.requestBytes).toBe(49357);
    expect(x.aborted).toBe(false);
  });

  it("refuses a frame without an xid or without a ts", () => {
    // No xid means no detail endpoint to ask and nothing to dedupe by; no ts
    // means no place in the trace. Both are the frame's own contract.
    expect(readExchange(frame({ xid: undefined }))).toBeNull();
    expect(readExchange(frame({ ts: undefined }))).toBeNull();
    expect(readExchange(null)).toBeNull();
    expect(readExchange("nope")).toBeNull();
  });
});

describe("llmExchangeSummary", () => {
  it("is the compact line: path, provider, sizes, status, duration", () => {
    expect(llmExchangeSummary(meta())).toBe("/v1/messages · anthropic · 48 kB → 12 kB · 200 · 3.4 s");
  });

  it("says aborted instead of a status the exchange never reached", () => {
    expect(llmExchangeSummary(meta({ aborted: true, status: 0 }))).toBe(
      "/v1/messages · anthropic · 48 kB → 12 kB · aborted · 3.4 s",
    );
  });

  it("prints the empty glyph when no status was exposed, never a fabricated 0", () => {
    // The Anthropic SDK exposes no status on a natural finish (card 184).
    expect(llmExchangeSummary(meta({ status: 0 }))).toBe(
      "/v1/messages · anthropic · 48 kB → 12 kB · — · 3.4 s",
    );
  });

  it("names a kind that is not chat, so a compaction row says so", () => {
    expect(llmExchangeSummary(meta({ kind: "compaction" }))).toMatch(/^compaction · /);
    expect(llmExchangeSummary(meta())).not.toMatch(/^chat/);
  });

  it("prints an unparseable url verbatim rather than inventing a path", () => {
    expect(llmExchangeSummary(meta({ url: "not a url" }))).toMatch(/^not a url · /);
  });

  it("never carries body content, even off a frame that smuggled some", () => {
    // The frame contract has no body field; a summary built only from the
    // read meta cannot leak one however the payload was widened.
    const x = readExchange(frame({ body: "SECRETBYTES", requestBody: "SECRETBYTES" }));
    expect(x).not.toBeNull();
    expect(llmExchangeSummary(x!)).not.toContain("SECRETBYTES");
  });
});

/** A trace row as the reducer would have appended it. */
const row = (seq: number, ts: number, type = "turn_start"): TraceEntry => ({
  seq,
  dir: "in",
  ts,
  type,
  payload: { type, ts },
});

describe("mergeLlmExchanges", () => {
  // REPLACED, not loosened: an archive has to get the REQUEST row back too, at
  // the moment the call really left. That moment is exact rather than guessed —
  // the recorder's durationMs IS close minus send, so ts - durationMs is the
  // instant the POST went out, the same one the live frame carries directly.
  // Without it a reopened session shows the answer with no call in front of it,
  // which is the causally impossible story leg 2 exists to end.
  it("inserts BOTH rows of each exchange, at their own moments, and renumbers", () => {
    const trace = [row(1, 500), row(2, 1500), row(3, 2500)];
    const merged = mergeLlmExchanges(trace, [meta({ ts: 2000, xid: "a", durationMs: 700 })]);
    expect(merged.map((r) => r.type)).toEqual([
      "turn_start",
      "llm_request",
      "turn_start",
      "llm_exchange",
      "turn_start",
    ]);
    expect(merged.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(merged[1].ts).toBe(1300); // 2000 - 700: when it LEFT
    expect(merged[3].ts).toBe(2000); // when it closed
    expect(merged[1].dir).toBe("out"); // it went TO the provider
    const inserted = merged[3];
    expect(inserted.dir).toBe("in");
    expect(inserted.agentId).toBe("main");
    expect(inserted.model).toBe("claude-sonnet-5");
    expect((inserted.payload as { xid?: string }).xid).toBe("a");
  });

  // A duration of zero means the recorder never measured one (an exchange that
  // never closed), and a request row stamped at the close would be a claim.
  it("adds no request row when there is no measured duration to place it by", () => {
    const merged = mergeLlmExchanges([row(1, 500)], [meta({ ts: 2000, xid: "a", durationMs: 0 })]);
    expect(merged.map((r) => r.type)).toEqual(["turn_start", "llm_exchange"]);
  });

  it("dedupes by xid against rows already in the trace", () => {
    // A live-received frame is already a row; the index answering the same
    // exchange must not double it.
    const live: TraceEntry = {
      seq: 2,
      dir: "in",
      ts: 1200,
      type: "llm_exchange",
      payload: frame({ xid: "a", ts: 1200 }),
    };
    const merged = mergeLlmExchanges(
      [row(1, 500), live],
      [meta({ xid: "a", ts: 1200 }), meta({ xid: "b", ts: 1300 })],
    );
    expect(merged.filter((r) => r.type === "llm_exchange")).toHaveLength(2);
    const xids = merged
      .filter((r) => r.type === "llm_exchange")
      .map((r) => (r.payload as { xid?: string }).xid);
    expect(xids).toEqual(["a", "b"]);
  });

  it("dedupes inside the index itself", () => {
    const merged = mergeLlmExchanges([row(1, 500)], [meta({ xid: "a" }), meta({ xid: "a" })]);
    expect(merged.filter((r) => r.type === "llm_exchange")).toHaveLength(1);
  });

  it("returns the rows untouched when the index brings nothing new", () => {
    const trace = [row(1, 500), row(2, 1500)];
    expect(mergeLlmExchanges(trace, [])).toBe(trace);
  });
});

describe("the fidelity sentence", () => {
  it("maps each recorded fidelity to its own sentence key", () => {
    expect(fidelityKey("bytes")).toBe("trace.llm.fid.bytes");
    expect(fidelityKey("sdk-json")).toBe("trace.llm.fid.sdk-json");
    expect(fidelityKey("sdk-events")).toBe("trace.llm.fid.sdk-events");
    // The stt request side: the recording's own base64 of the real input
    // bytes — minted by the recorder, not read off a socket.
    expect(fidelityKey("encoded")).toBe("trace.llm.fid.encoded");
  });

  it("refuses a fidelity nobody wrote a sentence for", () => {
    // A null falls back to printing the word itself — a wrong sentence about
    // the wrong recording would be worse than the bare word.
    expect(fidelityKey("telepathy")).toBeNull();
  });
});

describe("the dictionary carries every llm-wire sentence, both languages", () => {
  it("has the detail pane's and the download link's keys", () => {
    for (const key of [
      "trace.cat.llm",
      "trace.llm.fid.bytes",
      "trace.llm.fid.sdk-json",
      "trace.llm.fid.sdk-events",
      "trace.llm.fid.encoded",
      "trace.llm.imported",
      "trace.llm.loading",
      "trace.llm.failed",
      "trace.llm.blobTitle",
      "trace.llm.linesCap",
      "trace.llm.omittedCeiling",
      "trace.llm.noResponse",
      "arch.llmWire",
      "arch.llmWireTitle",
    ]) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key]?.de, `${key}.de`).toBeTruthy();
      expect(dict[key]?.en, `${key}.en`).toBeTruthy();
    }
  });
});

// Card 184's routing repair needs one field that was being dropped here: the
// endpoint hands over the whole recorded line, headers included, and the reader
// decided what a face could see. Without them the wire face could show a POST
// line and a body but not the request, and a request without its headers is not
// what went over the socket.
describe("what a face gets to see of a recorded side", () => {
  it("carries the recorded headers through, values already redacted by the writer", () => {
    const detail = readExchangeDetail({
      request: {
        fidelity: "bytes",
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        transport: "https",
        bodyBytes: 9162,
        headers: { "content-type": "application/json", "x-api-key": "[redacted · 108 chars]" },
        body: "{}",
      },
      response: { fidelity: "sdk-events", lines: [] },
    });
    expect(detail?.request.headers["content-type"]).toBe("application/json");
    expect(detail?.request.headers["x-api-key"]).toBe("[redacted · 108 chars]");
    expect(detail?.request.transport).toBe("https");
    expect(detail?.request.bodyBytes).toBe(9162);
  });

  it("loses one foreign cell rather than the whole map", () => {
    const detail = readExchangeDetail({
      request: { headers: { good: "yes", bad: 7, worse: null } },
      response: {},
    });
    expect(detail?.request.headers).toEqual({ good: "yes" });
  });

  it("has an empty map, never undefined, for a side that recorded none", () => {
    const detail = readExchangeDetail({ request: {}, response: {} });
    expect(detail?.response.headers).toEqual({});
    expect(Object.keys(detail!.request.headers)).toHaveLength(0);
  });
});

// Every exchange stands for three rows: it left, it came back, and here is the
// summary. That was true for a chat turn and NOT for a voice call — the response
// row was inserted before the voice rows were folded in, so speech drew two rows
// where everything else drew three. Found by counting them in the app.
describe("the rows an exchange stands for, wherever it came from", () => {
  const voiceExchange = {
    wireSession: "stt-2026-08-07",
    xid: "v1",
    agentId: "composer",
    turn: 0,
    kind: "stt",
    provider: "whisper-cpp",
    model: "ggml-small.bin",
    url: "process://whisper-cli",
    status: 200,
    requestBytes: 99884,
    responseBytes: 46,
    responseLines: 1,
    aborted: false,
    fidelity: "encoded",
    durationMs: 8446,
    ts: 3000,
  };

  const chatRow: TraceEntry = {
    seq: 1,
    dir: "in",
    ts: 9000,
    type: "llm_exchange",
    payload: { type: "llm_exchange", ...readExchange(frame()) },
  };

  it("gives a voice call the same three rows a chat turn gets", () => {
    const types = traceWithVoice([chatRow], [voiceExchange]).map((r) => r.type);

    expect(types.filter((t) => t.startsWith("llm_"))).toEqual([
      "llm_request", // the recording left, at ts - durationMs
      "llm_response", // it came back
      "llm_exchange", // and the summary closes the group
      "llm_response",
      "llm_exchange",
    ]);
  });

  it("keeps every row in time order and numbers them from one", () => {
    const rows = traceWithVoice([chatRow], [voiceExchange]);

    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.ts)).toEqual([
      voiceExchange.ts - voiceExchange.durationMs,
      voiceExchange.ts,
      voiceExchange.ts,
      chatRow.ts,
      chatRow.ts,
    ]);
  });

  it("leaves a trace with no voice in it exactly as it was", () => {
    expect(traceWithVoice([chatRow], []).map((r) => r.type)).toEqual(["llm_response", "llm_exchange"]);
  });
});

// A child process has no HTTP method and no path, and the row used to print
// both: `stt · POST · whisper-cpp`, where the POST was invented by the reader's
// own default and the path was the empty remainder of `process://whisper-cli`.
describe("what a request row says about a call that never opened a socket", () => {
  const request = (over: Record<string, unknown>) => ({
    xid: "x",
    agentId: "composer",
    turn: 0,
    kind: "stt",
    provider: "whisper-cpp",
    model: "ggml-small.bin",
    transport: "process",
    method: "",
    url: "process://whisper-cli",
    requestBytes: 99884,
    fidelity: "encoded",
    ts: 1,
    ...over,
  });

  it("names the process instead of a verb it never used", () => {
    const line = llmRequestSummary(request({}));
    expect(line).toContain("whisper-cli");
    expect(line).not.toContain("POST");
  });

  it("still prints the verb and the path for a call that really is one", () => {
    const line = llmRequestSummary(
      request({
        transport: "http",
        method: "POST",
        url: "https://api.openai.com/v1/audio/transcriptions",
        provider: "openai",
      }),
    );
    expect(line).toContain("POST /v1/audio/transcriptions");
  });
});

describe("the response row keeps every other row's identity", () => {
  const row = (seq: number, type: string, ts: number): TraceEntry =>
    ({ seq, type, ts, dir: "in", summary: `row ${seq}` }) as unknown as TraceEntry;

  it("returns the SAME objects for rows it does not change", () => {
    // The defect this pins, found 2026-08-10: the function used to renumber the
    // whole list with `out.map((r, i) => ({ ...r, seq: i + 1 }))`, which builds
    // a new object for EVERY row. `TraceRow` is memo() with no comparator and
    // takes `entry={e}`, so once identity breaks not one row can bail out — and
    // its own comment promises "during a delta flood only the appended rows
    // render".
    //
    // It was latent until card 184 leg 3, which put llm_exchange into every
    // live session. Then the early return above stopped firing and a live trace
    // re-rendered all of its rows on every frame batch.
    const rows = [row(1, "frame", 10), row(2, "llm_exchange", 20), row(3, "frame", 30)];
    const out = withResponseRows(rows);
    expect(out).toHaveLength(4);
    for (const original of rows) {
      expect(out).toContain(original); // identity, not equality
    }
  });

  it("still puts the response row before the exchange it belongs to", () => {
    const rows = [row(1, "llm_exchange", 10)];
    expect(withResponseRows(rows).map((r) => r.type)).toEqual(["llm_response", "llm_exchange"]);
  });

  it("gives the synthetic row a seq of its own that collides with nothing", () => {
    // Real rows keep their number, so the synthetic one cannot have an integer.
    // The trace already carries a synthetic row at seq 0 (the system context),
    // so a non-integer seq is not a new idea here — it is the existing one.
    const rows = [row(1, "frame", 10), row(2, "llm_exchange", 20)];
    const out = withResponseRows(rows);
    const seqs = out.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(out.find((r) => r.type === "llm_response")?.seq).toBeLessThan(2);
    expect(out.find((r) => r.type === "llm_exchange")?.seq).toBe(2);
  });

  it("leaves a list without any exchange completely alone", () => {
    const rows = [row(1, "frame", 10), row(2, "frame", 20)];
    expect(withResponseRows(rows)).toBe(rows); // the same array, not a copy
  });
});
