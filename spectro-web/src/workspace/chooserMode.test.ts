import { describe, it, expect } from "vitest";
import { preselectedMode } from "./chooserMode";
import type { WorkspaceAnnouncement } from "./paneState";

describe("preselectedMode", () => {
  it("thePreselectedModeFollowsTheAnnouncementNotAConstant", () => {
    // The chooser held useState<Mode>("random") and its own comment admitted it
    // "only applies on click", while buildAgentOnce resolves the CONFIGURED
    // workspace. The empty chat reported a choice the run would not honour.
    const configured: WorkspaceAnnouncement = {
      resolved: false,
      mode: "default",
      configured: true,
      path: "/Users/you/spectroscope-workspace",
      exists: true,
    };
    expect(preselectedMode(configured)).toBe("default");
  });

  it("aPinnedFolderPreselectsSetAndNothingConfiguredPreselectsRandom", () => {
    expect(preselectedMode({ resolved: false, mode: "set", configured: true, path: "/x" })).toBe("set");
    expect(preselectedMode({ resolved: false, mode: "random", configured: false })).toBe("random");
  });

  it("withoutAnAnnouncementNothingIsPreselected", () => {
    // No frame yet means we do not know; showing a filled-in radio would be the
    // same guess in a new costume.
    expect(preselectedMode(null)).toBeNull();
  });
});
