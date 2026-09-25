// Card 435, criterion 1: opening a recorded session builds no trace rows.
//
// The fold is found where the opens call it: the test reads App.tsx for the
// fold each open runs, folds a recorded fixture of 10,044 events through that
// very function and counts the trace rows in what it returns. Before this card
// the session open and the import folded with foldArchiveSliced and the
// scenario with foldArchive, and each built one row per event.

import { describe, expect, it } from "vitest";
import * as archiveFold from "./archiveFold";
import type { UiState } from "./reducer";
import { archiveEvents } from "../testkit/archiveEvents";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const EVENTS = archiveEvents(10_000);

/** The body of `const name = ...` in App, up to its closing `};` line. */
function fn(name: string): string {
  const at = app.indexOf(`  const ${name} = `);
  if (at < 0) throw new Error(`App declares no ${name}`);
  return app.slice(at, app.indexOf("\n  };\n", at));
}

/** A trace row: a seq, a direction and a payload. */
function isRow(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const row = value as { seq?: unknown; dir?: unknown };
  return typeof row.seq === "number" && (row.dir === "in" || row.dir === "out") && "payload" in row;
}

/** The trace rows in a fold's result: in any list up to two levels down, so
 *  the state's own trace and any list returned beside the state both count. */
function rowsIn(result: unknown): number {
  let rows = 0;
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || seen.has(value) || depth > 2) return;
    seen.add(value);
    if (Array.isArray(value)) {
      rows += value.filter(isRow).length;
      return;
    }
    for (const inner of Object.values(value)) walk(inner, depth + 1);
  };
  walk(result, 0);
  return rows;
}

/** The chat state in a fold's result, whether the fold returns the state or a record holding it. */
function stateOf(result: unknown): UiState {
  const held = result as { state?: UiState };
  return held.state !== undefined && Array.isArray(held.state.turns) ? held.state : (result as UiState);
}

type AnyFold = (events: unknown, options?: unknown) => unknown;

/** The archiveFold function an open calls on its events. */
function foldOf(open: string): { name: string; fold: AnyFold } {
  const m = /\b(fold\w*)\(events\b/.exec(fn(open));
  if (m === null) throw new Error(`${open} calls no fold on its events`);
  const fold = (archiveFold as unknown as Record<string, unknown>)[m[1]];
  if (typeof fold !== "function") throw new Error(`${m[1]} is not an export of archiveFold`);
  return { name: m[1], fold: fold as AnyFold };
}

const SLICES = { isCurrent: () => true, yieldToBrowser: () => Promise.resolve() };

describe("the archive open builds no trace rows (criterion 1)", () => {
  for (const open of ["openSession", "openImport", "openScenario"]) {
    it(`${open}: its fold holds the chat and no trace row`, async () => {
      const { fold } = foldOf(open);
      const result = await fold(EVENTS, SLICES);
      expect(result).not.toBeNull();
      // The fold really ran, so a result without rows is not an empty fold.
      expect(stateOf(result).turns.length).toBeGreaterThan(100);
      expect(rowsIn(result)).toBe(0);
    });
  }

  it("counts rows where there are some, so a zero is not a blind counter", () => {
    expect(rowsIn(archiveFold.foldArchive(EVENTS))).toBe(EVENTS.length);
  });
});
