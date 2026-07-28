import { describe, it, expect } from "vitest";
import { progressPct, formatGB, fitKey, builtInLabel, localModelLede, type CatalogModel } from "./localModel";

describe("progressPct", () => {
  it("is 0 before anything and 100 at the end", () => {
    expect(progressPct(0, 100)).toBe(0);
    expect(progressPct(100, 100)).toBe(100);
  });
  it("rounds mid-download and clamps overshoot", () => {
    expect(progressPct(33, 100)).toBe(33);
    expect(progressPct(150, 100)).toBe(100);
  });
  it("is 0 when the total is unknown", () => {
    expect(progressPct(50, 0)).toBe(0);
  });
});

describe("formatGB", () => {
  it("renders catalogue byte sizes as one-decimal GB", () => {
    expect(formatGB(1_929_903_232)).toBe("1.9 GB");
    expect(formatGB(4_683_073_536)).toBe("4.7 GB");
  });
});

function row(preflight: Partial<CatalogModel["preflight"]>): CatalogModel {
  return {
    id: "x",
    label: "X",
    sizeBytes: 1,
    minRamBytes: 1,
    contextTokens: 1,
    nativeTools: true,
    reasoning: false,
    licence: "apache-2.0",
    licenceUrl: "u",
    sourceUrl: "s",
    state: "absent",
    bytes: 0,
    preflight: { ok: true, tight: false, known: true, ramOk: true, diskOk: true, ...preflight },
  };
}

describe("fitKey", () => {
  it("an unknown machine says so before claiming anything", () => {
    expect(fitKey(row({ known: false, ramOk: false }))).toBe("lm.fit.unknown");
  });
  it("disk beats memory in the report, because it blocks the download itself", () => {
    expect(fitKey(row({ diskOk: false, ramOk: false }))).toBe("lm.fit.disk");
  });
  it("too little memory is named", () => {
    expect(fitKey(row({ ramOk: false }))).toBe("lm.fit.ram");
  });
  it("a tight fit warns without blocking", () => {
    expect(fitKey(row({ tight: true }))).toBe("lm.fit.tight");
  });
  it("a roomy machine gets the plain ok", () => {
    expect(fitKey(row({}))).toBe("lm.fit.ok");
  });
});

describe("localModelLede", () => {
  // Card 107 (V11): the old sheet claimed "Nothing you type leaves your
  // computer" — false the moment a run uses the tool belt (run_command and
  // friends reach the network when a run is allowed to). The MODEL being local
  // is the honest claim; total network silence is not.
  it("claims the model is local, never total network silence", () => {
    for (const lang of ["en", "de"] as const) {
      const lede = localModelLede(lang, "Qwen3 4B");
      expect(lede).toContain("Qwen3 4B");
      expect(lede.toLowerCase()).not.toContain("nothing you type leaves");
      expect(lede.toLowerCase()).not.toContain("nichts, was du tippst");
    }
  });
  it("says prompts stay local AND that tools can still reach the network", () => {
    expect(localModelLede("en", "X")).toMatch(/prompts .*never leave/i);
    expect(localModelLede("en", "X")).toMatch(/tools .*can still reach the network/i);
    expect(localModelLede("de", "X")).toMatch(/Prompts .*verlassen .*nicht/i);
    expect(localModelLede("de", "X")).toMatch(/Tools .*können .*ins Netz/i);
  });
});

describe("builtInLabel", () => {
  const labels = { "qwen3-4b": "Qwen3 4B", "vibethinker-3b": "VibeThinker 3B" };
  it("names the selected model when the catalogue knows it", () => {
    expect(builtInLabel("qwen3-4b", labels)).toBe("built-in · Qwen3 4B");
  });
  it("never shows a wrong hardcoded name for an unknown or missing model", () => {
    expect(builtInLabel("retired-model", labels)).toBe("built-in");
    expect(builtInLabel(undefined, labels)).toBe("built-in");
  });
});
