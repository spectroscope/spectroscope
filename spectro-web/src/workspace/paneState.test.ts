import { describe, it, expect } from "vitest";
import { paneState } from "./paneState";
import type { WorkspaceAnnouncement, FetchOutcome } from "./paneState";

const configured: WorkspaceAnnouncement = {
  resolved: false,
  mode: "default",
  configured: true,
  path: "/Users/you/spectroscope-workspace",
  exists: true,
};

const random: WorkspaceAnnouncement = {
  resolved: false,
  mode: "random",
  configured: false,
};

const running: WorkspaceAnnouncement = {
  resolved: true,
  mode: "default",
  configured: true,
  sessionId: "20260803-120000",
  path: "/Users/you/spectroscope-workspace",
  exists: true,
};

describe("paneState", () => {
  it("beforeTheFirstRunThePaneIsPendingNotATree", () => {
    // The pane used to fall back to a sessionless /api/files, which answered
    // with the server's own working directory. There is no tree to show yet.
    expect(paneState(random, null, "en").kind).toBe("pending");
    expect(paneState(configured, null, "en").kind).toBe("pending");
    expect(paneState(null, null, "en").kind).toBe("pending");
  });

  it("noInputEverProducesATreeWithoutAResolvedWorkspace", () => {
    const announcements: (WorkspaceAnnouncement | null)[] = [
      null,
      random,
      configured,
      { ...configured, exists: false },
      { ...random, path: "/tmp/spectroscope-ws/x" },
    ];
    const outcomes: (FetchOutcome | null)[] = [
      null,
      { kind: "ok" },
      { kind: "status", status: 200 },
      { kind: "status", status: 404 },
      { kind: "status", status: 409 },
      { kind: "offline" },
    ];
    for (const a of announcements) {
      for (const o of outcomes) {
        for (const lang of ["en", "de"] as const) {
          expect(paneState(a, o, lang).kind).not.toBe("tree");
        }
      }
    }
  });

  it("aDeadServerReadsAsUnreachableAndAnAbsentFolderDoesNot", () => {
    // Today both collapse into "Server unreachable". A folder that has not been
    // created yet is not a broken server.
    expect(paneState(running, { kind: "offline" }, "en").kind).toBe("unreachable");
    expect(paneState(running, { kind: "status", status: 404 }, "en").kind).toBe("pending");
    expect(paneState(running, { kind: "status", status: 409 }, "en").kind).toBe("pending");
  });

  it("aResolvedWorkspaceThatAnswersOkIsATree", () => {
    expect(paneState(running, { kind: "ok" }, "en").kind).toBe("tree");
  });

  it("thePendingStateNamesWhatWillHappenInBothLanguages", () => {
    for (const announcement of [random, configured, { ...configured, exists: false }]) {
      const en = paneState(announcement, null, "en");
      const de = paneState(announcement, null, "de");
      if (en.kind !== "pending" || de.kind !== "pending") throw new Error("expected pending");
      expect(en.message.length).toBeGreaterThan(0);
      expect(de.message.length).toBeGreaterThan(0);
      expect(en.message).not.toBe(de.message);
      // It must say WHEN the folder appears, not merely that it is missing.
      expect(en.message).toContain("first run");
      expect(de.message).toContain("lauf");
    }
  });

  it("thePendingStateCarriesThePathOnlyWhenOneIsKnown", () => {
    const withPath = paneState(configured, null, "en");
    const withoutPath = paneState(random, null, "en");
    if (withPath.kind !== "pending" || withoutPath.kind !== "pending") {
      throw new Error("expected pending");
    }
    expect(withPath.path).toBe("/Users/you/spectroscope-workspace");
    // "random" is keyed by a session id that does not exist yet, inventing a
    // path here would be the same guess the chooser used to make.
    expect(withoutPath.path).toBeNull();
  });
});
