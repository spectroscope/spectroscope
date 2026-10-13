// Card 554, web task 9: a playbook run in the chat of its session.
//
// The server tells the page which playbook the session picked
// (playbook_info, socket-only), answers /run-with-playbook with the start
// sheet's content (playbook_confirm, socket-only) and writes three kinds of
// playbook_progress line into the session file: the start with the playbook
// and the task, one per step with its name and model, the end with the
// outcome. A step's prompt arrives as a run_start with origin "playbook" and
// is drawn as the playbook's turn, not as the owner's (criterion 8f).

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { dict } from "../i18n/i18n";
import { markStarting, nextStartAsk } from "./playbookChat";
import { NON_WIRE_TYPES } from "../wire/nonWire";
import { initialState, reduce, type Turn, type UiState } from "./reducer";
import { recallEntries } from "../components/composerKeys";
import { read, blockOf } from "../testkit/source";

const PREVIEW = {
  dir: "/pb/spectro",
  hash: "sha256:abc",
  findings: [],
  steps: [],
  skills: [],
  commands: ["npm test"],
  refusals: [],
};

function fold(...frames: unknown[]): UiState {
  return frames.reduce<UiState>((s, f) => reduce(s, f as RunEvent), initialState);
}

const progress = (fields: Record<string, unknown>): unknown => ({
  type: "playbook_progress",
  agentId: "playbook",
  runId: "pr-1",
  ts: 1000,
  ...fields,
});

const infos = (state: UiState): Extract<Turn, { kind: "info" }>[] =>
  state.turns.filter((t): t is Extract<Turn, { kind: "info" }> => t.kind === "info");

describe("the session's playbook (playbook_info)", () => {
  it("holds the picked folder, its name and whether it was found", () => {
    const state = fold({ type: "playbook_info", dir: "/pb/spectro", name: "spectro", found: true });
    expect(state.playbook).toEqual({ dir: "/pb/spectro", name: "spectro", found: true });
  });

  it("reads a pick whose folder is gone, and no pick at all", () => {
    expect(fold({ type: "playbook_info", dir: "/pb/gone", name: null, found: false }).playbook).toEqual({
      dir: "/pb/gone",
      name: null,
      found: false,
    });
    expect(fold({ type: "playbook_info", dir: null, name: null, found: false }).playbook).toEqual({
      dir: null,
      name: null,
      found: false,
    });
  });

  it("is null before the first frame, and the frame draws no line", () => {
    expect(initialState.playbook).toBeNull();
    expect(fold({ type: "playbook_info", dir: "/pb", name: "x", found: true }).turns).toEqual([]);
  });

  it("reads the pick a session file recorded, its presence unknown until the server says", () => {
    const state = fold({ type: "playbook_picked", dir: "/pb/spectro", name: "spectro", ts: 1 });
    expect(state.playbook).toEqual({ dir: "/pb/spectro", name: "spectro", found: null });
    const withdrawn = fold({ type: "playbook_picked", ts: 2 });
    expect(withdrawn.playbook).toEqual({ dir: null, name: null, found: null });
    // The server's frame after the line keeps the last word.
    const both = fold(
      { type: "playbook_picked", dir: "/pb/spectro", name: "spectro", ts: 1 },
      { type: "playbook_info", dir: "/pb/spectro", name: "spectro", found: true },
    );
    expect(both.playbook?.found).toBe(true);
  });

  // Card 554, integrator decision b: "No playbook" is a pick of its own.
  it("reads the explicit No playbook from the server and from the session file", () => {
    const told = fold({ type: "playbook_info", dir: null, name: null, found: false, none: true });
    expect(told.playbook).toEqual({ dir: null, name: null, found: false, none: true });
    const recorded = fold({ type: "playbook_picked", none: true, ts: 3 });
    expect(recorded.playbook).toEqual({ dir: null, name: null, found: null, none: true });
    // A pick of a folder after it is a pick again, and a withdrawn pick is no none.
    const after = fold(
      { type: "playbook_picked", none: true, ts: 3 },
      { type: "playbook_picked", dir: "/pb", ts: 4 },
    );
    expect(after.playbook?.none).toBeUndefined();
    expect(fold({ type: "playbook_picked", ts: 5 }).playbook?.none).toBeUndefined();
    expect(
      fold({ type: "playbook_info", dir: "/pb", name: "x", found: true, none: false }).playbook?.none,
    ).toBeUndefined();
  });
});

