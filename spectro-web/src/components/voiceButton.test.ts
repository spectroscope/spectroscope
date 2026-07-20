import { describe, expect, it } from "vitest";
import { formatTimer, micButtonState, STT_SETUP_HINT } from "./voiceButton";

// The DOM-bound parts (getUserMedia, MediaRecorder, the fetch to /api/transcribe)
// are exercised in the browser walkthrough; the pure button-state decisions and the
// timer label are pinned here — the same split as AttachmentPreview's formatSize.

describe("micButtonState", () => {
  it("idle: enabled and ready to record", () => {
    expect(micButtonState("idle", true, false)).toEqual({
      title: "Record a voice message",
      recording: false,
      disabled: false,
    });
  });

  it("recording: enabled (press stops it) and flagged recording", () => {
    const view = micButtonState("recording", true, false);
    expect(view.recording).toBe(true);
    expect(view.disabled).toBe(false);
  });

  it("transcribing: disabled while the POST is in flight — no second recording", () => {
    expect(micButtonState("transcribing", true, false).disabled).toBe(true);
  });

  it("unavailable: disabled with the setup hint as the tooltip, whatever the phase", () => {
    const view = micButtonState("idle", false, false);
    expect(view.disabled).toBe(true);
    expect(view.recording).toBe(false);
    expect(view.title).toBe(STT_SETUP_HINT);
    expect(view.title).toContain("scripts/setup-stt.sh");
  });

  it("disables the mic while a run is streaming (composer busy)", () => {
    expect(micButtonState("idle", true, true).disabled).toBe(true);
  });
});

describe("formatTimer", () => {
  it("renders mm:ss, zero-padding the seconds", () => {
    expect(formatTimer(0)).toBe("0:00");
    expect(formatTimer(3_200)).toBe("0:03");
    expect(formatTimer(59_000)).toBe("0:59");
    expect(formatTimer(72_000)).toBe("1:12");
  });

  it("never shows a negative timer", () => {
    expect(formatTimer(-500)).toBe("0:00");
  });
});
