// Card 410: a pack of the catalogue installs and uninstalls as one set. The
// grouping is a pure function of the rows `/api/skills` returns, and the set
// actions are one request each, in the same store as the single install, so
// the "one copy at a time" rule covers both.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSet,
  installSkill,
  installState,
  packState,
  removeSet,
  removeSkill,
  resetInstallState,
  resetPackState,
  resetRowRemoval,
  rowRemoval,
  type CatalogueRow,
} from "./skillInstall";
import { packGroups } from "./skillPacks";

const row = (pack: string, name: string, root: "user" | "project" | null = null): CatalogueRow => ({
  id: `${pack}/${name}`,
  name,
  pack,
  description: `${name} does one thing.`,
  licence: "MIT",
  repo: "https://example.com/repo",
  commit: "0".repeat(40),
  files: 3,
  bytes: 1200,
  installed: root !== null,
  root,
});

/** Pack alpha: four skills, two installed in the user root. Pack beta: two, none installed. */
const FIXTURE: CatalogueRow[] = [
  row("alpha", "a1", "user"),
  row("alpha", "a2", "user"),
  row("alpha", "a3"),
  row("alpha", "a4"),
  row("beta", "b1"),
  row("beta", "b2"),
];

let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown = {}): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/** A call the test settles by hand, so "pending" is a state it can read. */
function deferred(): { settle: (status: number, body?: unknown) => void } {
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

const sentBody = (call: number): unknown =>
  JSON.parse((fetchMock.mock.calls[call] as [string, RequestInit])[1].body as string);

beforeEach(() => {
  resetInstallState();
  resetPackState();
  resetRowRemoval();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("packGroups", () => {
  it("makes one group per pack with its installed count, what is missing and what may come out", () => {
    const groups = packGroups(FIXTURE);

    expect(groups.map((g) => [g.pack, g.installed, g.total])).toEqual([
      ["alpha", 2, 4],
      ["beta", 0, 2],
    ]);
    expect(groups[0].missing.map((r) => r.id)).toEqual(["alpha/a3", "alpha/a4"]);
    expect(groups[0].removable.map((r) => r.id)).toEqual(["alpha/a1", "alpha/a2"]);
    expect(groups[1].missing.map((r) => r.id)).toEqual(["beta/b1", "beta/b2"]);
    expect(groups[1].removable).toEqual([]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["alpha/a1", "alpha/a2", "alpha/a3", "alpha/a4"]);
  });

  it("counts a project-root copy as installed but never offers it for removal", () => {
    const [alpha] = packGroups([row("alpha", "a1", "project"), row("alpha", "a2")]);

    expect(alpha.installed).toBe(1);
    expect(alpha.removable).toEqual([]);
    expect(alpha.missing.map((r) => r.id)).toEqual(["alpha/a2"]);
  });

  it("sorts the packs by name, whatever order the rows come in", () => {
    const groups = packGroups([row("zeta", "z"), row("alpha", "a"), row("mid", "m"), row("alpha", "b")]);
    expect(groups.map((g) => g.pack)).toEqual(["alpha", "mid", "zeta"]);
    expect(groups[0].rows.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("installSet", () => {
  it("fires exactly one request naming every skill it installs, then reloads once", async () => {
    respond(200, { installed: [] });
    const reload = vi.fn();
    const [alpha] = packGroups(FIXTURE);

    expect(await installSet("alpha", alpha.missing, reload)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/skills/install-set");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(sentBody(0)).toEqual({ skills: ["alpha/a3", "alpha/a4"] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(packState()).toEqual({ pending: null, refused: null });
  });

  it("keeps a refusal per skill, with its reason, and does not reload", async () => {
    respond(409, {
      message: "Nothing was installed: 1 of 3 refused.",
      refused: [
        { skill: "alpha/a3", status: 409, message: "Already installed.", name: "alpha:a3", root: "user" },
      ],
    });
    const reload = vi.fn();

    expect(
      await installSet("alpha", [row("alpha", "a3"), row("alpha", "a4"), row("alpha", "a5")], reload),
    ).toBe(false);

    expect(reload).not.toHaveBeenCalled();
    expect(packState()).toEqual({
      pending: null,
      refused: {
        pack: "alpha",
        action: "install",
        status: 409,
        refused: [{ id: "alpha/a3", reason: "Already installed.", status: 409, root: "user" }],
      },
    });
  });

  it("names the pack when the server sends no list, and when it cannot be reached", async () => {
    respond(500, { message: "disk gave up" });
    await installSet("beta", [row("beta", "b1")], vi.fn());
    expect(packState().refused?.refused).toEqual([{ id: "beta", reason: "disk gave up", status: 500 }]);

    fetchMock.mockRejectedValue(new Error("offline"));
    await installSet("beta", [row("beta", "b1")], vi.fn());
    expect(packState().refused).toEqual({
      pack: "beta",
      action: "install",
      status: 0,
      refused: [{ id: "beta", reason: "offline", status: 0 }],
    });
  });

  it("sends nothing for an empty set", async () => {
    expect(await installSet("alpha", [], vi.fn())).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a set that stopped with skills left behind", () => {
  it("keeps what the take-back left installed, and reloads because the disk changed", async () => {
    respond(500, {
      message: "alpha/a4 failed, and 1 copied before it could not be taken back: alpha/a3.",
      refused: [{ skill: "alpha/a4", status: 500, message: "disk gave up" }],
      leftover: ["alpha/a3"],
    });
    const reload = vi.fn();

    expect(await installSet("alpha", [row("alpha", "a3"), row("alpha", "a4")], reload)).toBe(false);

    expect(packState().refused).toEqual({
      pack: "alpha",
      action: "install",
      status: 500,
      refused: [{ id: "alpha/a4", reason: "disk gave up", status: 500 }],
      leftover: ["alpha/a3"],
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps what the put-back left out of the root and the folder it waits in", async () => {
    respond(500, {
      refused: [{ skill: "alpha/a2", status: 500, message: "the disk said no" }],
      leftover: ["alpha/a1"],
      holding: "/home/someone/.spectro/.skill-remove/42",
    });
    const reload = vi.fn();

    await removeSet("alpha", [row("alpha", "a1", "user"), row("alpha", "a2", "user")], reload);

    expect(packState().refused?.leftover).toEqual(["alpha/a1"]);
    expect(packState().refused?.holding).toBe("/home/someone/.spectro/.skill-remove/42");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("removeSet", () => {
  it("fires exactly one request naming every skill it removes, then reloads once", async () => {
    respond(200, { removed: ["alpha/a1", "alpha/a2"] });
    const reload = vi.fn();
    const [alpha] = packGroups(FIXTURE);

    expect(await removeSet("alpha", alpha.removable, reload)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/skills/remove-set");
    expect(init.method).toBe("POST");
    expect(sentBody(0)).toEqual({ skills: ["alpha/a1", "alpha/a2"] });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the refusal as a remove", async () => {
    respond(409, { refused: [{ skill: "alpha/a1", status: 409, message: "project", root: "project" }] });
    await removeSet("alpha", [row("alpha", "a1", "user")], vi.fn());
    expect(packState().refused?.action).toBe("remove");
    expect(packState().refused?.refused[0]).toEqual({
      id: "alpha/a1",
      reason: "project",
      status: 409,
      root: "project",
    });
  });
});

describe("one copy at a time, single and set alike", () => {
  it("holds the pack and action while a set runs and bars every other press", async () => {
    const running = deferred();
    const reload = vi.fn();
    const first = installSet("alpha", [row("alpha", "a3")], reload);
    expect(packState().pending).toEqual({ pack: "alpha", action: "install" });

    // Each call reaches its fetch before its first await, so the count is
    // read right after each press rather than after a promise that a wrongly
    // started request would never settle.
    const barred = [
      installSet("beta", [row("beta", "b1")], reload),
      removeSet("alpha", [row("alpha", "a1", "user")], reload),
      installSkill(row("beta", "b2"), reload),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await Promise.all(barred)).toEqual([false, false, false]);

    running.settle(200, { installed: [] });
    expect(await first).toBe(true);
    expect(packState().pending).toBeNull();
  });

  it("does not start a set while a single install is copying", async () => {
    const running = deferred();
    const single = installSkill(row("beta", "b1"), vi.fn());
    expect(installState().pending).toBe("beta/b1");

    const barred = installSet("alpha", [row("alpha", "a3")], vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await barred).toBe(false);

    running.settle(200, {});
    await single;
  });
});

describe("a row's off switch holds the same one-at-a-time line", () => {
  it("sends one DELETE for that skill, holds its id while it runs, then reloads once", async () => {
    const running = deferred();
    const reload = vi.fn();
    const removal = removeSkill(row("alpha", "a1", "user"), reload);

    expect(rowRemoval()).toBe("alpha/a1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/skills/alpha/a1");
    expect(init.method).toBe("DELETE");
    expect(reload).not.toHaveBeenCalled();

    running.settle(200, { deleted: "alpha:a1" });
    expect(await removal).toBe(true);
    expect(rowRemoval()).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("while it runs, no set, install or second removal starts", async () => {
    // The reviewer's case: a remove-set fired while a row's DELETE runs would
    // still list the skill being deleted, and come back refused.
    const running = deferred();
    const reload = vi.fn();
    const removal = removeSkill(row("alpha", "a1", "user"), reload);

    const barred = [
      removeSet("alpha", [row("alpha", "a1", "user"), row("alpha", "a2", "user")], reload),
      installSet("beta", [row("beta", "b1")], reload),
      installSkill(row("beta", "b2"), reload),
      removeSkill(row("alpha", "a2", "user"), reload),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await Promise.all(barred)).toEqual([false, false, false, false]);

    running.settle(200, {});
    expect(await removal).toBe(true);
  });

  it("does not start while a set runs", async () => {
    const running = deferred();
    const set = installSet("alpha", [row("alpha", "a3")], vi.fn());

    const barred = removeSkill(row("alpha", "a1", "user"), vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await barred).toBe(false);
    expect(rowRemoval()).toBeNull();

    running.settle(200, { installed: [] });
    await set;
  });

  it("reloads after a refused or unreachable DELETE too, and lets go of the id", async () => {
    respond(409, { error: "a project skill belongs to the repo" });
    const reload = vi.fn();
    expect(await removeSkill(row("alpha", "a1", "user"), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await removeSkill(row("alpha", "a1", "user"), reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(rowRemoval()).toBeNull();
  });
});
