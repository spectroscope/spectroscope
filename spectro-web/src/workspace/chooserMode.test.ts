import { describe, it, expect } from "vitest";
import { chooserFolder, preselectedMode } from "./chooserMode";
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

// The chooser names the folder (card 179). The announcement carried the path
// all along and this screen printed only the word "default" — the one place
// that exists to tell the reader where his agent will work said everything
// except the folder.
describe("chooserFolder", () => {
  const info = (o: Partial<WorkspaceAnnouncement>): WorkspaceAnnouncement => ({
    resolved: false,
    mode: "default",
    configured: true,
    ...o,
  });

  it("names the folder a configured workspace points at", () => {
    expect(chooserFolder(info({ path: "/Users/x/ForgeDemo" }))).toBe("ForgeDemo");
  });

  it("says nothing before an announcement arrives", () => {
    expect(chooserFolder(null)).toBeNull();
  });

  it("says nothing in random mode, where the folder has no name yet", () => {
    // Keyed by a session id that has not been minted. Inventing one would be a
    // claim about a session that does not exist.
    expect(chooserFolder(info({ mode: "random", configured: false }))).toBeNull();
    expect(chooserFolder(info({ mode: "random", configured: false, path: undefined }))).toBeNull();
  });

  it("says nothing when the frame carries no path", () => {
    expect(chooserFolder(info({}))).toBeNull();
    expect(chooserFolder(info({ path: "" }))).toBeNull();
    expect(chooserFolder(info({ path: "   " }))).toBeNull();
  });

  it("survives a trailing slash and a root path", () => {
    expect(chooserFolder(info({ path: "/Users/x/work/" }))).toBe("work");
    expect(chooserFolder(info({ path: "/" }))).toBeNull();
  });
});
