// Card 471, criterion 1: the slash picker lists two commands above the skills.
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
  setLang("en");
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
});

describe("the commands in the popover", () => {
  it("stand above the skills, compact first, each with its help line", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/" />));

    const commands = pop.indexOf('<div class="settings-label">Commands</div>');
    const skills = pop.indexOf('<div class="settings-label">Skills</div>');
    expect(commands, "the commands heading").toBeGreaterThan(-1);
    expect(skills, "the skills heading").toBeGreaterThan(commands);
    const compact = pop.indexOf('<span class="slash-name mono">/compact</span>');
    const clear = pop.indexOf('<span class="slash-name mono">/clear</span>');
    expect(compact).toBeGreaterThan(commands);
    expect(clear).toBeGreaterThan(compact);
    expect(skills).toBeGreaterThan(clear);
    expect(pop).toContain("Summarize the history now to free the context");
    expect(pop).toContain("Start a fresh context in this session");
    expect(pop.match(/slash-row--on/g)?.length, "one focus over both lists").toBe(1);
    expect(pop).toMatch(
      /aria-selected="true" class="slash-row slash-row--on[^"]*"[^>]*><span class="slash-name mono">\/compact</,
    );
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
    expect(picked).toEqual([{ text: "/compact", caret: 8 }]);
  });

  it("ArrowDown then Enter on a partial name writes clear into the draft", () => {
    drive(<Picker draft="/" />, [Picker], [press("ArrowDown"), press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/clear", caret: 6 }]);
  });

  it("a partial name and Enter complete it, and run nothing", () => {
    drive(<Picker draft="/cl" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/clear", caret: 6 }]);
  });

  it("ArrowDown past the commands reaches the first skill, which still completes", () => {
    drive(<Picker draft="/" />, [Picker], [press("ArrowDown"), press("ArrowDown"), press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/clean-code ", caret: 12 }]);
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
});
