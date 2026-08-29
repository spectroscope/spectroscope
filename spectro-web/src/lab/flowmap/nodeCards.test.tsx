// Markup pins for the extracted agent body and the full worker card
// (card 287). Rendered with react-dom/server like the panel tests — no DOM in
// this gate — with the canvas package's Handle stubbed out (it needs the
// canvas store, and these pins are about OUR markup, not the handles).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpandAllContext } from "./expandContext";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { AgentCardBody, OsNode, SubagentNode, type AgentData } from "./nodes";

const agentData: AgentData = {
  active: true,
  error: false,
  focus: "cmd",
  activity: { text: "$ ls -la", color: "var(--sand)" },
  gate: "none",
  gateNote: "ready",
  gateColor: "var(--border-strong)",
  activeTool: "run_command",
  ctxParts: null,
  ctxTotals: null,
  prompt: "go",
  systemPrompt: null,
  tool: { name: "run_command", input: { command: "ls -la" } },
  genImage: null,
  attached: null,
};

const Sub = SubagentNode as unknown as (p: { data: unknown }) => ReturnType<typeof AgentCardBody>;

const workerData = {
  id: "toolu_opaque99",
  label: "app-scout",
  task: "Scout Flink checkout",
  state: "working",
  stateLabel: "working",
  stateColor: "var(--warn)",
  lastStatus: "checking the shop",
  activity: { text: "$ curl …", color: "var(--sand)" },
  focus: "cmd",
  active: true,
  think: "",
  full: {
    error: false,
    gate: "none",
    gateNote: "ready",
    gateColor: "var(--border-strong)",
    activeTool: "run_command",
    tool: { name: "run_command", input: { command: "curl x" } },
    genImage: null,
    attached: null,
    brief: "Repo root: /tmp/demo. Scout the checkout.",
    model: "claude-sonnet-5",
    spend: { peak: 66041, turns: 17 },
  },
};

describe("AgentCardBody (the extracted instrument)", () => {
  it("carries the belt, the loop row and the gate row", () => {
    const m = renderToStaticMarkup(<AgentCardBody data={agentData} />);
    expect(m).toContain("Tools");
    expect(m).toContain("pf-chip");
    expect(m).toContain("Loop");
    expect(m).toContain("ready");
    expect(m).toContain("$ ls -la");
  });

  it("renders the wide two-column form under an expanded shell", () => {
    const m = renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <AgentCardBody data={agentData} />
      </ExpandAllContext.Provider>,
    );
    expect(m).toContain("pf-agent__cols");
  });
});

describe("the full worker card (card 287)", () => {
  const markup = renderToStaticMarkup(
    <ExpandAllContext.Provider value={true}>
      <Sub data={workerData} />
    </ExpandAllContext.Provider>,
  );

  it("is the agent's own instrument wrapped in worker chrome", () => {
    expect(markup).toContain("pf-sub--full");
    expect(markup).toContain("pf-agent__cols"); // the body came along, wide
    expect(markup).toContain("Scout Flink checkout");
    expect(markup).toContain("app-scout"); // the kind badge — the wire named one
    expect(markup).toContain("66,041"); // peak, grouped for the UI language
    expect(markup).toContain("17 turns");
  });

  it("says one turn, not one turns", () => {
    const m = renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <Sub data={{ ...workerData, full: { ...workerData.full, spend: { peak: 900, turns: 1 } } }} />
      </ExpandAllContext.Provider>,
    );
    expect(m).toContain("1 turn");
    expect(m).not.toContain("1 turns");
    expect(markup).toContain("claude-sonnet-5");
    expect(markup).toContain("checking the shop");
  });

  it("keeps the opaque id out of the visible text — title attribute only", () => {
    expect(markup).toContain('title="toolu_opaque99"');
    const withoutTitles = markup.replace(/title="[^"]*"/g, "");
    expect(withoutTitles).not.toContain("toolu_opaque99");
  });

  // Card 296 re-review. The card 296 head cap (max-height 50px, overflow
  // hidden) is what makes the seat a BOUND — measured here, dropping it and
  // paying the 15 world px back moves the reserve to 495, and at 495 rowsFor
  // sends three seats back to 2 rows and twelve back to 3, which is the
  // owner's own complaint returning. So the cap stays and the clipped text
  // has to be recoverable somewhere: the head's title carries the opaque
  // agent id (pinned above), so the NAME needs its own.
  it("a clipped task name is still readable — the name carries its own title", () => {
    const long =
      "Scout the Flink checkout end to end, then write down every place the " +
      "session id is read back out of local storage instead of the wire";
    const m = renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <Sub data={{ ...workerData, task: long }} />
      </ExpandAllContext.Provider>,
    );
    expect(m).toContain(`<span class="pf-sub__id" title="${long}">`);
  });

  // The title follows what is VISIBLE, not the task field: a worker the wire
  // gave no task shows its kind, and hovering must not offer an empty tooltip.
  it("the name's title is whatever the card actually shows", () => {
    const m = renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <Sub data={{ ...workerData, task: "" }} />
      </ExpandAllContext.Provider>,
    );
    expect(m).toContain('<span class="pf-sub__id" title="app-scout">');
  });

  it("a worker the wire gave no kind renders no kind badge", () => {
    const m = renderToStaticMarkup(
      <ExpandAllContext.Provider value={true}>
        <Sub data={{ ...workerData, label: null }} />
      </ExpandAllContext.Provider>,
    );
    expect(m).not.toContain("app-scout");
  });

  it("compact stays the small card — no full chrome without the data", () => {
    const m = renderToStaticMarkup(<Sub data={{ ...workerData, full: undefined }} />);
    expect(m).not.toContain("pf-sub--full");
    expect(m).toContain("pf-sub__task");
  });
});

