// Card 299: what the transport says about WHERE the interesting part is.
//
// Every assertion here bites ONE kind of mark, one mapping, one bound. A single
// "some marks exist" test would pin nothing: the whole value of this module is
// that a compaction is told apart from a refusal and a refusal from a question,
// and a test that only counts marks is green while all three read alike.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { ChapterKind, ChapterMark, MarkPosition } from "./stepper";
import {
  MARK_MIN_GAP_PCT,
  SPEED_FACTORS,
  chapterMarks,
  clockLabel,
  endSeekTarget,
  intervalForFactor,
  markPositions,
  runClock,
  thinMarks,
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

  // markMessage has TWO branches and only one of them was pinned: replacing the
  // whole body with an unconditional truncation left this file and
  // chapterLabel.test.ts green, and a 20-character error would then have read
  // with a trailing ellipsis promising text that does not exist. Both branches
  // are asserted by EQUALITY below, so a message can neither grow nor shrink
  // by a character without a red test.
  const shownFor = (message: string): string =>
    String(chapterMarks([ev({ type: "error", agentId: "main", message, ts: T })])[0].vars.message);

  /** MARK_MESSAGE_CAP in stepper.ts — moving it there is meant to be red here. */
  const CAP = 60;

  it("marks an error with its message, cut at the label's bound", () => {
    const long = "x".repeat(200);
    const marks = chapterMarks([ev({ type: "error", agentId: "main", message: long, ts: T })]);
    expect(marks[0].kind).toBe("error");
    expect(marks[0].labelKey).toBe("lab.mark.error");
    // The ellipsis costs a character, so the whole label stays inside the cap.
    expect(marks[0].vars.message).toBe("x".repeat(CAP - 1) + "…");
    expect(shownFor("x".repeat(CAP + 1))).toBe("x".repeat(CAP - 1) + "…");
  });

  it("hands a short error message back UNCHANGED, with no ellipsis promising more", () => {
    expect(shownFor("disk on fire")).toBe("disk on fire");
    // Twenty characters is the length the reviewer's bite used: an
    // unconditional truncation would read "…" here and lie about the text.
    expect(shownFor("connection refused!!")).toBe("connection refused!!");
    // Exactly the cap is still the whole message — the > / >= bite.
    expect(shownFor("x".repeat(CAP))).toBe("x".repeat(CAP));
  });

  it("folds a multi-line message into the one line a tooltip is", () => {
    expect(shownFor("  boom\n  at Foo.java:12\t\tand again  ")).toBe("boom at Foo.java:12 and again");
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
  const marks: ChapterMark[] = [
    { at: 1, kind: "turn", labelKey: "lab.mark.turn", vars: { n: 1 } },
    { at: 4, kind: "end", labelKey: "lab.mark.end", vars: { reason: "end_turn" } },
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

// ---- the fix round: a wall of ticks is not a chapter list ------------------
//
// The first build drew every mark. Measured with these very functions on a
// plain 60-turn single-agent run — 422 events, 242 coarse steps — that is 61
// ticks, 1.65% apart, and at the 11px hit box lab.css gives them they touch
// each other on any bar narrower than 671px. The density is therefore a rule
// of its own, pure and pinned, rather than a property of whatever the browser
// happened to do.

/** The same plain run the fix round was measured on: 60 turns, one agent, no
 *  spawns — a text block, a tool call and its result per turn.
 *
 *  `errorAtTurn` drops ONE error into that turn's block, which is the run this
 *  card exists for: sixty ordinary boundaries and one thing that went wrong. */
function plainRun(turns: number, errorAtTurn: number | null = null): RunEvent[] {
  const out: RunEvent[] = [ev({ type: "run_start", runId: "r", agentId: "main", prompt: "p", ts: T })];
  for (let i = 1; i <= turns; i++) {
    out.push(ev({ type: "turn_start", agentId: "main", turn: i, ts: T + i * 1000 }));
    for (let d = 0; d < 4; d++) {
      out.push(ev({ type: "text_delta", agentId: "main", text: "x", ts: T + i * 1000 }));
    }
    out.push(
      ev({
        type: "tool_call",
        agentId: "main",
        callId: `c${i}`,
        name: "read_file",
        input: {},
        ts: T + i * 1000,
      }),
    );
    out.push(ev({ type: "tool_result", agentId: "main", callId: `c${i}`, ok: true, ts: T + i * 1000 }));
    if (i === errorAtTurn) {
      out.push(ev({ type: "error", agentId: "main", message: "disk on fire", ts: T + i * 1000 }));
    }
  }
  out.push(ev({ type: "run_end", runId: "r", stopReason: "end_turn", ts: T + turns * 1000 }));
  return out;
}

/** A placed mark of a given kind at a percentage — the two things thinMarks
 *  reads. */
const kindAt = (kind: ChapterKind, pct: number): MarkPosition => ({
  mark: { at: pct, kind, labelKey: `lab.mark.${kind}`, vars: {} },
  index: pct,
  pct,
});

/** A placed mark at a percentage; a plain turn, the kind that makes the crowd. */
const at = (pct: number): MarkPosition => kindAt("turn", pct);

describe("thinMarks — the bar carries chapters, not a picket fence", () => {
  it("drops a tick that stands closer to its neighbour than the floor", () => {
    expect(thinMarks([at(0), at(1), at(10)], 2).map((p) => p.pct)).toEqual([1, 10]);
  });

  it("keeps a tick that stands exactly the floor away", () => {
    // The >= / > bite: at exactly the floor the ticks no longer overlap, so
    // dropping one here would thin the bar for nothing.
    expect(thinMarks([at(0), at(2), at(4)], 2).map((p) => p.pct)).toEqual([0, 2, 4]);
  });

  it("never lets a crowd swallow the last chapter of the run", () => {
    // The end of a run is the one tick a presenter always jumps to. Thinning
    // from the front would keep 99 and throw 100 away.
    const kept = thinMarks([at(0), at(99), at(99.5), at(100)], 2);
    expect(kept[kept.length - 1].pct).toBe(100);
  });

  it("hands the ticks back in the run's own order", () => {
    const kept = thinMarks([at(0), at(5), at(50), at(100)], 2).map((p) => p.pct);
    expect(kept).toEqual([...kept].sort((a, b) => a - b));
    expect(kept).toEqual([0, 5, 50, 100]);
  });

  it("gives nothing back for a run with no chapters", () => {
    expect(thinMarks([], 2)).toEqual([]);
  });

  it("thins the 60-turn run the wall was measured on", () => {
    const events = plainRun(60);
    const bounds = stepBoundaries(events);
    const raw = markPositions(chapterMarks(events), bounds);
    expect(events).toHaveLength(422);
    expect(bounds.length - 1).toBe(242);
    expect(raw).toHaveLength(61); // the wall this rule exists to prevent
    const kept = thinMarks(raw, MARK_MIN_GAP_PCT);
    expect(kept.length).toBeLessThan(raw.length);
    // The rule itself: no two ticks closer than the floor, whatever the run.
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].pct - kept[i - 1].pct).toBeGreaterThanOrEqual(MARK_MIN_GAP_PCT);
    }
  });

  // ---- the second fix round: the thinning ate the marks it exists for ------
  //
  // Ranking by position alone kept whichever of two crowded ticks stood later.
  // `turn` is the only kind that fires every turn, so on any long run the
  // turns ARE the crowd — and a rarer kind standing beside one lost its place
  // to it. Measured with these functions on the 60-turn run below carrying a
  // single error: 62 marks in, 31 out, and the one failure of the whole run
  // was not among them.

  it("lets a rarer kind take the place a plain turn was holding", () => {
    const seen = (ms: MarkPosition[]): [ChapterKind, number][] =>
      thinMarks(ms, 2).map((p) => [p.mark.kind, p.pct]);
    // The later tick used to win on position alone; now the rarer kind does,
    // whichever side of the crowd it stands on.
    expect(seen([kindAt("turn", 10), kindAt("error", 10.5)])).toEqual([["error", 10.5]]);
    expect(seen([kindAt("error", 10), kindAt("turn", 10.5)])).toEqual([["error", 10]]);
    // spawn is the other kind that fires per agent rather than per exception.
    expect(seen([kindAt("spawn", 10), kindAt("gate", 10.5)])).toEqual([["gate", 10.5]]);
    expect(seen([kindAt("gate", 10), kindAt("spawn", 10.5)])).toEqual([["gate", 10]]);
  });

  it("keeps the LATER of two ticks the ranking cannot tell apart", () => {
    // The tie rule is what protects the run's last chapter, so it stays: two
    // rare kinds, or two crowd kinds, still resolve by position.
    expect(thinMarks([kindAt("error", 10), kindAt("gate", 10.5)], 2).map((p) => p.pct)).toEqual([10.5]);
    expect(thinMarks([kindAt("turn", 10), kindAt("spawn", 10.5)], 2).map((p) => p.pct)).toEqual([10.5]);
    // …including an error standing on the doorstep of the ending.
    expect(thinMarks([kindAt("error", 99.5), kindAt("end", 100)], 2).map((p) => p.mark.kind)).toEqual([
      "end",
    ]);
  });

  it("keeps the ONE error of a 60-turn run that thirty turn boundaries crowd", () => {
    const events = plainRun(60, 30);
    const bounds = stepBoundaries(events);
    const raw = markPositions(chapterMarks(events), bounds);
    expect(events).toHaveLength(423);
    expect(bounds.length - 1).toBe(243);
    expect(raw).toHaveLength(62); // 60 turns, the error, the end

    // Measured on this very fixture: the error stands at 50.21% of the bar and
    // the next turn_start 0.41% later — a fifth of the floor, so one of the
    // two has to go, and it used to be the error.
    const err = raw.find((p) => p.mark.kind === "error");
    expect(err).toBeDefined();
    expect(err!.pct).toBeCloseTo(50.206, 3);
    const next = raw.filter((p) => p.pct > err!.pct)[0];
    expect(next.mark.kind).toBe("turn");
    expect(next.pct - err!.pct).toBeLessThan(MARK_MIN_GAP_PCT);

    const kept = thinMarks(raw, MARK_MIN_GAP_PCT);
    expect(kept).toHaveLength(31);
    // The whole point: the only failure in the run survives the thinning.
    expect(kept.map((p) => p.mark.kind)).toContain("error");
    // And it took the crowding turn's place rather than being drawn beside it.
    expect(kept.filter((p) => Math.abs(p.pct - err!.pct) < MARK_MIN_GAP_PCT)).toHaveLength(1);
    // The floor still holds after the swap — a replaced tick moves EARLIER,
    // never later, so the gap to the neighbour behind it can only grow.
    for (let i = 1; i < kept.length; i++) {
      expect(kept[i].pct - kept[i - 1].pct).toBeGreaterThanOrEqual(MARK_MIN_GAP_PCT);
    }
  });

  it("bounds how many ticks any run can put on the bar", () => {
    // A floor of g% admits at most 100/g + 1 ticks, so the count cannot grow
    // with the run the way 61 did.
    const ceiling = Math.floor(100 / MARK_MIN_GAP_PCT) + 1;
    const dense = Array.from({ length: 400 }, (_, i) => at((i / 399) * 100));
    expect(thinMarks(dense, MARK_MIN_GAP_PCT).length).toBeLessThanOrEqual(ceiling);
  });
});

describe("endSeekTarget — where the jump to the end lands", () => {
  // The transport's ⇥ was pinned by its LABEL alone: seeking one event short
  // of the run's ending renders exactly the same button. The destination is a
  // reading, so it lives in this module and is pinned without a DOM.
  it("applies every event of the stream", () => {
    const events = plainRun(3);
    expect(endSeekTarget(events)).toBe(events.length);
    expect(endSeekTarget([])).toBe(0);
  });

  it("lands on the very boundary the slider's right end walks to", () => {
    for (const events of [plainRun(1), plainRun(7), plainRun(60, 30)]) {
      const bounds = stepBoundaries(events);
      expect(endSeekTarget(events)).toBe(bounds[bounds.length - 1]);
    }
  });
});
