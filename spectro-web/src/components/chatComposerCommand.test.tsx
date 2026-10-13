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
import { __resetSkillList, loadSkills } from "../state/skillList";
import { __resetCommandList, __setCommandRows } from "../state/commandList";
import { coreCommandRows } from "../testkit/commandRows";
import { setViewMode } from "../state/viewMode";

let sent: string[] = [];
let ran: ChatCommandName[] = [];
let accept = true;

beforeEach(() => {
  sent = [];
  ran = [];
  accept = true;
  // The picker asks for the skills on the first slash; nobody answers here.
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  // Card 554: the composer decides against the command list the server serves.
  __setCommandRows(coreCommandRows());
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __resetCommandList();
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
    // Card 554: /help is the first row of the list.
    expect(field(tree).props.value).toBe("/help");
  });

  it("never sends a command of the list as text (card 554)", () => {
    for (const draft of ["/help", "/run-with-playbook add a CSV export", "/playbook list", "/skills"]) {
      sent = [];
      drive(chat, [Chat], [type(draft), enter]);
      expect(sent, draft).toEqual([]);
    }
  });

  it("keeps a command the page answers when the host cannot show the answer (card 554)", () => {
    // This host has no onLocalLine and no Skills view, as the Lab.
    for (const draft of ["/help", "/playbook list", "/skills"]) {
      const tree = drive(chat, [Chat], [type(draft), enter]);
      expect(field(tree).props.value, draft).toBe(draft);
    }
  });

  it("stays in the draft when the frame could not leave", () => {
    accept = false;
    const tree = drive(chat, [Chat], [type("/clear"), clickSend]);

    expect(ran).toEqual(["clear"]);
    expect(sent).toEqual([]);
    expect(field(tree).props.value).toBe("/clear");
  });
});

describe("a slash draft before the command list arrived (card 554, criterion 8h)", () => {
  it("is held in the composer: nothing is sent, nothing runs, the draft stays", () => {
    __resetCommandList();
    const playbook = drive(chat, [Chat], [type("/run-with-playbook add a CSV export"), enter]);
    expect(sent, "never sent to the model as text").toEqual([]);
    expect(ran).toEqual([]);
    expect(field(playbook).props.value).toBe("/run-with-playbook add a CSV export");

    const clear = drive(chat, [Chat], [type("/clear"), clickSend]);
    expect(sent).toEqual([]);
    expect(ran, "not run either: the list decides what a command is").toEqual([]);
    expect(field(clear).props.value).toBe("/clear");
  });

  it("goes once the list is here", () => {
    __resetCommandList();
    __setCommandRows(coreCommandRows());
    drive(chat, [Chat], [type("/clear"), clickSend]);
    expect(ran).toEqual(["clear"]);
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

// Card 588, fix round (I1, M4): with the caret inside the first two words of
// a command draft, Enter sends the draft as it stands, as it did before card
// 588, and never rewrites it. Driven through the real composer: the caret
// moves through the field's select event and Enter through its key handler.
describe("a command draft edited inside its first words", () => {
  const frames: ClientMessage[] = [];
  const withSession = (
    <Chat
      state={initialState}
      liveView={true}
      onSend={(text) => void sent.push(text)}
      onCommand={(command) => {
        ran.push(command);
        return true;
      }}
      onSessionFrame={(frame) => {
        frames.push(frame);
        return true;
      }}
      onLocalLine={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
    />
  );

  /** Moves the caret, as the field's select event reports it. */
  const caretAt =
    (at: number): Step =>
    (tree) =>
      (field(tree).props.onSelect as (e: { currentTarget: { selectionStart: number } }) => void)({
        currentTarget: { selectionStart: at },
      });

  /** Presses Enter with the caret at `at`. */
  const enterAt =
    (at: number): Step =>
    (tree) => {
      const value = String(field(tree).props.value);
      (field(tree).props.onKeyDown as (e: unknown) => void)({
        key: "Enter",
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        nativeEvent: { isComposing: false },
        currentTarget: { value, selectionStart: at, selectionEnd: at },
        preventDefault: () => {},
      });
    };

  // Round 2, N1: the skills a folder with a code graph has, loaded the way
  // the picker loads them. `code-graph` matches every prefix of "graph", so a
  // picker that offered skills for the first word would pick it.
  beforeEach(async () => {
    frames.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            skills: [
              {
                name: "code-graph",
                folder: "code-graph",
                pack: null,
                description: "Ask the code graph.",
                disabled: false,
              },
              {
                name: "verification",
                folder: "verification",
                pack: null,
                description: "Check it.",
                disabled: false,
              },
            ],
          }),
      } as unknown as Response),
    );
    loadSkills();
    await new Promise((r) => setTimeout(r, 0));
  });

  afterEach(() => {
    setViewMode("learn");
  });

  for (const [where, at] of [
    ["inside the subcommand", 8],
    ["right after the first word's space", 7],
    ["at the end of the first word", 6],
    ["inside the first word", 3],
    ["right after the slash", 1],
  ] as const) {
    it(`sends /graph ask with the caret ${where}`, () => {
      const tree = drive(withSession, [Chat], [type("/graph ask who calls X"), caretAt(at), enterAt(at)]);
      expect(frames).toEqual([{ type: "graph_ask", question: "who calls X" }]);
      expect(sent, "never to the model as text").toEqual([]);
      expect(field(tree).props.value, "the draft left whole").toBe("");
    });
  }

  it("sends /playbook use with the caret inside use, in developer mode", () => {
    setViewMode("developer");
    const tree = drive(withSession, [Chat], [type("/playbook use spec-review"), caretAt(11), enterAt(11)]);
    expect(field(tree).props.value, "accepted as /playbook use, not rewritten").toBe("");
    expect(sent).toEqual([]);
  });

  it("runs a command of one word with the caret inside it, and writes no skill over it", () => {
    const tree = drive(withSession, [Chat], [type("/graph"), caretAt(3), enterAt(3)]);
    expect(field(tree).props.value, "accepted as /graph, which lists the subcommands").toBe("");
    expect(sent).toEqual([]);
  });

  it("still completes a skill at the start of a draft that is no command", () => {
    const tree = drive(withSession, [Chat], [type("/ver ask me"), caretAt(4), enterAt(4)]);
    expect(String(field(tree).props.value), "premise: the skill list is still the picker's").toMatch(
      /^\/verification /,
    );
    expect(sent).toEqual([]);
  });

  it("keeps the skills under the commands while the caret ends the draft", () => {
    const tree = drive(withSession, [Chat], [type("/graph")]);
    const names = tree
      .filter((el) => String(el.props.className ?? "").includes("slash-name"))
      .map((el) => String(el.props.children));
    expect(names, "the command rows").toContain("/graph");
    expect(names, "and the skill below them").toContain("code-graph");
  });

  it("still completes the subcommand when the caret ends the draft", () => {
    const tree = drive(withSession, [Chat], [type("/graph a"), enterAt(8)]);
    expect(field(tree).props.value, "premise: the picker still picks at the end").toBe("/graph ask ");
    expect(frames).toEqual([]);
  });
});
