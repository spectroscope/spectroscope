// Card 309A: the chapter marks as a list somebody can READ.
//
// Every assertion below bites ONE thing. The panel's whole claim is that a
// refusal is told apart from a question and a compaction from an error, and
// that each row names the agent it belongs to — a test that only counted rows
// would be green while all eleven kinds rendered alike. Card 299's first
// thinning shipped exactly that way: green, and eating the only error in a
// 60-turn run.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import type { ChapterKind } from "../state/stepper";
import { chapterMarks, markPositions, stepBoundaries, thinMarks, MARK_MIN_GAP_PCT } from "../state/stepper";
import { agentDirectory } from "./agentDirectory";
import { MOMENT_KIND_KEY, momentsOf } from "./moments";
import { chapterLabel, momentLabel } from "./chapterLabel";

const T = 1700000000000;

/** One event of each shape, cast the way the rest of the suite casts them. */
const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

const only = (events: RunEvent[]) => {
  const rows = momentsOf(events);
  expect(rows).toHaveLength(1);
  return rows[0];
};

describe("momentsOf — one bite per kind, and who each moment belongs to", () => {
  it("reads an empty run as no moments at all", () => {
    expect(momentsOf([])).toEqual([]);
    expect(
      momentsOf([
        ev({ type: "text_delta", agentId: "main", text: "hi", ts: T }),
        ev({ type: "usage", agentId: "main", inputTokens: 1, outputTokens: 2, ts: T }),
      ]),
    ).toEqual([]);
  });

  it("gives a turn to the agent whose turn it is", () => {
    const row = only([ev({ type: "turn_start", agentId: "main", turn: 3, ts: T })]);
    expect(row.mark.kind).toBe("turn");
    expect(row.agentId).toBe("main");
  });

  it("gives a spawn to the CHILD the frame names", () => {
    const row = only([ev({ type: "agent_spawn", agentId: "kid", parentId: "main", task: "read", ts: T })]);
    expect(row.mark.kind).toBe("spawn");
    expect(row.agentId).toBe("kid");
  });

  it("gives a compaction to the agent whose history was folded", () => {
    const row = only([ev({ type: "compaction", agentId: "w1", removedTurns: 7, summaryChars: 90, ts: T })]);
    expect(row.mark.kind).toBe("compaction");
    expect(row.agentId).toBe("w1");
  });

  it("gives a gate to the agent that asked", () => {
    const row = only([
      ev({ type: "permission_request", agentId: "w2", callId: "c1", name: "write_file", input: {}, ts: T }),
    ]);
    expect(row.mark.kind).toBe("gate");
    expect(row.agentId).toBe("w2");
  });

  it("gives a REFUSAL to the agent that asked, which the decision frame never names", () => {
    // permission_decision carries a callId and no agentId. Reading the asker
    // off the matching request is a measured link, not a guess — and without
    // it the one row a reader most wants to attribute is the anonymous one.
    const rows = momentsOf([
      ev({ type: "permission_request", agentId: "w2", callId: "c1", name: "rm", input: {}, ts: T }),
      ev({ type: "permission_decision", callId: "c1", allowed: false, ts: T + 1 }),
    ]);
    expect(rows.map((r) => r.mark.kind)).toEqual(["gate", "denied"]);
    expect(rows[1].agentId).toBe("w2");
  });

  it("leaves a refusal unattributed when the run never recorded who asked", () => {
    // A guess here would name the wrong agent on the one row that says
    // something was stopped. Silence is the honest answer.
    const row = only([ev({ type: "permission_decision", callId: "orphan", allowed: false, ts: T })]);
    expect(row.mark.kind).toBe("denied");
    expect(row.agentId).toBeNull();
  });

  it("does not list an ALLOWED decision at all", () => {
    expect(momentsOf([ev({ type: "permission_decision", callId: "c1", allowed: true, ts: T })])).toEqual([]);
  });

  it("gives a no_progress observation to the agent it was made about", () => {
    const row = only([
      ev({
        type: "no_progress",
        agentId: "w1",
        detector: "stalled_plan",
        count: 3,
        evidence: "same plan",
        ts: T,
      }),
    ]);
    expect(row.mark.kind).toBe("no_progress");
    expect(row.agentId).toBe("w1");
  });

  it("gives an intervention to the agent that was steered", () => {
    const row = only([
      ev({
        type: "progress_intervention",
        agentId: "w1",
        callId: "c9",
        detector: "stalled_plan",
        intervention: "CHANGE_COURSE",
        stoodDown: false,
        ts: T,
      }),
    ]);
    expect(row.mark.kind).toBe("intervention");
    expect(row.agentId).toBe("w1");
  });

  it("gives a question to the agent that asked it", () => {
    const row = only([ev({ type: "question_asked", agentId: "main", callId: "q1", questions: [{}], ts: T })]);
    expect(row.mark.kind).toBe("question");
    expect(row.agentId).toBe("main");
  });

  it("gives a skill load to the agent that loaded it", () => {
    const row = only([
      ev({
        type: "tool_call",
        agentId: "w3",
        callId: "c1",
        name: "Skill",
        input: { name: "research" },
        ts: T,
      }),
    ]);
    expect(row.mark.kind).toBe("skill");
    expect(row.agentId).toBe("w3");
  });

  it("gives an error to its agent, and to nobody when the frame named none", () => {
    expect(only([ev({ type: "error", agentId: "w1", message: "boom", ts: T })]).agentId).toBe("w1");
    // `agentId` is optional on an error frame. An unattributed error stays
    // unattributed rather than being handed to the root.
    const orphan = only([ev({ type: "error", message: "boom", ts: T })]);
    expect(orphan.mark.kind).toBe("error");
    expect(orphan.agentId).toBeNull();
  });

  it("attributes the run's end to nobody — run_end names a RUN, not an agent", () => {
    const row = only([ev({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: T })]);
    expect(row.mark.kind).toBe("end");
    expect(row.agentId).toBeNull();
  });
});

