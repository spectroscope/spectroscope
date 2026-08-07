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
  it("inserts each exchange at its ts and renumbers the rows", () => {
    const trace = [row(1, 500), row(2, 1500), row(3, 2500)];
    const merged = mergeLlmExchanges(trace, [meta({ ts: 2000, xid: "a" })]);
    expect(merged.map((r) => r.type)).toEqual(["turn_start", "turn_start", "llm_exchange", "turn_start"]);
    expect(merged.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    const inserted = merged[2];
    expect(inserted.dir).toBe("in");
    expect(inserted.agentId).toBe("main");
    expect(inserted.model).toBe("claude-sonnet-5");
    expect((inserted.payload as { xid?: string }).xid).toBe("a");
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
