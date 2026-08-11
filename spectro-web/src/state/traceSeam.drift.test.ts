// Card 116 says the trace may window a live stream but may never do it quietly.
// The reducer half of that is pinned in reducer.test.ts and resume.test.ts: the
// fold keeps every row, `windowTrace` cuts only at the live seam and counts what
// it cut. Both halves are still only as true as the two lines in App.tsx that
// join them to the screen, and there is no DOM in this suite — so this reads
// them off disk, the way componentReach.drift.test.ts reads its seams.
//
// Both lines were wrong at once and in opposite directions: a resumed archive
// went into live state unbounded, and the pane that draws the disclosure was
// handed the LIVE socket's count while it was showing a stored session.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** @return the body of a top-level `const <name> = ...` up to its closing `};` */
function body(name: string): string {
  const from = app.indexOf(`const ${name}`);
  expect(from).toBeGreaterThan(-1);
  const rest = app.slice(from);
  return rest.slice(0, rest.indexOf("\n  };"));
}

describe("the live trace window reaches the screen honestly", () => {
  it("a resumed archive is bounded before the socket starts appending to it", () => {
    expect(body("resumeSession")).toContain("setLive(seedResumedLive(seeded))");
  });

  it("the pane is told the dropped count of the record it is SHOWING", () => {
    // The last mount is the sessions/archive trace (the earlier one belongs to
    // an entered fleet), identified by the prop only it takes.
    const from = app.lastIndexOf("<TraceView");
    const props = app.slice(from, app.indexOf("/>", from));
    expect(props).toContain("llmWireSessionId=");
    // `view` is the wrong source too: under a translation it is a fresh fold of
    // the translated events, whose traceDropped is 0 while the rows on screen
    // are still the windowed ones — the disclosure would vanish mid-session.
    expect(props).toContain("droppedRows={recordedView.traceDropped}");
  });
});
