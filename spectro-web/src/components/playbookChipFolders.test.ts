// Card 554 fix round 3, item 7: the header's playbook chip lists the
// registered folders whether or not the session has a workspace. Only the
// suggestion, the folder pinned for a workspace, needs one. PlaybookChip runs
// here as a hook under HookHost, so its effect runs as it does in the window.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HookHost } from "../testkit/hookHost";
import { PlaybookChip } from "./PlaybookChip";
import { __resetPlaybooks, refreshFolders, usePlaybookFolders } from "../state/playbooks";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  __resetPlaybooks();
  vi.unstubAllGlobals();
});

function server(): ReturnType<typeof vi.fn> {
  const fetchFn = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        folders: ["/pb/spectro", "/pb/team-x"],
        active: url.includes("workspace=") ? "/pb/spectro" : null,
      }),
    }),
  );
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

describe("the chip's folder list", () => {
  it("is read without a workspace, and then holds no pin", async () => {
    const fetchFn = server();
    const host = new HookHost(() => PlaybookChip({ workspace: null, pick: null, onPick: () => {} }));
    await settle();
    expect(fetchFn).toHaveBeenCalledWith("/api/playbooks");
    const folders = new HookHost(() => usePlaybookFolders());
    expect(folders.value).toEqual({ folders: ["/pb/spectro", "/pb/team-x"], active: null });
    host.unmount();
  });

  it("keeps the pin the store has when it reads without a workspace", async () => {
    server();
    await refreshFolders("/ws");
    await refreshFolders(null);
    const folders = new HookHost(() => usePlaybookFolders());
    expect(folders.value.active, "a read without a workspace says nothing about a pin").toBe("/pb/spectro");
  });

  it("reads the pin with a workspace", async () => {
    const fetchFn = server();
    const host = new HookHost(() => PlaybookChip({ workspace: "/ws", pick: null, onPick: () => {} }));
    await settle();
    expect(fetchFn).toHaveBeenCalledWith("/api/playbooks?workspace=%2Fws");
    host.unmount();
  });
});
