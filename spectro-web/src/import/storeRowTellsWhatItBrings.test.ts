// Card 318, the other half: the row says which door its click takes, and says
// it out loud.
//
// The owner, on being sent to find a directory:
//   "When you pick a file that has a folder with workflows next to it, then you
//    get a popup or an extra option, or you can choose beforehand: I only want
//    this file, or find the folder of this file and import the whole folder.
//    Because as a user you do not want to decide that and you do not want to be
//    told: go find the folder yourself. So make it an option, or always load
//    the folder when the workflows and everything are there."
//
// So the DEFAULT is the run, the session-file-only path stays reachable and
// clearly secondary, and a refusal degrades LOUDLY — never back into something
// that looks exactly like today's behaviour.
//
// The decision belongs beside the other one this module already owns. `rowState`
// is the single place that decides what the dialog may do with a row; it reads
// the listing row and what the listing published about its own limit, and the
// dialog is wiring. Which DOOR the click takes is the same kind of decision off
// one more fact the dialog already has on the row — `workflow-agents ×N`, the
// count that feeds the chip — and putting it anywhere else means two answers to
// one question on one screen.
//
// The plan is reached through a cast below because the field does not exist
// yet; once it does, the cast comes out and these call sites type themselves.

import { describe, expect, it } from "vitest";

import { rowState, type RowState, type StoreLimits, type TranscriptRow } from "./rowState";
import type { TranscriptFacts } from "./transcriptFacts";
import { dict, t, type Lang } from "../i18n/i18n";
import * as rowStateModule from "./rowState";

// ---- the contract this card adds to rowState -------------------------------

/**
 * Which door a row's click takes, and the numbers the reader is told before it
 * opens.
 *
 * `agents` is not a second counter. It is the SAME number the row's
 * `workflow-agents ×N` chip prints, off the same fold, because two counts of
 * one thing on one screen is how a panel starts contradicting itself — card
 * 313's lesson, one surface earlier.
 */
type RowPlan =
  { door: "run"; agents: number } | { door: "session"; reason: "noAgents" | "tooLarge"; agents: number };

/** `rowState` as this card must leave it: the same verdict, plus the plan, off
 *  the facts the dialog already holds for the row. */
const planned = rowState as unknown as (
  row: TranscriptRow,
  limits: StoreLimits | null,
  lang: Lang,
  facts?: TranscriptFacts,
) => RowState & { plan?: RowPlan };

const LIMITS: StoreLimits = { limitBytes: 128 * 1024 * 1024 };

const row = (over: Partial<TranscriptRow> = {}): TranscriptRow => ({
  path: "-Users-x-repo/s1.jsonl",
  project: "-Users-x-repo",
  file: "s1.jsonl",
  size: 3 * 1024 * 1024,
  modifiedAt: 1,
  loadable: true,
  ...over,
});

const facts = (over: Partial<TranscriptFacts> = {}): TranscriptFacts => ({
  path: "-Users-x-repo/s1.jsonl",
  models: ["test-model"],
  workflowCalls: 1,
  subagents: 0,
  workflowAgents: 13,
  ...over,
});

// ---- the default is the run ------------------------------------------------

describe("which door a row's click takes", () => {
  it("a session with workflow agents beside it loads the RUN, on a plain click", () => {
    // The card in one assertion. No second gesture, no folder picker, no
    // "go find the directory": the row the owner already clicks brings the run.
    expect(planned(row(), LIMITS, "en", facts()).plan?.door).toBe("run");
  });

  it("a session with nothing beside it loads the session file, and says why", () => {
    // Bitten separately from the ceiling case below: both end at the session
    // file and they are not the same fact, so one reason code for the pair
    // would let the dialog print "the agents were left behind" for a session
    // that never had any.
    const plan = planned(row(), LIMITS, "en", facts({ workflowAgents: 0, subagents: 0 })).plan;
    expect(plan?.door).toBe("session");
    expect(plan?.door === "session" ? plan.reason : null).toBe("noAgents");
  });

  it("a transcript the server will not serve at all still refuses, and says which refusal it is", () => {
    // The existing verdict is untouched — `enabled` is still the server's word,
    // never a size comparison made here — and the plan names the OTHER reason,
    // so the sentence under the row cannot claim agents were dropped when the
    // session itself was never read.
    const state = planned(row({ loadable: false, size: 200 * 1024 * 1024 }), LIMITS, "en", facts());
    expect(state.enabled).toBe(false);
    expect(state.plan?.door).toBe("session");
    expect(state.plan?.door === "session" ? state.plan.reason : null).toBe("tooLarge");
  });

  it("a row whose facts have not landed yet still takes the run door", () => {
    // Absent facts mean "did not say", not zero — the same rule those fields
    // already carry. The list never waits for facts, so a click can land on a
    // row that has not filled in, and guessing "no agents" there is the exact
    // silence this card removes. Guessing the other way costs nothing: a
    // session with nothing beside it answers a bundle with empty arrays
    // (pinned server-side in ClaudeTranscriptsRunBundleTest), so one request
    // is right in both cases and the row never has to know first.
    //
    // Written as a positive: `not.toBe("session")` would have been green for
    // as long as `plan` was undefined, which pins nothing at all.
    expect(planned(row(), LIMITS, "en", undefined).plan?.door).toBe("run");
  });
});

