// Card 593: the ring and its popover show the picked agent and say so.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo, ContextSnapshot } from "../state/reducer";
import { initialState } from "../state/reducer";
import { figuresOf, shownAgentOf, type AgentPick } from "../state/shownAgent";
import { ComposerMeta } from "./ComposerMeta";
import { ContextPopover, ContextRing } from "./ContextRing";
import { contextGauge, ringFrame } from "./contextRingMath";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  parentId,
  label: null,
  task: "",
  state: "working",
  lastStatus: null,
  inTokens: 0,
  outTokens: 0,
  ...extra,
});
const agents = [
  row("main", null),
  row("explore-1", "main", { model: "minimax-m3:cloud" }),
  row("worker-2", "main", { state: "submitted" }),
];
const snapshot = (extra: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  turn: 2,
  messages: 5,
  estimatedTokens: 3000,
  threshold: 22_937,
  thresholdSource: "window",
  contextWindow: 32_768,
  parts: [
    { label: "system prompt", chars: 1200, estTokens: 300 },
    { label: "tool schemas", chars: 4000, estTokens: 1000 },
    { label: "conversation", chars: 6800, estTokens: 1700 },
  ],
  ...extra,
});
const base = {
  ...initialState,
  rootAgentId: "main",
  agents,
  lastInputTokens: 24_100,
  context: snapshot({ threshold: 143_001, contextWindow: 204_288 }),
  aiCredits: 0.42,
};
const pick = (id: string | null, state = base): AgentPick => ({
  agents: state.agents,
  shown: shownAgentOf(state, id),
  onPick: () => {},
});

const popover = (
  state: typeof base,
  id: string | null,
  onWindowOverride: ((n: number | null) => void) | undefined = () => {},
): string => {
  const picker = pick(id, state);
  const figures = figuresOf(state, picker.shown);
  const frame = ringFrame(figures.context, figures.announcedWindow);
  const gauge = contextGauge(frame.threshold, frame.contextWindow, frame.thresholdSource);
  return renderToStaticMarkup(
    <ContextPopover
      lastInputTokens={figures.lastInputTokens}
      context={figures.context}
      frame={frame}
      gauge={gauge}
      shownPct={Math.round((figures.lastInputTokens / gauge.denominator.value) * 100)}
      onWindowOverride={onWindowOverride}
      aiCredits={state.aiCredits}
      picker={picker}
    />,
  );
};
const ring = (state: typeof base, id: string | null): string => {
  const picker = pick(id, state);
  const figures = figuresOf(state, picker.shown);
  return renderToStaticMarkup(
    <ContextRing
      lastInputTokens={figures.lastInputTokens}
      context={figures.context}
      announcedWindow={figures.announcedWindow}
      onWindowOverride={undefined}
      aiCredits={null}
      picker={picker}
    />,
  );
};
const withHelper = {
  ...base,
  helpers: { "explore-1": { lastInputTokens: 12_300, context: snapshot(), announcedWindow: null } },
};

describe("the ring", () => {
  it("names the main agent in its label and shows no prefix", () => {
    const html = ring(base, null);
    expect(html).toContain('aria-label="Context of Main agent, 12 percent full"');
    expect(html).not.toContain("context-ring-agent");
  });

  it("puts a helper's id in front of its percentage, with the agent's dot colour", () => {
    const html = ring(withHelper, "explore-1");
    expect(html).toContain('aria-label="Context of explore-1, 38 percent full"');
    expect(html).toMatch(/class="context-ring-agent mono" style="--agent-color:var\(--agent-explore\)"/);
    expect(html).toContain("explore-1</span>");
    expect(html).toContain(">38%</span>");
  });

  it("shows 0 % for a helper before its first usage", () => {
    expect(ring(base, "worker-2")).toContain(">0%</span>");
  });
});

describe("the popover for the root", () => {
  it("carries the picker under the eyebrow and keeps the session window row and the credits", () => {
    const html = popover(base, null);
    expect(html.indexOf("agent-pick")).toBeGreaterThan(html.indexOf('class="eyebrow"'));
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain('class="context-override"');
    expect(html).toContain("context-credits");
  });
});

describe("the popover for a helper", () => {
  it("shows the picker, its headline, the compaction line, its model, its parts, the meta line and the note", () => {
    const html = popover(withHelper, "explore-1");
    expect(html).toContain("Showing: explore-1");
    expect(html).toMatch(/12\.3k of \S+ (loaded|model|set) window \(38%\)/);
    expect(html).toContain("compacts at");
    expect(html).toContain("model minimax-m3:cloud");
    expect(html).toContain("tool schemas");
    expect(html).toContain("messages: 5");
    expect(html).toContain("Helpers record the sizes of their parts, not the texts.");
  });

  it("leaves the session window row and the credits out", () => {
    const html = popover(withHelper, "explore-1");
    expect(html).not.toContain("context-override");
    expect(html).not.toContain("context-credits");
  });

  it("shows tokens alone and no percentage line for a helper without a window", () => {
    const noWindow = {
      ...base,
      helpers: {
        "explore-1": {
          lastInputTokens: 12_300,
          context: snapshot({ thresholdSource: "fallback", contextWindow: undefined, threshold: 100_000 }),
          announcedWindow: null,
        },
      },
    };
    const html = popover(noWindow, "explore-1");
    expect(html).toContain('<p class="context-line tabular">12.3k</p>');
    expect(html).not.toMatch(/\(\d+%\)/);
    expect(html).toContain("window unknown");
  });

  it("says that no parts were recorded for a helper without a snapshot, and draws no model line without a model", () => {
    const html = popover(base, "worker-2");
    expect(html).toContain("No parts were recorded for worker-2 in this session.");
    expect(html).not.toContain("context-parts");
    expect(html).not.toContain("context-helper-model");
  });

  it("speaks German", () => {
    setLang("de");
    const html = popover(withHelper, "explore-1");
    expect(html).toContain("Zeigt: explore-1");
    expect(html).toContain("Modell minimax-m3:cloud");
    expect(html).toContain("Helfer zeichnen die Größen ihrer Teile auf, nicht die Texte.");
  });
});

describe("the row under the composer", () => {
  const meta = (state: typeof base, id: string | null): string => {
    const picker = pick(id, state);
    return renderToStaticMarkup(
      <ComposerMeta
        provider="ollama"
        model="qwen2.5:7b"
        status="open"
        onApplyProvider={() => {}}
        liveView
        lastInputTokens={state.lastInputTokens}
        aiCredits={null}
        context={state.context}
        onWindowOverride={() => {}}
        ring={{ picker, figures: figuresOf(state, picker.shown) }}
      />,
    );
  };

  it("draws the ring on the root's fill and shows the helper's figures in it", () => {
    const html = meta(withHelper, "explore-1");
    expect(html).toContain("context-wrap");
    expect(html).toContain("explore-1</span>");
    expect(html).toContain(">38%</span>");
  });

  it("draws no ring before the root's first usage, whatever is picked", () => {
    expect(meta({ ...withHelper, lastInputTokens: 0 }, "explore-1")).not.toContain("context-wrap");
  });
});
