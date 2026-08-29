// Card 300: the dock's WIRING — that a collapsed dock costs nothing, that
// opening it mounts the panel, and that the panel prints the honest words.
//
// Rendered with react-dom/server like the lab's other view suites: no DOM in
// this gate, the canvas package stubbed, localStorage faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div data-mock="reactflow">{children}</div>,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
  useNodesState: () => [[], () => {}, () => {}],
  useEdgesState: () => [[], () => {}, () => {}],
  getSmoothStepPath: () => ["M0,0 L1,1", 0, 0],
}));

import { LabView } from "./LabView";
import { ContextPeak } from "./ContextPeak";
import { __resetForTests, toggleCtx } from "../state/layout";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";
import type { RunEvent } from "../events";

const lang = currentLang();

beforeEach(() => {
  __resetForTests();
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
});
afterEach(() => vi.unstubAllGlobals());

const render = (): string =>
  renderToStaticMarkup(
    <LabView
      replay={null}
      liveEvents={[]}
      running={false}
      onSend={() => {}}
      onDecide={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
    />,
  );

describe("the dock is collapsed until it is asked for", () => {
  it("a fresh lab renders the rail and NOT the panel", () => {
    const html = render();
    expect(html).not.toContain('class="lab-ctx"');
    // the rail is there, so the dock can be opened at all
    expect(html).toContain(t(lang, "rz.ariaExpand", { label: t(lang, "lab.ctx.title") }));
  });

  it("opening it mounts the panel", () => {
    toggleCtx();
    const html = render();
    expect(html).toContain('class="lab-ctx"');
    expect(html).toContain(`aria-label="${t(lang, "lab.ctx.aria")}"`);
  });

  it("the row carries the dock's width as a custom property", () => {
    toggleCtx();
    expect(render()).toContain("--lab-ctx-w:320px");
  });
});

// ---------------------------------------------------------------------------
// The panel's own words. Rendered directly — the join is pinned separately in
// contextPeak.test.ts, so these check only that the right sentence is shown.
// ---------------------------------------------------------------------------

const panel = (applied: RunEvent[], model?: string): string =>
  renderToStaticMarkup(<ContextPeak applied={applied} {...(model === undefined ? {} : { model })} />);

const rootStart = (model?: string): RunEvent =>
  ({
    type: "run_start",
    runId: "r",
    agentId: "main",
    prompt: "go",
    ...(model === undefined ? {} : { model }),
    ts: 1,
  }) as RunEvent;
const usage = (agentId: string, input: number): RunEvent =>
  ({ type: "usage", agentId, inputTokens: input, outputTokens: 1, ts: 3 }) as RunEvent;
const spawn = (agentId: string, task: string): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task, ts: 2 }) as RunEvent;
const ctxInfo = (threshold: number, source?: string): RunEvent =>
  ({
    type: "context_info",
    agentId: "main",
    turn: 1,
    messages: 2,
    estimatedTokens: 10,
    threshold,
    parts: [],
    ts: 4,
    ...(source === undefined ? {} : { thresholdSource: source }),
  }) as RunEvent;

describe("the panel says what its divisor is", () => {
  it("an empty run says so and raises no note about a divisor", () => {
    const html = panel([]);
    expect(html).toContain(t(lang, "lab.ctx.empty"));
    expect(html).not.toContain(t(lang, "lab.ctx.note.measured", { limit: "" }).slice(0, 12));
  });

  it("a measured threshold is named as the run's own", () => {
    const html = panel([rootStart("claude-opus-4-6"), ctxInfo(153_216, "window"), usage("main", 76_608)]);
    expect(html).toContain(t(lang, "lab.ctx.note.measured", { limit: "153k" }));
    expect(html).toContain(t(lang, "lab.ctx.share", { peak: "76.6k", limit: "153k", pct: 50 }));
  });

  it("a published limit says out loud that it is not a measurement", () => {
    const html = panel([rootStart("gpt-4o"), usage("main", 64_000)]);
    expect(html).toContain(t(lang, "lab.ctx.note.published", { limit: "128k", model: "gpt-4o" }));
    expect(html).not.toContain(t(lang, "lab.ctx.note.measured", { limit: "128k" }));
  });

  it("a stand-in divisor says it is a stand-in", () => {
    const html = panel([rootStart("some-local-build"), usage("main", 25_000)]);
    expect(html).toContain(t(lang, "lab.ctx.note.unknown", { limit: "100k" }));
  });
});

describe("HONESTY — a child is printed without a percentage, and the panel says why", () => {
  it("the child's line carries no percent sign and the reason is on the panel", () => {
    const html = panel([
      rootStart("claude-opus-4-6"),
      ctxInfo(153_216, "window"),
      spawn("kid", "read the docs"),
      usage("main", 76_608),
      usage("kid", 30_000),
    ]);
    expect(html).toContain(t(lang, "lab.ctx.shareNoLimit", { peak: "30.0k" }));
    expect(html).toContain(t(lang, "lab.ctx.note.childrenNoWindow"));
    // the child's name comes from the directory, never the opaque id
    expect(html).toContain("read the docs");
    expect(html).not.toContain(">kid<");
  });

  it("a run with no children never prints that line", () => {
    const html = panel([rootStart("gpt-4o"), usage("main", 1_000)]);
    expect(html).not.toContain(t(lang, "lab.ctx.note.childrenNoWindow"));
  });
});
