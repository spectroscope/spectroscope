// Card 460: the snapshot behind srcText(). Every test file runs in its own
// process, so an in-memory cache alone still reads the tree once per test
// file. The snapshot carries the texts across processes. A snapshot that can
// serve a stale text would weaken every guard built on the reader, so what is
// pinned here is that it never does: each file is checked against its size,
// mtime, ctime and inode, and anything that moved is read from disk again.
// Each of the four fields is pinned on its own with a hand-made snapshot; the
// tests that really edit a file wait for the file system clock to move first,
// because ext4 and tmpfs keep ctime on a coarse tick.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  reads: [] as string[],
  writes: [] as string[],
  renames: [] as string[][],
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: string, ...rest: unknown[]) => {
    calls.reads.push(String(path));
    return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  const writeFileSync = ((path: string, ...rest: unknown[]) => {
    calls.writes.push(String(path));
    return (fs.writeFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.writeFileSync;
  const renameSync = ((from: string, to: string) => {
    calls.renames.push([String(from), String(to)]);
    return fs.renameSync(from, to);
  }) as typeof fs.renameSync;
  const mocked = { readFileSync, writeFileSync, renameSync };
  return { ...fs, default: { ...fs, ...mocked }, ...mocked };
});

import { loadTexts } from "./tree";

// One scratch folder for the file, one subfolder per test: every file created
// here costs time on a loaded machine, so the setup creates no more than the
// tests need.
let root: string;
let n = 0;
let cache: string;
let a: string;
let b: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tree-snapshot-"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  const dir = join(root, String(++n));
  mkdirSync(dir);
  a = join(dir, "a.ts");
  b = join(dir, "b.css");
  writeFileSync(a, "export const a = 1;\n");
  writeFileSync(b, ".b { color: red; }\n");
  cache = join(dir, "tree.json");
  calls.reads.length = 0;
  calls.writes.length = 0;
  calls.renames.length = 0;
});

/** Waits until a file created now gets a later ctime than `after`, so an edit
 *  made next cannot share a coarse clock tick with the stamp it must beat. */
function pastTick(after: number): void {
  const probe = join(dirname(a), "tick");
  for (let i = 0; i < 100_000; i++) {
    writeFileSync(probe, String(i));
    if (statSync(probe).ctimeMs > after) return;
  }
  throw new Error("the file system clock did not move");
}

/** Rewrites one entry of the snapshot on disk, as a foreign writer would. */
function patchEntry(file: string, patch: (entry: unknown[]) => unknown): void {
  const snap = JSON.parse(readFileSync(cache, "utf8")) as { files: Record<string, unknown[]> };
  snap.files[file] = patch([...snap.files[file]]) as unknown[];
  writeFileSync(cache, JSON.stringify(snap));
  calls.reads.length = 0;
  calls.writes.length = 0;
  calls.renames.length = 0;
}

const sourceReads = (): string[] => calls.reads.filter((path) => path !== cache);

