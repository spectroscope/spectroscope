import { describe, expect, it } from "vitest";
import type { BrowserActionMeta } from "../wire/browserWire";
import { clampStep, lastShotBefore, replayStage } from "./replayModel";

const step = (over: Partial<BrowserActionMeta> = {}): BrowserActionMeta => ({
  cid: "c",
  epoch: 1,
  agentId: "main",
  callId: "t",
  tool: "browser_eval",
  operator: false,
  pageUrl: "https://example.com",
  ok: true,
  resultBytes: 4,
  durationMs: 10,
  blobPath: "",
  sha256: "",
  mediaType: "",
  width: 0,
  height: 0,
  ts: 100,
  startedAt: 90,
  ...over,
});

describe("the scrubber position", () => {
  it("never leaves the steps it has", () => {
    expect(clampStep(5, 3)).toBe(2);
    expect(clampStep(-1, 3)).toBe(0);
    expect(clampStep(1, 3)).toBe(1);
  });

  it("is 0 for a trace with no steps, so a caller needs no second branch", () => {
    expect(clampStep(4, 0)).toBe(0);
  });
});

describe("what the stage shows at a step", () => {
  const shot = (cid: string, sha: string): BrowserActionMeta =>
    step({ cid, tool: "browser_computer", blobPath: `images/${sha}.png`, sha256: sha });

  it("shows this step's own picture when it took one", () => {
    const steps = [shot("a", "aa"), shot("b", "bb")];
    expect(replayStage(steps, 1)?.sha256).toBe("bb");
  });

  it("holds the last picture while later steps take none", () => {
    // A run is one navigate, one screenshot, then twelve evals — the measured
    // shape (card 201: eval is 41 % of all calls). A scrubber that blanked the
    // stage on every eval would show a black screen for most of the run, which
    // is the opposite of watching it back.
    const steps = [shot("a", "aa"), step({ cid: "b" }), step({ cid: "c" })];
    expect(replayStage(steps, 2)?.sha256).toBe("aa");
    expect(lastShotBefore(steps, 2)?.cid).toBe("a");
  });

  it("shows nothing before the first picture rather than borrowing a later one", () => {
    // Showing step 3's screenshot at step 0 would be a claim about what the page
    // looked like at a moment nobody photographed.
    const steps = [step({ cid: "a" }), shot("b", "bb")];
    expect(replayStage(steps, 0)).toBeNull();
    expect(replayStage(steps, 1)?.sha256).toBe("bb");
  });

  it("has nothing to show for an empty trace", () => {
    expect(replayStage([], 0)).toBeNull();
    expect(lastShotBefore([], 0)).toBeNull();
  });
});
