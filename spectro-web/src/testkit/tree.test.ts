// Card 460: the kit's own pin for the shared source-tree reader. Twenty-one
// drift tests walked src/ themselves and read every file in the test body; on
// 2026-09-29 ten of them timed out under load. They now ask this reader, so
// what it returns has to be exactly what their own walks returned: the same
// files, in the same order, with the same text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ reads: new Map<string, number>(), readdirs: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: string, ...rest: unknown[]) => {
    calls.reads.set(String(path), (calls.reads.get(String(path)) ?? 0) + 1);
    return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  const readdirSync = ((...a: unknown[]) => {
    calls.readdirs++;
    return (fs.readdirSync as (...b: unknown[]) => unknown)(...a);
  }) as typeof fs.readdirSync;
  return { ...fs, default: { ...fs, readFileSync, readdirSync }, readFileSync, readdirSync };
});

import { srcFiles, srcText } from "./tree";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** The walk the drift tests carried, verbatim in shape: readdir, stat, recurse. */
function reference(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...reference(path));
    else out.push(path);
  }
  return out;
}

describe("srcFiles", () => {
  it("lists every file under src, in the order the old walks found them", () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(reference(SRC));
  });

  it("narrows to one folder at any depth, with or without the trailing slash", () => {
    const styles = reference(join(SRC, "styles"));
    expect(styles.length).toBeGreaterThan(10);
    expect(srcFiles(join(SRC, "styles"))).toEqual(styles);
    expect(srcFiles(join(SRC, "styles") + "/")).toEqual(styles);
    expect(srcFiles(fileURLToPath(new URL("../styles/", import.meta.url)))).toEqual(styles);
  });

  it("does not take a folder whose name only starts like the one asked for", () => {
    // src/state and src/stategraph share a prefix; the match is on a whole segment.
    const state = srcFiles(join(SRC, "state"));
    expect(state.length).toBeGreaterThan(10);
    expect(srcFiles(join(SRC, "stategraph")).length).toBeGreaterThan(0);
    expect(state.filter((f) => f.startsWith(join(SRC, "stategraph")))).toEqual([]);
  });

  it("refuses a folder outside src rather than answering with nothing", () => {
    expect(() => srcFiles(join(SRC, ".."))).toThrow(/not under src/);
  });

  it("refuses a folder that is not there, or a file, rather than answering with nothing", () => {
    // A typo in a guard's folder would otherwise make every negative assertion
    // under it pass on an empty list.
    expect(() => srcFiles(join(SRC, "no-such-folder"))).toThrow(/not a folder under src/);
    expect(() => srcFiles(join(SRC, "App.tsx"))).toThrow(/not a folder under src/);
  });

  it("walks the disk once per process, however often it is asked", () => {
    srcFiles();
    const before = calls.readdirs;
    srcFiles();
    srcFiles(join(SRC, "styles"));
    expect(calls.readdirs).toBe(before);
  });
});

describe("srcText", () => {
  it("loads the texts once per process: later calls open nothing at all", () => {
    srcText(join(SRC, "main.tsx"));
    const opened = [...calls.reads.values()].reduce((sum, n) => sum + n, 0);
    srcText(join(SRC, "main.tsx"));
    srcText(join(SRC, "tokens.css"));
    srcText(join(SRC, "styles", "chat.css"));
    expect([...calls.reads.values()].reduce((sum, n) => sum + n, 0)).toBe(opened);
  });

  it("reads each file at most once per process", () => {
    // The first srcText call in this process already built the whole text map
    // (the test above did it), and under a cold snapshot that build read this
    // file from disk once. So the count here is 0 or 1 before we start, not a
    // virgin 0: measure what these three calls add, not the absolute count.
    const file = join(SRC, "App.tsx");
    const before = calls.reads.get(file) ?? 0;
    const text = srcText(file);
    srcText(file);
    srcText(file);
    // The three calls read nothing new: srcText serves the in-memory map.
    expect(calls.reads.get(file) ?? 0).toBe(before);
    // And across the whole process the file is read from disk at most once.
    expect(calls.reads.get(file) ?? 0).toBeLessThanOrEqual(1);
    expect(text).toContain("export");
  });

  // Every file is compared, twenty per test: one test that opens the whole
  // tree is the very shape that timed out under load, and a block of a hundred
  // still took 5.6 s in a full run on 2026-09-29.
  const every = reference(SRC);
  const blocks = Array.from({ length: Math.ceil(every.length / 20) }, (_, i) => [
    i * 20,
    every.slice(i * 20, i * 20 + 20),
  ]) as [number, string[]][];

  it("compares every file the walk finds, split into blocks", () => {
    expect(blocks.flatMap(([, files]) => files)).toEqual(every);
  });

  it.each(blocks)("gives files %i onwards the text readFileSync gives them", (_, files) => {
    const differ = files.filter((f) => srcText(f) !== readFileSync(f, "utf8"));
    expect(differ).toEqual([]);
  });

  it("accepts the path however the caller spelled it", () => {
    const direct = join(SRC, "tokens.css");
    expect(srcText(`${SRC}/styles/../tokens.css`)).toBe(srcText(direct));
    expect(srcText(direct)).toContain(":root");
  });

  it("refuses a path that is not a file under src", () => {
    expect(() => srcText(join(SRC, "no-such-file.ts"))).toThrow(/not a file under src/);
    expect(() => srcText(join(SRC, "styles"))).toThrow(/not a file under src/);
  });
});
