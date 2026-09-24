// Criterion 3, second half: a profile where localStorage throws, a private
// window or blocked site data, must still load this module and read normal.
// The reader runs at module load, so the stub has to be in place BEFORE the
// import, and the import has to be dynamic. Own file, because it resets the
// module registry.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("answerLine with no usable localStorage", () => {
  it("loads and reads normal instead of throwing", async () => {
    const boom = (): never => {
      throw new Error("site data blocked");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
    vi.resetModules();
    const mod = await import("./answerLine");
    expect(mod.currentAnswerLine()).toBe("normal");
    // The positive twin: the module is alive, not merely silent.
    expect(mod.ANSWER_LINE_MODES).toEqual(["normal", "extended"]);
  });
});
