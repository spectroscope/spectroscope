// Card 554, task 13, on the composer itself: the commands of the list that
// are not /compact, /clear or /loop.
//
// The frames of the session leave through the host's onSessionFrame, which
// App points at the session's own socket, and never through sendClient (the
// socket in view, criterion 6) or onSend (the model): /run-with-playbook asks
// for the start sheet, /playbook workflow starts a workflow, /playbook use
// picks a playbook. /help and the playbook rows that only read are answered
// as a line of this chat; /skills opens the Skills and Commands view. A step's
// prompt carries the playbook's eyebrow (criterion 8f), and the answer to
// /playbook show links to the playbook's Steps tab.
//
// Driven through the composer's own field with the drive() probe, no DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import type { ClientMessage } from "../events";
import { t } from "../i18n/i18n";
import { initialState, type UiState } from "../state/reducer";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { __resetSkillList } from "../state/skillList";
import { __resetCommandList, __setCommandRows, commandListStatus, loadCommands } from "../state/commandList";
import { coreCommandRows } from "../testkit/commandRows";
import { helpText } from "../state/chatCommands";
import type { LocalLine } from "../state/pageCommands";
import { read, stripComments } from "../testkit/source";

let sent: string[] = [];
let session: ClientMessage[] = [];
let direct: ClientMessage[] = [];
let lines: LocalLine[] = [];
let skills = 0;
let opened: string[] = [];

beforeEach(() => {
  sent = [];
  session = [];
  direct = [];
  lines = [];
  skills = 0;
  opened = [];
  __setCommandRows(coreCommandRows());
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/playbooks?")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ folders: ["/pb/spectro", "/pb/team-x"], active: null }),
        });
      }
      if (url.startsWith("/api/playbooks/load")) {
        const dir = decodeURIComponent(/dir=([^&]*)/.exec(url)?.[1] ?? "");
        return Promise.resolve({
          ok: true,
          json: async () => ({ dir, findings: [], steps: [], topology: null, playbook: null }),
        });
      }
      return new Promise(() => {});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __resetCommandList();
});

function chat(state: UiState = initialState) {
  return (
    <Chat
      state={state}
      liveView={true}
      onSend={(text) => void sent.push(text)}
      onCommand={() => true}
      onSessionFrame={(frame) => {
        session.push(frame);
        return true;
      }}
      onLocalLine={(line) => void lines.push(line)}
      onOpenSkills={() => void skills++}
      onOpenPlaybook={(dir) => void opened.push(dir)}
      commandWorkspace="/ws"
      onReturnToLive={() => {}}
      sendClient={(msg) => {
        direct.push(msg);
        return true;
      }}
    />
  );
}

function field(tree: El[]): El {
  const found = tree.find((el) => el.type === "textarea");
  if (found === undefined) throw new Error("the composer field is not in this pass");
  return found;
}

const type =
  (value: string): Step =>
  (tree) =>
    (field(tree).props.onChange as (e: { target: { value: string; selectionStart: number } }) => void)({
      target: { value, selectionStart: value.length },
    });

