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

/**
 * Every `<TraceView …/>` in App.tsx, props text only.
 *
 * The first version of this file read `lastIndexOf("<TraceView")` and pinned
 * that one mount. It walked straight past the other one on the way — and the
 * other one was wrong.
 */
function traceMounts(): string[] {
  const out: string[] = [];
  for (let at = app.indexOf("<TraceView"); at !== -1; at = app.indexOf("<TraceView", at + 1)) {
    out.push(app.slice(at, app.indexOf("/>", at)));
  }
  return out;
}

describe("the live trace window reaches the screen honestly", () => {
  it("a resumed archive is bounded before the socket starts appending to it", () => {
    expect(body("resumeSession")).toContain("setLive(seedResumedLive(seeded))");
  });

  it("has exactly the two trace mounts this file knows about", () => {
    // A third one would be unpinned, and an unpinned mount is how the fleet's
    // pane came to announce another record's losses for a whole release.
    expect(traceMounts()).toHaveLength(2);
  });

  it("the pane is told the dropped count of the record it is SHOWING", () => {
    // The sessions/archive trace, identified by the prop only it takes.
    const props = traceMounts().find((m) => m.includes("llmWireSessionId="));
    expect(props).toBeDefined();
    // `view` is the wrong source too: under a translation it is a fresh fold of
    // the translated events, whose traceDropped is 0 while the rows on screen
    // are still the windowed ones — the disclosure would vanish mid-session.
    expect(props).toContain("droppedRows={recordedView.traceDropped}");
  });

  it("the fleet's trace, which windows nothing, claims no losses", () => {
    // The fleet pane is fed `traceFromEvents(shownEvents)`: a flat map over the
    // fleet's own frames, seq from 1, no window and no count. It was handed
    // `live.traceDropped` — THIS browser's session socket — so entering a demo
    // fleet after a windowed live run drew 45 complete rows under the line
    // "last 45 of 4047 · 4002 fell out of the live window", with a tooltip that
    // said in the same breath that the record begins at seq 1. Not a rounding
    // error: the two numbers came from two different records.
    const fleet = traceMounts().find((m) => !m.includes("llmWireSessionId="));
    expect(fleet).toBeDefined();
    expect(fleet).toContain("agentFilter={traceAgent}");
    expect(fleet).not.toContain("droppedRows=");
    // Exactly one pane in this file may claim a loss, and the source it claims
    // it from is `recordedView` — which resolves to `live` on its own when a
    // live session really is the record on screen. Reading the socket directly
    // is the defect, whichever pane does it.
    expect(traceMounts().filter((m) => m.includes("droppedRows="))).toHaveLength(1);
    expect(app).not.toContain("droppedRows={live.");
  });

  it("the fleet's rows really are the unwindowed fold the test above assumes", () => {
    // The premise of the pin, kept next to it: if this ever became a windowed
    // fold, the fleet pane would need a disclosure of its OWN, not none.
    expect(app).toContain("traceFromEvents(shownEvents) : view.trace");
  });

  it("the pane counts the RECORD for its disclosure, not the list it draws", () => {
    // The seam that was wrong on main: the count came from `allEntries`, which
    // is the record PLUS a response row per llm_exchange, plus any voice rows,
    // plus the synthetic system_context row. Measured on a 9000-frame stream
    // carrying four exchanges, the pane announced "last 5004 of 9004".
    //
    // Read off disk because there is no DOM in this suite, the same way this
    // file already reads App.tsx.
    const view = readFileSync(fileURLToPath(new URL("../components/TraceView.tsx", import.meta.url)), "utf8");
    const call = view.slice(view.indexOf("traceDisclosure("), view.indexOf("traceDisclosure(") + 120);
    expect(call).toContain("traceDisclosure(entries,");
    expect(call).not.toContain("allEntries");

    // And the rendered line reads only from that result, so no second, unpinned
    // arithmetic can grow beside it.
    const span = view.slice(view.indexOf("<span"), view.indexOf("</span>", view.indexOf("trace-dropped")));
    const disclosure = span.slice(span.indexOf("trace-dropped"));
    expect(disclosure).not.toContain("allEntries.length");
  });

  it("the disclosure the pane draws actually has a rule to draw it with", () => {
    // `.trace-dropped` shipped on main naming a class no stylesheet defined, so
    // the one line that admits the trace is a window rendered as unstyled body
    // text next to a mono, nowrap search note — and nothing anywhere complained.
    // A missing CSS class is as silent as the missing token phantomTokens.drift
    // was written for. Narrow on purpose: these two are the toolbar's read-outs
    // about what the reader is NOT seeing, and they have to look like siblings.
    const css = readFileSync(fileURLToPath(new URL("../styles/panels.css", import.meta.url)), "utf8");
    for (const cls of [".trace-dropped", ".trace-search-note"]) {
      expect(css, `${cls} has no rule`).toContain(`${cls} {`);
    }
  });
});
