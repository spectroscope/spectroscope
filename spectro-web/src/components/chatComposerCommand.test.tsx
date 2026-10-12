// Card 471, criterion 1 and the security criterion, on the composer itself.
//
// The Chat component is driven through its own textarea and send button (the
// drive() probe hosts its hooks; no DOM, house rule). A draft that is exactly
// a command reaches the command callback and never onSend. A sentence that
// merely mentions "/clear" reaches onSend as written and no command runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import { ComposerGear } from "./ComposerGear";
import { GoalSection } from "./GoalSection";
import { LocalModeSection } from "./LocalModeSection";
import { ToolGroupsSection } from "./ToolGroupsSection";
import type { ClientMessage } from "../events";
import { t } from "../i18n/i18n";
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

describe("/loop in the composer (card 504, fix round 2)", () => {
  // Found in the live check: on a stored session the page's sendClient goes
  // to the socket in view, not to the session's own, so /loop stop on a
  // reopened session reached nobody. The loop frames leave through the host's
  // onSessionFrame (onLoopFrame until the hub and spoke fix round), which
  // continues a stored session first, as /clear does.
  const frames: { type: string; action?: string }[] = [];
  const direct: { type: string }[] = [];
  const host = (
    <Chat
      state={initialState}
      liveView={true}
      onSend={(text) => void sent.push(text)}
      onCommand={() => true}
      onSessionFrame={(frame) => {
        frames.push(frame as { type: string; action?: string });
        return true;
      }}
      onReturnToLive={() => {}}
      sendClient={(msg) => {
        direct.push(msg);
        return true;
      }}
    />
  );

  it("sends /loop stop through onSessionFrame and not through sendClient", () => {
    frames.length = 0;
    direct.length = 0;
    const tree = drive(host, [Chat], [type("/loop stop"), clickSend]);
    expect(frames).toEqual([{ type: "set_loop", action: "stop" }]);
    expect(direct).toEqual([]);
    expect(sent).toEqual([]);
    expect(field(tree).props.value).toBe("");
  });

  it("sends a /loop start through onSessionFrame too", () => {
    frames.length = 0;
    direct.length = 0;
    drive(host, [Chat], [type("/loop 5m check the build"), clickSend]);
    expect(frames.map((f) => [f.type, f.action])).toEqual([["set_loop", "start"]]);
    expect(direct).toEqual([]);
  });
});

describe("the goal in the composer gear (card 504, hub and spoke fix round)", () => {
  // The review found Set goal and Clear goal on sendClient: on a stored
  // session that is the socket in view, another session's. They leave through
  // the host's onSessionFrame, as /loop does. The gear's popover mounts the
  // section only when open, so the probe opens the gear and reads the
  // section's sender off its element; the section's own buttons are driven
  // on their own below.
  const GOAL = { stated: true, outcome: "the tests are green", check: "npm test", file: "/h/g.goal.md" };
  const frames: ClientMessage[] = [];
  const direct: ClientMessage[] = [];
  const toFrames = (frame: ClientMessage): boolean => {
    frames.push(frame);
    return true;
  };
  const toDirect = (msg: ClientMessage): boolean => {
    direct.push(msg);
    return true;
  };
  const openGear: Step = (tree) => {
    const gear = tree.find(
      (el) =>
        el.type === "button" &&
        el.props["aria-haspopup"] === "dialog" &&
        el.props.title === t("en", "wsg.title"),
    );
    if (gear === undefined) throw new Error("the gear is not in this pass");
    gear.props.onClick?.();
  };
  const section = (tree: El[]): El => {
    const found = tree.find((el) => el.type === GoalSection);
    if (found === undefined) throw new Error("the goal section is not in this pass");
    return found;
  };
  const press =
    (key: "goal.set" | "goal.clear"): Step =>
    (tree) => {
      const button = tree.find((el) => el.type === "button" && el.props.children === t("en", key));
      if (button === undefined) throw new Error(`${key} is not in this pass`);
      button.props.onClick?.();
    };

  it("the gear hands the goal section the host's onSessionFrame, not sendClient", () => {
    frames.length = 0;
    direct.length = 0;
    const host = (
      <Chat
        state={{ ...initialState, goal: GOAL }}
        liveView={true}
        onSend={() => {}}
        onSessionFrame={toFrames}
        onReturnToLive={() => {}}
        sendClient={toDirect}
      />
    );
    const tree = drive(host, [Chat, ComposerGear], [openGear]);
    const send = section(tree).props.sendSession as (msg: ClientMessage) => boolean;
    expect(send({ type: "set_goal", outcome: "o", check: "c" })).toBe(true);
    expect(frames).toEqual([{ type: "set_goal", outcome: "o", check: "c" }]);
    expect(direct, "never on the socket in view").toEqual([]);
  });

  it("without a host frame the section falls back to sendClient, as /loop does", () => {
    frames.length = 0;
    direct.length = 0;
    const bare = (
      <Chat
        state={{ ...initialState, goal: GOAL }}
        liveView={true}
        onSend={() => {}}
        onReturnToLive={() => {}}
        sendClient={toDirect}
      />
    );
    const tree = drive(bare, [Chat, ComposerGear], [openGear]);
    (section(tree).props.sendSession as (msg: ClientMessage) => boolean)({
      type: "set_goal",
      outcome: "",
      check: "",
    });
    expect(direct).toEqual([{ type: "set_goal", outcome: "", check: "" }]);
  });

  it("Set goal and Clear goal leave through the section's sendSession", () => {
    frames.length = 0;
    const goal = <GoalSection lang="en" goal={GOAL} sendSession={toFrames} />;
    drive(goal, [GoalSection], [press("goal.set")]);
    drive(goal, [GoalSection], [press("goal.clear")]);
    expect(frames).toEqual([
      { type: "set_goal", outcome: "the tests are green", check: "npm test" },
      { type: "set_goal", outcome: "", check: "" },
    ]);
  });
});

