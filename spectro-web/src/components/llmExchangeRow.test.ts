// The llm_exchange frame as a trace row: which chip it answers to, and what
// the collapsed line says. Card 179's lesson twice over — a type categoryOf
// does not know gets no chip, and the summary is also the row's search text,
// so it must never carry a body.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import type { TraceEntry } from "../state/reducer";
import { llmExchangeSummary, readExchange } from "../wire/llmWire";
import { CATEGORIES, categoryOf, inCategories, searchText, summarize } from "./TraceView";

const payload = {
  type: "llm_exchange",
  xid: "x1",
  agentId: "main",
  turn: 3,
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
};

const entry: TraceEntry = { seq: 7, dir: "in", ts: 1000, type: "llm_exchange", payload };

describe("the llm chip", () => {
  it("exists, and the frame answers to it", () => {
    expect(CATEGORIES).toContain("llm");
    expect(categoryOf("llm_exchange")).toBe("llm");
  });

  it("filters the row with the llm chip, not with `other`", () => {
    const noLlm = new Set(CATEGORIES.filter((c) => c !== "llm"));
    const noOther = new Set(CATEGORIES.filter((c) => c !== "other"));
    expect(inCategories(entry, noLlm)).toBe(false);
    expect(inCategories(entry, noOther)).toBe(true);
  });

  it("has its word in the dict, both languages", () => {
    expect(dict["trace.cat.llm"]?.de).toBeTruthy();
    expect(dict["trace.cat.llm"]?.en).toBeTruthy();
  });
});

describe("the collapsed row", () => {
  it("says the compact line, exactly what llmExchangeSummary builds", () => {
    const x = readExchange(payload);
    expect(x).not.toBeNull();
    expect(summarize(entry, "en")).toBe(llmExchangeSummary(x!));
  });

  it("prints no body content — the summary is also the search text", () => {
    const smuggled: TraceEntry = {
      ...entry,
      payload: { ...payload, body: "AAAABBBBCCCCDDDD_base64_noise" },
    };
    expect(summarize(smuggled, "en")).not.toContain("AAAABBBBCCCCDDDD");
  });

  it("falls back to the raw frame when the payload does not read", () => {
    const torn: TraceEntry = {
      seq: 8,
      dir: "in",
      ts: 1,
      type: "llm_exchange",
      payload: { type: "llm_exchange" },
    };
    expect(summarize(torn, "en")).toBe(JSON.stringify(torn.payload));
  });
});

describe("the filter predicate's search text", () => {
  it("searches an llm_exchange row by its summary, so a smuggled field cannot match", () => {
    // The frame contract carries no body, but that guarantee must be client
    // structure, not server discipline: a widened frame's extra field would
    // otherwise enter the chip-row filter text via compactJson.
    const smuggled: TraceEntry = {
      ...entry,
      // The reducer stamps the frame's agentId onto the entry itself; the
      // filter reads it there, never out of the payload.
      agentId: "main",
      payload: { ...payload, body: "AAAABBBBCCCCDDDD_base64_noise" },
    };
    const text = searchText(smuggled).toLowerCase();
    expect(text).not.toContain("aaaabbbbccccdddd");
    // What the summary says stays searchable — and so do type and agent.
    expect(text).toContain("anthropic");
    expect(text).toContain("/v1/messages");
    expect(text).toContain("llm_exchange");
    expect(text).toContain("main");
  });

  it("keeps the raw frame as the search text for every other type", () => {
    const other: TraceEntry = {
      seq: 9,
      dir: "in",
      ts: 1,
      type: "turn_start",
      payload: { type: "turn_start", detail: "needle" },
    };
    expect(searchText(other)).toContain("needle");
  });
});
