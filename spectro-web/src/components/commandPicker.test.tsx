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
import { offerCommands, type ChatCommandName } from "../state/chatCommands";
import { drive, type El } from "../testkit/driveComponent";
import { setLang } from "../state/lang";
import { __resetCommandList, __setCommandRows, loadCommands } from "../state/commandList";
import { setViewMode } from "../state/viewMode";
import { coreCommandRows } from "../testkit/commandRows";
import { blockOf, read } from "../testkit/source";

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
      /aria-selected="true" class="slash-row slash-row--command slash-row--on"[^>]*><span class="slash-name mono">\/help</,
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
    // Card 588: a bare slash offers the command; its subcommands follow its name.
    expect(developer).toContain('<span class="slash-name mono">/playbook</span>');
    expect(developer).not.toContain('<span class="slash-name mono">/playbook workflow</span>');
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
    // Card 554: as many presses as the picker offers commands in learn; card
    // 587 added the code graph rows, so the count is read, not typed.
    const commands = offerCommands("/", 1, coreCommandRows(), "learn")?.rows.length ?? 0;
    expect(commands, "premise: the picker offers commands").toBeGreaterThan(4);
    drive(
      <Picker draft="/" />,
      [Picker],
      [...Array.from({ length: commands }, () => press("ArrowDown")), press("Enter")],
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

describe("subcommands and templates (card 588)", () => {
  const optionNamed = (name: string) => (tree: El[]) =>
    tree.find((el) => el.props.role === "option" && JSON.stringify(el.props.children).includes(`"${name}"`));

  it("lists /graph's subcommands, each with its help line, once the name is typed (criterion 1)", () => {
    const pop = popOf(renderToStaticMarkup(<Picker draft="/graph" />));
    for (const sub of ["build", "update", "show", "ask", "help"]) {
      expect(pop).toContain(`<span class="slash-name mono">/graph ${sub}</span>`);
    }
    expect(pop).toContain("Build the code graph of this folder from its code");
    expect(pop).toContain("Ask a question the model answers through the code graph");
  });

  it("keeps them after the space, while a bare slash offers /graph alone", () => {
    expect(popOf(renderToStaticMarkup(<Picker draft="/graph " />))).toContain(
      '<span class="slash-name mono">/graph ask</span>',
    );
    const bare = popOf(renderToStaticMarkup(<Picker draft="/" />));
    expect(bare).toContain('<span class="slash-name mono">/graph</span>');
    expect(bare).not.toContain('<span class="slash-name mono">/graph ask</span>');
  });

  // Fix round, M9: a template under the highlighted row alone grew the
  // popover by one line whenever the highlight reached it, and every row
  // above moved up 22.6 px (measured in Chrome, fix1-shift-before.json). Each
  // row with a template now shows it, so the highlight moves nothing.
  it("shows each row's template under it, the highlighted row's too (criterion 2)", () => {
    const ask = popOf(renderToStaticMarkup(<Picker draft="/graph a" />));
    expect(ask).toMatch(
      /slash-row--on[^"]*"[^>]*><span class="slash-name mono">\/graph ask<\/span>.*?<span class="slash-usage mono">\/graph ask &lt;question&gt;<\/span>/,
    );
    const graph = popOf(renderToStaticMarkup(<Picker draft="/graph" />));
    expect(graph).toMatch(/slash-row--on[^"]*"[^>]*><span class="slash-name mono">\/graph<\/span>/);
    expect(graph, "ask is not highlighted and still shows its template").toContain(
      '<span class="slash-usage mono">/graph ask &lt;question&gt;</span>',
    );
    expect(graph.match(/class="slash-usage mono"/g)?.length, "only the row that has one").toBe(1);
    expect(popOf(renderToStaticMarkup(<Picker draft="/lo" />))).toContain(
      '<span class="slash-usage mono">/loop [interval] &lt;prompt&gt;</span>',
    );
  });

  // Fix round, M3: the whole help is readable: in the title, and on rows that wrap.
  it("gives every command row and the template line the full help as a title, and lets the help wrap", () => {
    const graph = popOf(renderToStaticMarkup(<Picker draft="/graph" />));
    for (const row of coreCommandRows().filter((r) => r.name === "graph")) {
      expect(graph, row.id).toContain(`<span class="slash-desc" title="${row.help.en}">`);
    }
    expect(graph.match(/class="slash-row slash-row--command/g)?.length, "every command row is marked").toBe(
      6,
    );
    const writing = popOf(renderToStaticMarkup(<Picker draft="/graph ask who" />));
    expect(writing).toContain(
      '<span class="slash-desc" title="Ask a question the model answers through the code graph">',
    );
    const css = read("../styles/modal-composer.css", import.meta.url);
    // A wrapping help keeps a floor of width, never wider than the row, so on
    // a narrow row it goes under the name instead of into a column of
    // syllables (seen at 390 px in shots-fix1 before the floor).
    for (const sel of [".slash-row--command .slash-desc", ".slash-writing .slash-desc"]) {
      expect(blockOf(css, sel), sel).toMatch(/white-space:\s*normal/);
      expect(blockOf(css, sel), sel).toMatch(/min-width:\s*min\(100%,\s*\d+(\.\d+)?em\)/);
    }
  });

  // Fix round, M2: one rule for upper case: the offer, the template and the parse agree.
  it("reads a command typed in capitals as the command, for its rows and its template", () => {
    expect(popOf(renderToStaticMarkup(<Picker draft="/GRAPH ask who" />))).toContain(
      '<span class="slash-usage mono">/graph ask &lt;question&gt;</span>',
    );
    expect(popOf(renderToStaticMarkup(<Picker draft="/GRAPH a" />))).toContain(
      '<span class="slash-name mono">/graph ask</span>',
    );
    // A whole command in capitals is spelled out: Enter is the composer's.
    let consumed: boolean | null = null;
    drive(
      <Picker draft="/HELP" />,
      [Picker],
      [
        (tree) => {
          const field = tree.find((el) => el.type === "textarea");
          consumed = (field?.props.onKeyDown as SlashPicker["handleKey"])(key("Enter"));
        },
      ],
    );
    expect(consumed).toBe(false);
    expect(picked).toEqual([]);
  });

  // Fix round, M1: an input method's Enter and Shift+Enter are not the picker's.
  it("leaves Enter during composition and Shift+Enter to the composer", () => {
    const consumed: boolean[] = [];
    drive(
      <Picker draft="/graph b" />,
      [Picker],
      [
        (tree) => {
          const field = tree.find((el) => el.type === "textarea");
          const handle = field?.props.onKeyDown as SlashPicker["handleKey"];
          for (const extra of [
            { nativeEvent: { isComposing: true } },
            { keyCode: 229, nativeEvent: { isComposing: false } },
            { shiftKey: true, nativeEvent: { isComposing: false } },
          ]) {
            consumed.push(handle({ ...key("Enter"), ...extra } as unknown as KeyboardEvent));
          }
        },
      ],
    );
    expect(consumed).toEqual([false, false, false]);
    expect(picked).toEqual([]);
    drive(<Picker draft="/graph b" />, [Picker], [press("Enter")]);
    expect(picked, "premise: a plain Enter picks").toEqual([{ text: "/graph build ", caret: 13 }]);
  });

  // Fix round, M9: whether a picked command leads on to subcommands is read
  // off the rows the picker shows in this mode.
  it("writes a command with a space only when this mode shows its subcommands", () => {
    const base = { aliases: [], takesArgs: false, group: "chat", surfaces: "both", wired: true, usage: null };
    __setCommandRows([
      {
        ...base,
        id: "demo",
        name: "demo",
        sub: null,
        developerOnly: false,
        help: { en: "Demo", de: "Demo" },
      },
      {
        ...base,
        id: "demo-x",
        name: "demo",
        sub: "x",
        developerOnly: true,
        help: { en: "Demo x", de: "Demo x" },
      },
    ]);
    drive(<Picker draft="/dem" />, [Picker], [press("Tab")]);
    expect(picked, "learn shows no subcommand of /demo").toEqual([{ text: "/demo", caret: 5 }]);
    picked = [];
    setViewMode("developer");
    drive(<Picker draft="/dem" />, [Picker], [press("Tab")]);
    expect(picked, "developer shows /demo x").toEqual([{ text: "/demo ", caret: 6 }]);
  });

  it("speaks German: the help and the template come from the list (criterion 3)", () => {
    setLang("de");
    const pop = popOf(renderToStaticMarkup(<Picker draft="/graph a" />));
    expect(pop).toContain("Eine Frage stellen, die das Modell über den Code-Graphen beantwortet");
    expect(pop).toContain('<span class="slash-usage mono">/graph ask &lt;Frage&gt;</span>');
  });

  it("writes /graph build and a space for Enter on the narrowed row, the caret at the end (criterion 1)", () => {
    drive(<Picker draft="/graph b" />, [Picker], [press("Enter")]);
    expect(ran).toEqual([]);
    expect(picked).toEqual([{ text: "/graph build ", caret: 13 }]);
  });

  it("the owner's scenario: /playbook lists list, show, use and workflow, and a click on use writes /playbook use", () => {
    setViewMode("developer");
    const pop = popOf(renderToStaticMarkup(<Picker draft="/playbook" />));
    for (const sub of ["list", "show", "use", "workflow"]) {
      expect(pop).toContain(`<span class="slash-name mono">/playbook ${sub}</span>`);
    }
    expect(pop).toContain("Use this playbook in this session");
    drive(
      <Picker draft="/playbook" />,
      [Picker],
      [
        (tree) => {
          const row = optionNamed("/playbook use")(tree);
          expect(row, "the use row is drawn").toBeDefined();
          row?.props.onClick?.();
        },
      ],
    );
    expect(picked).toEqual([{ text: "/playbook use ", caret: 14 }]);
  });

  it("walks the subcommands with the arrows and writes the one reached (criterion 4)", () => {
    drive(<Picker draft="/graph " />, [Picker], [press("ArrowDown"), press("ArrowDown"), press("Enter")]);
    expect(picked).toEqual([{ text: "/graph update ", caret: 14 }]);
  });

  it("writes the command itself with a space for Tab, so its subcommands follow", () => {
    drive(<Picker draft="/gr" />, [Picker], [press("Tab")]);
    expect(picked).toEqual([{ text: "/graph ", caret: 7 }]);
  });

  it("leaves Enter on /graph spelled out to the composer, which runs its help", () => {
    expect(popOf(renderToStaticMarkup(<Picker draft="/graph" />)), "premise: its rows are up").toContain(
      '<span class="slash-name mono">/graph build</span>',
    );
    let consumed: boolean | null = null;
    drive(
      <Picker draft="/graph" />,
      [Picker],
      [
        (tree) => {
          const field = tree.find((el) => el.type === "textarea");
          consumed = (field?.props.onKeyDown as SlashPicker["handleKey"])(key("Enter"));
        },
      ],
    );
    expect(consumed).toBe(false);
    expect(picked).toEqual([]);
  });

  it("keeps the template up while the words are typed, and leaves the keys to the composer", () => {
    expect(popOf(renderToStaticMarkup(<Picker draft="/graph ask " />))).toContain(
      "/graph ask &lt;question&gt;",
    );
    expect(popOf(renderToStaticMarkup(<Picker draft="/graph ask who calls" />))).toContain(
      "/graph ask &lt;question&gt;",
    );
    const consumed: boolean[] = [];
    drive(
      <Picker draft="/graph ask who" />,
      [Picker],
      [
        (tree) => {
          const field = tree.find((el) => el.type === "textarea");
          for (const name of ["ArrowDown", "Enter", "Tab"]) {
            consumed.push((field?.props.onKeyDown as SlashPicker["handleKey"])(key(name)));
          }
        },
      ],
    );
    expect(consumed).toEqual([false, false, false]);
    expect(picked).toEqual([]);
  });

  it("puts the template away on Escape", () => {
    const classes = (tree: El[]): string => JSON.stringify(tree.map((el) => el.props.className ?? ""));
    expect(classes(drive(<Picker draft="/graph ask who" />, [Picker], [])), "premise: it is up").toContain(
      "slash-pop",
    );
    expect(classes(drive(<Picker draft="/graph ask who" />, [Picker], [press("Escape")]))).not.toContain(
      "slash-pop",
    );
  });

  it("opens nothing once a command that takes no words is written out with its space", () => {
    expect(
      renderToStaticMarkup(<Picker draft="/graph ask " />),
      "premise: one that takes words opens",
    ).toContain("slash-pop");
    expect(renderToStaticMarkup(<Picker draft="/graph build " />)).not.toContain("slash-pop");
  });
});
