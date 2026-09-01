// CARD 333 — the LLM card says where the model IS. RED FIRST.
//
// What it said before this file existed, at nodes.tsx:950, in full:
//
//     <b>{t(lang, "map.remote")}</b> · {d.provider}
//
// — a literal with no condition anywhere on the line, and `map.remote` was
// "remote" in BOTH languages, so a translator never saw a decision either. The
// three backends this project tests against are ollama on this machine, LM
// Studio on the tailnet and the bundled llama-server on loopback; the word was
// wrong for all three, every frame.
//
// THREE states and not two, and the reason is a count: of 486 recorded session
// files 36 carry an address or an `llm_exchange` at all (7.4 %). On the other
// 92.6 % there is nothing to be honest about, and a card that printed "local"
// there would have traded one confident falsehood for another. So `unknown` is
// a state of its own, and the tests below demand it reads as neither of the
// other two.
//
// The locality question is NOT answered here. `outboundHop` (card 329) answers
// it, and it delegates to `isLoopbackAddress`, whose own doc names
// `localhost.evil.example` as the reason it matches the host exactly and never
// by substring. `modelLocation` adds the two states `outboundHop` folds
// together — it may not fold "nothing was recorded" into "loopback" — and
// nothing else.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { RunEvent } from "../../events";
import { setLang } from "../../state/lang";
import { modelLocation } from "./addresses";
import { deriveDetail } from "./sceneToFlow";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { LlmNode } from "./nodes";

const Llm = LlmNode as unknown as (p: { data: unknown }) => ReactElement;

const T = 1787148162959;

/** The measured `llm_exchange` shape (events.ts), with only `url` varying. */
const exchange = (url: string, over: Partial<{ agentId: string; ts: number }> = {}): RunEvent =>
  ({
    type: "llm_exchange",
    xid: "x1",
    agentId: over.agentId ?? "main",
    turn: 1,
    kind: "chat",
    provider: "lmstudio",
    model: "a-model",
    transport: "http",
    url,
    status: 200,
    requestBytes: 12,
    responseBytes: 34,
    responseLines: 1,
    aborted: false,
    fidelity: "full",
    durationMs: 9,
    ts: over.ts ?? T + 1,
  }) as RunEvent;

const runStart = (runId: string, ts: number, agentId = "main"): RunEvent =>
  ({ type: "run_start", runId, agentId, prompt: "go", ts }) as RunEvent;

const card = (loc: unknown, provider = "lmstudio"): string =>
  renderToStaticMarkup(<Llm data={{ active: false, provider, model: "a-model", lanes: [], more: 0, loc }} />);

