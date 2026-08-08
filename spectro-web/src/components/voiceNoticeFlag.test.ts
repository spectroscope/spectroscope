import { beforeEach, describe, expect, it } from "vitest";
import {
  __setVoiceNoticeTestHooks,
  markVoiceNoticeSeen,
  readVoiceNoticeSeen,
  shouldShowVoiceNotice,
  VOICE_NOTICE_KEY,
} from "./voiceNoticeFlag";
import { opensTheSheet } from "./voiceNoticeReading";

describe("the voice sheet's once-per-home flag", () => {
  let store: string | null;
  beforeEach(() => {
    store = null;
    __setVoiceNoticeTestHooks({
      get: () => store,
      set: () => {
        store = "1";
      },
    });
  });

  it("shows on the first reach and not on the second", () => {
    expect(shouldShowVoiceNotice(readVoiceNoticeSeen(), null, false)).toBe(true);
    markVoiceNoticeSeen();
    expect(shouldShowVoiceNotice(readVoiceNoticeSeen(), null, false)).toBe(false);
  });

  it("comes back for the setup case even after it was dismissed", () => {
    // sttMissing takes the microphone button away, and the tooltip with it. A
    // reader who dismissed the sheet once would otherwise be left with nothing
    // at all to read and nothing to press.
    markVoiceNoticeSeen();
    expect(shouldShowVoiceNotice(readVoiceNoticeSeen(), "sttMissing", opensTheSheet("sttMissing"))).toBe(
      true,
    );
  });

  it("stays away for a retryable failure after it was dismissed", () => {
    markVoiceNoticeSeen();
    for (const reason of ["requestFailed", "deviceBusy", "convertFailed", "denied", "noDevice"]) {
      expect(shouldShowVoiceNotice(readVoiceNoticeSeen(), reason, opensTheSheet(reason)), reason).toBe(false);
    }
  });

  it("treats blocked storage as not-yet-dismissed rather than as dismissed", () => {
    // Private mode throws on read. Repeating the sheet is a smaller harm than
    // a reader who can never see why speech is not working.
    __setVoiceNoticeTestHooks({ get: () => null, set: () => {} });
    expect(shouldShowVoiceNotice(readVoiceNoticeSeen(), null, false)).toBe(true);
  });

  it("keys the flag apart from the built-in model notice", () => {
    expect(VOICE_NOTICE_KEY).toBe("spectroscope:voiceNotice");
    expect(VOICE_NOTICE_KEY).not.toBe("spectroscope:localModelNotice");
  });
});
