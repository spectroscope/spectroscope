// Card 527 criterion 4 on the composer itself, fix round: the Send button of
// the rendered Chat receives focus() when the first heard words of a
// recording appear, and a letter typed into the box before that keeps the
// focus where it is.
//
// voiceFocus.test.ts pins the rule; this file pins the wiring in Chat: the
// ref on the Send button, the effect that calls focus(), and the keydown in
// the textarea that cancels the move. Chat is driven with drive() and a fake
// voice hook (voiceHook.ts). The server renderer runs no effects, so this
// file records the effects useSendFocus registers and runs them after each
// pass, the way folderPickNote.test.tsx does for its hook.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import { initialState } from "../state/reducer";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { __resetSkillList } from "../state/skillList";
import { __setVoiceHook } from "./voiceHook";
import type { MicPhase } from "./voiceButton";
import type { VoiceInput } from "./useVoiceInput";

type Effect = () => void | (() => void);

const effects = vi.hoisted(() => [] as { run: Effect; from: string }[]);

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: Effect) => {
      effects.push({ run: effect, from: new Error().stack ?? "" });
    },
  };
});

let phase: MicPhase = "recording";
let heard = "";
let focused = 0;

beforeEach(() => {
  effects.length = 0;
  phase = "recording";
  heard = "";
  focused = 0;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  __setVoiceHook((): VoiceInput => ({
    micPhase: phase,
    modelLoading: false,
    micAvailable: true,
    micError: null,
    level: 0,
    choice: { devices: [], unnamed: false },
    refreshDevices: async () => {},
    recordMs: 0,
    provisional: heard,
    liveFailed: null,
    toggleMic: async () => {},
    finish: () => Promise.resolve(heard),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __setVoiceHook(null);
  effects.length = 0;
});

const chat = (
  <Chat
    state={initialState}
    liveView={true}
    onSend={() => {}}
    onReturnToLive={() => {}}
    sendClient={() => true}
  />
);

function sendButton(tree: El[]): El {
  const found = tree.find(
    (el) => el.type === "button" && String(el.props.className).includes("composer-seat--send"),
  );
  if (found === undefined) throw new Error("the send button is not in this pass");
  return found;
}

function field(tree: El[]): El {
  const found = tree.find((el) => el.type === "textarea");
  if (found === undefined) throw new Error("the composer field is not in this pass");
  return found;
}

/**
 * The commit of one pass: the Send button's ref gets an element that counts
 * focus() calls, then the effects useSendFocus registered in this pass run.
 */
const commit: Step = (tree) => {
  const ref = sendButton(tree).props.ref as { current: unknown } | undefined;
  if (ref === undefined || ref === null) throw new Error("the send button carries no ref");
  ref.current = { focus: () => void focused++ };
  const mine = effects.filter((e) => e.from.includes("useSendFocus"));
  effects.length = 0;
  for (const e of mine) e.run();
};

const press =
  (key: string): Step =>
  (tree) => {
    const value = String(field(tree).props.value ?? "");
    (field(tree).props.onKeyDown as (e: unknown) => void)({
      key,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      nativeEvent: { isComposing: false },
      currentTarget: { value, selectionStart: value.length, selectionEnd: value.length },
      preventDefault: () => {},
    });
  };

const hear =
  (text: string): Step =>
  () => {
    heard = text;
  };

const both =
  (...steps: Step[]): Step =>
  (tree) => {
    for (const s of steps) s(tree);
  };

describe("the Send button takes the focus while dictating (criterion 4)", () => {
  it("receives focus() once when the first heard words appear", () => {
    drive(chat, [Chat], [both(commit, hear("hello")), commit, commit]);

    expect(focused).toBe(1);
  });

  it("does not receive it while nothing is heard", () => {
    drive(chat, [Chat], [commit, commit]);

    expect(focused).toBe(0);
  });

  it("does not receive it after a letter typed into the box during the recording", () => {
    drive(chat, [Chat], [both(commit, press("a"), hear("hello")), commit]);

    expect(focused).toBe(0);
  });

  it("still receives it after Tab, which only moves between the box and Send", () => {
    drive(chat, [Chat], [both(commit, press("Tab"), hear("hello")), commit]);

    expect(focused).toBe(1);
  });

  it("moves again in the next recording", () => {
    drive(
      chat,
      [Chat],
      [
        both(commit, hear("hello")),
        both(commit, () => {
          phase = "idle";
          heard = "";
        }),
        both(commit, () => {
          phase = "recording";
        }),
        both(commit, hear("again")),
        commit,
      ],
    );

    expect(focused).toBe(2);
  });
});