describe("the start sheet's content (playbook_confirm)", () => {
  it("holds the folder, the prompt and the preview", () => {
    const state = fold({
      type: "playbook_confirm",
      dir: "/pb/spectro",
      prompt: "add a CSV export",
      preview: PREVIEW,
    });
    expect(state.playbookConfirm).toEqual({
      dir: "/pb/spectro",
      prompt: "add a CSV export",
      preview: PREVIEW,
    });
    expect(state.turns).toEqual([]);
  });

  it("keeps the last one when a frame cannot be read", () => {
    const state = fold(
      { type: "playbook_confirm", dir: "/pb/spectro", prompt: "x", preview: PREVIEW },
      { type: "playbook_confirm", dir: "/pb/spectro" },
    );
    expect(state.playbookConfirm?.prompt).toBe("x");
  });

  it("is closed by the run's start", () => {
    const state = fold(
      { type: "playbook_confirm", dir: "/pb/spectro", prompt: "x", preview: PREVIEW },
      progress({ phase: "start", playbook: "spectro", task: "x" }),
    );
    expect(state.playbookConfirm).toBeNull();
  });

  // Card 584, fix round (review N7): the sheet stays open until the server
  // starts the run, and a refusal of the start shows in it.
  it("marks a sent start with the id it asked with, and keeps the picks' preview", () => {
    const open = fold({ type: "playbook_confirm", dir: "/pb/spectro", prompt: "x", preview: PREVIEW });
    const starting = markStarting(open.playbookConfirm!, "start-1");
    expect(starting).toMatchObject({ starting: true, ask: "start-1", refusal: null });
    expect(starting.preview, "the picks of the sheet belong to this preview").toBe(PREVIEW);
  });

  // Second fix round: the sheet shows only the refusal of its own start.
  it("shows the refusal that answers its own start, in the sheet as well as in the chat", () => {
    const open = fold({ type: "playbook_confirm", dir: "/pb/spectro", prompt: "x", preview: PREVIEW });
    const starting = { ...open, playbookConfirm: markStarting(open.playbookConfirm!, "start-1") };

    const refused = reduce(
      reduce(starting, { type: "error", message: "The model pick for tidy does not serve: x." } as RunEvent),
      {
        type: "playbook_start_refused",
        ask: "start-1",
        message: "The model pick for tidy does not serve: x.",
      } as never,
    );

    expect(refused.playbookConfirm).toMatchObject({
      starting: false,
      ask: "start-1",
      refusal: "The model pick for tidy does not serve: x.",
    });
    expect(refused.turns.at(-1)).toMatchObject({ kind: "error" });
    expect(markStarting(refused.playbookConfirm!, "start-2")).toMatchObject({
      starting: true,
      ask: "start-2",
      refusal: null,
    });
  });

  it("does not take an error of something else, or the refusal of another start, for its refusal", () => {
    const open = fold({ type: "playbook_confirm", dir: "/pb/spectro", prompt: "x", preview: PREVIEW });
    const starting = { ...open, playbookConfirm: markStarting(open.playbookConfirm!, "start-1") };

    const afterError = reduce(starting, { type: "error", message: "something else" } as RunEvent);
    expect(afterError.playbookConfirm, "an error in the window is no answer").toBe(starting.playbookConfirm);
    expect(afterError.turns.at(-1)).toMatchObject({ kind: "error", text: "something else" });

    const other = reduce(starting, {
      type: "playbook_start_refused",
      ask: "start-0",
      message: "old",
    } as never);
    expect(other.playbookConfirm).toBe(starting.playbookConfirm);

    const notStarted = reduce(open, {
      type: "playbook_start_refused",
      ask: "start-1",
      message: "late",
    } as never);
    expect(notStarted.playbookConfirm).toBe(open.playbookConfirm);
    expect(
      reduce(initialState, { type: "playbook_start_refused", ask: "start-1", message: "x" } as never)
        .playbookConfirm,
    ).toBeNull();
  });

  it("is a frame of the page only, never written", () => {
    expect(NON_WIRE_TYPES.has("playbook_start_refused")).toBe(true);
  });

  it("gives every start its own id", () => {
    expect(nextStartAsk()).not.toBe(nextStartAsk());
  });
});