// ---- card 295: the station says WHO is on it, and looks busy while they are.
const Os = OsNode as unknown as (p: { data: unknown }) => ReturnType<typeof AgentCardBody>;
const osMarkup = (data: Record<string, unknown>) => renderToStaticMarkup(<Os data={data} />);

describe("OsNode occupancy (card 295)", () => {
  it("an idle station is neither busy nor tinted", () => {
    const m = osMarkup({ kind: "shell", active: false, command: null, by: [], byTag: null });
    expect(m).not.toContain("pf-os--busy");
    expect(m).not.toContain("pf-os--worker");
  });

  it("main at the station: busy, but no worker tint", () => {
    const m = osMarkup({
      kind: "shell",
      active: true,
      command: "ls",
      by: [{ tag: "main", name: "main", agentId: "main" }],
      byTag: "main",
    });
    expect(m).toContain("pf-os--busy");
    expect(m).not.toContain("pf-os--worker");
  });

  it("a worker at the station wears the worker accent", () => {
    const m = osMarkup({
      kind: "disk",
      active: true,
      disk: "write",
      file: "a.md",
      by: [{ tag: "w2", name: "Scout the checkout", agentId: "toolu_x" }],
      byTag: "w2",
    });
    expect(m).toContain("pf-os--busy");
    expect(m).toContain("pf-os--worker");
    expect(m).toContain("w2");
  });

  it("a demoted occupant is NAMED, not silently reduced to a tag", () => {
    const m = osMarkup({
      kind: "disk",
      active: true,
      disk: "read",
      file: "a.md",
      by: [
        { tag: "main", name: "main", agentId: "main" },
        { tag: "w3", name: "Scout the checkout", agentId: "toolu_y" },
      ],
      byTag: "main",
    });
    expect(m).toContain(">w3 · Scout the checkout</span>"); // the visible chip, not just the title
    expect(m).not.toContain("toolu_y"); // an opaque id is never a visible name
  });

  it("a crowded station names two extras and COUNTS the rest — never silently drops one", () => {
    const by = ["main", "w1", "w2", "w3", "w4", "w5"].map((tag, i) => ({
      tag,
      name: tag === "main" ? "main" : `worker ${i}`,
      agentId: `id-${i}`,
    }));
    const m = osMarkup({ kind: "disk", active: true, disk: "read", file: "a.md", by, byTag: "main" });
    expect(m).toContain(">w1 · worker 1</span>");
    expect(m).toContain(">w2 · worker 2</span>");
    expect(m).toContain("+3"); // three more, counted rather than dropped
    // and the full roster is still reachable, on the row's own title
    expect(m).toContain("w5 · worker 5");
  });
});
