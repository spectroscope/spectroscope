import { describe, expect, it } from "vitest";
import {
  atDraft,
  composerKeyAction,
  recallEntries,
  recallReadout,
  walkStep,
  type ComposerChord,
  type WalkState,
} from "./composerKeys";

/** A keydown with nothing pressed and the caret at the end of `value`. */
function chord(key: string, value = "", over: Partial<ComposerChord> = {}): ComposerChord {
  return {
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    ...over,
  };
}

describe("what a key in the composer means", () => {
  it("sends on a bare Enter, which is the rule the composer had and nothing pinned", () => {
    expect(composerKeyAction(chord("Enter", "ship it"))).toBe("send");
  });

  it("passes Shift and Enter through, so a newline is still a newline", () => {
    expect(composerKeyAction(chord("Enter", "ship it", { shiftKey: true }))).toBe("pass");
  });

  it("recalls back on ArrowUp when the selection is empty and no newline sits before the caret", () => {
    expect(composerKeyAction(chord("ArrowUp", ""))).toBe("recall-back");
    expect(composerKeyAction(chord("ArrowUp", "one line"))).toBe("recall-back");
  });

  it("recalls forward on ArrowDown when no newline sits after the caret", () => {
    expect(composerKeyAction(chord("ArrowDown", ""))).toBe("recall-forward");
    expect(composerKeyAction(chord("ArrowDown", "one line"))).toBe("recall-forward");
  });

  it("leaves ArrowUp to the caret once a newline sits before it", () => {
    // The zsh rule: up moves up a line while there is a line above, and only
    // reaches the history from the top line.
    const value = "first\nsecond";
    expect(composerKeyAction(chord("ArrowUp", value))).toBe("pass");
    // Caret on the first line of the same draft: the history is reachable again.
    expect(composerKeyAction(chord("ArrowUp", value, { selectionStart: 2, selectionEnd: 2 }))).toBe(
      "recall-back",
    );
  });

  it("leaves ArrowDown to the caret while a newline sits after it", () => {
    const value = "first\nsecond";
    expect(composerKeyAction(chord("ArrowDown", value, { selectionStart: 2, selectionEnd: 2 }))).toBe("pass");
    expect(composerKeyAction(chord("ArrowDown", value))).toBe("recall-forward");
  });

  it("leaves both arrows alone while text is selected", () => {
    // Shift-arrow extends a selection, and an arrow with one open collapses it.
    // Either way the keystroke belongs to the text, not to the history.
    const sel = { selectionStart: 0, selectionEnd: 3 };
    expect(composerKeyAction(chord("ArrowUp", "abc", sel))).toBe("pass");
    expect(composerKeyAction(chord("ArrowDown", "abc", sel))).toBe("pass");
  });

  it("leaves a modified arrow alone, each modifier on its own, on both arrows", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      for (const mod of ["shiftKey", "altKey", "metaKey", "ctrlKey"] as const) {
        expect(composerKeyAction(chord(key, "", { [mod]: true })), `${key} + ${mod}`).toBe("pass");
      }
    }
  });

  it("passes every key that arrives while an IME is composing", () => {
    // The precedent is keyIntent in SearchBox.tsx: a candidate list owns the
    // arrows and the commit key while a word is being composed.
    for (const key of ["Enter", "ArrowUp", "ArrowDown"]) {
      expect(composerKeyAction(chord(key, "", { isComposing: true })), key).toBe("pass");
    }
  });

  it("passes anything else", () => {
    expect(composerKeyAction(chord("a", "a"))).toBe("pass");
    expect(composerKeyAction(chord("Escape"))).toBe("pass");
    expect(composerKeyAction(chord("ArrowLeft", "abc"))).toBe("pass");
  });
});

