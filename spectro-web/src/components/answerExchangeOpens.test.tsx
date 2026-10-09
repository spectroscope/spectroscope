// Card 473, round three: an LLM interaction opens in the chat and in the Lab,
// not only in the trace. The chat gives every billed answer an opener for the
// exchange that produced it; the Lab's JSONL strip opens an llm_exchange line
// on its bodies. Both read the same session id the trace reads, so an import
// that holds its wire answers from it. Server renderer, no DOM: the fetch
// behind the opener is pinned in wire/answerExchange.test.ts.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { t } from "../i18n/i18n";
import { initialState, reduceAll } from "../state/reducer";
import { LabLine } from "../lab/LabTrace";
import { AnswerExchange } from "./AnswerExchange";
import { Chat } from "./Chat";

const history: RunEvent[] = [
  { type: "run_start", runId: "r0", agentId: "main", prompt: "Hallo Welt", ts: 10 },
  { type: "turn_start", agentId: "main", turn: 1, ts: 11 },
  { type: "text_delta", agentId: "main", text: "Hallo zurück", ts: 12 },
  { type: "usage", agentId: "main", inputTokens: 9, outputTokens: 3, ts: 20 },
  { type: "run_end", runId: "r0", stopReason: "end_turn", ts: 21 },
];

const opener = t("en", "chat.exchangeShow");

function chat(exchangeSessionId: string | null, events: RunEvent[] = history): string {
  return renderToStaticMarkup(
    <Chat
      state={reduceAll(initialState, events)}
      liveView={false}
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => false}
      readOnlyNote="Imported sessions are read-only."
      exchangeSessionId={exchangeSessionId}
    />,
  );
}

describe("the chat opens an answer's exchange", () => {
  it("offers the opener on a billed answer of a session that holds its wire", () => {
    const html = chat("import:spectroscope:x");
    expect(html).toContain("Hallo zurück");
    expect(html).toContain('class="link answer-exchange-toggle"');
    expect(html).toContain(opener);
  });

  it("offers nothing without a wire to read, or on an answer never billed", () => {
    // Positive control above: the same history with a wire offers it.
    expect(chat(null)).not.toContain("answer-exchange-toggle");
    expect(
      chat(
        "import:spectroscope:x",
        history.filter((e) => e.type !== "usage"),
      ),
    ).not.toContain("answer-exchange-toggle");
  });

  it("opens into the exchange pane", () => {
    const html = renderToStaticMarkup(
      <AnswerExchange sessionId="import:spectroscope:x" agentId="main" endTs={20} defaultOpen />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("answer-exchange-body");
    expect(html).toContain(t("en", "chat.exchangeLoading"));
  });
});

describe("the Lab opens an llm_exchange line on its bodies", () => {
  const exchange = {
    type: "llm_exchange",
    xid: "43c25991-408c-42c8-b861-a9147791b65c",
    agentId: "main",
    turn: 1,
    kind: "chat",
    provider: "anthropic",
    model: "claude-sonnet-5",
    transport: "http",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    requestBytes: 80,
    responseBytes: 115,
    responseLines: 3,
    aborted: false,
    fidelity: "bytes",
    durationMs: 650,
    ts: 950,
  } as unknown as RunEvent;

  const line = (exchangeSessionId: string | null, event: RunEvent = exchange): string =>
    renderToStaticMarkup(
      <LabLine
        event={event}
        seq={1}
        variant="applied"
        calls={new Map()}
        exchangeSessionId={exchangeSessionId}
        defaultOpen
      />,
    );

  it("shows the recorded exchange first, on the exchange face, when the session holds its wire", () => {
    const html = line("import:spectroscope:x");
    expect(html).toContain(t("en", "trace.mode.exchange"));
    expect(html).toContain(t("en", "trace.llm.loading"));
  });

  it("keeps the line's own faces for a session without a wire and for every other line", () => {
    const html = line(null);
    expect(html).not.toContain(t("en", "trace.llm.loading"));
    expect(html).not.toContain(t("en", "trace.mode.exchange"));
    const text = line("import:spectroscope:x", { type: "text_delta", agentId: "main", text: "hi", ts: 1 });
    expect(text).not.toContain(t("en", "trace.mode.exchange"));
  });
});
