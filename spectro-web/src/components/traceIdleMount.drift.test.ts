// Card 175. Where the hidden trace is mounted, and when.
//
// This guard is about a shape no pure test can reach: which JSX condition the
// trace hangs from in a 2,600-line component, which term the warm gate is armed
// from, and in which order the two are read. This project's vitest runs without
// a DOM, so the alternative to reading the source is trusting a comment.
//
// The rule itself — when a record counts as warm — is not pinned here but in
// `traceWarmup.test.ts`, which drives the shipped gate through a sequence of
// renders. This file only pins the wiring that reaches it.
//
// The four ways it has been wrong, or would be:
//
//   1. UNMOUNTED WHILE ANOTHER TAB SHOWS — the shape before this card. Every
//      press rebuilt the whole list: 955 ms of blocked main thread when the card
//      was opened, about 50 ms once card 117 windowed the build. Measured on
//      `20260805-155913-624f5baf`, 9,319 rows.
//
//   2. MOUNTED IN THE SAME PASS AS THE CHAT — the shape the August build
//      shipped, and the trap this card's own story names ("mounting the trace
//      together with the chat does not move the cost, it moves the delay onto
//      the chat").
//
//   3. WARM-UP READ BEFORE SHOWING — a press would then wait for an idle
//      callback that a busy page may hold for up to WARM_DEADLINE_MS. The tab
//      the reader just pressed must never wait on a background nicety.
//
//   4. WARMED WHERE THERE IS NO TRACE TO WARM — inside a fleet, `traceEntries`
//      becomes `traceFromEvents(shownEvents)` on the render path, so a warm
//      trace left mounted there folds the FLEET's events beside the fleet's own
//      chat, and when the fleet's trace tab shows, two TraceViews are mounted at
//      once. The gate and the showing condition therefore share one term.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** Blank out comments, keeping newlines, so the prose above cannot satisfy the
 *  guard it describes. */
const code = app.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");

/** The body of a `const <name> = …;` declaration, or null when there is none. */
function declaration(name: string): string | null {
  const found = new RegExp(`\\n {2}const ${name} =([\\s\\S]*?);\\n`).exec(code);
  return found === null ? null : found[1];
}

describe("the trace is built while the reader is elsewhere, after the chat has painted", () => {
  it("still finds the two things it is about, so a clean pass is not a broken parser", () => {
    expect(code).toContain("traceShowing");
    expect(code).toContain("useTraceWarm");
  });

  it("mounts the trace when it is showing OR once the browser has been idle", () => {
    // Not `traceShowing` alone: that is the pre-card shape, and the press pays
    // the whole build. Not unconditional either: that is the August shape, and
    // the chat pays it.
    expect(code).toMatch(/\{\(traceShowing \|\| traceWarm\) && \(/);
  });

  it("shows it on the press without waiting for idle", () => {
    // Order is the guarantee. `traceShowing` first means a press short-circuits
    // the warm-up entirely — the tab the reader is asking for renders in that
    // same commit, exactly as it did before the warm-up existed.
    //
    // Matched loosely enough to survive the terms being SWAPPED, so this fails
    // on the order and says so, instead of losing its anchor and failing the
    // same way the test above already does.
    const gate = /\{\((traceShowing|traceWarm) \|\| (traceShowing|traceWarm)\) && \(/.exec(code);
    expect(gate).not.toBeNull();
    expect(gate?.[1]).toBe("traceShowing");
    expect(gate?.[2]).toBe("traceWarm");
    // And the visibility of the mounted view still follows the tab alone, so a
    // warm trace stays hidden until it is asked for.
    expect(code).toMatch(/display: traceShowing \? "contents" : "none"/);
  });

  it("keys the warm-up on the record LOADED, not on the name it shares with the last open", () => {
    // The cost is per record, and per OPEN: `openSession` fetches the events
    // again and folds them again, so re-opening the session already on screen
    // has a whole trace to build. Keyed on the session id, that arrival is
    // invisible and the build lands in the chat's render pass.
    const record = declaration("traceRecord");
    expect(record).not.toBeNull();
    expect(record).toContain("replay");
    expect(record).not.toMatch(/replay\s*[?.]*\.id/);
    expect(code).toMatch(/const traceWarm = useTraceWarm\(traceRecord, traceReachable\)/);
  });

  it("arms the warm-up only where a trace could be shown at all", () => {
    // One term, two readers: `traceShowing` is this plus the tab, and the warm
    // gate is this alone. Written twice they drift, and the drift is finding 4
    // above — a trace warmed inside a fleet.
    const reachable = declaration("traceReachable");
    expect(reachable).not.toBeNull();
    expect(reachable).toContain("enteredFleet === null");
    expect(reachable).toContain('nav === "sessions"');
    expect(code).toMatch(/const traceShowing = traceReachable && tab === "trace"/);
  });

  it("keeps the fleet's own trace out of the warm gate", () => {
    // The fleet tab's TraceView is a different mount site inside its own chain,
    // reached only when that tab is the one showing. Nothing warms there, and
    // nothing may start to.
    const fleetArm = code.slice(code.indexOf('fleetTab === "trace"'));
    expect(fleetArm.slice(0, 400)).not.toContain("traceWarm");
  });

  it("tells the trace whether it is the surface the reader is looking at", () => {
    // The mounted-but-hidden trace shares one search store with chat and text
    // (`state/search.ts`), and a view nobody is looking at must not speak for
    // it. Without this the chat's hit count is overwritten by the hidden
    // trace's, because the trace's effect runs after the chat's.
    expect(code).toMatch(/showing=\{traceShowing\}/);
  });
});