// ---- one counter, not two --------------------------------------------------

describe("the number the row prints and the number the plan carries are one number", () => {
  it("the plan's agent count follows the fold that feeds the row's chip", () => {
    // Derived, not typed: the expectation is the input. Move the source number
    // and the plan must move with it, which is the bite that catches a second
    // counter being introduced beside the first.
    for (const n of [1, 3, 13, 240]) {
      expect(planned(row(), LIMITS, "en", facts({ workflowAgents: n })).plan?.agents).toBe(n);
    }
  });

  it("direct spawns count too — they are agents beside the session as much as a run's are", () => {
    // 15% of the agent transcripts in the real store are direct `Task` spawns
    // under `subagents/` rather than under a run directory. A plan that only
    // read `workflowAgents` would send exactly those sessions down the
    // session-only door while their agents sat one directory away.
    const plan = planned(row(), LIMITS, "en", facts({ workflowAgents: 0, subagents: 4 })).plan;
    expect(plan?.door).toBe("run");
    expect(plan?.agents).toBe(4);
  });
});

// ---- the words -------------------------------------------------------------

/**
 * The three sentences this card needs, in both languages.
 *
 * Every user-visible string goes through `i18n.ts` with de AND en; `t` returns
 * the KEY for anything missing, so a bare key coming back is the red.
 */
const KEYS = ["imp.run.brings", "imp.run.only", "imp.run.tooBig"] as const;

describe("what the reader is told", () => {
  it("both languages carry all three sentences", () => {
    for (const key of KEYS) {
      expect(dict[key], `${key} is missing from the dictionary`).toBeDefined();
      expect(t("en", key), `${key}.en`).not.toBe(key);
      expect(t("de", key), `${key}.de`).not.toBe(key);
    }
  });

  it("the German is German and not the English pasted twice", () => {
    for (const key of KEYS) {
      expect(t("de", key), `${key} reads identically in both languages`).not.toBe(t("en", key));
    }
  });

  it("the default door's sentence names what the click is about to bring", () => {
    // Before and/or as it loads, never after: the whole point is that the
    // reader is not surprised by a 104 MB import he did not ask for.
    for (const lang of ["en", "de"] as const) {
      expect(t(lang, "imp.run.brings", { agents: 13 })).toContain("13");
    }
  });

  it("a refusal degrades loudly, with both numbers and the agents it left behind", () => {
    // AC8. Over the ceiling the row loads the session file — today's
    // behaviour — and it must NOT be possible to mistake that for today's
    // behaviour. The server names both numbers in its 413; this sentence is
    // where they are printed.
    for (const lang of ["en", "de"] as const) {
      const said = t(lang, "imp.run.tooBig", { size: "104.0 MB", limit: "64.0 MB", agents: 240 });
      expect(said).toContain("104.0 MB");
      expect(said).toContain("64.0 MB");
      expect(said).toContain("240");
    }
  });

  it("the degrade is keyed on a reason code the module owns, not on prose", () => {
    // A sentence matched by substring goes soft the day somebody rewords it,
    // and rewording user copy is the one thing that happens to every string in
    // this file. The codes belong beside the decision that produces them and
    // are exported so `i18n.test.ts` can demand a word for each, the way it
    // already does for SOURCE_NOTE_KINDS and TODO_STATUSES.
    const codes = (rowStateModule as { RUN_DOOR_REASONS?: readonly string[] }).RUN_DOOR_REASONS;
    expect(codes, "rowState.ts must export the reason codes its plan can carry").toBeDefined();
    expect([...(codes ?? [])].sort()).toEqual(["noAgents", "tooLarge"]);
  });
});

// ---- what must not have moved ----------------------------------------------

describe("the verdict rowState already owned is unchanged", () => {
  it("a row the server calls loadable is still clickable", () => {
    expect(rowState(row(), LIMITS, "en")).toEqual({ enabled: true, kind: "whole" });
  });

  it("a refused row still explains itself with its own size and the server's ceiling", () => {
    const state = rowState(row({ loadable: false, size: 200 * 1024 * 1024 }), LIMITS, "en");
    expect(state.enabled).toBe(false);
    expect(state.enabled === false ? state.reason : "").toContain("200.0 MB");
    expect(state.enabled === false ? state.reason : "").toContain("128.0 MB");
  });
});
