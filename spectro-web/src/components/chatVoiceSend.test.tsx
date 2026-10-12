// Card 527 criterion 3 on the composer itself: while recording, Send is
// enabled on heard words; Enter or Send stops the recording, takes the last
// words and sends them with the draft in one gesture; a transcript that
// arrives after the send never lands in the composer.
//
// The Chat component is driven through its own textarea and send button (the
// drive() probe hosts its hooks; no DOM, house rule). The microphone is a fake
// voice hook behind the seam in voiceHook.ts, standing in for the socket: it
// hands Chat the heard words and, like the real hook's TakeGate, swallows a
// transcript once a send has claimed the take.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import { initialState } from "../state/reducer";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { __resetSkillList } from "../state/skillList";
import { __setVoiceHook } from "./voiceHook";
import { SpeechModelOpening } from "./OpeningSurface";
import type { MicPhase } from "./voiceButton";
import type { VoiceInput } from "./useVoiceInput";

let sent: string[] = [];
let finishCalls = 0;
let claimed = false;
let deliver: ((text: string) => void) | null = null;

/** A microphone in `phase` that has heard `heard`; `loading` is the server's
 *  word that the speech model loads (card 528). */
function fakeVoice(phase: MicPhase, heard: string, loading = phase === "warming"): void {
  __setVoiceHook((onTranscript): VoiceInput => {
    deliver = onTranscript;
    return {
      micPhase: phase,
      modelLoading: loading,
      micAvailable: true,
      micError: null,
      level: 0,
      choice: { devices: [], unnamed: false },
      refreshDevices: async () => {},
      recordMs: 0,
      provisional: heard,
      liveFailed: null,
      toggleMic: async () => {},
      finish: () => {
        finishCalls++;
        claimed = true;
        return Promise.resolve(heard);
      },
    };
  });
}

beforeEach(() => {
  sent = [];
  finishCalls = 0;
  claimed = false;
  deliver = null;
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __setVoiceHook(null);
});

const chat = (
  <Chat
    state={initialState}
    liveView={true}
    onSend={(text) => void sent.push(text)}
    onReturnToLive={() => {}}
    sendClient={() => true}
  />
);

function field(tree: El[]): El {
  const found = tree.find((el) => el.type === "textarea");
  if (found === undefined) throw new Error("the composer field is not in this pass");
  return found;
}

function sendButton(tree: El[]): El {
  const found = tree.find(
    (el) => el.type === "button" && String(el.props.className).includes("composer-seat--send"),
  );
  if (found === undefined) throw new Error("the send button is not in this pass");
  return found;
}

function micButton(tree: El[]): El {
  const found = tree.find((el) => el.type === "button" && String(el.props.className).includes("mic-button"));
  if (found === undefined) throw new Error("the mic button is not in this pass");
  return found;
}

const type =
  (value: string): Step =>
  (tree) =>
    (field(tree).props.onChange as (e: { target: { value: string; selectionStart: number } }) => void)({
      target: { value, selectionStart: value.length },
    });

const clickSend: Step = (tree) => sendButton(tree).props.onClick?.();

const enter: Step = (tree) => {
  const value = String(field(tree).props.value);
  (field(tree).props.onKeyDown as (e: unknown) => void)({
    key: "Enter",
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    currentTarget: { value, selectionStart: value.length, selectionEnd: value.length },
    preventDefault: () => {},
  });
};

/** The real hook hands a late final to the draft only when no send claimed it. */
const lateFinal =
  (text: string): Step =>
  () => {
    if (!claimed) deliver?.(text);
  };