describe("which prompts the walk can reach", () => {
  const turns = [
    { kind: "user" as const, text: "read the log" },
    { kind: "assistant" as const, text: "here it is" },
    { kind: "user" as const, text: "now fix it" },
    { kind: "user" as const, text: "and test it" },
  ];

  it("lists the sent prompts newest first", () => {
    // The expectation is MAPPED off the same fixture: a fixture that grows
    // changes what this asserts, and no literal list is restated here.
    const expected = turns
      .filter((turn) => turn.kind === "user")
      .map((turn) => ({ text: turn.text }))
      .reverse();
    expect(recallEntries(turns, [])).toEqual(expected);
  });

  it("puts the waiting queue in front of the sent prompts, newest queued first", () => {
    const queued = [
      { id: 4, text: "waiting one" },
      { id: 5, text: "waiting two" },
    ];
    const expected = [
      ...[...queued].reverse().map((m) => ({ text: m.text, queueId: m.id })),
      ...turns
        .filter((turn) => turn.kind === "user")
        .map((turn) => ({ text: turn.text }))
        .reverse(),
    ];
    expect(recallEntries(turns, queued)).toEqual(expected);
  });

  it("keeps the newest copy of a prompt that was sent twice", () => {
    const repeated = [
      { kind: "user" as const, text: "again" },
      { kind: "user" as const, text: "in between" },
      { kind: "user" as const, text: "again" },
    ];
    expect(recallEntries(repeated, []).map((e) => e.text)).toEqual(["again", "in between"]);
  });

  it("drops blank turns rather than offering an empty entry", () => {
    expect(recallEntries([{ kind: "user", text: "   " }], [])).toEqual([]);
  });

  it("steps over a turn that carries no text at all", () => {
    // The reducer's Turn is a union, and the tool arm has a callId and no
    // text. Reading .text off it is how this walks off the end of its own type.
    expect(recallEntries([{ kind: "tool" }, { kind: "user", text: "still here" }], [])).toEqual([
      { text: "still here" },
    ]);
  });

  it("has nothing to offer in a session with no prompts", () => {
    expect(recallEntries([], [])).toEqual([]);
  });
});

