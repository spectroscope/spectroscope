import { describe, it, expect } from "vitest";
import {
  beforeFirstPrompt,
  chooserFolder,
  chooserTitle,
  clipName,
  optionFor,
  preselectedMode,
  preselectedOption,
} from "./chooserMode";
import type { WorkspaceAnnouncement } from "./paneState";
import type { Turn } from "../state/reducer";

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

// Card 389 criterion 6: the full path goes in the tooltip, the last segment is
// the text, and both follow the path the frame carries rather than the
// `configured` flag. The resolved frame of a random-mode run carries a real
// folder with configured false, and the row used to name nothing for it.
describe("chooserTitle", () => {
  const frame = (o: Partial<WorkspaceAnnouncement>): WorkspaceAnnouncement => ({
    resolved: true,
    mode: "default",
    configured: true,
    ...o,
  });

  it("answers the whole path of a deep folder, and the text is its last segment", () => {
    const deep = frame({ path: "/Users/you/code/spectroscope/particle_demo" });
    expect(chooserTitle(deep)).toBe("/Users/you/code/spectroscope/particle_demo");
    expect(chooserFolder(deep)).toBe("particle_demo");
  });

  it("answers a one segment path whole, and the text is that segment", () => {
    const one = frame({ path: "/work" });
    expect(chooserTitle(one)).toBe("/work");
    expect(chooserFolder(one)).toBe("work");
  });

  it("keeps a trailing slash in the title and drops it from the text", () => {
    const slash = frame({ path: "/Users/you/work/" });
    expect(chooserTitle(slash)).toBe("/Users/you/work/");
    expect(chooserFolder(slash)).toBe("work");
  });

  it("names the folder of a resolved random run, which is not configured", () => {
    const resolvedRandom = frame({
      mode: "random",
      configured: false,
      sessionId: "s-9",
      path: "/tmp/runs/s-9",
      exists: true,
    });
    expect(chooserTitle(resolvedRandom)).toBe("/tmp/runs/s-9");
    expect(chooserFolder(resolvedRandom)).toBe("s-9");
  });

  it("answers null for a prospective random frame, which carries no path", () => {
    const prospective = frame({ resolved: false, mode: "random", configured: false });
    expect(chooserTitle(prospective)).toBeNull();
    expect(chooserFolder(prospective)).toBeNull();
  });

  it("answers null before an announcement and for a blank path", () => {
    expect(chooserTitle(null)).toBeNull();
    expect(chooserTitle(frame({ path: "  " }))).toBeNull();
  });
});

describe("optionFor and preselectedOption", () => {
  it("draws a recorded folder on the option for a specific folder", () => {
    // A resumed session works in the folder its record names: one specific
    // folder, which is what the "set" option stands for.
    expect(optionFor("recorded")).toBe("set");
  });

  it("draws every other mode on its own option", () => {
    expect(optionFor("random")).toBe("random");
    expect(optionFor("default")).toBe("default");
    expect(optionFor("set")).toBe("set");
  });

  it("marks nothing before an announcement", () => {
    expect(preselectedOption(null)).toBeNull();
  });
});

describe("clipName", () => {
  it("keeps a name of up to the limit whole", () => {
    expect(clipName("ForgeDemo", 24)).toBe("ForgeDemo");
    expect(clipName("x".repeat(24), 24)).toBe("x".repeat(24));
  });

  it("cuts a longer name to the limit, the last character an ellipsis", () => {
    const clipped = clipName("a-very-long-folder-name-that-keeps-going", 24);
    expect(clipped).toHaveLength(24);
    expect(clipped).toBe("a-very-long-folder-name…");
  });
});

describe("beforeFirstPrompt (card 428)", () => {
  // The working folder row shows while this is true. A user turn is built by
  // the run_start that answers a prompt (or by an imported transcript), so a
  // prompt the server refused or a folder pick it rejected, which leave only
  // an error line, do not count as the first message.
  it("is true on a chat with no turns", () => {
    expect(beforeFirstPrompt([])).toBe(true);
  });

  it("stays true while the chat holds only error and info lines", () => {
    const lines: Turn[] = [
      { kind: "error", text: "Workspace rejected: not a directory" },
      { kind: "info", text: "workspace settings ignored", tone: "warn" },
    ];
    expect(beforeFirstPrompt(lines)).toBe(true);
  });

  it("is false once a prompt is in the chat", () => {
    expect(beforeFirstPrompt([{ kind: "user", text: "first" }])).toBe(false);
    expect(
      beforeFirstPrompt([
        { kind: "error", text: "refused" },
        { kind: "user", text: "again" },
      ]),
    ).toBe(false);
  });
});