/** Lets the finish promise and the send after it run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Send while recording", () => {
  it("is enabled as soon as words were heard, with nothing typed", () => {
    fakeVoice("recording", "hello there");
    const tree = drive(chat, [Chat], [() => {}]);

    expect(sendButton(tree).props.disabled).toBe(false);
  });

  it("stays disabled while recording with nothing heard and nothing typed", () => {
    fakeVoice("recording", "");
    const tree = drive(chat, [Chat], [() => {}]);

    expect(sendButton(tree).props.disabled).toBe(true);
  });

  it("stops the recording, takes the last words and sends them with the draft in one gesture", async () => {
    fakeVoice("recording", "hello there");
    drive(chat, [Chat], [type("Note:"), clickSend]);

    expect(finishCalls, "the recording was asked to finish").toBe(1);
    expect(sent, "nothing leaves before the last words are in").toEqual([]);
    await settle();
    expect(sent).toEqual(["Note: hello there"]);
  });

  it("does the same on Enter", async () => {
    fakeVoice("recording", "hello there");
    drive(chat, [Chat], [enter]);

    await settle();
    expect(finishCalls).toBe(1);
    expect(sent).toEqual(["hello there"]);
  });

  it("a transcript after the send never lands in the composer", () => {
    fakeVoice("recording", "hello there");
    const tree = drive(chat, [Chat], [type("Note:"), clickSend, lateFinal("late words"), () => {}]);

    expect(String(field(tree).props.value)).not.toContain("late words");
  });

  it("waits for the batch answer the same way while the last words are transcribed", async () => {
    fakeVoice("transcribing", "");
    drive(chat, [Chat], [type("Note:"), enter]);

    await settle();
    expect(finishCalls).toBe(1);
    expect(sent).toEqual(["Note:"]);
  });

  it("a second Enter while finishing sends nothing more", async () => {
    fakeVoice("finishing", "hello there");
    drive(chat, [Chat], [type("Note:"), enter]);

    await settle();
    expect(finishCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  it("the microphone button says it is finishing", () => {
    fakeVoice("finishing", "hello there");
    const tree = drive(chat, [Chat], [() => {}]);

    expect(micButton(tree).props["aria-label"]).toBe("Finishing the recording and sending ...");
    expect(micButton(tree).props.disabled).toBe(true);
  });

  it("with the microphone off, Send sends the draft as it always did", () => {
    fakeVoice("idle", "");
    drive(chat, [Chat], [type("just text"), clickSend]);

    expect(finishCalls).toBe(0);
    expect(sent).toEqual(["just text"]);
  });
});

describe("the loading surface while the speech model loads (criterion 8)", () => {
  const surface = (tree: El[]): El | undefined =>
    tree.find((el) => el.type === "div" && String(el.props.className).includes("opening-surface"));

  it("covers the composer between the press and ready", () => {
    fakeVoice("warming", "");
    const tree = drive(chat, [Chat, SpeechModelOpening], [() => {}]);

    expect(surface(tree), "the surface is in the tree from the click").toBeDefined();
    expect(JSON.stringify(tree.map((el) => el.props.children ?? null))).toContain("Loading the speech model");
  });

  it("is not there while warming against a model that is already loaded (card 528)", () => {
    fakeVoice("warming", "", false);
    const tree = drive(chat, [Chat, SpeechModelOpening], [() => {}]);

    expect(surface(tree), "the second press shows no loading card").toBeUndefined();
  });

  it("is gone once the recording runs", () => {
    fakeVoice("recording", "hello");
    const tree = drive(chat, [Chat, SpeechModelOpening], [() => {}]);

    expect(surface(tree)).toBeUndefined();
  });

  it("is not there with the microphone off", () => {
    fakeVoice("idle", "");
    expect(surface(drive(chat, [Chat, SpeechModelOpening], [() => {}]))).toBeUndefined();
  });
});

describe("the microphone glyph on the button (card 528 criterion 8)", () => {
  const glyph = (tree: El[]): El | undefined =>
    tree.find((el) => el.type === "svg" && String(el.props.className ?? "").includes("mic-glyph"));
  const capsule = (tree: El[]): El | undefined =>
    tree.find((el) => el.type === "rect" && el.props.x === "6" && el.props.width === "4");

  it("is the microphone, filled, while recording", () => {
    fakeVoice("recording", "hello");
    const tree = drive(chat, [Chat, SpeechModelOpening], [() => {}]);

    expect(String(glyph(tree)?.props.className)).toContain("mic-glyph--filled");
    expect(capsule(tree)?.props.fill, "the capsule is filled").toBe("currentColor");
    expect(
      tree.some((el) => el.type === "rect" && el.props.width === "9"),
      "no square",
    ).toBe(false);
  });

  it("is the microphone, outlined, while idle", () => {
    fakeVoice("idle", "");
    const tree = drive(chat, [Chat, SpeechModelOpening], [() => {}]);

    expect(String(glyph(tree)?.props.className)).not.toContain("mic-glyph--filled");
    expect(capsule(tree)?.props.fill ?? "none").toBe("none");
  });
});
