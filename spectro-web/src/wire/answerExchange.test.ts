// Card 473, round three: an LLM interaction opens in the chat. An answer in
// the chat has no exchange id of its own; it has its agent and the moment its
// usage line closed it. The exchange that produced it closes at that moment
// too, so the answer opens the chat exchange of the same agent that closed
// nearest to it.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readZip } from "../import/bundleZip";
import { holdImportWires, unpackBundle } from "../import/wireImport";
import type { RunEvent } from "../events";
import { releaseHeldWires } from "./heldWire";
import { fetchLlmExchange, type LlmExchangeMeta } from "./llmWire";
import { exchangeForAnswer, findAnswerExchange, ANSWER_EXCHANGE_WINDOW_MS } from "./answerExchange";

const meta = (over: Partial<LlmExchangeMeta>): LlmExchangeMeta => ({
  xid: "x",
  agentId: "main",
  turn: 1,
  kind: "chat",
  provider: "ollama",
  model: "m",
  transport: "http",
  url: "http://localhost:11434/api/chat",
  status: 200,
  requestBytes: 1,
  responseBytes: 1,
  responseLines: 1,
  aborted: false,
  fidelity: "bytes",
  durationMs: 100,
  ts: 0,
  ...over,
});

describe("which exchange an answer opens", () => {
  const index = [
    meta({ xid: "a", ts: 1_000 }),
    meta({ xid: "b", ts: 5_000 }),
    meta({ xid: "c", ts: 5_020, kind: "compaction" }),
    meta({ xid: "d", ts: 5_010, agentId: "helper" }),
    meta({ xid: "e", ts: 9_000 }),
  ];

  it("takes the chat exchange of the same agent that closed nearest the answer", () => {
    expect(exchangeForAnswer(index, { agentId: "main", endTs: 5_030 })?.xid).toBe("b");
    expect(exchangeForAnswer(index, { agentId: "main", endTs: 1_005 })?.xid).toBe("a");
    expect(exchangeForAnswer(index, { agentId: "helper", endTs: 5_030 })?.xid).toBe("d");
  });

  it("never takes an exchange that started after the answer closed", () => {
    // Measured live on 2026-10-09 against a scripted model: two runs 60 ms
    // apart. The first answer's usage closed at ...152; its exchange closed
    // at ...121, the next run's exchange started at ...171 and closed at
    // ...180, which is nearer in time and belongs to the next answer.
    const live = [
      meta({ xid: "first", ts: 1_791_558_393_121, durationMs: 8 }),
      meta({ xid: "second", ts: 1_791_558_393_180, durationMs: 9 }),
    ];
    expect(exchangeForAnswer(live, { agentId: "main", endTs: 1_791_558_393_152 })?.xid).toBe("first");
    expect(exchangeForAnswer(live, { agentId: "main", endTs: 1_791_558_393_221 })?.xid).toBe("second");
  });

  it("opens nothing for an answer without a closing moment, or with no exchange near it", () => {
    expect(exchangeForAnswer(index, { agentId: "main" })).toBeNull();
    expect(
      exchangeForAnswer(index, { agentId: "main", endTs: 9_000 + ANSWER_EXCHANGE_WINDOW_MS + 1 }),
    ).toBeNull();
    expect(exchangeForAnswer([], { agentId: "main", endTs: 5_000 })).toBeNull();
  });
});

describe("an answer of an imported session opens its exchange from the held wire", () => {
  afterEach(() => releaseHeldWires());
  const dir = fileURLToPath(new URL("../import/fixtures/bundle-473/", import.meta.url));
  const zipName = readdirSync(dir).find((n) => n.endsWith(".spectro.zip"))!;
  const IMPORT = "import:spectroscope:answer";

  it("finds the exchange and its bodies without asking the server", async () => {
    const { session, wires } = unpackBundle(await readZip(new Uint8Array(readFileSync(dir + zipName))));
    const events = session.text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as RunEvent);
    await holdImportWires(IMPORT, events, wires, {}, () => Promise.reject(new Error("no network")));
    // The fixture's first exchange closed at ...950; its answer's usage line
    // would close a few milliseconds after.
    const found = await findAnswerExchange(IMPORT, { agentId: "main", endTs: 1_791_540_000_960 });
    expect(found?.xid).toBe("43c25991-408c-42c8-b861-a9147791b65c");
    const bodies = await fetchLlmExchange(IMPORT, found!.xid);
    expect(bodies?.request.body).toContain("Grüß mich");
  });
});
