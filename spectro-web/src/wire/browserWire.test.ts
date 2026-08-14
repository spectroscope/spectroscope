import { describe, expect, it } from "vitest";
import {
  browserStepSummary,
  hasScreenshot,
  readBrowserAction,
  replayEpochs,
  screenshotUrl,
  type BrowserActionMeta,
} from "./browserWire";

const row = (over: Partial<BrowserActionMeta> = {}): BrowserActionMeta => ({
  cid: "c-1",
  epoch: 1,
  agentId: "main",
  callId: "toolu_1",
  tool: "browser_navigate",
  operator: false,
  pageUrl: "https://example.com",
  ok: true,
  resultBytes: 84,
  durationMs: 412,
  blobPath: "",
  sha256: "",
  mediaType: "",
  width: 0,
  height: 0,
  ts: 1000,
  startedAt: 900,
  ...over,
});

describe("reading the ledger", () => {
  it("keeps a row that has the two things it cannot exist without", () => {
    const read = readBrowserAction({ cid: "c-9", ts: 5, tool: "browser_eval", epoch: 2 });
    expect(read?.cid).toBe("c-9");
    expect(read?.epoch).toBe(2);
    expect(read?.tool).toBe("browser_eval");
  });

  it("drops a row with no cid or no ts, because neither can be invented", () => {
    expect(readBrowserAction({ ts: 5 })).toBeNull();
    expect(readBrowserAction({ cid: "c-1" })).toBeNull();
    expect(readBrowserAction("nonsense")).toBeNull();
    expect(readBrowserAction(null)).toBeNull();
  });

  it("defaults a field it does not recognise rather than losing the row", () => {
    // An older or newer server degrades a cell, not a step of the replay.
    const read = readBrowserAction({ cid: "c-2", ts: 7 });
    expect(read?.tool).toBe("");
    expect(read?.ok).toBe(false);
    expect(read?.epoch).toBe(0);
  });

  it("reads who drove, and absent means agent — card 227's compatibility rule", () => {
    // Every sidecar written before card 227 carries no actor at all; those
    // files must read exactly as they always did, as the agent's own steps.
    expect(readBrowserAction({ cid: "c-3", ts: 8, actor: "operator" })?.operator).toBe(true);
    expect(readBrowserAction({ cid: "c-4", ts: 9 })?.operator).toBe(false);
    expect(readBrowserAction({ cid: "c-5", ts: 10, actor: null })?.operator).toBe(false);
  });
});

describe("the step summary", () => {
  it("names the tool, the page and how it went", () => {
    expect(browserStepSummary(row())).toBe("browser_navigate · example.com · 412 ms");
  });

  it("says when the OPERATOR drove — a replay must not hand a human's step to the model", () => {
    // Criterion 4's face half: the record distinguishes (actor field), and the
    // summary is where a reader would otherwise read every step as the agent's.
    expect(browserStepSummary(row({ operator: true, tool: "navigate" }))).toBe(
      "operator · navigate · example.com · 412 ms",
    );
    expect(browserStepSummary(row())).not.toContain("operator");
  });

  it("says failed when the call refused, because that is the run worth replaying", () => {
    expect(browserStepSummary(row({ ok: false }))).toContain("failed");
  });

  it("prints the whole string when the page url is not a url at all", () => {
    // A recorded page can be a redaction marker; half a guess would be a claim.
    expect(browserStepSummary(row({ pageUrl: "[redacted: github-pat]" }))).toContain(
      "[redacted: github-pat]",
    );
  });

  it("says so when no page was open rather than printing an empty cell", () => {
    expect(browserStepSummary(row({ pageUrl: "" }))).toContain("no page");
  });
});

describe("the screenshot reference", () => {
  it("is a picture only when a blob was actually recorded", () => {
    expect(hasScreenshot(row())).toBe(false);
    expect(hasScreenshot(row({ blobPath: "images/ab.png", sha256: "ab" }))).toBe(true);
  });

  it("loads from the image endpoint by FILE NAME, never by a path from the record", () => {
    // blobPath is text out of a file. Handing it to a URL whole would let a
    // recorded "../../etc/passwd" address the server; only the basename travels.
    expect(screenshotUrl(row({ blobPath: "images/ab12.png" }))).toBe("/api/images/ab12.png");
    expect(screenshotUrl(row({ blobPath: "../../secrets/key.pem" }))).toBe("/api/images/key.pem");
    expect(screenshotUrl(row({ blobPath: "" }))).toBeNull();
  });
});

describe("the epochs", () => {
  it("cuts the trace where one browser ended and the next began", () => {
    // Card 218: a session can outlive its browser. Two logins are two stories,
    // and a scrubber that ran straight through them would tell one.
    const epochs = replayEpochs([
      row({ cid: "a", epoch: 1, ts: 10 }),
      row({ cid: "b", epoch: 1, ts: 20 }),
      row({ cid: "c", epoch: 2, ts: 30 }),
    ]);
    expect(epochs).toHaveLength(2);
    expect(epochs[0].epoch).toBe(1);
    expect(epochs[0].steps.map((s) => s.cid)).toEqual(["a", "b"]);
    expect(epochs[1].steps.map((s) => s.cid)).toEqual(["c"]);
  });

  it("keeps one browser as one story", () => {
    const epochs = replayEpochs([row({ cid: "a" }), row({ cid: "b" })]);
    expect(epochs).toHaveLength(1);
    expect(epochs[0].steps).toHaveLength(2);
  });

  it("orders the steps by when they happened, not by when they were read", () => {
    const epochs = replayEpochs([row({ cid: "late", startedAt: 90 }), row({ cid: "early", startedAt: 10 })]);
    expect(epochs[0].steps.map((s) => s.cid)).toEqual(["early", "late"]);
  });

  it("has nothing to show for a session that never drove a browser", () => {
    expect(replayEpochs([])).toEqual([]);
  });
});