describe("momentsOf — a row seeks exactly where the tick seeks", () => {
  const run: RunEvent[] = [
    ev({ type: "turn_start", agentId: "main", turn: 1, ts: T }),
    ev({ type: "text_delta", agentId: "main", text: "a", ts: T + 1 }),
    ev({ type: "text_delta", agentId: "main", text: "b", ts: T + 2 }),
    ev({ type: "tool_call", agentId: "main", callId: "c1", name: "Skill", input: { name: "s" }, ts: T + 3 }),
    ev({ type: "turn_start", agentId: "main", turn: 2, ts: T + 4 }),
    ev({ type: "error", agentId: "main", message: "boom", ts: T + 5 }),
    ev({ type: "run_end", runId: "r1", stopReason: "error", ts: T + 6 }),
  ];

  it("lands on the same coarse step the scrub tick lands on", () => {
    const boundaries = stepBoundaries(run);
    const ticks = markPositions(chapterMarks(run), boundaries);
    const rows = momentsOf(run);
    expect(rows.map((r) => r.step)).toEqual(ticks.map((p) => p.index));
    // The transport seeks `boundaries[index]`; a row must seek the same number
    // or the two surfaces disagree about where a moment is.
    expect(rows.map((r) => r.cursor)).toEqual(ticks.map((p) => boundaries[p.index]));
  });

  it("seeks PAST the marked event, so the step it lands on shows it", () => {
    const rows = momentsOf(run);
    const err = rows.find((r) => r.mark.kind === "error");
    expect(err).toBeDefined();
    expect(err?.cursor).toBeGreaterThan(err?.mark.at ?? 0);
  });

  it("keeps every moment the scrub bar had to throw away", () => {
    // The bar thins because an 11px tick cannot stand 1.65% from its neighbour.
    // The dock scrolls, so it thins nothing — and that is the point of the
    // panel: the moments the ticks could not fit are exactly the ones a reader
    // came looking for.
    const crowded: RunEvent[] = [];
    for (let i = 0; i < 60; i += 1)
      crowded.push(ev({ type: "turn_start", agentId: "main", turn: i, ts: T + i }));
    crowded.push(ev({ type: "error", agentId: "main", message: "the only one", ts: T + 99 }));
    const boundaries = stepBoundaries(crowded);
    const thinned = thinMarks(markPositions(chapterMarks(crowded), boundaries), MARK_MIN_GAP_PCT);
    expect(thinned.length).toBeLessThan(crowded.length);
    expect(momentsOf(crowded)).toHaveLength(61);
  });
});

