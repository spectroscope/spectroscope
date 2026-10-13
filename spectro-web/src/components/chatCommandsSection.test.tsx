// Card 554, task 11 (owner answer 6): the rail row Skills becomes "Skills and
// Commands" (the key nav.skills stays), and its view lists the chat commands
// from the one shared list: every row the web chat runs, grouped, each with
// its aliases and its help in the page language. The rows are read from the
// core list off disk here, never typed out, so a row the list gains must show
// on the page or this goes red.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatCommandsSection } from "./ChatCommandsSection";
import { SkillsPane } from "./SkillsPane";
import { dict, t } from "../i18n/i18n";
import { setLang } from "../state/lang";
import { __resetCommandList, __setCommandRows, webCommands } from "../state/commandList";
import { spellingsOf } from "../state/chatCommands";
import { coreCommandRows } from "../testkit/commandRows";

const ROWS = coreCommandRows();

beforeEach(() => {
  __setCommandRows(ROWS);
});

afterEach(() => {
  __resetCommandList();
  setLang("en");
});

const section = (): string => renderToStaticMarkup(<ChatCommandsSection />);

/** A text as static markup writes it. */
const esc = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#x27;")
    .replace(/"/g, "&quot;");

describe("the rail row's name", () => {
  it("is Skills and Commands, under the key it always had", () => {
    expect(dict["nav.skills"]).toEqual({ de: "Skills und Befehle", en: "Skills and Commands" });
  });
});

describe("the chat commands on the Skills and Commands page", () => {
  it("lists every row the web chat runs, each with its help, and no other", () => {
    const html = section();
    const web = webCommands(ROWS);
    expect(web.length).toBeGreaterThan(5);
    for (const row of web) {
      expect(html, row.id).toContain(`data-command="${row.id}"`);
      expect(html, row.id).toContain(esc(t("en", `cmd.${row.id}.help`)));
    }
    expect([...html.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1])).toEqual(
      [...new Set(web.map((r) => r.group))].flatMap((g) => web.filter((r) => r.group === g).map((r) => r.id)),
    );
  });

  it("names each command by every spelling it answers to", () => {
    const html = section();
    for (const row of webCommands(ROWS)) {
      for (const spelling of spellingsOf(row)) expect(html).toContain(`/${spelling}</code>`);
    }
  });

  it("groups the rows under their group's name", () => {
    const html = section();
    const chat = html.indexOf(">Chat</h4>");
    const playbook = html.indexOf(">Playbook</h4>");
    expect(chat).toBeGreaterThan(-1);
    expect(playbook).toBeGreaterThan(chat);
    expect(html.indexOf('data-command="run-with-playbook"')).toBeGreaterThan(playbook);
  });

  it("marks the rows the picker offers in developer mode only", () => {
    const html = section();
    const row = (id: string): string => {
      const at = html.indexOf(`data-command="${id}"`);
      return html.slice(at, html.indexOf("</li>", at));
    };
    expect(row("run-with-playbook")).toContain("developer mode");
    expect(row("clear")).not.toContain("developer mode");
  });

  it("leaves out the terminal's own commands and the rows another card wires", () => {
    const html = section();
    expect(html).not.toContain('data-command="goal"');
    expect(html).not.toContain('data-command="codegraph"');
  });

  it("speaks German", () => {
    setLang("de");
    const html = section();
    expect(html).toContain("Chat-Befehle");
    expect(html).toContain("Jeden Befehl mit einer kurzen Hilfe auflisten");
    expect(html).toContain("Entwicklermodus");
  });

  it("says the list is loading until it has arrived", () => {
    __resetCommandList();
    const html = section();
    expect(html).toContain("Loading the commands");
    expect(html).not.toContain("data-command=");
  });
});

describe("the page", () => {
  it("draws the section below the skills, under the new title", () => {
    const html = renderToStaticMarkup(<SkillsPane />);
    expect(html).toContain('<h2 class="skills-title">Skills and Commands</h2>');
    expect(html.indexOf("Chat commands")).toBeGreaterThan(html.indexOf("skills-head"));
  });
});
