// Card 304 — the Spectrum half: the bus card's cloud mark follows the FOCUS
// alone. The bus used to spare the mark for a "local" provider; ollama serves
// cloud models too, so that distinction stated nothing true and is gone.
//
// This pins the fold, not the pixels: osChipState is the one place FleetBus
// decides what the four inline OS chips say.
import { describe, expect, it } from "vitest";
import { osChipState } from "./FleetBus";
import type { FleetLabNode } from "../lab/fleetLabScene";

function card(over: Partial<FleetLabNode> = {}): FleetLabNode {
  return {
    id: "a1",
    role: "worker",
    task: "",
    state: "working",
    lastStatus: null,
    connected: true,
    provider: null,
    trigger: null,
    focus: "agent",
    disk: "idle",
    gate: "none",
    activeTool: null,
    activeFile: null,
    activeCommand: null,
    activeMcp: null,
    gateFrom: null,
    isError: false,
    ...over,
  };
}

describe("osChipState — the llm chip", () => {
  it("marks an ollama card at the model as remote (the locality bit is gone)", () => {
    const os = osChipState(card({ focus: "llm", provider: "ollama" }));
    expect(os.llm).toBe("ollama");
    expect(os.llmRemote).toBe(true);
  });

  it("marks a localhost-shaped provider at the model as remote too", () => {
    expect(osChipState(card({ focus: "llm", provider: "lmstudio" })).llmRemote).toBe(true);
    expect(osChipState(card({ focus: "llm", provider: "local" })).llmRemote).toBe(true);
  });

  it("gives an ollama card the SAME chips as an anthropic one at the same focus", () => {
    const ollama = osChipState(card({ focus: "llm", provider: "ollama" }));
    const anthropic = osChipState(card({ focus: "llm", provider: "anthropic" }));
    expect(ollama.llmRemote).toBe(anthropic.llmRemote);
    expect({ ...ollama, llm: null }).toEqual({ ...anthropic, llm: null });
  });

  it("carries no llm chip and no cloud mark while the packet is elsewhere", () => {
    const os = osChipState(card({ focus: "agent", provider: "anthropic" }));
    expect(os.llm).toBeNull();
    expect(os.llmRemote).toBe(false);
  });

  it("falls back to the bare label when the model focus has no provider yet", () => {
    const os = osChipState(card({ focus: "llm", provider: null }));
    expect(os.llm).toBe("llm");
    expect(os.llmRemote).toBe(true);
  });
});

describe("osChipState — the other three chips are untouched by card 304", () => {
  it("shows the touched file while the disk works, and nothing while it idles", () => {
    expect(osChipState(card({ disk: "write", activeFile: "labScene.ts" })).disk).toBe("labScene.ts");
    expect(osChipState(card({ disk: "write" })).disk).toBe("write");
    expect(osChipState(card({ disk: "idle", activeFile: "labScene.ts" })).disk).toBeNull();
  });

  it("passes the shell command and the mcp call straight through", () => {
    const os = osChipState(card({ activeCommand: "npm test", activeMcp: "board · list" }));
    expect(os.shell).toBe("npm test");
    expect(os.mcp).toBe("board · list");
  });
});
