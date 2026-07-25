// Pins for the send/stop cluster (card 78 #2+#3): the composer never locks
// during a run — Send flips to Queue, Stop appears, and a clicked Stop
// disarms visibly until the run actually ends.

import { describe, expect, it } from "vitest";
import { composerButtons } from "./composerButtons";

describe("composerButtons", () => {
  it("idle: send only, enabled with a draft", () => {
    const v = composerButtons({ running: false, stopping: false, draftEmpty: false });
    expect(v.showStop).toBe(false);
    expect(v.sendLabel).toBe("Send");
    expect(v.sendDisabled).toBe(false);
  });

  it("idle: an empty draft disables send", () => {
    expect(composerButtons({ running: false, stopping: false, draftEmpty: true }).sendDisabled).toBe(true);
  });

  it("running: stop appears and send becomes queue — NOT disabled", () => {
    const v = composerButtons({ running: true, stopping: false, draftEmpty: false });
    expect(v.showStop).toBe(true);
    expect(v.stopDisabled).toBe(false);
    expect(v.stopLabel).toBe("Stop");
    expect(v.sendLabel).toBe("Queue");
    expect(v.sendDisabled).toBe(false);
  });

  it("stopping: the stop button disarms and says so", () => {
    const v = composerButtons({ running: true, stopping: true, draftEmpty: true });
    expect(v.stopDisabled).toBe(true);
    expect(v.stopLabel).toBe("Stopping …");
  });

  it("translates the labels", () => {
    const v = composerButtons({ running: true, stopping: false, draftEmpty: false }, "de");
    expect(v.stopLabel).toBe("Stopp");
    expect(v.sendLabel).toBe("Einreihen");
  });
});
