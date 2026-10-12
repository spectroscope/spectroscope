// Card 521 (owner, 2026-10-11): "wenn ich zum Beispiel auf irgendeine Session
// gehe, die mit Minimax geladen wurde und das Minimax hatte zu dem Zeitpunkt
// eine Million Kontextfenster, dann steht das Kontextfenster auf 300%". The
// window a run had is a fact of the run: run_start records it, the server
// announces it on provider_info, and the ring reads the main agent's window
// and never a child's.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunEvent } from "../events";
import { initialState, reduce, reduceAll, type UiState } from "./reducer";
import { foldArchiveDeferred } from "./archiveFold";
import { ComposerMeta } from "../components/ComposerMeta";
import { ContextPopover } from "../components/ContextRing";
import { contextGauge, ringFrame } from "../components/contextRingMath";

const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

const mainStart = (extra: Record<string, unknown> = {}): RunEvent =>
  ev({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "go",
    provider: "ollama",
    model: "minimax-m3:cloud",
    ts: 1,
    ...extra,
  });

const usage = (inputTokens: number, agentId = "main"): RunEvent =>
  ev({ type: "usage", agentId, inputTokens, outputTokens: 5, ts: 2 });

const info = (agentId: string, extra: Record<string, unknown>): RunEvent =>
  ev({
    type: "context_info",
    agentId,
    turn: 1,
    messages: 2,
    estimatedTokens: 900,
    threshold: 700_000,
    parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
    ts: 3,
    ...extra,
  });

/** What the ring divides by, read through the same selector the ring uses. */
const denominator = (state: UiState): number => {
  const frame = ringFrame(state.context, state.announcedWindow);
  return contextGauge(frame.threshold, frame.contextWindow, frame.thresholdSource).denominator.value;
};

/** The ring's percentage as the stored view draws it. */
const ringPercent = (state: UiState): string => {
  const html = renderToStaticMarkup(
    <ComposerMeta
      provider="ollama"
      model="minimax-m3:cloud"
      status="open"
      onApplyProvider={() => {}}
      liveView={false}
      lastInputTokens={state.lastInputTokens}
      aiCredits={null}
      context={state.context}
      announcedWindow={state.announcedWindow}
    />,
  );
  const m = /<span class="tabular">(\d+)%<\/span>/.exec(html);
  if (m === null) throw new Error(`no ring in: ${html}`);
  return `${m[1]}%`;
};

/** The popover's markup for a state, as the ring would open it. */
const popover = (state: UiState): string => {
  const frame = ringFrame(state.context, state.announcedWindow);
  const gauge = contextGauge(frame.threshold, frame.contextWindow, frame.thresholdSource);
  return renderToStaticMarkup(
    <ContextPopover
      lastInputTokens={state.lastInputTokens}
      context={state.context}
      frame={frame}
      gauge={gauge}
      shownPct={Math.round((state.lastInputTokens / gauge.denominator.value) * 100)}
      onWindowOverride={undefined}
      aiCredits={null}
    />,
  );
};

describe("the ring reads the main agent's window, never a child's (card 521, AC 2)", () => {
  it("a child's context_info does not move the ring's denominator", () => {
    const state = reduceAll(initialState, [
      mainStart(),
      usage(300_000),
      info("main", { threshold: 700_000, thresholdSource: "model", contextWindow: 1_000_000 }),
      ev({ type: "agent_spawn", agentId: "worker", parentId: "main", ts: 4 }),
      ev({ type: "run_start", runId: "c1", agentId: "worker", parentId: "main", prompt: "sub", ts: 5 }),
      info("worker", { threshold: 22_937, thresholdSource: "window", contextWindow: 32_768 }),
    ]);

    expect(denominator(state)).toBe(1_000_000);
    expect(state.context?.contextWindow).toBe(1_000_000);
    expect(ringPercent(state)).toBe("30%");
  });
});

describe("a stored session shows the window it had at once (card 521, AC 3)", () => {
  it("a session whose events name a window divides by it on selection", () => {
    // Only the run_start names the window: no context_info, no frame.
    const { state } = foldArchiveDeferred([
      mainStart({ contextWindow: 1_000_000, windowSource: "model" }),
      usage(300_000),
      ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 6 }),
    ]);

    expect(denominator(state)).toBe(1_000_000);
    expect(ringPercent(state)).toBe("30%");
    expect(popover(state)).toContain("model window");
    expect(popover(state)).not.toContain("window unknown");
  });

  it("a session whose events name no window divides by the fallback and says the window is unknown", () => {
    const { state } = foldArchiveDeferred([
      mainStart(),
      usage(50_000),
      info("main", { threshold: 100_000, thresholdSource: "fallback" }),
      ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 6 }),
    ]);

    expect(denominator(state)).toBe(100_000);
    expect(ringPercent(state)).toBe("50%");
    expect(popover(state)).toContain("window unknown");
  });
});

describe("provider_info names the window until the next context_info (card 521, AC 4)", () => {
  const before = reduceAll(initialState, [
    mainStart(),
    usage(50_000),
    info("main", { threshold: 100_000, thresholdSource: "fallback" }),
  ]);

  it("a wake that announces a window moves the ring to it", () => {
    const woken = reduce(
      before,
      ev({
        type: "provider_info",
        provider: "ollama",
        model: "minimax-m3:cloud",
        host: "localhost:11434",
        contextWindow: 512_000,
        windowSource: "model",
      }),
    );

    expect(denominator(woken)).toBe(512_000);
    expect(popover(woken)).not.toContain("window unknown");
  });

  it("the next context_info of the main agent takes over again", () => {
    const woken = reduce(
      before,
      ev({
        type: "provider_info",
        provider: "ollama",
        model: "minimax-m3:cloud",
        host: "localhost:11434",
        contextWindow: 512_000,
        windowSource: "model",
      }),
    );
    const next = reduce(
      woken,
      info("main", { threshold: 22_937, thresholdSource: "window", contextWindow: 32_768 }),
    );

    expect(denominator(next)).toBe(32_768);
  });

  it("a provider_info from a server that names no window source leaves the ring alone", () => {
    const old = reduce(
      before,
      ev({ type: "provider_info", provider: "ollama", model: "qwen3", host: "localhost:11434" }),
    );

    expect(denominator(old)).toBe(100_000);
    expect(old.announcedWindow).toBeNull();
  });
});
