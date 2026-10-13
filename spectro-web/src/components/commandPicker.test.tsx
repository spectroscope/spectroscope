// Card 471, criterion 1: the slash picker lists two commands above the skills.
// Card 554: the commands are the web rows of the core list, grouped, /help
// first; the playbook group only in developer mode. A command that takes
// words is written into the draft; a whole command other than /compact and
// /clear is the composer's to send, so Enter on it is not the picker's.
//
// /compact and /clear stand first, each with a one-line help, and only when
// the slash opens the draft: a command is the whole message or nothing. A
// command never reaches the model as a prompt: it runs through the composer's
// command callback. Review round: Enter runs a command only when the draft
// already spells it out. On a partial name ("/" or "/cl") Enter writes the
// highlighted command into the draft, as Tab does, so a slash and a stray Enter
// cannot fire a model call that rewrites the history. A click runs the row.
//
// No DOM in this suite (house rule): static markup plus the drive() probe, the
// same harness slashPickerStates.test.tsx uses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSlashPicker, type SlashPicker } from "./SlashPicker";
import { __resetSkillList, loadSkills } from "../state/skillList";
import type { SkillOption } from "../state/slashCommands";
import type { ChatCommandName } from "../state/chatCommands";
import { drive, type El } from "../testkit/driveComponent";
import { setLang } from "../state/lang";
import { __resetCommandList, __setCommandRows, loadCommands } from "../state/commandList";
import { setViewMode } from "../state/viewMode";
import { coreCommandRows } from "../testkit/commandRows";

const SKILLS: SkillOption[] = [
  { name: "clean-code", folder: "clean-code", pack: null, description: "Tidy the diff.", disabled: false },
  { name: "verification", folder: "verification", pack: null, description: "Check it.", disabled: false },
];

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function serve(skills: SkillOption[]): Promise<void> {
  __resetSkillList();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ skills }),
    } as unknown as Response),
  );
  loadSkills();
  await flush();
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
  __resetCommandList();
  setLang("en");
  setViewMode("learn");
});

let picked: { text: string; caret: number }[] = [];
let ran: ChatCommandName[] = [];

function Picker({ draft }: { draft: string }) {
  const slash = useSlashPicker(
    draft,
    draft.length,
    true,
    (text, caret) => void picked.push({ text, caret }),
    (command) => void ran.push(command),
  );
  return (
    <div className="composer-inner">
      <textarea value={draft} readOnly onKeyDown={slash.handleKey} />
      {slash.node}
    </div>
  );
}

function popOf(html: string): string {
  const at = html.indexOf('<div class="wsg-pop slash-pop"');
  expect(at, "the popover is in the markup").toBeGreaterThan(-1);
  return html.slice(at);
}

function key(name: string): KeyboardEvent {
  return { key: name, preventDefault: () => {} } as unknown as KeyboardEvent;
}

const press =
  (name: string) =>
  (tree: El[]): void => {
    const field = tree.find((el) => el.type === "textarea");
    if (field === undefined) throw new Error("the composer field is not in this pass");
    (field.props.onKeyDown as SlashPicker["handleKey"])(key(name));
  };

beforeEach(async () => {
  picked = [];
  ran = [];
  await serve(SKILLS);
  // Card 554: the commands come from the list the server serves.
  __setCommandRows(coreCommandRows());
});

describe("before the command list arrived (card 554, criterion 8h)", () => {
  it("says the commands are loading and offers none, the skills stay", () => {
    __resetCommandList();
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(pop).toContain('<div class="settings-label">Commands</div>');
    expect(pop).toContain("Loading the commands");
    expect(pop).not.toContain("/compact");
    expect(pop).not.toContain("/clear");
    expect(pop).toContain('<span class="slash-name mono">clean-code</span>');
  });

  it("says it in German too", () => {
    __resetCommandList();
    setLang("de");
    expect(popOf(renderToStaticMarkup(<Picker draft="/" />))).toContain("Befehle werden geladen");
  });

  it("says so when the list could not be read, instead of loading forever", async () => {
    __resetCommandList();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );
    loadCommands();
    await flush();
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(pop).not.toContain("Loading the commands");
    expect(pop).toContain("The commands could not be read");
    expect(pop).not.toContain("/compact");
  });

  it("drops the note once the list is here", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(pop).not.toContain("Loading the commands");
    expect(pop).toContain('<span class="slash-name mono">/compact</span>');
  });

  it("runs nothing on Enter while loading", () => {
    __resetCommandList();
    drive(<Picker draft="/clear" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
  });
});