describe("the gear's other session frames (card 504, hub and spoke review, round 1)", () => {
  // The review found the permission mode, the tool groups and Local mode on
  // sendClient. On a stored session that is the socket in view, another
  // session's, so a mode chosen in a reopened session could switch a different
  // live one. Every frame the gear sends belongs to the session on screen and
  // leaves through sendSession, which App continues a stored session for first.
  const frames: ClientMessage[] = [];
  const direct: ClientMessage[] = [];
  const toFrames = (frame: ClientMessage): boolean => {
    frames.push(frame);
    return true;
  };
  const toDirect = (msg: ClientMessage): boolean => {
    direct.push(msg);
    return true;
  };
  const openGear: Step = (tree) => {
    const gear = tree.find(
      (el) =>
        el.type === "button" &&
        el.props["aria-haspopup"] === "dialog" &&
        el.props.title === t("en", "wsg.title"),
    );
    if (gear === undefined) throw new Error("the gear is not in this pass");
    gear.props.onClick?.();
  };
  const one = (tree: El[], type: unknown, what: string): El => {
    const found = tree.find((el) => el.type === type);
    if (found === undefined) throw new Error(`${what} is not in this pass`);
    return found;
  };
  /** Presses every control of the gear that sends a frame of the session. */
  const pressAll = (tree: El[]): void => {
    const modes = tree.filter((el) => el.type === "div" && el.props.role === "option");
    expect(modes.length, "positive: the four permission modes are drawn").toBe(4);
    modes[1]?.props.onClick?.();
    (one(tree, ToolGroupsSection, "the tool groups").props.onChange as unknown as (off: string[]) => void)([
      "web",
    ]);
    const local = one(tree, LocalModeSection, "Local mode").props;
    (local.onSwitch as (on: boolean) => void)(true);
    (local.onEdit as (key: string, value: unknown) => void)("maxTurns", 40);
    (local.onReset as (key: string) => void)("maxTurns");
  };
  const EXPECTED: ClientMessage[] = [
    { type: "set_permission_mode", mode: "auto" },
    { type: "set_tool_groups_off", groups: ["web"], save: false },
    { type: "set_local_mode", on: true },
    { type: "set_local_mode", values: { maxTurns: 40 } },
    { type: "set_local_mode", reset: ["maxTurns"] },
  ];

  it("the permission mode, the tool groups and Local mode leave through sendSession, never sendClient", () => {
    frames.length = 0;
    direct.length = 0;
    const gear = (
      <ComposerGear
        workspaceInfo={null}
        permissionMode="ask"
        toolGroups={null}
        localMode={null}
        sendClient={toDirect}
        sendSession={toFrames}
      />
    );
    pressAll(drive(gear, [ComposerGear], [openGear]));
    expect(frames).toEqual(EXPECTED);
    expect(direct, "never on the socket in view").toEqual([]);
  });

  it("through Chat they reach the host's onSessionFrame", () => {
    frames.length = 0;
    direct.length = 0;
    const host = (
      <Chat
        state={initialState}
        liveView={false}
        continuable={true}
        onSend={() => {}}
        onSessionFrame={toFrames}
        onReturnToLive={() => {}}
        sendClient={toDirect}
      />
    );
    pressAll(drive(host, [Chat, ComposerGear], [openGear]));
    expect(frames).toEqual(EXPECTED);
    expect(direct, "a stored session's gear never sends on the socket in view").toEqual([]);
  });

  it("without sendSession they fall back to sendClient, as the goal does", () => {
    frames.length = 0;
    direct.length = 0;
    const gear = (
      <ComposerGear
        workspaceInfo={null}
        permissionMode="ask"
        toolGroups={null}
        localMode={null}
        sendClient={toDirect}
      />
    );
    pressAll(drive(gear, [ComposerGear], [openGear]));
    expect(direct).toEqual(EXPECTED);
  });
});
