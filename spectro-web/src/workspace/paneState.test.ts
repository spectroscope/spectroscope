import { describe, it, expect } from "vitest";
import { listableBeforeTheFirstRun, paneState } from "./paneState";
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
  it("beforeTheFirstRunAnUnnamedFolderIsPendingNotATree", () => {
    // The pane used to fall back to a sessionless /api/files, which answered
    // with the server's own working directory. Where no folder is named there
    // is still nothing to show.
    expect(paneState(random, null, "en").kind).toBe("pending");
    expect(paneState(null, null, "en").kind).toBe("pending");
    expect(paneState({ ...configured, exists: false }, null, "en").kind).toBe("pending");
  });

  it("noTreeIsDrawnForAFolderThatIsNeitherResolvedNorOnDisk", () => {
    // The premise of the older version of this test was "no tree without a
    // resolved workspace", and it is replaced rather than loosened: a mode that
    // NAMES a folder which the announcement says is on disk is a folder the app
    // knows. What may never produce a tree is a folder nobody has named, or one
    // named but not there.
    const announcements: (WorkspaceAnnouncement | null)[] = [
      null,
      random,
      { ...configured, exists: false },
      { ...configured, path: undefined },
      { ...random, path: "/tmp/spectroscope-ws/x", exists: true },
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

  it("aNamedFolderThatIsOnDiskIsListedBeforeTheFirstRun", () => {
    // The owner's report: on a fresh start the Files pane printed the folder
    // and showed nothing in it. Toggling the chooser to random and back minted
    // a session, which resolved a workspace, which finally populated the pane.
    // The app knew the folder the whole time.
    expect(listableBeforeTheFirstRun(configured)).toBe(true);
    const asked = paneState(configured, { kind: "ok" }, "en");
    expect(asked.kind).toBe("tree");
    if (asked.kind !== "tree") throw new Error("expected tree");
    expect(asked.scope).toBe("prospective");
  });

  it("aTreeSaysWhetherItIsASessionsFolderOrTheOneTheFirstRunWillUse", () => {
    // Nothing may claim a session that has not started, so the two trees are
    // not the same state with the same header.
    const prospective = paneState(configured, { kind: "ok" }, "en");
    const session = paneState(running, { kind: "ok" }, "en");
    if (prospective.kind !== "tree" || session.kind !== "tree") throw new Error("expected trees");
    expect(prospective.scope).toBe("prospective");
    expect(session.scope).toBe("session");
  });

  it("aFolderTheFirstRunWouldUseIsNeitherRandomNorAbsent", () => {
    // random is keyed by a session id that does not exist yet: there is no
    // folder to ask about, and asking would have to invent one.
    expect(listableBeforeTheFirstRun(random)).toBe(false);
    expect(listableBeforeTheFirstRun({ ...random, path: "/tmp/spectroscope-ws/x", exists: true })).toBe(
      false,
    );
    expect(listableBeforeTheFirstRun({ ...configured, exists: false })).toBe(false);
    expect(listableBeforeTheFirstRun({ ...configured, path: undefined })).toBe(false);
    expect(listableBeforeTheFirstRun(null)).toBe(false);
    // Already resolved: that is the session tree, not the prospective one.
    expect(listableBeforeTheFirstRun(running)).toBe(false);
  });

  it("theProspectiveTreeWaitsForTheServerInsteadOfPromisingTheFolderIsEmpty", () => {
    const waiting = paneState(configured, null, "en");
    expect(waiting.kind).toBe("loading");
  });

  it("aServerThatWillNotListTheProspectiveFolderFallsBackToNamingIt", () => {
    // 409 here means the server has no configured workspace to list, while the
    // announcement said it has one. The pane repeats what it was told and
    // claims no tree, rather than inventing either.
    const refused = paneState(configured, { kind: "status", status: 409 }, "en");
    expect(refused.kind).toBe("pending");
    if (refused.kind !== "pending") throw new Error("expected pending");
    expect(refused.path).toBe(configured.path);
    const gone = paneState(configured, { kind: "status", status: 404 }, "en");
    if (gone.kind !== "pending") throw new Error("expected pending");
    expect(gone.message).not.toContain("first run");
    // A dead server outranks everything, prospective or not.
    expect(paneState(configured, { kind: "offline" }, "en").kind).toBe("unreachable");
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
    for (const announcement of [random, { ...configured, exists: false }]) {
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

  it("aResolvedWorkspaceWithNoAnswerYetIsLoadingNotAPromiseOfAFolder", () => {
    // WorkspaceTab remounts on every return to the Files tab, so outcome is
    // null again each time while /api/files is in flight. The run has already
    // made this folder; saying it will be created when the first run starts is
    // a false claim, and the state before this one showed an honest "loading".
    const en = paneState(running, null, "en");
    const de = paneState(running, null, "de");
    expect(en.kind).toBe("loading");
    expect(de.kind).toBe("loading");
    if (en.kind !== "loading" || de.kind !== "loading") throw new Error("expected loading");
    expect(en.message).not.toBe(de.message);
    expect(en.message).not.toContain("first run");
  });

  it("aRandomFolderThatAlreadyExistsIsNotCalledUnborn", () => {
    // pending() branched on mode before it looked at exists, so the exists
    // guard below it was unreachable for the default install, whose mode is
    // "random". A folder that is on disk is not one the first run creates.
    const there = { ...random, path: "/tmp/spectroscope-ws/20260803-120000", exists: true };
    const en = paneState(there, null, "en");
    if (en.kind !== "pending") throw new Error("expected pending");
    expect(en.message).not.toContain("created");
    expect(en.message).toContain("this folder");
  });

  it("aFolderTheServerCannotFindAnyMoreDoesNotPromiseToCreateIt", () => {
    // 404 means the recorded workspace is not a directory right now: deleted,
    // or on an unmounted volume. This state is not time-boxed the way the
    // in-flight one is, so a wrong sentence here stands forever.
    for (const lang of ["en", "de"] as const) {
      const gone = paneState(running, { kind: "status", status: 404 }, lang);
      if (gone.kind !== "pending") throw new Error("expected pending");
      expect(gone.message).not.toContain("first run");
      expect(gone.message).not.toContain("erste");
      expect(gone.path).toBe(running.path);
    }
    // 409 is a different fact: the server does not know this chat's folder, not
    // that the folder is missing. A restarted server loses the in-memory record.
    const forgotten = paneState(running, { kind: "status", status: 409 }, "en");
    const vanished = paneState(running, { kind: "status", status: 404 }, "en");
    if (forgotten.kind !== "pending" || vanished.kind !== "pending") {
      throw new Error("expected pending");
    }
    expect(forgotten.message).not.toBe(vanished.message);
  });

  it("thePendingStateCarriesThePathOnlyWhenOneIsKnown", () => {
    const withPath = paneState({ ...configured, exists: false }, null, "en");
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
