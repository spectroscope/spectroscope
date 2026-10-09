// Card 471, criterion 1 and the security criterion, on the composer itself.
//
// The Chat component is driven through its own textarea and send button (the
// drive() probe hosts its hooks; no DOM, house rule). A draft that is exactly
// a command reaches the command callback and never onSend. A sentence that
// merely mentions "/clear" reaches onSend as written and no command runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import { initialState } from "../state/reducer";
import type { ChatCommandName } from "../state/chatCommands";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { __resetSkillList } from "../state/skillList";

let sent: string[] = [];
let ran: ChatCommandName[] = [];
let accept = true;

beforeEach(() => {
  sent = [];
  ran = [];
  accept = true;
  // The picker asks for the skills on the first slash; nobody answers here.
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
});

const chat = (
  <Chat
    state={initialState}
    liveView={true}
    onSend={(text) => void sent.push(text)}
    onCommand={(command) => {
      ran.push(command);
      return accept;
    }}
    onReturnToLive={() => {}}
    sendClient={() => true}
  />
);

function field(tree: El[]): El {
  const found = tree.find((el) => el.type === "textarea");
  if (found === undefined) throw new Error("the composer field is not in this pass");
  return found;
}

/** Types the whole draft, the caret at its end, as a change event delivers it. */
const type =
  (value: string): Step =>
  (tree) =>
    // The host props type the change event as `{ target: { value } }`; the
    // composer also reads the caret off it, so the caret rides along.
    (field(tree).props.onChange as (e: { target: { value: string; selectionStart: number } }) => void)({
      target: { value, selectionStart: value.length },
    });

/** Clicks the send button. */
const clickSend: Step = (tree) => {
  const button = tree.find(
    (el) => el.type === "button" && String(el.props.className).includes("composer-seat--send"),
  );
  if (button === undefined) throw new Error("the send button is not in this pass");
  button.props.onClick?.();
};

/** Presses Enter in the field. */
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

describe("a command typed into the composer", () => {
  it("runs through the command callback when sent, and never reaches onSend", () => {
    const tree = drive(chat, [Chat], [type("/clear"), clickSend]);

    expect(ran).toEqual(["clear"]);
    expect(sent).toEqual([]);
    expect(field(tree).props.value, "the draft empties once the frame left").toBe("");
  });

  it("runs when Enter is pressed on the whole command", () => {
    drive(chat, [Chat], [type("/compact"), enter]);

    expect(ran).toEqual(["compact"]);
    expect(sent).toEqual([]);
  });

  it("a partial name and Enter complete the command; a second Enter runs it", () => {
    const once = drive(chat, [Chat], [type("/cl"), enter]);

    expect(ran, "one Enter on a partial name runs nothing").toEqual([]);
    expect(field(once).props.value).toBe("/clear");

    const twice = drive(chat, [Chat], [type("/cl"), enter, enter]);

    expect(ran).toEqual(["clear"]);
    expect(sent).toEqual([]);
    expect(field(twice).props.value).toBe("");
  });

  it("a slash and Enter run nothing", () => {
    const tree = drive(chat, [Chat], [type("/"), enter]);

    expect(ran).toEqual([]);
    expect(sent).toEqual([]);
    expect(field(tree).props.value).toBe("/compact");
  });

  it("stays in the draft when the frame could not leave", () => {
    accept = false;
    const tree = drive(chat, [Chat], [type("/clear"), clickSend]);

    expect(ran).toEqual(["clear"]);
    expect(sent).toEqual([]);
    expect(field(tree).props.value).toBe("/clear");
  });
});

describe("a sentence that mentions a command", () => {
  it("is a prompt, sent as written, and runs nothing", () => {
    drive(chat, [Chat], [type("please /clear the cache"), clickSend]);

    expect(sent).toEqual(["please /clear the cache"]);
    expect(ran).toEqual([]);
  });

  it("is a prompt when the command opens it and words follow", () => {
    drive(chat, [Chat], [type("/clear the cache"), enter]);

    expect(sent).toEqual(["/clear the cache"]);
    expect(ran).toEqual([]);
  });
});

describe("the send button while the history is being compacted", () => {
  const during = (compacting: boolean) => (
    <Chat
      state={{ ...initialState, running: true, compacting }}
      liveView={true}
      steers={true}
      onSend={(text) => void sent.push(text)}
      onCommand={() => true}
      onReturnToLive={() => {}}
      sendClient={() => true}
    />
  );
  const sendLabel = (tree: El[]): string => {
    const button = tree.find(
      (el) => el.type === "button" && String(el.props.className).includes("composer-seat--send"),
    );
    if (button === undefined) throw new Error("the send button is not in this pass");
    return String(button.props["aria-label"]);
  };

  it("premise: during a run a sentence steers", () => {
    expect(sendLabel(drive(during(false), [Chat], [type("and also this")]))).toBe("Steer");
  });

  it("says Queue, since there is no run to steer", () => {
    expect(sendLabel(drive(during(true), [Chat], [type("and also this")]))).toBe("Queue");
  });
});
