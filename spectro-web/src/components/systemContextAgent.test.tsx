// Card 593: the System context panel names its agent before the server has answered, and a helper's model line is its own.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "../state/reducer";
import { shownAgentOf } from "../state/shownAgent";
import { modelLineOf, SystemContextTab } from "./SystemContextTab";
import { read, stripComments } from "../testkit/source";

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
  row("worker-2", "main"),
];
const state = { rootAgentId: "main", agents };

describe("the System context panel", () => {
  it("heads the tab with the picker while the context is still loading", () => {
    const shown = shownAgentOf(state, "explore-1");
    const html = renderToStaticMarkup(
      <SystemContextTab
        selected={shown.row}
        shown={shown}
        agents={agents}
        onPickAgent={() => {}}
        thinking={false}
      />,
    );
    expect(html.indexOf("Showing: explore-1")).toBeGreaterThan(-1);
    expect(html.indexOf("agent-pick")).toBeLessThan(html.indexOf("ctx-empty"));
  });

  it("reads a helper's own model when it has one, else the session's model as before", () => {
    expect(modelLineOf(agents[1], "qwen2.5:7b", "boot-model")).toBe("minimax-m3:cloud");
    expect(modelLineOf(agents[2], "qwen2.5:7b", "boot-model")).toBe("qwen2.5:7b");
    expect(modelLineOf(agents[0], "qwen2.5:7b", "boot-model")).toBe("qwen2.5:7b");
    expect(modelLineOf(null, undefined, "boot-model")).toBe("boot-model");
  });

  it("heads the loaded tab with the picker too, before its lead (read off disk: the loaded state needs the fetch)", () => {
    const tab = stripComments(read("./SystemContextTab.tsx", import.meta.url));
    expect(tab).toMatch(/<div className="ctx">\s*\{picker\}\s*<div className="ctx-head">/);
    expect(tab.split("{picker}").length - 1).toBe(3);
  });
});
