// Card 554, task 7: the command list is fetched from the server, once, and
// again after a reconnect. Pure store, pinned in node with a stubbed fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetCommandList,
  __setCommandRows,
  COMMANDS_TIMEOUT_MS,
  commandListStatus,
  commandRows,
  loadCommands,
  reloadCommands,
  rowOf,
  webCommands,
} from "./commandList";
import { coreCommandRows, rawCoreCommands } from "../testkit/commandRows";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The server's answer: every core row, with the fields Jackson always writes. */
function served(): unknown[] {
  return rawCoreCommands().map((row) => ({ aliases: [], sub: null, wired: true, ...row }));
}

function answer(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchFn = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

beforeEach(() => {
  __resetCommandList();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetCommandList();
});

describe("the command list store", () => {
  it("has no rows before the server answered", () => {
    expect(commandRows()).toBeNull();
    expect(commandListStatus()).toBe("idle");
  });

  it("reads every row GET /api/commands answers, in the list's order", async () => {
    const fetchFn = answer(served());
    loadCommands();
    expect(commandListStatus()).toBe("loading");
    expect(commandRows(), "nothing until the answer").toBeNull();
    await flush();
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/commands",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(commandListStatus()).toBe("ready");
    expect(commandRows()?.map((r) => r.id)).toEqual(rawCoreCommands().map((r) => r.id));
  });

  it("asks once: a second load in flight or after the answer sends nothing", async () => {
    const fetchFn = answer(served());
    loadCommands();
    loadCommands();
    await flush();
    loadCommands();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("keeps no rows when the request fails, and the next load asks again", async () => {
    const failing = answer({}, false);
    loadCommands();
    await flush();
    expect(commandListStatus()).toBe("failed");
    expect(commandRows()).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);

    answer(served());
    loadCommands();
    await flush();
    expect(commandListStatus()).toBe("ready");
    expect(commandRows()?.length).toBe(rawCoreCommands().length);
  });

  // Fix round 3, item 8: a request that never answers ends as failed after a
  // bounded wait, so the composer can say so and ask again.
  it("gives up on a request that never answers after the bounded wait", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(() => new Promise(() => {}));
      vi.stubGlobal("fetch", hanging);
      loadCommands();
      expect(commandListStatus()).toBe("loading");
      await vi.advanceTimersByTimeAsync(COMMANDS_TIMEOUT_MS - 1);
      expect(commandListStatus(), "still waiting inside the bound").toBe("loading");
      await vi.advanceTimersByTimeAsync(1);
      expect(commandListStatus()).toBe("failed");
      expect(COMMANDS_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a request that answers after it was given up and a newer one answered", async () => {
    vi.useFakeTimers();
    try {
      let late: (value: unknown) => void = () => {};
      const first = vi.fn(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      );
      vi.stubGlobal("fetch", first);
      loadCommands();
      await vi.advanceTimersByTimeAsync(COMMANDS_TIMEOUT_MS);
      expect(commandListStatus(), "premise: given up").toBe("failed");
      answer(served().slice(0, 2));
      loadCommands();
      await vi.advanceTimersByTimeAsync(0);
      expect(commandRows()?.length).toBe(2);
      late({ ok: true, status: 200, json: () => Promise.resolve(served()) });
      await vi.advanceTimersByTimeAsync(0);
      expect(commandRows()?.length, "the late answer of the first request does not count").toBe(2);
      expect(commandListStatus()).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets no request still out overwrite rows that were set or reset since it left", async () => {
    let late: (value: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      ),
    );
    loadCommands();
    __setCommandRows(coreCommandRows().slice(0, 1));
    late({ ok: true, status: 200, json: () => Promise.resolve(served()) });
    await flush();
    expect(commandRows()?.length, "the rows set after the request left stay").toBe(1);
  });

  it("asks again on a reconnect and keeps the rows it had until the answer", async () => {
    answer(served());
    loadCommands();
    await flush();
    const before = commandRows();

    const again = answer(served().slice(0, 2));
    reloadCommands();
    expect(again).toHaveBeenCalledTimes(1);
    expect(commandRows(), "the old rows stay while the reload is in flight").toBe(before);
    await flush();
    expect(commandRows()?.length).toBe(2);
  });
});

describe("a row read off the answer", () => {
  it("defaults what the file leaves out: no aliases, no sub, wired", () => {
    expect(rowOf({ id: "x", name: "x", takesArgs: false, help: { en: "X" } })).toEqual({
      id: "x",
      name: "x",
      aliases: [],
      sub: null,
      takesArgs: false,
      group: "chat",
      surfaces: "both",
      developerOnly: false,
      wired: true,
      help: { en: "X" },
    });
  });

  it("drops a row without an id or a name", () => {
    expect(rowOf({ name: "x" })).toBeNull();
    expect(rowOf({ id: "x" })).toBeNull();
    expect(rowOf("x")).toBeNull();
  });
});

describe("the rows the web chat offers", () => {
  const rows = coreCommandRows();

  it("are the web's and both faces' wired rows", () => {
    const ids = webCommands(rows, "developer").map((r) => r.id);
    expect(ids).toContain("run-with-playbook");
    expect(ids).toContain("help");
    expect(ids, "a terminal-only row").not.toContain("goal");
    expect(ids, "a row another card wires").not.toContain("codegraph");
    for (const row of webCommands(rows, "developer")) {
      expect(["web", "both"]).toContain(row.surfaces);
      expect(row.wired).toBe(true);
    }
  });

  it("leave the developer rows out in learn and light", () => {
    for (const mode of ["learn", "light"] as const) {
      const shown = webCommands(rows, mode);
      expect(shown.some((r) => r.developerOnly)).toBe(false);
      expect(shown.map((r) => r.id)).toContain("clear");
    }
  });
});
