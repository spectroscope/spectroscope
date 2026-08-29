// Card 299: the sentence a chapter tick shows, in both locales.
//
// chapterMarks deliberately returns a dict KEY, not prose. This is where the
// key becomes words, so this is where the words are pinned — one bite per kind,
// in EN and in DE, plus the drift check that no key the marks module can emit
// is missing from the dictionary (a missing key renders as itself, loudly, and
// "lab.mark.turn" on a scrub bar is the defect this test exists to catch).

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { chapterMarks } from "../state/stepper";
import { chapterLabel } from "./chapterLabel";
import { dict } from "../i18n/i18n";

const T = 1700000000000;
const ev = (e: Record<string, unknown>): RunEvent => e as unknown as RunEvent;

/** One stream carrying every kind of chapter this build can draw. */
const everyKind: RunEvent[] = [
  ev({ type: "turn_start", agentId: "main", turn: 3, ts: T }),
  ev({ type: "agent_spawn", agentId: "kid", parentId: "main", task: "read", ts: T }),
  ev({ type: "compaction", agentId: "main", removedTurns: 7, summaryChars: 90, ts: T }),
  ev({ type: "permission_request", agentId: "main", callId: "c1", name: "write_file", input: {}, ts: T }),
  ev({ type: "permission_decision", callId: "c1", allowed: false, ts: T }),
  ev({ type: "no_progress", agentId: "main", detector: "identical_writes", count: 3, evidence: "e", ts: T }),
  ev({ type: "no_progress", agentId: "main", detector: "repeated_failure", count: 2, evidence: "e", ts: T }),
  ev({ type: "no_progress", agentId: "main", detector: "stalled_plan", count: 4, evidence: "e", ts: T }),
  ev({ type: "no_progress", agentId: "main", detector: "a_fourth_net", count: 9, evidence: "e", ts: T }),
  ev({
    type: "progress_intervention",
    agentId: "m",
    callId: "c",
    detector: "d",
    intervention: "CARRY_ON",
    stoodDown: false,
    ts: T,
  }),
  ev({
    type: "progress_intervention",
    agentId: "m",
    callId: "c",
    detector: "d",
    intervention: "CHANGE_COURSE",
    stoodDown: false,
    ts: T,
  }),
  ev({
    type: "progress_intervention",
    agentId: "m",
    callId: "c",
    detector: "d",
    intervention: "END",
    stoodDown: false,
    ts: T,
  }),
  ev({
    type: "progress_intervention",
    agentId: "m",
    callId: "c",
    detector: "d",
    intervention: "NEW_ONE",
    stoodDown: false,
    ts: T,
  }),
  ev({
    type: "question_asked",
    agentId: "main",
    callId: "q1",
    questions: [{ question: "a", options: [] }],
    ts: T,
  }),
  ev({
    type: "tool_call",
    agentId: "main",
    callId: "s1",
    name: "Skill",
    input: { name: "humanizer" },
    ts: T,
  }),
  ev({ type: "tool_call", agentId: "main", callId: "s2", name: "Skill", input: {}, ts: T }),
  ev({ type: "error", agentId: "main", message: "the socket went away", ts: T }),
  ev({ type: "run_end", runId: "r1", stopReason: "max_turns", ts: T }),
];

const label = (e: RunEvent, lang: "en" | "de"): string => chapterLabel(chapterMarks([e])[0], lang);