const clickSend: Step = (tree) => {
  const button = tree.find(
    (el) => el.type === "button" && String(el.props.className).includes("composer-seat--send"),
  );
  if (button === undefined) throw new Error("the send button is not in this pass");
  button.props.onClick?.();
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe("the playbook commands that leave as frames of the session", () => {
  it("asks for the start sheet with the prompt, on the session's own socket (criteria 1, 6, 8b)", () => {
    const tree = drive(chat(), [Chat], [type("/run-with-playbook add a CSV export"), clickSend]);
    expect(session).toEqual([{ type: "confirm_playbook", prompt: "add a CSV export" }]);
    expect(direct, "never on the socket in view").toEqual([]);
    expect(sent, "never to the model").toEqual([]);
    expect(field(tree).props.value).toBe("");
  });

  it("reads the alias /playbook run the same way", () => {
    drive(chat(), [Chat], [type("/playbook run add a CSV export"), clickSend]);
    expect(session).toEqual([{ type: "confirm_playbook", prompt: "add a CSV export" }]);
  });

  it("starts a workflow by name at once, with its input (criterion 8a)", () => {
    drive(chat(), [Chat], [type("/playbook workflow fan check the auth module"), clickSend]);
    expect(session).toEqual([
      { type: "start_workflow", name: "fan", input: "check the auth module", lang: "en" },
    ]);
    expect(direct).toEqual([]);
  });

  it("picks a playbook by name on the session's own socket", async () => {
    drive(chat(), [Chat], [type("/playbook use team-x"), clickSend]);
    await flush();
    expect(session).toEqual([{ type: "set_playbook", dir: "/pb/team-x" }]);
    expect(direct).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("a slash draft before the list arrived, in a host that runs every command (criterion 8h)", () => {
  it("stays in the composer: no frame, nothing to the model, only the line that says why", async () => {
    __resetCommandList();
    const tree = drive(chat(), [Chat], [type("/playbook list"), clickSend]);
    await flush();
    expect(field(tree).props.value).toBe("/playbook list");
    // Fix round 3, item 8: the one line is the composer's own, no answer of the command.
    expect(lines).toEqual([{ text: t("en", "slash.heldLoading") }]);
    expect(session).toEqual([]);
    expect(direct).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("the commands the page answers", () => {
  it("answers /help with one line of this chat and sends nothing", () => {
    const tree = drive(chat(), [Chat], [type("/help"), clickSend]);
    expect(lines).toEqual([{ text: helpText(coreCommandRows(), "en", "learn") }]);
    expect(session).toEqual([]);
    expect(direct).toEqual([]);
    expect(sent).toEqual([]);
    expect(field(tree).props.value).toBe("");
  });

  it("opens the Skills and Commands view for /skills", () => {
    drive(chat(), [Chat], [type("/skills"), clickSend]);
    expect(skills).toBe(1);
    expect(sent).toEqual([]);
  });

  it("lists the playbooks as a line, reading the folders of the session's workspace", async () => {
    drive(chat(), [Chat], [type("/playbook list"), clickSend]);
    await flush();
    expect(lines).toEqual([
      { text: "Playbooks you can use:\n- spectro (/pb/spectro)\n- team-x (/pb/team-x)" },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/playbooks?workspace=%2Fws");
  });

  it("names the session's pick without a read", () => {
    const picked = { ...initialState, playbook: { dir: "/pb/team-x", name: "Team X", found: true } };
    drive(chat(picked), [Chat], [type("/playbook"), clickSend]);
    return flush().then(() => {
      expect(lines).toEqual([{ text: "Current playbook: Team X\nFolder: /pb/team-x\nSource: picked" }]);
    });
  });
});

describe("what the chat draws for the playbook (criterion 8f)", () => {
  const eyebrows = (tree: El[]): unknown[] =>
    tree.filter((el) => el.type === "div" && el.props.className === "eyebrow").map((el) => el.props.children);

  it("heads a step's prompt with Playbook, and the owner's own prompt with You", () => {
    const state: UiState = {
      ...initialState,
      turns: [
        { kind: "user", text: "add a CSV export" },
        { kind: "user", text: "Task: add a CSV export\nClassify it.", by: "playbook" },
      ],
    };
    const tree = drive(chat(state), [Chat], []);
    expect(eyebrows(tree)).toEqual([t("en", "chat.you"), t("en", "chat.byPlaybook")]);
  });

  it("links the answer to /playbook show to the playbook's Steps tab", () => {
    const state: UiState = {
      ...initialState,
      turns: [{ kind: "info", text: "Playbook spectro", tone: "neutral", openPlaybook: "/pb/spectro" }],
    };
    const press: Step = (tree) => {
      const link = tree.find(
        (el) => el.type === "button" && el.props.children === t("en", "pbcmd.show.open"),
      );
      expect(link, "the link is drawn").toBeDefined();
      link?.props.onClick?.();
    };
    drive(chat(state), [Chat], [press]);
    expect(opened).toEqual(["/pb/spectro"]);
  });
});

describe("the composer takes the play button's text (criterion 4)", () => {
  // drive() renders on the server renderer, where effects do not run; the
  // hook's behaviour is pinned in composerPrefillTake.test.ts. Here the
  // wiring is read off the source.
  const src = stripComments(read("./Chat.tsx", import.meta.url));

  it("takes a prefill only while the composer is open, into the draft, with the caret at the end and the focus", () => {
    const at = src.indexOf("useTakePrefill(composerOpen,");
    expect(at, "the composer takes the prefill").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("});", at));
    expect(body).toContain("prefilledDraft(text, draftRef.current)");
    expect(body).toContain("setDraft(next)");
    expect(body).toContain("el.focus()");
    expect(body).toContain("setSelectionRange(next.length, next.length)");
    expect(body, "a prefill sends nothing").not.toMatch(/onSend|sendSession|sendClient/);
  });
});

// Card 554 fix round 3, item 1 (criterion 6): /playbook use answers after
// reads, and by then the owner may be in another session. The composer asks
// its host for the sender when the command is submitted, so the frame goes to
// the record that was on screen then, never to the one in view later.
describe("a page command's frames go to the session it was typed in", () => {
  it("binds the sender when the command is submitted, not when the frame leaves", async () => {
    const bound: string[] = [];
    let binds = 0;
    const host = (
      <Chat
        state={initialState}
        liveView={true}
        onSend={(text) => void sent.push(text)}
        onCommand={() => true}
        onSessionFrame={(frame) => {
          session.push(frame);
          return true;
        }}
        onBindSessionFrame={() => {
          const at = `submit ${++binds}`;
          return (frame) => {
            bound.push(`${at}: ${frame.type}`);
            return true;
          };
        }}
        onLocalLine={(line) => void lines.push(line)}
        commandWorkspace="/ws"
        onReturnToLive={() => {}}
        sendClient={(msg) => {
          direct.push(msg);
          return true;
        }}
      />
    );
    drive(host, [Chat], [type("/playbook use team-x"), clickSend]);
    expect(binds, "bound at the submit, before any read").toBe(1);
    await flush();
    expect(bound).toEqual(["submit 1: set_playbook"]);
    expect(session, "not the sender of the render in view").toEqual([]);
    expect(direct).toEqual([]);
  });
});

// Card 554 fix round 3, item 3: an error that answers a command is no failed
// prompt. It offers no "Send again", and a resend never picks a playbook
// step's prompt as the owner's text.
describe("Send again after an error", () => {
  let current: UiState = initialState;
  function Host() {
    return chat(current);
  }
  const sendAgain = (tree: El[]): El | undefined =>
    tree.find((el) => el.type === "button" && el.props.children === t("en", "chat.sendAgain"));
  const fail =
    (text: string): Step =>
    () => {
      current = { ...current, turns: [...current.turns, { kind: "error", text }] };
    };

  it("is not offered under the refusal of a command", () => {
    current = { ...initialState, turns: [{ kind: "user", text: "hello" }] };
    const tree = drive(
      <Host />,
      [Host, Chat],
      [type("/run-with-playbook add it"), clickSend, fail("No playbook")],
    );
    expect(session, "premise: the command left").toEqual([{ type: "confirm_playbook", prompt: "add it" }]);
    expect(sendAgain(tree)).toBeUndefined();
  });

  it("resends the owner's last prompt after a failed prompt, never a playbook step's", () => {
    current = {
      ...initialState,
      turns: [
        { kind: "user", text: "hello" },
        { kind: "user", text: "Task: add it\nProbe the code.", by: "playbook" },
        { kind: "error", text: "the provider is down" },
      ],
    };
    const press: Step = (tree) => {
      const button = sendAgain(tree);
      expect(button, "offered under a failed prompt").toBeDefined();
      button?.props.onClick?.();
    };
    drive(<Host />, [Host, Chat], [press]);
    expect(sent).toEqual(["hello"]);
  });
});

// Card 554 fix round 3, item 8 (criterion 8h): Enter on a draft held because
// the command list could not be read asks the server again and says so.
describe("Enter on a held draft", () => {
  it("asks for the command list again when it failed, and says the commands could not be loaded", async () => {
    __resetCommandList();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    loadCommands();
    await flush();
    expect(commandListStatus(), "premise").toBe("failed");
    const retry = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", retry);
    const tree = drive(chat(), [Chat], [type("/clear"), clickSend]);
    expect(field(tree).props.value, "the draft stays").toBe("/clear");
    expect(retry).toHaveBeenCalledWith("/api/commands", expect.anything());
    expect(lines).toEqual([{ text: t("en", "slash.heldFailed"), tone: "warn" }]);
    expect(sent).toEqual([]);
  });

  it("says the commands are still loading while the request is out", () => {
    __resetCommandList();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    loadCommands();
    drive(chat(), [Chat], [type("/clear"), clickSend]);
    expect(lines).toEqual([{ text: t("en", "slash.heldLoading") }]);
  });
});