describe("the kind word — a reader never meets the raw enum", () => {
  const KINDS: ChapterKind[] = [
    "turn",
    "spawn",
    "compaction",
    "gate",
    "denied",
    "no_progress",
    "intervention",
    "question",
    "skill",
    "error",
    "end",
  ];

  it("has a word for every kind, in both locales, and never prints the enum", () => {
    for (const kind of KINDS) {
      const key = MOMENT_KIND_KEY[kind];
      const entry = dict[key];
      expect(entry, `no dictionary entry for ${kind}`).toBeDefined();
      expect(entry.en.length).toBeGreaterThan(0);
      expect(entry.de.length).toBeGreaterThan(0);
      // The wire's own spelling never reaches a reader. Not "differs from the
      // enum" — English "turn" IS the word for a turn, and pinning that would
      // force a worse word to satisfy a test. What must never appear is the
      // snake_case field name: `no_progress` printed as itself is a wire key.
      expect(entry.en).not.toContain("_");
      expect(entry.de).not.toContain("_");
    }
  });

  it("says something different for a refusal than for a gate", () => {
    // The two crowd each other in every run that has both, and a panel that
    // gave them one word would be exactly as unreadable as the ticks.
    expect(dict[MOMENT_KIND_KEY.denied].en).not.toBe(dict[MOMENT_KIND_KEY.gate].en);
    expect(dict[MOMENT_KIND_KEY.denied].de).not.toBe(dict[MOMENT_KIND_KEY.gate].de);
  });
});

describe("momentLabel — the sentence a row shows", () => {
  it("puts the child's HANDLE in the spawn line, never the raw agent id", () => {
    // card 299 wrote `lab.mark.spawn` for an 11px tooltip and let it carry the
    // raw id. On a panel that is the thing card 298's directory exists to stop.
    const spawn = ev({
      type: "agent_spawn",
      agentId: "agent_01JQ8Z3K7NOPAQUE",
      parentId: "main",
      task: "read",
      ts: T,
    });
    const dir = agentDirectory([spawn]);
    const row = only([spawn]);
    const tag = dir.get(row.agentId ?? "")?.tag ?? null;
    expect(tag).not.toBeNull();
    const line = momentLabel(row.mark, tag, "en");
    expect(line).toContain(tag);
    expect(line).not.toContain("agent_01JQ8Z3K7NOPAQUE");
  });

  it("names an unnamed child as one rather than printing an id it could not resolve", () => {
    const mark = { at: 0, kind: "spawn" as const, labelKey: "lab.mark.spawn", vars: { id: "opaque_id" } };
    for (const lang of ["en", "de"] as const) {
      const line = momentLabel(mark, null, lang);
      expect(line).not.toContain("opaque_id");
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("leaves every other kind's sentence exactly as the tick says it", () => {
    // One vocabulary for the tooltip and the row, or the two drift into two
    // different words for one moment. Compared against chapterLabel itself —
    // not against a string written here, which would only pin this test.
    const others: RunEvent[] = [
      ev({ type: "turn_start", agentId: "main", turn: 4, ts: T }),
      ev({ type: "error", agentId: "main", message: "boom", ts: T + 1 }),
      ev({ type: "run_end", runId: "r1", stopReason: "max_turns", ts: T + 2 }),
    ];
    for (const row of momentsOf(others)) {
      for (const lang of ["en", "de"] as const) {
        expect(momentLabel(row.mark, "main", lang)).toBe(chapterLabel(row.mark, lang));
      }
    }
  });
});