describe("chapterLabel — every kind says what happened, in both locales", () => {
  it("names the turn", () => {
    expect(label(everyKind[0], "en")).toBe("turn 3 starts");
    expect(label(everyKind[0], "de")).toBe("Zug 3 beginnt");
  });

  it("names the child agent", () => {
    expect(label(everyKind[1], "en")).toBe("child agent kid starts");
    expect(label(everyKind[1], "de")).toBe("Kind-Agent kid beginnt");
  });

  it("says how much history the compaction folded away", () => {
    expect(label(everyKind[2], "en")).toContain("7 turns");
    expect(label(everyKind[2], "de")).toContain("7 Züge");
  });

  it("names the tool the gate stopped", () => {
    expect(label(everyKind[3], "en")).toContain("write_file");
    expect(label(everyKind[3], "de")).toContain("write_file");
  });

  it("says a refusal was a refusal", () => {
    expect(label(everyKind[4], "en")).toBe("refused at the gate");
    expect(label(everyKind[4], "de")).toBe("am Gate abgelehnt");
  });

  it("gives each progress detector its own sentence, and the unknown one the wire name", () => {
    expect(label(everyKind[5], "en")).toContain("3 earlier paths");
    expect(label(everyKind[6], "en")).toContain("failed 2 times");
    expect(label(everyKind[7], "en")).toContain("4 turns");
    expect(label(everyKind[8], "en")).toContain("a_fourth_net");
    expect(label(everyKind[5], "de")).toContain("3 früheren Pfaden");
    expect(label(everyKind[6], "de")).toContain("2 Mal");
    expect(label(everyKind[7], "de")).toContain("4 Zügen");
    expect(label(everyKind[8], "de")).toContain("a_fourth_net");
  });

  it("says what the person watching decided", () => {
    expect(label(everyKind[9], "en")).toContain("carried on");
    expect(label(everyKind[10], "en")).toContain("course");
    expect(label(everyKind[11], "en")).toContain("ended here");
    expect(label(everyKind[12], "en")).toContain("NEW_ONE");
    expect(label(everyKind[9], "de")).toContain("ging weiter");
    expect(label(everyKind[11], "de")).toContain("beendet");
  });

  it("says the run stopped to ask", () => {
    expect(label(everyKind[13], "en")).toContain("asked");
    expect(label(everyKind[13], "de")).toContain("gefragt");
  });

  it("names a loaded skill, and says a skill loaded when the call named none", () => {
    expect(label(everyKind[14], "en")).toContain("humanizer");
    expect(label(everyKind[14], "de")).toContain("humanizer");
    expect(label(everyKind[15], "en")).not.toContain("{");
    expect(label(everyKind[15], "en")).toContain("skill");
    expect(label(everyKind[15], "de")).toContain("Skill");
  });

  it("carries the error's own words", () => {
    expect(label(everyKind[16], "en")).toContain("the socket went away");
    expect(label(everyKind[16], "de")).toContain("the socket went away");
  });

  it("reads the stop reason through the SAME dictionary the transcript footer uses", () => {
    expect(label(everyKind[17], "en")).toContain("turn limit reached");
    expect(label(everyKind[17], "de")).toContain("Zug-Limit erreicht");
  });

  it("puts an unknown stop reason inside a sentence rather than on its own", () => {
    const mark = chapterMarks([ev({ type: "run_end", runId: "r", stopReason: "a_new_reason", ts: T })])[0];
    expect(chapterLabel(mark, "en")).toContain("unknown reason (a_new_reason)");
    expect(chapterLabel(mark, "de")).toContain("unbekannter Grund (a_new_reason)");
  });
});

describe("no chapter key is missing from the dictionary", () => {
  const marks = chapterMarks(everyKind);

  it("draws a mark for every kind this build knows", () => {
    expect(new Set(marks.map((m) => m.kind))).toEqual(
      new Set([
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
      ]),
    );
  });

  it("has both locales for every key any of them can emit", () => {
    for (const m of marks) {
      const entry = dict[m.labelKey];
      expect(entry, `missing dict entry: ${m.labelKey}`).toBeDefined();
      expect(entry.en.length, m.labelKey).toBeGreaterThan(0);
      expect(entry.de.length, m.labelKey).toBeGreaterThan(0);
    }
  });

  it("leaves no placeholder unfilled and never renders a bare key", () => {
    for (const m of marks) {
      for (const lang of ["en", "de"] as const) {
        const line = chapterLabel(m, lang);
        expect(line, m.labelKey).not.toContain("{");
        expect(line, m.labelKey).not.toBe(m.labelKey);
      }
    }
  });
});
