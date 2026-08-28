// The agents surface carries the run-analysis affordance (card 294) — for an
// imported run the panel is handed the AnalyzeRun node and renders it above
// the roster; the live view hands nothing and reads exactly as before.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentsTab } from "./AgentsTab";
import type { AgentInfo } from "../state/reducer";

const oneAgent: AgentInfo[] = [
  {
    id: "main",
    parentId: null,
    label: null,
    task: "",
    state: "completed",
    lastStatus: null,
    inTokens: 1,
    outTokens: 1,
  },
];

describe("AgentsTab — the analyze slot", () => {
  it("renders the analyze node above the roster", () => {
    const html = renderToStaticMarkup(
      <AgentsTab
        agents={oneAgent}
        selectedId={null}
        onSelect={() => {}}
        analyze={<div data-pin="analyze-affordance" />}
      />,
    );
    expect(html).toContain("analyze-affordance");
    expect(html.indexOf("analyze-affordance")).toBeLessThan(html.indexOf("agents-list"));
  });

  it("renders it even when the roster is empty", () => {
    const html = renderToStaticMarkup(
      <AgentsTab
        agents={[]}
        selectedId={null}
        onSelect={() => {}}
        analyze={<div data-pin="analyze-affordance" />}
      />,
    );
    expect(html).toContain("analyze-affordance");
  });

  it("renders no slot when none is handed (the live view)", () => {
    const html = renderToStaticMarkup(<AgentsTab agents={oneAgent} selectedId={null} onSelect={() => {}} />);
    expect(html).not.toContain("analyze-affordance");
  });
});
