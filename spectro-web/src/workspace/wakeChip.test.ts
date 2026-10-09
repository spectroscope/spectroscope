// Card 498: the header chip of a stored session, before and after its wake.

import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "../state/reducer";
import { headerWorkspace, ownSessionIds, storedChipWorkspace, wakeWanted } from "./wakeChip";

const answered = (sessionId: string, path: string, exists = true): WorkspaceInfo => ({
  resolved: exists,
  mode: "recorded",
  configured: false,
  sessionId,
  path,
  exists,
});

describe("the stored folder in the chip", () => {
  it("names the recorded folder at once, with no session for the actions yet", () => {
    expect(storedChipWorkspace("/work/ForgeDemo")).toEqual({
      resolved: false,
      mode: "recorded",
      configured: false,
      path: "/work/ForgeDemo",
    });
  });

  it("is nothing for a session that recorded no folder", () => {
    expect(storedChipWorkspace(null)).toBeNull();
    expect(storedChipWorkspace("")).toBeNull();
  });
});

describe("the workspace the header shows", () => {
  const base = { viewingLive: false, liveWorkspace: null, continuable: true, replayId: "s-1" };

  it("is the live session's own announcement in the live view", () => {
    const live = answered("live-1", "/work/live");
    expect(
      headerWorkspace({ ...base, viewingLive: true, liveWorkspace: live, storedCwd: "/x", woken: null }),
    ).toBe(live);
  });

  it("is the recorded folder for a stored session before any wake", () => {
    expect(headerWorkspace({ ...base, storedCwd: "/work/ForgeDemo", woken: null })).toEqual(
      storedChipWorkspace("/work/ForgeDemo"),
    );
  });

  it("stays the recorded folder while the woken socket has only said what the app would use", () => {
    // The connect frame of the wake's own socket names the app's folder and no
    // session; the chip must not flash it before the answer.
    const prospective: WorkspaceInfo = {
      resolved: false,
      mode: "default",
      configured: true,
      path: "/work/app",
    };
    expect(headerWorkspace({ ...base, storedCwd: "/work/ForgeDemo", woken: prospective })).toEqual(
      storedChipWorkspace("/work/ForgeDemo"),
    );
  });

  it("is the wake's answer once it names this session", () => {
    const answer = answered("s-1", "/work/ForgeDemo");
    expect(headerWorkspace({ ...base, storedCwd: "/work/ForgeDemo", woken: answer })).toBe(answer);
  });

  it("ignores an answer for another session", () => {
    expect(
      headerWorkspace({ ...base, storedCwd: "/work/ForgeDemo", woken: answered("s-2", "/work/Other") }),
    ).toEqual(storedChipWorkspace("/work/ForgeDemo"));
  });

  it("shows the answer even for a session that recorded no folder", () => {
    const answer = answered("s-1", "/tmp/spectroscope-ws/s-1");
    expect(headerWorkspace({ ...base, storedCwd: null, woken: answer })).toBe(answer);
  });

  it("is nothing for a stored session without a folder and without a wake, as before", () => {
    expect(headerWorkspace({ ...base, storedCwd: null, woken: null })).toBeNull();
  });

  it("is nothing for an archive that stays read-only", () => {
    expect(
      headerWorkspace({ ...base, continuable: false, storedCwd: "/work/ForgeDemo", woken: null }),
    ).toBeNull();
  });
});

describe("whether a focus wakes the session", () => {
  it("wakes a stored session that can be continued and is not woken yet", () => {
    expect(wakeWanted({ replayId: "s-1", continuable: true, held: false })).toBe(true);
  });

  it("does nothing for the live view, a read-only archive, or a session already held or woken", () => {
    expect(wakeWanted({ replayId: null, continuable: false, held: false })).toBe(false);
    expect(wakeWanted({ replayId: "s-1", continuable: false, held: false })).toBe(false);
    expect(wakeWanted({ replayId: "s-1", continuable: true, held: true })).toBe(false);
  });

  it("never wakes an import or a scenario", () => {
    expect(wakeWanted({ replayId: "import:a", continuable: true, held: false })).toBe(false);
    expect(wakeWanted({ replayId: "scenario:a", continuable: true, held: false })).toBe(false);
  });
});

describe("the sessions this page holds", () => {
  it("count a woken session as this page's own, so the server's live set does not make it read-only", () => {
    // Found in the live check: the wake's claim put the session in the live
    // set, the rail does not list a wake as held, and the composer under it
    // turned read-only the moment the box was clicked.
    const held = [{ id: "held-1" }];
    const slots = [
      { sessionId: "held-1", woken: false },
      { sessionId: "s-1", woken: true },
      { sessionId: null, woken: false },
    ];
    expect(ownSessionIds(held, slots)).toEqual(["held-1", "s-1"]);
  });
});
