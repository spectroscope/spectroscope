import { describe, expect, it } from "vitest";
import { formatTimer, micButtonState, speechModelLoads, STT_SETUP_HINT } from "./voiceButton";

// The DOM-bound parts (getUserMedia, MediaRecorder, the fetch to /api/transcribe)
// are exercised in the browser walkthrough; the pure button-state decisions and the
// timer label are pinned here — the same split as AttachmentPreview's formatSize.

describe("micButtonState", () => {
  it("idle: enabled and ready to record", () => {
    expect(micButtonState("idle", true)).toEqual({
      title: "Record a voice message",
      recording: false,
      disabled: false,
      glyph: "outline",
    });
  });

  it("recording: enabled (press stops it) and flagged recording", () => {
    const view = micButtonState("recording", true);
    expect(view.recording).toBe(true);
    expect(view.disabled).toBe(false);
  });

  it("transcribing: disabled while the POST is in flight — no second recording", () => {
    expect(micButtonState("transcribing", true).disabled).toBe(true);
  });

  it("unavailable: disabled with the setup hint as the tooltip, whatever the phase", () => {
    const view = micButtonState("idle", false);
    expect(view.disabled).toBe(true);
    expect(view.recording).toBe(false);
    expect(view.title).toBe(STT_SETUP_HINT);
    expect(view.title).toContain("scripts/setup-stt.sh");
  });

  it("stays enabled while a run streams — the transcript lands in the draft (card 78)", () => {
    expect(micButtonState("idle", true).disabled).toBe(false);
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

describe("the finishing phase (card 527)", () => {
  it("finishing: the mic button says it is finishing and cannot start a second take", () => {
    const view = micButtonState("finishing", true);
    expect(view.title).toBe("Finishing the recording and sending ...");
    expect(view.disabled).toBe(true);
    expect(view.recording).toBe(false);
  });

  it("finishing reads in German too", () => {
    expect(micButtonState("finishing", true, "de").title).toBe("Aufnahme wird beendet und gesendet …");
  });
});

describe("the warming phase (card 527 criterion 8)", () => {
  it("warming: the mic button says the model is loading and cannot be pressed", () => {
    const view = micButtonState("warming", true);
    expect(view.title).toBe("Loading the speech model ...");
    expect(view.disabled).toBe(true);
    expect(view.recording).toBe(false);
  });
});

describe("the wait for ready per route (card 527, fix round)", () => {
  it("local: the speech model card covers the composer while the model loads", () => {
    expect(speechModelLoads("warming", "local", true)).toBe(true);
  });

  it("local: no card while warming against a model that is already loaded (card 528)", () => {
    expect(speechModelLoads("warming", "local", false)).toBe(false);
  });

  it("hosted: no speech model card, the hosted route loads no local model", () => {
    expect(speechModelLoads("warming", "hosted", true)).toBe(false);
    expect(speechModelLoads("warming", "hosted", false)).toBe(false);
  });

  it("no card outside the wait on either route", () => {
    for (const phase of ["idle", "recording", "transcribing", "finishing"] as const) {
      for (const loading of [true, false]) {
        expect(speechModelLoads(phase, "local", loading)).toBe(false);
        expect(speechModelLoads(phase, "hosted", loading)).toBe(false);
      }
    }
  });

  it("hosted: the mic button says it is connecting, not loading a model", () => {
    const view = micButtonState("warming", true, "en", "hosted");
    expect(view.title).toBe("Connecting to the speech service ...");
    expect(view.disabled).toBe(true);
    expect(micButtonState("warming", true, "de", "hosted").title).toBe(
      "Verbindung zum Sprachdienst wird aufgebaut …",
    );
  });

  it("local: the mic button still says the model is loading", () => {
    expect(micButtonState("warming", true, "en", "local").title).toBe("Loading the speech model ...");
  });
});

describe("the microphone glyph (card 528 criterion 8)", () => {
  it("recording: the same microphone, filled", () => {
    expect(micButtonState("recording", true).glyph).toBe("filled");
  });

  it("idle: the microphone outlined", () => {
    expect(micButtonState("idle", true).glyph).toBe("outline");
  });

  it("every other phase keeps the outline", () => {
    for (const phase of ["warming", "transcribing", "finishing"] as const) {
      expect(micButtonState(phase, true).glyph, phase).toBe("outline");
    }
    expect(micButtonState("recording", false).glyph, "unavailable").toBe("outline");
  });
});
