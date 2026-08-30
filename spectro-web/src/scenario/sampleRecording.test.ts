// The pin under card 310: the recording this repo ships is still the recording
// its own source produces.
//
// A committed artefact that quietly stops matching the code it came from is the
// drift this house keeps paying for — the file still opens, still looks like a
// run, and lies about which run. compile() is deterministic (fixed base
// timestamp, ids minted in order), so "still matching" is a byte comparison and
// not a judgement call.
//
// WHEN THIS GOES RED, THE FIX IS TO REGENERATE THE FILE. Every failure message
// below says so, because the cheap way out — widening the comparison until the
// stale file passes — would leave the repo shipping a recording nobody can
// trace to a scenario, which is the exact failure the pin exists to stop.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import {
  SAMPLE_LANG,
  SAMPLE_PATH,
  SAMPLE_REGEN_COMMAND,
  SAMPLE_SCENARIO_ID,
  renderSampleRecording,
} from "./sampleRecording";

/** The shipped file, resolved from THIS test's location so the pin does not
 *  depend on where vitest was started from. */
const onDisk = fileURLToPath(new URL(`../../../${SAMPLE_PATH}`, import.meta.url));

/**
 * The full type tally of the shipped file, measured 2026-08-29 with
 *
 *   npm run generate:sample-run   (then: cut -d'"' -f4 on the type field)
 *
 * All thirteen kinds, not a selection: a partial tally is green for a stream
 * that grew a fourteenth kind, and a new event type in a shipped sample is
 * exactly the change somebody should have to look at.
 */
const MEASURED_MIX: Record<string, number> = {
  run_start: 14,
  turn_start: 14,
  context_info: 1,
  thinking_delta: 1,
  tool_call: 31,
  agent_spawn: 13,
  agent_message: 39,
  tool_result: 31,
  usage: 14,
  text_delta: 14,
  run_end: 14,
  permission_request: 5,
  permission_decision: 5,
};

const fix = `regenerate it with \`${SAMPLE_REGEN_COMMAND}\` — do not loosen this test`;

describe(`the shipped recording ${SAMPLE_PATH}`, () => {
  it("exists", () => {
    expect(existsSync(onDisk), `${SAMPLE_PATH} is missing — ${fix}`).toBe(true);
  });

  it("is byte-identical to what its scenario compiles to today", () => {
    const shipped = readFileSync(onDisk, "utf8");
    const fresh = renderSampleRecording();
    // Line-by-line first: a 196-line diff of one string is unreadable, and the
    // first differing line is the whole answer.
    const shippedLines = shipped.split("\n");
    const freshLines = fresh.split("\n");
    const at = shippedLines.findIndex((line, i) => line !== freshLines[i]);
    expect(
      at,
      at < 0
        ? ""
        : `${SAMPLE_PATH} line ${at + 1} no longer matches compile("${SAMPLE_SCENARIO_ID}", "${SAMPLE_LANG}") — ${fix}\n` +
            `  shipped: ${shippedLines[at]?.slice(0, 200) ?? "<end of file>"}\n` +
            `  fresh:   ${freshLines[at]?.slice(0, 200) ?? "<end of file>"}`,
    ).toBe(-1);
    // And then the whole string, because a difference in LENGTH alone (a file
    // one line short, or one line long) leaves every compared line equal.
    expect(shipped, `${SAMPLE_PATH} is not byte-identical to its source — ${fix}`).toBe(fresh);
  });
});

describe("the shipped recording is still the run card 310 describes", () => {
  // Measured on the generated file, 2026-08-29. These are not a second opinion
  // about the bytes — that is the comparison above. They are here so that
  // regenerating after a scenario edit is a DECISION: if the workflow run stops
  // being 13 agents in 5 phases, this says so out loud instead of letting a
  // silent regeneration swap the shipped run for another one.
  //
  // Read inside each case, not once at module level: a missing file must fail
  // the case above with its own message, not blow the whole suite up during
  // collection with an ENOENT that names no fix.
  const events = (): RunEvent[] =>
    readFileSync(onDisk, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as RunEvent);

  const note = `the scenario changed shape — decide whether that is wanted, then ${SAMPLE_REGEN_COMMAND}`;

  it("holds 196 events, one per line", () => {
    expect(events().length, note).toBe(196);
  });

  it("spawns the 13 named agents of the five phases", () => {
    const spawned = events()
      .filter((e) => e.type === "agent_spawn")
      .map((e) => e.agentId);
    expect(spawned, note).toEqual([
      "scope",
      "probe-1",
      "probe-2",
      "probe-3",
      "probe-4",
      "probe-5",
      "merge",
      "draft",
      "audit-1",
      "audit-2",
      "audit-3",
      "audit-4",
      "audit-5",
    ]);
  });

  it("opens on a run_start and closes on a run_end", () => {
    const all = events();
    expect(all[0].type, note).toBe("run_start");
    expect(all[all.length - 1].type, note).toBe("run_end");
  });

  it("carries the event mix the card measured", () => {
    const tally: Record<string, number> = {};
    for (const e of events()) tally[e.type] = (tally[e.type] ?? 0) + 1;
    expect(tally, note).toEqual(MEASURED_MIX);
  });
});
