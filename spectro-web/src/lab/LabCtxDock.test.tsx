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
import { DOCK_TAB_STORAGE_KEY } from "./labDockTabs";
import { __resetForTests as resetStepper, pushLive, seek } from "../state/stepper";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";
import type { RunEvent } from "../events";

const lang = currentLang();

/** A Map-backed localStorage double — the gate has no browser storage. */
let store: Map<string, string>;
beforeEach(() => {
  __resetForTests();
  resetStepper();
  store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const render = (props: Partial<Parameters<typeof LabView>[0]> = {}): string =>
  renderToStaticMarkup(
    <LabView
      replay={null}
      liveEvents={[]}
      running={false}
      onSend={() => {}}
      onDecide={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
      {...props}
    />,
  );

/** react-dom/server escapes an apostrophe to `&#x27;`, and the dock's own
 *  sentences are full of them ("the run's own spawn tree"), so markup is
 *  decoded before it is compared against the dictionary the words come from. */
const plain = (html: string): string =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** Put events into the stepper's APPLIED prefix — what the dock reads. */
const applied = (events: RunEvent[]): void => {
  pushLive(events);
  seek(events.length);
};

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

// No model argument: the panel reads the recorded events and nothing else.
const panel = (applied: RunEvent[]): string => renderToStaticMarkup(<ContextPeak applied={applied} />);

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

  it("a fallen-back threshold is named as one, and the percentage is the ring's", () => {
    // The shape every Anthropic run has. The panel used to print 8 % of a
    // published 1,000,000 here while the header ring printed 77 % of the same
    // spend, and justified the million with a table that has been wrong before.
    const html = panel([rootStart("claude-opus-4-6"), ctxInfo(100_000, "fallback"), usage("main", 76_608)]);
    expect(html).toContain(t(lang, "lab.ctx.note.fellBack", { limit: "100k" }));
    expect(html).toContain(t(lang, "lab.ctx.share", { peak: "76.6k", limit: "100k", pct: 77 }));
    expect(html).not.toContain(t(lang, "lab.ctx.note.measured", { limit: "100k" }));
    expect(html).not.toContain(
      t(lang, "lab.ctx.note.published", { limit: "1.0M", model: "claude-opus-4-6" }),
    );
  });

  it("and it never claims the run reported nothing, whatever the model is", () => {
    // The old wording for this case read "The run reported no threshold and no
    // limit is on file for this model." The run reported one: 100,000.
    const html = panel([rootStart("some-local-build"), ctxInfo(100_000, "fallback"), usage("main", 25_000)]);
    expect(html).toContain(t(lang, "lab.ctx.note.fellBack", { limit: "100k" }));
    expect(html).not.toContain(t(lang, "lab.ctx.note.unknown", { limit: "100k" }));
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

// ---------------------------------------------------------------------------
// Card 301: the DOCK'S WIRING inside LabView. Everything below was mutable
// while the whole suite stayed green — three props could be replaced with a
// constant or dropped entirely and nothing went red, including the very label
// the previous round's note claimed to have pinned.
// ---------------------------------------------------------------------------

const dockStart = (agentId: string, ts: number): RunEvent =>
  ({ type: "run_start", runId: `r-${agentId}`, agentId, prompt: "go", ts }) as RunEvent;
const dockSpawn = (agentId: string, task: string, ts: number): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task, ts }) as RunEvent;
const dockTask = (to: string, text: string, ts: number): RunEvent =>
  ({ type: "agent_message", from: "main", to, role: "task", state: "submitted", text, ts }) as RunEvent;

const handover: RunEvent[] = [
  dockStart("main", 0),
  dockSpawn("kid", "scout the checkout", 10),
  dockTask("kid", "scout the checkout", 11),
];

describe("the collapsed rail names the panel the dock would OPEN", () => {
  it("says 'handovers' while the handovers tab is the stored choice", () => {
    store.set(DOCK_TAB_STORAGE_KEY, "msg");
    const html = render();
    expect(html).toContain(t(lang, "rz.ariaExpand", { label: t(lang, "lab.msg.title") }));
    expect(html).not.toContain(t(lang, "rz.ariaExpand", { label: t(lang, "lab.ctx.title") }));
  });

  it("says 'files' while the files tab is the stored choice", () => {
    store.set(DOCK_TAB_STORAGE_KEY, "files");
    expect(render()).toContain(t(lang, "rz.ariaExpand", { label: t(lang, "lab.files.title") }));
  });
});

describe("the open dock shows the tab the lab is actually on", () => {
  it("opens on the stored handovers tab, not on the panel it shipped with", () => {
    store.set(DOCK_TAB_STORAGE_KEY, "msg");
    toggleCtx();
    const html = plain(render());
    expect(html).toContain(t(lang, "lab.msg.hint"));
    expect(html).not.toContain(t(lang, "lab.ctx.hint"));
  });

  it("opens on the stored files tab", () => {
    store.set(DOCK_TAB_STORAGE_KEY, "files");
    toggleCtx();
    const html = plain(render());
    expect(html).toContain(t(lang, "lab.files.hint"));
    expect(html).not.toContain(t(lang, "lab.ctx.hint"));
  });
});

describe("the trace seam reaches the dock's rows", () => {
  // The card asked for exactly this and said where it lives: "WIRE THE
  // EVIDENCE … The seam already exists — use it." Dropping the prop here was
  // invisible to every other suite, because none of them hands one in.
  it("leaves the handover rows live when App's focus seam was handed in", () => {
    store.set(DOCK_TAB_STORAGE_KEY, "msg");
    toggleCtx();
    applied(handover);
    const html = render({ onFocusEvent: () => {} });
    const row = html.match(/<button[^>]*class="lab-msg-open"[^>]*>/);
    expect(row, "a handover row").not.toBeNull();
    expect((row as RegExpMatchArray)[0]).not.toContain("disabled");
    expect(html).toContain(t(lang, "lab.msg.open"));
  });

  it("leaves them inert when there is no seam to reach", () => {
    store.set(DOCK_TAB_STORAGE_KEY, "msg");
    toggleCtx();
    applied(handover);
    const html = render();
    const row = html.match(/<button[^>]*class="lab-msg-open"[^>]*>/);
    expect(row, "a handover row").not.toBeNull();
    expect((row as RegExpMatchArray)[0]).toContain('disabled=""');
  });
});