describe("walking the prompts", () => {
  const entries = [{ text: "third" }, { text: "second" }, { text: "first" }];

  it("starts at the operator's own draft", () => {
    expect(atDraft().index).toBe(-1);
  });

  it("brings back the newest prompt on the first step back", () => {
    const step = walkStep(atDraft(), "back", entries, "check the logs");
    expect(step.text).toBe("third");
    expect(step.state.index).toBe(0);
  });

  it("walks back to the oldest and home again, returning the draft byte for byte", () => {
    const draft = "check the logs";
    let state: WalkState = atDraft();
    let text = draft;
    for (const expected of ["third", "second", "first"]) {
      const step = walkStep(state, "back", entries, text);
      state = step.state;
      text = step.text;
      expect(text).toBe(expected);
    }
    expect(state.index).toBe(2);
    for (const expected of ["second", "third", draft]) {
      const step = walkStep(state, "forward", entries, text);
      state = step.state;
      text = step.text;
      expect(text).toBe(expected);
    }
    expect(state.index).toBe(-1);
  });

  it("keeps the stash untouched by an edit made at an entry in between", () => {
    // Owner call 4: an edit at an entry is a temporary copy of THAT entry. The
    // unsent draft is not a history entry and nothing along the walk may touch it.
    const draft = "check the logs";
    const back = walkStep(atDraft(), "back", entries, draft);
    const deeper = walkStep(back.state, "back", entries, "third, edited");
    const home = walkStep(
      walkStep(deeper.state, "forward", entries, "second, edited").state,
      "forward",
      entries,
      "third, edited",
    );
    expect(home.text).toBe(draft);
    expect(home.state.index).toBe(-1);
  });

  it("keeps an edit when the walk comes back to the same entry", () => {
    const back = walkStep(atDraft(), "back", entries, "");
    const deeper = walkStep(back.state, "back", entries, "third, edited");
    const again = walkStep(deeper.state, "forward", entries, "second");
    expect(again.text).toBe("third, edited");
  });

  it("stays put at the oldest entry", () => {
    let state = atDraft();
    let text = "";
    for (const _ of entries) {
      const step = walkStep(state, "back", entries, text);
      state = step.state;
      text = step.text;
    }
    const past = walkStep(state, "back", entries, text);
    expect(past.moved).toBe(false);
    expect(past.text).toBe("first");
    expect(past.state.index).toBe(2);
  });

  it("stays put on a step forward from the operator's own draft", () => {
    const step = walkStep(atDraft(), "forward", entries, "mine");
    expect(step.moved).toBe(false);
    expect(step.text).toBe("mine");
    expect(step.state.index).toBe(-1);
  });

  it("has nowhere to go when the session has no prompts", () => {
    const step = walkStep(atDraft(), "back", [], "mine");
    expect(step.moved).toBe(false);
    expect(step.text).toBe("mine");
  });

  it("freezes the list it is walking, so a queue that empties cannot shift the index", () => {
    // The entries are recomputed by the component on every render, and the
    // recall of a queued entry empties the queue. Reading the live list on the
    // second step would land the walk on a different prompt than the one the
    // counter promised.
    const withQueue = [{ text: "waiting", queueId: 7 }, ...entries];
    const first = walkStep(atDraft(), "back", withQueue, "");
    expect(first.text).toBe("waiting");
    const second = walkStep(first.state, "back", entries, "waiting");
    expect(second.text).toBe("third");
  });

  it("takes a recalled queue entry out of the queue at the moment of the recall", () => {
    const withQueue = [{ text: "waiting", queueId: 7 }, ...entries];
    const step = walkStep(atDraft(), "back", withQueue, "");
    expect(step.unqueue).toBe(7);
  });

  it("asks for that removal once and not again when the walk returns to the entry", () => {
    const withQueue = [{ text: "waiting", queueId: 7 }, ...entries];
    const first = walkStep(atDraft(), "back", withQueue, "");
    const deeper = walkStep(first.state, "back", withQueue, "waiting");
    const again = walkStep(deeper.state, "forward", withQueue, "third");
    expect(again.text).toBe("waiting");
    expect(again.unqueue).toBe(null);
  });

  it("drops a recalled queue entry when the operator walks forward to his own draft", () => {
    // The consequence the owner's answer carries, pinned on purpose so nobody
    // later reads it as a defect: the chip is gone from the moment of the
    // recall, so walking home leaves the message unsent and unlisted.
    const withQueue = [{ text: "waiting", queueId: 7 }];
    const back = walkStep(atDraft(), "back", withQueue, "my draft");
    expect(back.unqueue).toBe(7);
    const home = walkStep(back.state, "forward", withQueue, "waiting");
    expect(home.text).toBe("my draft");
    expect(home.state.index).toBe(-1);
    expect(home.unqueue).toBe(null);
  });

  it("asks for no removal when the entry was an ordinary sent prompt", () => {
    expect(walkStep(atDraft(), "back", entries, "").unqueue).toBe(null);
  });
});

describe("what the counter above the box reads", () => {
  const entries = [{ text: "third" }, { text: "second" }, { text: "first" }];

  it("says nothing while the operator is in his own draft", () => {
    expect(recallReadout(atDraft())).toEqual({ kind: "idle" });
  });

  it("reads 1 of n on the first step back, newest first", () => {
    const step = walkStep(atDraft(), "back", entries, "");
    expect(recallReadout(step.state)).toEqual({ kind: "at", position: 1, total: 3 });
  });

  it("reads n of n at the oldest entry", () => {
    let state = atDraft();
    let text = "";
    for (const _ of entries) {
      const step = walkStep(state, "back", entries, text);
      state = step.state;
      text = step.text;
    }
    expect(recallReadout(state)).toEqual({ kind: "at", position: 3, total: 3 });
  });

  it("goes back to saying nothing when the walk comes home", () => {
    const back = walkStep(atDraft(), "back", entries, "mine");
    const home = walkStep(back.state, "forward", entries, "third");
    expect(recallReadout(home.state)).toEqual({ kind: "idle" });
  });

  it("counts the frozen list, so it cannot disagree with the text in the box", () => {
    const one = walkStep(atDraft(), "back", [{ text: "only" }], "");
    expect(recallReadout(one.state)).toEqual({ kind: "at", position: 1, total: 1 });
  });
});