// ---------------------------------------------------------------------------
// The decision itself
// ---------------------------------------------------------------------------
describe("modelLocation decides, and never declares (card 333, criterion 1)", () => {
  it("calls this machine's own backend local", () => {
    // The two loopback backends this project actually tests against.
    expect(modelLocation("http://localhost:11434/v1/chat/completions")).toEqual({ kind: "local" });
    expect(modelLocation("http://127.0.0.1:18099/v1/chat/completions")).toEqual({ kind: "local" });
  });

  it("names the host when the call left this machine", () => {
    expect(modelLocation("https://api.anthropic.com/v1/messages")).toEqual({
      kind: "host",
      host: "api.anthropic.com",
    });
    // A port belongs to the host and stays on it — `outboundHop` reads
    // `URL.host`, not `URL.hostname`, and that is what a reader needs to find
    // the box again.
    expect(modelLocation("http://100.64.0.1:1234/v1/models")).toEqual({
      kind: "host",
      host: "100.64.0.1:1234",
    });
  });

  it("does NOT file localhost.evil.example as local (criterion 3)", () => {
    // The whole reason card 329 refused to spell the loopback rule a second
    // time. A substring test says "local" here and hands a remote host the
    // safest-looking word on the card.
    expect(modelLocation("http://localhost.evil.example/v1/chat")).toEqual({
      kind: "host",
      host: "localhost.evil.example",
    });
  });

  it("reads a redaction as a redaction, before any locality question (criterion 4)", () => {
    // BOTH writer shapes, because the session wire carries the bracketed form
    // and the sidecar the object one.
    expect(modelLocation("[redacted: anthropic-key]")).toEqual({ kind: "redacted" });
    expect(modelLocation({ kind: "redacted", rule: "anthropic-key", bytes: 51 })).toEqual({
      kind: "redacted",
    });
  });

  it("says UNKNOWN where nothing was recorded, never local (criterion 2)", () => {
    expect(modelLocation(undefined)).toEqual({ kind: "unknown" });
    expect(modelLocation(null)).toEqual({ kind: "unknown" });
    expect(modelLocation("")).toEqual({ kind: "unknown" });
  });

  it("says UNKNOWN for something that is not an address, never local", () => {
    // `outboundHop` answers `none` for a half-parse AND for loopback, on
    // purpose — it only ever had to decide whether to draw a hop. This card
    // has to tell those two apart, and the conservative direction is unknown:
    // "lmstudio" is a provider NAME, and a name is not evidence of a place.
    expect(modelLocation("lmstudio")).toEqual({ kind: "unknown" });
    expect(modelLocation("not a url at all")).toEqual({ kind: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// The address reaching the fold (criterion 5)
// ---------------------------------------------------------------------------
describe("the recorded address reaches the fold (card 333, criterion 5)", () => {
  it("carries the address the run recorded, not the provider name", () => {
    const d = deriveDetail([runStart("r1", T), exchange("http://localhost:11434/v1/chat")]);
    expect(d.llmUrl).toBe("http://localhost:11434/v1/chat");
  });

  it("is null before any exchange — 92.6 % of the recorded corpus", () => {
    expect(deriveDetail([runStart("r1", T)]).llmUrl).toBeNull();
  });

  it("holds the LAST exchange, so the card names the backend serving now", () => {
    const d = deriveDetail([
      runStart("r1", T),
      exchange("http://localhost:11434/v1/chat"),
      exchange("https://api.anthropic.com/v1/messages", { ts: T + 2 }),
    ]);
    expect(d.llmUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  it("a fresh run of the ROOT forgets the last run's address", () => {
    // The same scope `reached` and `page` already have: what the previous run
    // reached is not a fact about this one.
    const d = deriveDetail([
      runStart("r1", T),
      exchange("https://api.anthropic.com/v1/messages"),
      runStart("r2", T + 5),
    ]);
    expect(d.llmUrl).toBeNull();
  });

  it("a CHILD's run_start does not throw the parent's address away", () => {
    // 25 of 25 child run_starts on this machine carry their own runId, so a
    // scope keyed on the runId alone would empty the record on every spawn.
    const d = deriveDetail([
      runStart("r1", T),
      exchange("https://api.anthropic.com/v1/messages"),
      runStart("r2", T + 5, "sub-1"),
    ]);
    expect(d.llmUrl).toBe("https://api.anthropic.com/v1/messages");
  });
});

// ---------------------------------------------------------------------------
// What the card prints (criteria 1, 2, 7)
// ---------------------------------------------------------------------------
describe("the LLM card prints the decision (card 333)", () => {
  it("says local for a loopback backend, and does not say remote", () => {
    setLang("en");
    const html = card({ kind: "local" });
    expect(html).toContain("local");
    expect(html).not.toContain("remote");
  });

  it("names the host for a backend that is elsewhere", () => {
    setLang("en");
    const html = card({ kind: "host", host: "api.anthropic.com" });
    expect(html).toContain("api.anthropic.com");
    expect(html).not.toContain("remote");
  });

  it("says so explicitly where nothing was recorded, claiming neither", () => {
    setLang("en");
    const html = card({ kind: "unknown" });
    expect(html).toContain("address not recorded");
    // Neither of the other two words, which is criterion 2's whole point.
    expect(html).not.toContain("remote");
    expect(html).not.toMatch(/>local</);
  });

  it("says a redaction is a redaction", () => {
    setLang("en");
    expect(card({ kind: "redacted" })).toContain("address redacted");
  });

  it("stamps the state on the markup, the way the browser card stamps its own", () => {
    // `data-url-state` on the browser card (330) exists so a live DOM
    // measurement can read WHICH of the states is standing without parsing
    // prose that changes with the language. Same reason here, same shape.
    setLang("de");
    try {
      expect(card({ kind: "local" })).toContain('data-loc="local"');
      expect(card({ kind: "unknown" })).toContain('data-loc="unknown"');
      expect(card({ kind: "redacted" })).toContain('data-loc="redacted"');
      expect(card({ kind: "host", host: "api.anthropic.com" })).toContain('data-loc="host"');
    } finally {
      setLang("en");
    }
  });

  it("carries no literal of its own — the German card is German (criterion 7)", () => {
    setLang("de");
    try {
      expect(card({ kind: "local" })).toContain("lokal");
      expect(card({ kind: "unknown" })).toContain("Adresse nicht aufgezeichnet");
      expect(card({ kind: "redacted" })).toContain("Adresse geschwärzt");
      // A HOST is a fact and not copy: it is the same in both languages.
      expect(card({ kind: "host", host: "api.anthropic.com" })).toContain("api.anthropic.com");
    } finally {
      setLang("en");
    }
  });
});
