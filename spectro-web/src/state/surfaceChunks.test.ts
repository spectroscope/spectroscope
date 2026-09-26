// Card 430, criterion 9: learn fetches the chunks of its surfaces once the
// browser is idle after the first render, so the first press on a tab does not
// wait for a download; light fetches none of them.

import { describe, expect, it } from "vitest";
import type { WarmHost } from "../components/traceWarmup";
import { read, stripComments } from "../testkit/source";
import { chunk, ChunkLoadError, prefetchSurfaces, SURFACE_LOADERS } from "./surfaceChunks";
import { SURFACES, type SurfaceId } from "./surfaces";

/** A host whose idle callback runs only when the test says so. */
function idleHost(): { host: WarmHost; idle: () => void; scheduled: () => number } {
  const tasks: Array<() => void> = [];
  return {
    host: {
      requestIdleCallback: (task) => tasks.push(task),
      cancelIdleCallback: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    idle: () => {
      for (const task of tasks.splice(0)) task();
    },
    scheduled: () => tasks.length,
  };
}

/** Loaders that count their calls, one per chunked module of the table. */
function countingLoaders(): { loaders: typeof SURFACE_LOADERS; calls: string[] } {
  const calls: string[] = [];
  const loaders: typeof SURFACE_LOADERS = {};
  for (const id of Object.keys(SURFACES) as SurfaceId[]) {
    const chunks = SURFACES[id].chunks;
    if (chunks === undefined) continue;
    loaders[id] = chunks.map((module) => () => {
      calls.push(module);
      return Promise.resolve();
    });
  }
  return { loaders, calls };
}

describe("fetching the chunks on idle", () => {
  it("fetches nothing in light, and schedules nothing", () => {
    const { host, idle, scheduled } = idleHost();
    const { loaders, calls } = countingLoaders();
    prefetchSurfaces("light", host, loaders);
    expect(scheduled()).toBe(0);
    idle();
    expect(calls).toEqual([]);
  });

  it("fetches every chunk in learn, and only once the browser is idle (twin)", () => {
    const { host, idle } = idleHost();
    const { loaders, calls } = countingLoaders();
    prefetchSurfaces("learn", host, loaders);
    expect(calls).toEqual([]);
    idle();
    const expected = (Object.keys(SURFACES) as SurfaceId[]).flatMap((id) => SURFACES[id].chunks ?? []);
    expect([...calls].sort()).toEqual([...expected].sort());
    expect(calls.length).toBeGreaterThanOrEqual(13);
  });

  it("fetches nothing once cancelled, as a switch to light cancels it", () => {
    const { host, idle } = idleHost();
    const { loaders, calls } = countingLoaders();
    const cancel = prefetchSurfaces("learn", host, loaders);
    cancel();
    idle();
    expect(calls).toEqual([]);
  });

  it("leaves a chunk that failed to arrive for the press that needs it", async () => {
    const { host, idle } = idleHost();
    let settled = false;
    prefetchSurfaces("learn", host, {
      trace: [
        () =>
          Promise.reject(new Error("offline")).finally(() => {
            settled = true;
          }),
      ],
    });
    idle();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});

describe("the real loaders", () => {
  it("has one loader per chunked module of the table, per surface", () => {
    for (const id of Object.keys(SURFACES) as SurfaceId[]) {
      expect(SURFACE_LOADERS[id]?.length ?? 0, id).toBe(SURFACES[id].chunks?.length ?? 0);
    }
  });

  it("is asked for by App on every mode change, with the window as the host", () => {
    const app = stripComments(read("../App.tsx", import.meta.url));
    expect(app).toContain("useEffect(() => prefetchSurfaces(viewMode, window), [viewMode]);");
  });
});

describe("a failed import is told apart from any other error (review of criterion 9)", () => {
  it("turns a rejected import into a ChunkLoadError that names the module and keeps the cause", async () => {
    const cause = new TypeError("Failed to fetch dynamically imported module: /assets/TraceView-x.js");
    const load = chunk("components/TraceView", () => Promise.reject(cause));
    const error: unknown = await load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).module).toBe("components/TraceView");
    expect((error as ChunkLoadError).cause).toBe(cause);
  });

  it("hands a module that arrived through unchanged (twin)", async () => {
    const module = { TraceView: () => null };
    await expect(chunk("components/TraceView", () => Promise.resolve(module))()).resolves.toBe(module);
  });

  it("tags every import() of surfaceChunks.ts, so each lazy view fails as a ChunkLoadError", () => {
    const src = stripComments(read("./surfaceChunks.ts", import.meta.url));
    const imports = [...src.matchAll(/import\("\.\.\/([^"]+)"\)/g)].map((m) => m[1]);
    const tagged = [...src.matchAll(/chunk\("([^"]+)", \(\) => import\("\.\.\/([^"]+)"\)\)/g)];
    expect(imports.length).toBeGreaterThanOrEqual(13);
    expect(tagged.map((m) => m[2])).toEqual(imports);
    for (const m of tagged) expect(m[1], "the name a tagged loader gives its module").toBe(m[2]);
  });
});
