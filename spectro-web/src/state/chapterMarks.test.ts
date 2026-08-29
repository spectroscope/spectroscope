// Card 299: what the transport says about WHERE the interesting part is.
//
// Every assertion here bites ONE kind of mark, one mapping, one bound. A single
// "some marks exist" test would pin nothing: the whole value of this module is
// that a compaction is told apart from a refusal and a refusal from a question,
// and a test that only counts marks is green while all three read alike.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import {
  SPEED_FACTORS,
  chapterMarks,
  clockLabel,
  intervalForFactor,
  markPositions,
  runClock,
  speedFactorOf,
  stepBoundaries,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
} from "./stepper";

const T = 1700000000000;

/** One event of each shape, cast the way the rest of the suite casts them. */
const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

describe("chapterMarks — one bite per kind", () => {
  it("is empty for a stream with nothing worth a mark", () => {
    expect(
      chapterMarks([
        ev({ type: "text_delta", agentId: "main", text: "hi", ts: T }),
        ev({ type: "usage", agentId: "main", inputTokens: 1, outputTokens: 2, ts: T }),
      ]),
    ).toEqual([]);
  });

  it("marks a turn_start with its turn number", () => {
    expect(chapterMarks([ev({ type: "turn_start", agentId: "main", turn: 3, ts: T })])).toEqual([
      { at: 0, kind: "turn", labelKey: "lab.mark.turn", vars: { n: 3 } },
    ]);
  });

  it("marks an agent_spawn with the child's id", () => {
    expect(
      chapterMarks([ev({ type: "agent_spawn", agentId: "kid", parentId: "main", task: "read", ts: T })]),
    ).toEqual([{ at: 0, kind: "spawn", labelKey: "lab.mark.spawn", vars: { id: "kid" } }]);
  });

  it("marks a compaction with the turns it folded away", () => {
    expect(
      chapterMarks([ev({ type: "compaction", agentId: "main", removedTurns: 7, summaryChars: 90, ts: T })]),
    ).toEqual([{ at: 0, kind: "compaction", labelKey: "lab.mark.compaction", vars: { n: 7 } }]);
  });

  it("marks a permission_request with the tool that asked", () => {
    expect(
      chapterMarks([
        ev({
          type: "permission_request",
          agentId: "main",
          callId: "c1",
          name: "write_file",
          input: {},
          ts: T,
        }),
      ]),
    ).toEqual([{ at: 0, kind: "gate", labelKey: "lab.mark.gate", vars: { name: "write_file" } }]);
  });

  it("marks a REFUSED permission_decision and stays silent on an allowed one", () => {
    expect(chapterMarks([ev({ type: "permission_decision", callId: "c1", allowed: false, ts: T })])).toEqual([
      { at: 0, kind: "denied", labelKey: "lab.mark.denied", vars: {} },
    ]);
    expect(chapterMarks([ev({ type: "permission_decision", callId: "c1", allowed: true, ts: T })])).toEqual(
      [],
    );
  });

  it("marks no_progress per detector, and an unknown detector keeps its wire name", () => {
    const of = (detector: string, count: number): RunEvent =>
      ev({ type: "no_progress", agentId: "main", detector, count, evidence: "e", ts: T });
    expect(chapterMarks([of("identical_writes", 3)])[0]).toEqual({
      at: 0,
      kind: "no_progress",
      labelKey: "lab.mark.noProgress.identical_writes",
      vars: { n: 3, detector: "identical_writes" },
    });
    expect(chapterMarks([of("repeated_failure", 2)])[0].labelKey).toBe(
      "lab.mark.noProgress.repeated_failure",
    );
    expect(chapterMarks([of("stalled_plan", 4)])[0].labelKey).toBe("lab.mark.noProgress.stalled_plan");
    expect(chapterMarks([of("a_fourth_net", 9)])[0]).toEqual({
      at: 0,
      kind: "no_progress",
      labelKey: "lab.mark.noProgress.other",
      vars: { n: 9, detector: "a_fourth_net" },
    });
  });

  it("marks a progress_intervention per decision, unknown values included", () => {
    const of = (intervention: string): RunEvent =>
      ev({
        type: "progress_intervention",
        agentId: "main",
        callId: "c1",
        detector: "stalled_plan",
        intervention,
        stoodDown: false,
        ts: T,
      });
    expect(chapterMarks([of("CARRY_ON")])[0]).toEqual({
      at: 0,
      kind: "intervention",
      labelKey: "lab.mark.intervention.CARRY_ON",
      vars: { intervention: "CARRY_ON" },
    });
    expect(chapterMarks([of("CHANGE_COURSE")])[0].labelKey).toBe("lab.mark.intervention.CHANGE_COURSE");
    expect(chapterMarks([of("END")])[0].labelKey).toBe("lab.mark.intervention.END");
    expect(chapterMarks([of("SOMETHING_NEW")])[0].labelKey).toBe("lab.mark.intervention.other");
  });

  it("marks a question_asked with how many questions rode on it", () => {
    expect(
      chapterMarks([
        ev({
          type: "question_asked",
          agentId: "main",
          callId: "c1",
          questions: [
            { question: "a", options: [] },
            { question: "b", options: [] },
          ],
          ts: T,
        }),
      ]),
    ).toEqual([{ at: 0, kind: "question", labelKey: "lab.mark.question", vars: { n: 2 } }]);
  });

  it("marks an error with its message, cut at the label's bound", () => {
    const long = "x".repeat(200);
    const marks = chapterMarks([ev({ type: "error", agentId: "main", message: long, ts: T })]);
    expect(marks[0].kind).toBe("error");
    expect(marks[0].labelKey).toBe("lab.mark.error");
    const shown = String(marks[0].vars.message);
    expect(shown.length).toBeLessThan(long.length);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("marks a run_end and carries the stop reason verbatim", () => {
    expect(chapterMarks([ev({ type: "run_end", runId: "r1", stopReason: "max_turns", ts: T })])).toEqual([
      { at: 0, kind: "end", labelKey: "lab.mark.end", vars: { reason: "max_turns" } },
    ]);
  });

  it("marks a skill load — the two tool names that carry one — and names the skill", () => {
    const call = (name: string, input: unknown): RunEvent =>
      ev({ type: "tool_call", agentId: "main", callId: "c1", name, input, ts: T });
    expect(chapterMarks([call("Skill", { name: "humanizer" })])).toEqual([
      { at: 0, kind: "skill", labelKey: "lab.mark.skill", vars: { name: "humanizer" } },
    ]);
    expect(chapterMarks([call("use_skill", { skill: "kanban-ai" })])[0].vars).toEqual({ name: "kanban-ai" });
    // A skill call whose input names nothing is still a chapter, with its own line.
    expect(chapterMarks([call("Skill", {})])[0].labelKey).toBe("lab.mark.skill.unnamed");
    // Every other tool call is ordinary work, not a chapter.
    expect(chapterMarks([call("read_file", { path: "a" })])).toEqual([]);
  });

  it("keeps the stream's order and its own indices", () => {
    const marks = chapterMarks([
      ev({ type: "run_start", runId: "r1", agentId: "main", prompt: "p", ts: T }),
      ev({ type: "turn_start", agentId: "main", turn: 1, ts: T }),
      ev({ type: "text_delta", agentId: "main", text: "hi", ts: T }),
      ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: T }),
    ]);
    expect(marks.map((m) => [m.at, m.kind])).toEqual([
      [1, "turn"],
      [3, "end"],
    ]);
  });
});

