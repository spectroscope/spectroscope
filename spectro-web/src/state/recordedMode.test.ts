// Card 504, last fix round: the gear of a stored session showed "ask" until
// the session was continued, because permission_mode_info is a socket-only
// frame and a stored session has no socket. The mode a stored session runs
// with when continued is the one its settings give it (SessionConnection
// reads it from the session's workspace config on resume), so the gear reads
// the session-moment settings view, and the process-moment view when the
// session has no workspace (the session view answers 404 then).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordedPermissionMode } from "./recordedMode";

const fetchSettings = vi.fn();
vi.mock("./serverSettings", async (original) => ({
  ...(await original<typeof import("./serverSettings")>()),
  fetchSettings: (...args: unknown[]) => fetchSettings(...args),
}));

const view = (permissionMode: unknown) => ({
  effective: { permissionMode },
  origins: {},
  layers: {},
  files: {},
  workspace: null,
});

describe("the mode a stored session runs with", () => {
  beforeEach(() => fetchSettings.mockReset());

  it("is its session-moment settings' permissionMode", async () => {
    fetchSettings.mockResolvedValueOnce(view("auto"));
    expect(await recordedPermissionMode("20261012-090000-abcd")).toBe("auto");
    expect(fetchSettings).toHaveBeenCalledWith("20261012-090000-abcd");
  });

  it("falls back to the process-moment view when the session has no workspace", async () => {
    fetchSettings.mockRejectedValueOnce(new Error("404")).mockResolvedValueOnce(view("readonly"));
    expect(await recordedPermissionMode("20261012-090000-abcd")).toBe("readonly");
    expect(fetchSettings.mock.calls).toEqual([["20261012-090000-abcd"], []]);
  });

  it("is null when neither view answers or the value is not a mode", async () => {
    fetchSettings.mockRejectedValue(new Error("down"));
    expect(await recordedPermissionMode("x")).toBeNull();
    fetchSettings.mockReset();
    fetchSettings.mockResolvedValue(view(42));
    expect(await recordedPermissionMode("x")).toBeNull();
  });
});