describe("loadTexts", () => {
  it("reads every file from disk the first time and leaves a snapshot behind", () => {
    const texts = loadTexts([a, b], cache);
    expect(texts.get(a)).toBe("export const a = 1;\n");
    expect(texts.get(b)).toBe(".b { color: red; }\n");
    expect(sourceReads().sort()).toEqual([a, b].sort());
    expect(statSync(cache).size).toBeGreaterThan(0);
  });

  it("opens no source file when nothing has moved since the snapshot", () => {
    loadTexts([a, b], cache);
    calls.reads.length = 0;
    calls.writes.length = 0;
    calls.renames.length = 0;
    const texts = loadTexts([a, b], cache);
    expect(sourceReads()).toEqual([]);
    expect(calls.reads).toEqual([cache]);
    expect(calls.writes).toEqual([]);
    expect(calls.renames).toEqual([]);
    expect(texts.get(a)).toBe("export const a = 1;\n");
    expect(texts.get(b)).toBe(".b { color: red; }\n");
  });

  it("sees an edit that keeps the size and puts the mtime back", () => {
    // A whole second, so utimes can put it back exactly; ctime still moves.
    utimesSync(a, 1_700_000_000, 1_700_000_000);
    loadTexts([a, b], cache);
    const before = statSync(a);
    pastTick(before.ctimeMs);
    writeFileSync(a, "export const b = 2;\n");
    utimesSync(a, 1_700_000_000, 1_700_000_000);
    expect(statSync(a).size).toBe(before.size);
    expect(statSync(a).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(a).ino).toBe(before.ino);
    calls.reads.length = 0;
    const texts = loadTexts([a, b], cache);
    expect(texts.get(a)).toBe("export const b = 2;\n");
    expect(sourceReads()).toEqual([a]);
  });

  it("sees an edit that changes the size", () => {
    loadTexts([a, b], cache);
    writeFileSync(b, ".b { color: blue; }\n");
    expect(loadTexts([a, b], cache).get(b)).toBe(".b { color: blue; }\n");
  });

  it("sees a file replaced by another under the same name", () => {
    utimesSync(a, 1_700_000_000, 1_700_000_000);
    loadTexts([a, b], cache);
    pastTick(statSync(a).ctimeMs);
    rmSync(a);
    writeFileSync(a, "export const z = 9;\n");
    utimesSync(a, 1_700_000_000, 1_700_000_000);
    expect(loadTexts([a, b], cache).get(a)).toBe("export const z = 9;\n");
  });

  it("reads a new file and forgets a removed one", () => {
    loadTexts([a, b], cache);
    const c = join(a, "..", "c.ts");
    writeFileSync(c, "export const c = 3;\n");
    rmSync(b);
    const texts = loadTexts([a, c], cache);
    expect([...texts.keys()]).toEqual([a, c]);
    expect(texts.get(c)).toBe("export const c = 3;\n");
    calls.reads.length = 0;
    loadTexts([a, c], cache);
    expect(sourceReads()).toEqual([]);
  });

  it("rebuilds from disk when the snapshot is unreadable", () => {
    loadTexts([a, b], cache);
    writeFileSync(cache, "{ not json");
    calls.reads.length = 0;
    const texts = loadTexts([a, b], cache);
    expect(texts.get(a)).toBe("export const a = 1;\n");
    expect(sourceReads().sort()).toEqual([a, b].sort());
  });

  it("does not trust a snapshot written in another shape", () => {
    loadTexts([a, b], cache);
    writeFileSync(cache, JSON.stringify({ version: 0, files: {} }));
    calls.reads.length = 0;
    loadTexts([a, b], cache);
    expect(sourceReads().sort()).toEqual([a, b].sort());
  });

  it("never writes the snapshot in place: it writes aside and renames, and leaves nothing behind", () => {
    loadTexts([a, b], cache);
    expect(calls.writes).not.toContain(cache);
    expect(calls.renames).toHaveLength(1);
    const [from, to] = calls.renames[0];
    expect(to).toBe(cache);
    expect(calls.writes).toContain(from);
    expect(readdirSync(dirname(cache)).filter((name) => name.startsWith("tree.json."))).toEqual([]);
  });

  it("serves the snapshot's text when every field of the stamp matches", () => {
    // The control for the four cases below: without a changed field the
    // hand-made text is what comes back, so the snapshot really is read.
    loadTexts([a, b], cache);
    patchEntry(a, (entry) => [...entry.slice(0, 4), "FROM THE SNAPSHOT"]);
    expect(loadTexts([a, b], cache).get(a)).toBe("FROM THE SNAPSHOT");
    expect(sourceReads()).toEqual([]);
  });

  it.each([
    ["size", 0],
    ["mtime", 1],
    ["ctime", 2],
    ["inode", 3],
  ])("reads a file from disk again when only its %s differs", (_, field) => {
    loadTexts([a, b], cache);
    patchEntry(a, (entry) =>
      entry.map((value, i) => (i === field ? (value as number) + 1 : i === 4 ? "STALE" : value)),
    );
    expect(loadTexts([a, b], cache).get(a)).toBe("export const a = 1;\n");
    expect(sourceReads()).toEqual([a]);
  });

  it.each([
    ["null", () => null],
    ["too short", (entry: unknown[]) => entry.slice(0, 2)],
    ["without a text", (entry: unknown[]) => [...entry.slice(0, 4), 42]],
  ])("treats an entry that is %s as missing", (_, patch) => {
    loadTexts([a, b], cache);
    patchEntry(a, patch);
    expect(loadTexts([a, b], cache).get(a)).toBe("export const a = 1;\n");
  });

  it("drops a file that vanished between the walk and the read", () => {
    const gone = join(dirname(a), "gone.ts");
    const texts = loadTexts([a, gone, b], cache);
    expect([...texts.keys()]).toEqual([a, b]);
  });
});