describe("markPositions — a mark lands on the boundary that SHOWS its event", () => {
  const marks = [
    { at: 1, kind: "turn" as const, labelKey: "lab.mark.turn", vars: { n: 1 } },
    { at: 4, kind: "end" as const, labelKey: "lab.mark.end", vars: { reason: "end_turn" } },
  ];

  it("seeks past the marked event, never to the boundary before it", () => {
    // boundaries [0,1,2,4,5]: event 1 needs a seek to 2, event 4 needs 5.
    const bounds = [0, 1, 2, 4, 5];
    expect(markPositions(marks, bounds).map((p) => p.index)).toEqual([2, 4]);
  });

  it("puts the last boundary under a mark that nothing steps past", () => {
    expect(markPositions([{ ...marks[0], at: 9 }], [0, 1, 2]).map((p) => p.index)).toEqual([2]);
  });

  it("reads the position as a percentage of the scrub bar", () => {
    const p = markPositions(marks, [0, 1, 2, 4, 5]);
    expect(p[0].pct).toBeCloseTo(50);
    expect(p[1].pct).toBeCloseTo(100);
  });

  it("puts a single-boundary run's marks at zero rather than dividing by it", () => {
    expect(markPositions(marks, [0]).map((p) => p.pct)).toEqual([0, 0]);
  });

  it("walks the same boundaries the scrubber walks", () => {
    const events = [
      ev({ type: "turn_start", agentId: "main", turn: 1, ts: T }),
      ev({ type: "text_delta", agentId: "main", text: "a", ts: T }),
      ev({ type: "text_delta", agentId: "main", text: "b", ts: T }),
      ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: T }),
    ];
    const bounds = stepBoundaries(events);
    const at = markPositions(chapterMarks(events), bounds);
    expect(at.map((p) => bounds[p.index])).toEqual([1, 4]);
  });
});

