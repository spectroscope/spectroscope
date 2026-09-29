// The source tree as the drift suite reads it (card 460). Twenty-one tests
// walked src/ on their own and read every file inside the test body, so one
// run opened the same eleven hundred files twenty-odd times over. On
// 2026-09-29, with 14 workers and a load average of 171, ten of them timed out
// at 5000 ms. They now ask this module: one walk per process, and the texts
// from a snapshot that all processes share.
//
// Vitest runs every test file in a fresh process here (pool forks, isolate on),
// so an in-memory cache alone would still read the tree once per test file.
// The snapshot in node_modules/.cache carries the texts across processes and
// runs. It never serves a stale text: each file is checked against its size,
// mtime, ctime and inode first, and whatever moved is read from disk again.
//
// Test-only by construction: nothing under src/ imports this module except
// *.test.* files, so it never reaches the shipped bundle.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** src/, absolute, without a trailing separator. */
const SRC = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Where the shared snapshot lives: ignored by git, one per checkout. */
const CACHE = resolve(
  fileURLToPath(new URL("../../node_modules/.cache/spectro-testkit/src-tree.json", import.meta.url)),
);

let files: string[] | undefined;
let texts: Map<string, string> | undefined;

/** Depth first, in readdir order: the order every hand-written walk here used. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function tree(): string[] {
  files ??= walk(SRC);
  return files;
}

/**
 * Every file under `under` and its subfolders, as absolute paths, in the order
 * a recursive readdir finds them.
 *
 * @param under a folder under src/ (default: src/ itself); a trailing slash is fine
 * @returns absolute paths, the same strings `join(dir, entry)` builds
 * @throws Error when `under` is not src/ or a folder inside it
 */
export function srcFiles(under: string = SRC): string[] {
  const root = resolve(under);
  if (root === SRC) return [...tree()];
  if (!root.startsWith(SRC + sep)) throw new Error(`${under} is not under src/`);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${under} is not a folder under src/`);
  return tree().filter((file) => file.startsWith(root + sep));
}

/**
 * The text of one file under src/, as `readFileSync(path, "utf8")` returns it,
 * read at most once per process.
 *
 * @param path an absolute path to a file under src/, spelled any way `resolve` accepts
 * @throws Error when the path is not a file the walk found
 */
export function srcText(path: string): string {
  const file = resolve(path);
  texts ??= loadTexts(tree(), CACHE);
  const text = texts.get(file);
  if (text === undefined) throw new Error(`${path} is not a file under src/`);
  return text;
}

/** What a file looked like when its text was taken: size, mtime, ctime, inode. */
type Stamp = [number, number, number, number];

/** The snapshot on disk: one stamp and one text per absolute path. */
interface Snapshot {
  version: 1;
  files: Record<string, [...Stamp, string]>;
}

/** The stamp of a file, or undefined when it has gone since the walk. */
function stampOf(file: string): Stamp | undefined {
  const s = statSync(file, { throwIfNoEntry: false });
  return s === undefined ? undefined : [s.size, s.mtimeMs, s.ctimeMs, s.ino];
}

/** An entry this module wrote: four numbers and a text. Anything else is a miss. */
function isEntry(hit: unknown): hit is [...Stamp, string] {
  return (
    Array.isArray(hit) &&
    hit.length === 5 &&
    hit.slice(0, 4).every((value) => typeof value === "number") &&
    typeof hit[4] === "string"
  );
}

function readSnapshot(cacheFile: string): Snapshot["files"] {
  try {
    const snap = JSON.parse(readFileSync(cacheFile, "utf8")) as Snapshot;
    return snap.version === 1 && typeof snap.files === "object" && snap.files !== null ? snap.files : {};
  } catch {
    return {};
  }
}

/**
 * The text of every file in `list`: from the snapshot where the file's stamp
 * still matches, from disk where it does not. Rewrites the snapshot when
 * anything was read or dropped. Exported for its own test.
 *
 * @param list absolute paths of the files wanted
 * @param cacheFile where the snapshot is kept
 * @returns path to text, in the order of `list`
 */
export function loadTexts(list: readonly string[], cacheFile: string): Map<string, string> {
  const old = readSnapshot(cacheFile);
  const next: Snapshot = { version: 1, files: {} };
  const out = new Map<string, string>();
  let changed = Object.keys(old).length !== list.length;
  for (const file of list) {
    const stamp = stampOf(file);
    if (stamp === undefined) {
      changed = true;
      continue;
    }
    const hit: unknown = old[file];
    let text: string;
    if (isEntry(hit) && stamp.every((value, i) => value === hit[i])) {
      text = hit[4];
    } else {
      text = readFileSync(file, "utf8");
      changed = true;
    }
    out.set(file, text);
    next.files[file] = [...stamp, text];
  }
  if (changed) {
    // Written aside and renamed into place, so a process that reads while
    // another writes sees the old snapshot or the new one, never half of one.
    const aside = `${cacheFile}.${process.pid}.${Date.now()}`;
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(aside, JSON.stringify(next));
      renameSync(aside, cacheFile);
    } catch {
      // A snapshot that cannot be written only costs the next process a read.
      rmSync(aside, { force: true });
    }
    sweepAsides(cacheFile);
  }
  return out;
}

/** Removes aside files older than ten minutes: left by a worker killed between write and rename. */
function sweepAsides(cacheFile: string): void {
  const dir = dirname(cacheFile);
  const prefix = `${basename(cacheFile)}.`;
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (
        name.startsWith(prefix) &&
        Date.now() - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 600_000
      ) {
        rmSync(path, { force: true });
      }
    }
  } catch {
    // Nothing to sweep.
  }
}