describe("the commands in the popover", () => {
  it("stand above the skills, help first, each with its help line", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));

    const commands = pop.indexOf('<div class="settings-label">Commands</div>');
    const skills = pop.indexOf('<div class="settings-label">Skills</div>');
    expect(commands, "the commands heading").toBeGreaterThan(-1);
    expect(skills, "the skills heading").toBeGreaterThan(commands);
    const help = pop.indexOf('<span class="slash-name mono">/help</span>');
    const compact = pop.indexOf('<span class="slash-name mono">/compact</span>');
    const clear = pop.indexOf('<span class="slash-name mono">/clear</span>');
    expect(help).toBeGreaterThan(commands);
    expect(compact).toBeGreaterThan(help);
    expect(clear).toBeGreaterThan(compact);
    expect(skills).toBeGreaterThan(clear);
    expect(pop).toContain("Summarize the history now to free the context");
    expect(pop).toContain("Start a fresh context in this session");
    expect(pop.match(/slash-row--on/g)?.length, "one focus over both lists").toBe(1);
    expect(pop).toMatch(
      /aria-selected="true" class="slash-row slash-row--on[^"]*"[^>]*><span class="slash-name mono">\/help</,
    );
  });

  it("name a row's aliases beside it", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/he" />));
    expect(pop).toMatch(/\/help<\/span><span class="slash-alias mono">\/commands<\/span>/);
  });

  it("show the playbook group, under its label, in developer only", () => {
    const learn = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(learn).not.toContain("/run-with-playbook");
    expect(learn).not.toContain('<li class="slash-group" role="presentation">Playbook</li>');

    setViewMode("developer");
    const developer = popOf(renderToStaticMarkup(<Picker draft="/" />));
    const chat = developer.indexOf('<li class="slash-group" role="presentation">Chat</li>');
    const playbook = developer.indexOf('<li class="slash-group" role="presentation">Playbook</li>');
    expect(chat).toBeGreaterThan(-1);
    expect(playbook).toBeGreaterThan(chat);
    expect(developer.indexOf('<span class="slash-name mono">/run-with-playbook</span>')).toBeGreaterThan(
      playbook,
    );
    expect(developer).toContain('<span class="slash-name mono">/playbook workflow</span>');
    expect(developer).toContain("Run your prompt through this session");
  });

  it("draw no group label when only one group is on offer", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/cl" />));
    expect(pop).not.toContain('class="slash-group"');
  });

  it("narrow with the query, and a skill section with no match steps aside", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/cle" />));

    expect(pop).toContain('<span class="slash-name mono">/clear</span>');
    expect(pop).not.toContain("/compact");
    expect(pop).not.toContain("No skill matches");
    expect(pop).toContain('<span class="slash-name mono">clean-code</span>');
  });

  it("are not offered to a slash in the middle of a sentence", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="please /c" />));

    expect(pop).not.toContain("Commands");
    expect(pop).not.toContain("/clear");
    expect(pop).not.toContain("/compact");
  });

  it("speak German too", () => {
    setLang("de");
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(pop).toContain('<div class="settings-label">Befehle</div>');
    expect(pop).toContain("Verlauf jetzt zusammenfassen und Kontext frei machen");
    expect(pop).toContain("Frischer Kontext in dieser Session");
  });
});

describe("running a command", () => {
  it("a slash and Enter write the focused command into the draft and run nothing", () => {
    drive(<Picker draft="/" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/help", caret: 5 }]);
  });

  it("ArrowDown then Enter on a partial name writes compact into the draft", () => {
    drive(<Picker draft="/" />, [Picker], [press("ArrowDown"), press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/compact", caret: 8 }]);
  });

  it("a partial name and Enter complete it, and run nothing", () => {
    drive(<Picker draft="/cl" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/clear", caret: 6 }]);
  });

  it("ArrowDown past the commands reaches the first skill, which still completes", () => {
    // Card 554: five commands in learn, /help, /compact, /clear, /loop and /skills.
    drive(
      <Picker draft="/" />,
      [Picker],
      [
        press("ArrowDown"),
        press("ArrowDown"),
        press("ArrowDown"),
        press("ArrowDown"),
        press("ArrowDown"),
        press("Enter"),
      ],
    );
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/clean-code ", caret: 12 }]);
  });

  it("picking /loop writes it into the draft with a space instead of running it", () => {
    drive(<Picker draft="/lo" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/loop ", caret: 6 }]);
  });

  it("a click on /loop writes it into the draft as well", () => {
    const click = (tree: El[]): void => {
      const row = tree.find(
        (el) => el.props.role === "option" && JSON.stringify(el.props.children).includes("/loop"),
      );
      expect(row, "the loop row is drawn").toBeDefined();
      row?.props.onClick?.();
    };
    drive(<Picker draft="/" />, [Picker], [click]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/loop ", caret: 6 }]);
  });

  it("typing the whole command and pressing Enter runs it", () => {
    drive(<Picker draft="/clear" />, [Picker], [press("Enter")]);
    expect(ran).toEqual(["clear"]);
    expect(picked).toEqual([]);
  });

  it("a click runs the row it lands on", () => {
    const click = (tree: El[]): void => {
      const row = tree.find(
        (el) => el.props.role === "option" && JSON.stringify(el.props.children).includes("/clear"),
      );
      expect(row, "the clear row is drawn").toBeDefined();
      row?.props.onClick?.();
    };
    drive(<Picker draft="/" />, [Picker], [click]);
    expect(ran).toEqual(["clear"]);
  });

  it("Tab writes the command into the draft instead of running it", () => {
    drive(<Picker draft="/cle" />, [Picker], [press("Tab")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/clear", caret: 6 }]);
  });

  it("a playbook command written by its alias completes to the main name with a space (developer)", () => {
    setViewMode("developer");
    drive(<Picker draft="/run" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/run-with-playbook ", caret: 19 }]);
  });

  it("a click on /help writes it into the draft and runs nothing", () => {
    const click = (tree: El[]): void => {
      const row = tree.find(
        (el) => el.props.role === "option" && JSON.stringify(el.props.children).includes('"/help"'),
      );
      expect(row, "the help row is drawn").toBeDefined();
      row?.props.onClick?.();
    };
    drive(<Picker draft="/" />, [Picker], [click]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/help", caret: 5 }]);
  });

  it("Enter on a whole command other than compact and clear is left to the composer", () => {
    // The composer's submit is the one door every command leaves through
    // (card 554); the picker only runs the two that ran before it.
    let consumed: boolean | null = null;
    const enterOnce = (tree: El[]): void => {
      const field = tree.find((el) => el.type === "textarea");
      consumed = (field?.props.onKeyDown as SlashPicker["handleKey"])(key("Enter"));
    };
    drive(<Picker draft="/help" />, [Picker], [enterOnce]);
    expect(consumed).toBe(false);
    expect(ran).toEqual([]);
    expect(picked).toEqual([]);
  });
});
