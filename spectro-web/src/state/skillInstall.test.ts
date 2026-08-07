import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSkill, installState, resetInstallState, skillPath, type CatalogueRow } from "./skillInstall";

const BRAINSTORMING: CatalogueRow = {
  id: "superpowers/brainstorming",
  name: "brainstorming",
  pack: "superpowers",
  description: "Turn a vague idea into a spec.",
  licence: "MIT",
  repo: "https://github.com/obra/superpowers",
  commit: "0".repeat(40),
  files: 8,
  bytes: 52310,
  installed: false,
};

const HUMANIZER: CatalogueRow = {
  ...BRAINSTORMING,
  id: "humanizer/humanizer",
  name: "humanizer",
  pack: "humanizer",
};

let fetchMock: ReturnType<typeof vi.fn>;

/** An install call the test settles by hand, so "pending" is a state it can read. */
function deferredInstall(): { settle: (status: number, body?: unknown) => void } {
  let resolve: (r: Response) => void = () => {};
  fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
  return {
    settle: (status, body = {}) =>
      resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response),
  };
}

function respond(status: number, body: unknown = {}): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

beforeEach(() => {
  resetInstallState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installSkill", () => {
  it("posts the catalogue id and nothing else", async () => {
    respond(200, { name: "brainstorming", pack: "superpowers" });
    const reload = vi.fn();

    expect(await installSkill(BRAINSTORMING, reload)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/skills/install");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    // The server derives the destination from the id; a path never leaves here.
    expect(init.body).toBe('{"skill":"superpowers/brainstorming"}');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(installState()).toEqual({ pending: null, refused: null });
  });

  it("holds the pressed id while the copy runs and bars a second one", async () => {
    const first = deferredInstall();
    const reload = vi.fn();
    const running = installSkill(BRAINSTORMING, reload);
    expect(installState().pending).toBe("superpowers/brainstorming");

    // One at a time: two copies into the same root race on the staging
    // directory, and the loser's 409 would name the wrong reason.
    expect(await installSkill(HUMANIZER, reload)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    first.settle(200, {});
    await running;
    expect(installState().pending).toBeNull();
  });

  it("keeps the reason a refusal gives and does not reload the list", async () => {
    respond(409, { message: "Already installed — delete it first to install it again." });
    const reload = vi.fn();

    expect(await installSkill(BRAINSTORMING, reload)).toBe(false);

    expect(installState()).toEqual({
      pending: null,
      refused: {
        id: "superpowers/brainstorming",
        reason: "Already installed — delete it first to install it again.",
        status: 409,
      },
    });
    // The one that matters: nothing was written, so nothing may be redrawn.
    // A reload here is how a failed copy comes to look like a finished one.
    expect(reload).not.toHaveBeenCalled();
  });

  it("falls back to the status when the refusal carries no sentence", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response);

    await installSkill(BRAINSTORMING, vi.fn());

    expect(installState().refused).toEqual({ id: "superpowers/brainstorming", reason: "413", status: 413 });
  });

  it("reports an unreachable server instead of hanging on pending", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));

    expect(await installSkill(BRAINSTORMING, vi.fn())).toBe(false);

    expect(installState().pending).toBeNull();
    expect(installState().refused).toEqual({
      id: "superpowers/brainstorming",
      reason: "Failed to fetch",
      status: 0,
    });
  });

  it("clears the previous refusal when the next install starts", async () => {
    respond(409, { message: "taken" });
    await installSkill(BRAINSTORMING, vi.fn());
    expect(installState().refused).not.toBeNull();

    const second = deferredInstall();
    const running = installSkill(HUMANIZER, vi.fn());
    expect(installState()).toEqual({ pending: "humanizer/humanizer", refused: null });

    second.settle(200, {});
    await running;
  });
});

describe("skillPath", () => {
  it("gives a packed skill its pack as a segment, not a colon", () => {
    // The display name is "superpowers:brainstorming". A colon in a single path
    // segment would have to be encoded and the server would read one name where
    // there are two; the pack is a real directory, so it is a real segment.
    expect(skillPath("superpowers", "brainstorming")).toBe("/api/skills/superpowers/brainstorming");
  });

  it("leaves a top-level skill on the one-segment route", () => {
    expect(skillPath(null, "verification")).toBe("/api/skills/verification");
  });

  it("encodes every segment", () => {
    expect(skillPath("my pack", "a/b")).toBe("/api/skills/my%20pack/a%2Fb");
  });
});
