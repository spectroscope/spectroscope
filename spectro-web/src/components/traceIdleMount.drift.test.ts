// Card 175. Where the hidden trace is mounted, and when.
//
// This guard is about a shape no pure test can reach: which JSX condition the
// trace hangs from in a 2,600-line component, and in which order its two terms
// are read. This project's vitest runs without a DOM, so the alternative to
// reading the source is trusting a comment.
//
// The three ways it has been wrong, or would be:
//
//   1. UNMOUNTED WHILE ANOTHER TAB SHOWS — the shape before this card. Every
//      press rebuilt the whole list: 955 ms of blocked main thread when the card
//      was opened, about 50 ms once card 117 windowed the build. Measured on
//      `20260805-155913-624f5baf`, 9,319 rows.
//
//   2. MOUNTED IN THE SAME PASS AS THE CHAT — the shape the August build
//      shipped, and the trap this card's own story names ("mounting the trace
//      together with the chat does not move the cost, it moves the delay onto
//      the chat"). The counterfactual, first blocked task of opening that
//      session, four runs each: 563/601/621/637 ms beside the chat against
//      361/367/412/481 ms absent.
//
//   3. WARM-UP READ BEFORE SHOWING — a press would then wait for an idle
//      callback that a busy page may hold for up to WARM_DEADLINE_MS. The tab
//      the reader just pressed must never wait on a background nicety.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

/** Blank out comments, keeping newlines, so the prose above cannot satisfy the
 *  guard it describes. */
const code = app.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");

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
    const gate = code.slice(code.indexOf("{(traceShowing"));
    expect(gate.indexOf("traceShowing")).toBeLessThan(gate.indexOf("traceWarm"));
    // And the visibility of the mounted view still follows the tab alone, so a
    // warm trace stays hidden until it is asked for.
    expect(code).toMatch(/display: traceShowing \? "contents" : "none"/);
  });

  it("keys the warm-up on the record on screen, not on the app's lifetime", () => {
    // The cost is per record: every session opened folds a new stream and builds
    // new rows. A gate armed once would spare the first session's chat and let
    // every later one pay again.
    expect(code).toMatch(/const traceWarm = useTraceWarm\(shownSessionId\)/);
  });

  it("keeps the fleet's own trace out of the warm gate", () => {
    // The fleet tab's TraceView is a different mount site inside its own chain,
    // reached only when that tab is the one showing. Nothing warms there, and
    // nothing may start to: it would build a second full trace behind the
    // fleet's chat.
    const fleetArm = code.slice(code.indexOf('fleetTab === "trace"'));
    expect(fleetArm.slice(0, 400)).not.toContain("traceWarm");
  });
});
