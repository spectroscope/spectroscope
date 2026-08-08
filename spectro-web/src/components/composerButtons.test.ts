// Pins for the send/stop seat (card 78 #2+#3, regrouped composer 2026-08-09):
// the box has ONE button slot at its bottom right. Send holds it; while a run
// streams with nothing drafted, Stop takes the seat, and the moment the draft
// has text again the seat flips back to Send-as-Queue. The composer never
// locks during a run, and a clicked Stop disarms visibly until run_end.

import { describe, expect, it } from "vitest";
import { composerButtons } from "./composerButtons";

describe("composerButtons", () => {
  it("idle: send holds the seat, enabled with a draft", () => {
    const v = composerButtons({ running: false, stopping: false, draftEmpty: false });
    expect(v.seat).toBe("send");
    expect(v.sendLabel).toBe("Send");
    expect(v.sendDisabled).toBe(false);
  });

  it("idle: an empty draft disables send", () => {
    const v = composerButtons({ running: false, stopping: false, draftEmpty: true });
    expect(v.seat).toBe("send");
    expect(v.sendDisabled).toBe(true);
  });

  it("running with an empty draft: stop takes the seat, armed", () => {
    const v = composerButtons({ running: true, stopping: false, draftEmpty: true });
    expect(v.seat).toBe("stop");
    expect(v.stopDisabled).toBe(false);
    expect(v.stopLabel).toBe("Stop");
  });

  it("running with a draft: the seat flips back to send-as-queue — NOT disabled", () => {
    const v = composerButtons({ running: true, stopping: false, draftEmpty: false });
    expect(v.seat).toBe("send");
    expect(v.sendLabel).toBe("Queue");
    expect(v.sendDisabled).toBe(false);
  });

  it("stopping: the stop button keeps the seat, disarmed, and says so", () => {
    const v = composerButtons({ running: true, stopping: true, draftEmpty: true });
    expect(v.seat).toBe("stop");
    expect(v.stopDisabled).toBe(true);
    expect(v.stopLabel).toBe("Stopping …");
  });

  it("typing while stopping still flips the seat to queue", () => {
    const v = composerButtons({ running: true, stopping: true, draftEmpty: false });
    expect(v.seat).toBe("send");
    expect(v.sendLabel).toBe("Queue");
    expect(v.sendDisabled).toBe(false);
  });

  it("translates the labels", () => {
    const stop = composerButtons({ running: true, stopping: false, draftEmpty: true }, "de");
    expect(stop.stopLabel).toBe("Stopp");
    const queue = composerButtons({ running: true, stopping: false, draftEmpty: false }, "de");
    expect(queue.sendLabel).toBe("Einreihen");
  });
});
