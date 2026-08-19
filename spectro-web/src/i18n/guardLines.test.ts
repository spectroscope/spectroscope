import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dict, t } from "./i18n";
import type { RunEvent } from "../events";
import { initialState, reduce } from "../state/reducer";

/** One event per rendered sentence, in the shape the server emits. */
const EVENTS: RunEvent[] = [
  { type: "no_progress", agentId: "main", detector: "identical_writes", count: 4,
    evidence: "the same 283 bytes", ts: 1 },
  { type: "no_progress", agentId: "main", detector: "repeated_failure", count: 3,
    evidence: "the same call", ts: 1 },
  { type: "no_progress", agentId: "main", detector: "stalled_plan", count: 2,
    evidence: "two steps open", ts: 1 },
  { type: "no_progress", agentId: "main", detector: "a_net_from_the_future", count: 9,
    evidence: "whatever it saw", ts: 1 },
  { type: "progress_intervention", agentId: "main", callId: "c", detector: "identical_writes",
    intervention: "CARRY_ON", stoodDown: false, ts: 1 },
  { type: "progress_intervention", agentId: "main", callId: "c", detector: "identical_writes",
    intervention: "CARRY_ON", stoodDown: true, ts: 1 },
  { type: "progress_intervention", agentId: "main", callId: "c", detector: "identical_writes",
    intervention: "CHANGE_COURSE", stoodDown: false, ts: 1 },
  { type: "progress_intervention", agentId: "main", callId: "c", detector: "identical_writes",
    intervention: "END", stoodDown: false, ts: 1 },
  { type: "progress_intervention", agentId: "main", callId: "c", detector: "identical_writes",
    intervention: "SOMETHING_NEW", stoodDown: false, ts: 1 },
  { type: "continuation", agentId: "main", decision: "continued", continuation: 1, budget: 3,
    openSteps: 2, totalSteps: 5, inputTokens: 0, evidence: "two open", ts: 1 },
  { type: "continuation", agentId: "main", decision: "no_progress", continuation: 2, budget: 3,
    openSteps: 2, totalSteps: 5, inputTokens: 0, evidence: "nothing moved", ts: 1 },
  { type: "continuation", agentId: "main", decision: "budget_spent", continuation: 3, budget: 3,
    openSteps: 1, totalSteps: 5, inputTokens: 0, evidence: "spent", ts: 1 },
  { type: "continuation", agentId: "main", decision: "a_new_decision", continuation: 1, budget: 3,
    openSteps: 1, totalSteps: 5, inputTokens: 0, evidence: "?", ts: 1 },
  { type: "goal_check", agentId: "main", outcome: "met", command: "npm test", exitCode: 0,
    judge: "exit_code", output: "", durationMs: 1, evidence: "exit 0", ts: 1 },
  { type: "goal_check", agentId: "main", outcome: "unmet", command: "npm test", exitCode: 1,
    judge: "exit_code", output: "", durationMs: 1, evidence: "exit 1", ts: 1 },
  { type: "goal_check", agentId: "main", outcome: "unknown", command: "npm test", exitCode: null,
    judge: "exit_code", output: "", durationMs: 1, evidence: "no command ran", ts: 1 },
  { type: "goal_check", agentId: "main", outcome: "a_new_verdict", command: "npm test",
    exitCode: null, judge: "exit_code", output: "", durationMs: 1, evidence: "?", ts: 1 },
];

// Every sentence cards 281 and 282 can ask for, in both languages.
//
// t() falls back to the KEY when an entry is missing — `dict[key]` is undefined
// and the key itself is returned. So a forgotten line does not throw and does
// not blank: it prints "info.noProgress.identical_writes" into the operator's
// chat, in the middle of a German session, and nothing anywhere goes red.
//
// The keys are built the same way the reducer builds them, so a fifth detector
// added to the vocabulary without a sentence turns this red rather than
// shipping its own name as prose.
const DETECTORS = ["identical_writes", "repeated_failure", "stalled_plan", "other"];
// CARRY_ON is two different facts: said by a person it takes the net down,
// arriving because nobody was there it does not. Two sentences, not one with
// a variable, because one of them would be false half the time.
const INTERVENTIONS = ["CARRY_ON", "CARRY_ON.stoodDown", "CHANGE_COURSE", "END", "other"];
const DECISIONS = ["continued", "no_progress", "budget_spent", "other"];
// "unknown" is a REAL outcome here, which is why the fallback everywhere is
// spelled "other" — a fallback that collides with a meaningful value hides it.
const OUTCOMES = ["met", "unmet", "unknown", "other"];