describe("a run's lines in the chat (playbook_progress, criterion 8f)", () => {
  it("opens with the playbook and the task", () => {
    const [line] = infos(fold(progress({ phase: "start", playbook: "spectro", task: "add a CSV export" })));
    expect(line).toMatchObject({
      infoKey: "chat.pb.start",
      infoVars: { playbook: "spectro", task: "add a CSV export" },
      tone: "neutral",
      text: "Playbook spectro started on the task: add a CSV export",
    });
  });

  it("names a run that was started without a task", () => {
    const [line] = infos(fold(progress({ phase: "start", playbook: "spectro" })));
    expect(line).toMatchObject({ infoKey: "chat.pb.startNoTask", infoVars: { playbook: "spectro" } });
  });

  it("names each step and the model it runs on", () => {
    const [line] = infos(
      fold(
        progress({
          phase: "step",
          node: "classify",
          name: "Classify",
          provider: "anthropic",
          model: "claude-sonnet-4",
        }),
      ),
    );
    expect(line).toMatchObject({
      infoKey: "chat.pb.step",
      infoVars: { name: "Classify", model: "claude-sonnet-4 (anthropic)" },
      text: "Step Classify runs on claude-sonnet-4 (anthropic)",
    });
  });

  it("closes with the outcome: the result, the stop reason in words and the detail", () => {
    const [done] = infos(fold(progress({ phase: "end", stopReason: "done", result: "approved" })));
    expect(done).toMatchObject({
      infoKey: "chat.pb.endResult",
      infoRefKey: "pb.run.stop.done",
      infoVars: { result: "approved", more: "" },
      tone: "neutral",
    });
    const [failed] = infos(
      fold(
        progress({ phase: "end", stopReason: "step_failed", detail: "Classify: the model did not answer" }),
      ),
    );
    expect(failed).toMatchObject({
      infoKey: "chat.pb.end",
      infoRefKey: "pb.run.stop.step_failed",
      infoVars: { more: " Classify: the model did not answer" },
      tone: "warn",
    });
  });

  it("prints a stop reason the dictionary does not know as it came", () => {
    const [line] = infos(fold(progress({ phase: "end", stopReason: "brand_new" })));
    expect(line.infoRefKey).toBeUndefined();
    expect(line.infoVars).toMatchObject({ ref: "brand_new" });
  });

  // Card 586: the start line links to the run it opens.
  it("names the run on its start line, with and without a task, and on no other line", () => {
    const [withTask] = infos(
      fold(progress({ phase: "start", playbook: "spectro", task: "add a CSV export" })),
    );
    expect(withTask.runId).toBe("pr-1");
    const [noTask] = infos(fold(progress({ phase: "start", playbook: "spectro" })));
    expect(noTask.runId).toBe("pr-1");
    const [step] = infos(fold(progress({ phase: "step", node: "classify", name: "Classify" })));
    expect(Object.keys(step)).not.toContain("runId");
    const [end] = infos(fold(progress({ phase: "end", stopReason: "done" })));
    expect(Object.keys(end)).not.toContain("runId");
  });

  it("names no run on a start line without a run id", () => {
    const [line] = infos(
      fold({ type: "playbook_progress", agentId: "playbook", phase: "start", playbook: "x", ts: 1 }),
    );
    expect(line.infoKey, "premise: the start line is drawn").toBe("chat.pb.startNoTask");
    expect(Object.keys(line)).not.toContain("runId");
  });

  it("has every key it uses in both languages", () => {
    for (const key of [
      "chat.pb.start",
      "chat.pb.startNoTask",
      "chat.pb.step",
      "chat.pb.end",
      "chat.pb.endResult",
    ]) {
      expect(dict[key]?.de, key).toBeTruthy();
      expect(dict[key]?.en, key).toBeTruthy();
    }
  });
});

describe("a step's prompt (run_start with origin playbook, criterion 8f)", () => {
  const start = (origin?: string): unknown => ({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "Classify the task.\n\nTask: add a CSV export",
    ...(origin === undefined ? {} : { origin }),
    ts: 5,
  });

  it("is the playbook's turn, not the owner's", () => {
    const [turn] = fold(start("playbook")).turns;
    expect(turn).toMatchObject({
      kind: "user",
      by: "playbook",
      text: "Classify the task.\n\nTask: add a CSV export",
    });
  });

  it("leaves a typed prompt the owner's", () => {
    const [turn] = fold(start()).turns;
    expect(turn.kind).toBe("user");
    expect((turn as { by?: string }).by).toBeUndefined();
  });

  it("is not offered when the owner walks back through their own prompts", () => {
    const typed = { type: "run_start", runId: "r2", agentId: "main", prompt: "my own words", ts: 7 };
    const end = { type: "run_end", runId: "r1", agentId: "main", stopReason: "end_turn", ts: 6 };
    const turns = fold(start("playbook"), end, typed).turns;
    expect(turns.filter((t) => t.kind === "user").length, "both prompts are in the chat").toBe(2);
    expect(recallEntries(turns, []).map((e) => e.text)).toEqual(["my own words"]);
  });
});

describe("a question of a run ends with its task on a line of its own", () => {
  it("keeps the line breaks in the tool card's view of the question", () => {
    const css = read("../styles/toolcard.css", import.meta.url);
    expect(blockOf(css, ".tv-ask-q")).toMatch(/white-space:\s*pre-wrap/);
  });

  it("keeps them in the bar that asks it", () => {
    const css = read("../styles/surfaces.css", import.meta.url);
    expect(blockOf(css, ".ask-question")).toMatch(/white-space:\s*pre-wrap/);
  });
});