describe("runClock — wall clock, or silence", () => {
  const at = (ts: number): RunEvent => ev({ type: "text_delta", agentId: "main", text: "x", ts });

  it("reads elapsed from the last applied event and total from the whole stream", () => {
    const all = [at(T), at(T + 1000), at(T + 5000)];
    expect(runClock(all, 2)).toEqual({ elapsedMs: 1000, totalMs: 5000 });
    expect(runClock(all, 3)).toEqual({ elapsedMs: 5000, totalMs: 5000 });
  });

  it("is zero elapsed before the first step", () => {
    expect(runClock([at(T), at(T + 4000)], 0)).toEqual({ elapsedMs: 0, totalMs: 4000 });
  });

  it("says nothing when the run carries no span", () => {
    expect(runClock([], 0)).toBeNull();
    expect(runClock([at(T)], 1)).toBeNull();
    expect(runClock([at(T), at(T)], 2)).toBeNull(); // every line on the same tick
  });

  it("says nothing when the timestamps are not numbers a clock can read", () => {
    expect(runClock([ev({ type: "text_delta", agentId: "m", text: "x" }), at(T + 10)], 2)).toBeNull();
    expect(runClock([at(0), at(T)], 2)).toBeNull();
  });

  it("never reports more elapsed than total, whatever order the stamps arrive in", () => {
    const c = runClock([at(T), at(T + 9000), at(T + 3000)], 2);
    expect(c).not.toBeNull();
    expect(c!.elapsedMs).toBeLessThanOrEqual(c!.totalMs);
  });
});

describe("clockLabel", () => {
  it("reads minutes and seconds, zero-padded", () => {
    expect(clockLabel(0)).toBe("0:00");
    expect(clockLabel(7400)).toBe("0:07");
    expect(clockLabel(65000)).toBe("1:05");
    expect(clockLabel(600000)).toBe("10:00");
  });

  it("grows an hour field only when there is an hour", () => {
    expect(clockLabel(3599000)).toBe("59:59");
    expect(clockLabel(3600000)).toBe("1:00:00");
    expect(clockLabel(3725000)).toBe("1:02:05");
  });

  it("never renders a negative clock", () => {
    expect(clockLabel(-5000)).toBe("0:00");
  });
});

describe("the speed pills say what they do", () => {
  it("offers the five multipliers with 1x in the middle", () => {
    expect([...SPEED_FACTORS]).toEqual([0.25, 0.5, 1, 2, 5]);
  });

  it("makes 1x the shipped default pace", () => {
    expect(intervalForFactor(1)).toBe(DEFAULT_INTERVAL_MS);
  });

  it("maps every factor to an interval the store accepts UNCLAMPED", () => {
    for (const f of SPEED_FACTORS) {
      const ms = intervalForFactor(f);
      expect(ms).toBe(Math.round(DEFAULT_INTERVAL_MS / f));
      expect(ms).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
      expect(ms).toBeLessThanOrEqual(MAX_INTERVAL_MS);
    }
  });

  it("puts the slowest pill exactly on the bound, so 0.25x is 0.25x and not a rounded lie", () => {
    expect(intervalForFactor(0.25)).toBe(MAX_INTERVAL_MS);
  });

  it("lights the pill that matches the current pace, and none for a pace off the grid", () => {
    expect(speedFactorOf(DEFAULT_INTERVAL_MS)).toBe(1);
    expect(speedFactorOf(250)).toBe(5);
    expect(speedFactorOf(1000)).toBeNull();
  });
});