const KEYS = [
  ...DETECTORS.map((d) => `info.noProgress.${d}`),
  ...INTERVENTIONS.map((i) => `info.progressIntervention.${i}`),
  ...DECISIONS.map((d) => `info.continuation.${d}`),
  ...OUTCOMES.map((o) => `info.goalCheck.${o}`),
];

describe("the guard lines have sentences, in both languages", () => {
  it.each(KEYS)("%s is written in de and en", (key) => {
    const entry = dict[key];
    expect(entry, `${key} has no entry — the chat would print the key itself`).toBeDefined();
    expect(entry.de.length, `${key} has no German sentence`).toBeGreaterThan(0);
    expect(entry.en.length, `${key} has no English sentence`).toBeGreaterThan(0);
    expect(entry.de, `${key} ships the English sentence as German`).not.toBe(entry.en);
  });

  it("leaves no placeholder on screen, with the vars the reducer really passes", () => {
    // Driven THROUGH the reducer rather than with hand-written vars: a sentence
    // gaining a {placeholder} the reducer never fills is exactly the drift this
    // guards, and a test that invents its own vars cannot see it.
    //
    // The negative goes on the brace, never on a rendered word: asserting the
    // sentence does not contain "3" would be green for a sentence saying nothing.
    const lines = EVENTS.map((event) => reduce(initialState, event).turns[0]);
    expect(lines).toHaveLength(EVENTS.length);
    for (const lang of ["de", "en"] as const) {
      for (const line of lines) {
        if (line.kind !== "info" || line.infoKey === undefined) throw new Error("not an info line");
        const rendered = t(lang, line.infoKey, line.infoVars);
        expect(rendered, `${line.infoKey} (${lang}) left a placeholder on screen`).not.toContain("{");
        expect(rendered, `${line.infoKey} (${lang}) rendered as its own key`).not.toBe(line.infoKey);
      }
    }
  });
});

// Card 282, criterion 8: the run-ended line is two sentences and both are
// written. The composed form is the one that can go wrong — a missing {ref}
// substitution prints the dict key at the operator, which is the same silent
// failure the rest of this file guards.
describe("the run-ended line composes, in both languages", () => {
  it.each(["max_turns", "aborted", "unfinished_after_continuations", "a_reason_from_the_future"])(
    "%s reads as one sentence",
    (reason) => {
      const line = reduce(initialState, { type: "run_end", runId: "r", stopReason: reason, ts: 1 })
        .turns.at(-1);
      if (line === undefined || line.kind !== "info" || line.infoKey === undefined) {
        throw new Error(`${reason} drew no line`);
      }
      for (const lang of ["de", "en"] as const) {
        const ref = t(lang, line.infoRefKey ?? "", line.infoVars);
        const rendered = t(lang, line.infoKey, { ...line.infoVars, ref });
        expect(rendered, `${reason}/${lang} left a placeholder`).not.toContain("{");
        expect(rendered, `${reason}/${lang} printed a dict key`).not.toContain("stop.");
        expect(rendered).toContain(ref);
      }
    },
  );
});

// And the mount, because the test above cannot see it: it composes the line the
// same way Chat.tsx does, so it stays green for a Chat that forgot to. Read off
// the source, the idiom footerStatus.test.tsx already uses for the same reason.
describe("the chat actually substitutes the second sentence", () => {
  it("translates infoRefKey rather than passing it through as a var", () => {
    const chat = readFileSync(
      fileURLToPath(new URL("../components/Chat.tsx", import.meta.url)),
      "utf8",
    );
    expect(chat).toContain("turn.infoRefKey");
    expect(chat).toContain("ref: t(lang, turn.infoRefKey, turn.infoVars)");
  });
});
