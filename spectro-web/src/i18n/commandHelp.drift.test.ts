// Card 554, task 7, and card 588: the help of every chat command and its
// template come from the core list in English and German, read off disk here.
// The dictionary keeps no copy of either, so the two cannot drift; it keeps
// only the group labels. Every row the web shows that takes words carries a
// template, and every row with a second word stands under its parent.

import { describe, expect, it } from "vitest";
import { dict } from "./i18n";
import { coreCommandRows, COMMANDS_JSON } from "../testkit/commandRows";
import { webCommands } from "../state/commandList";

const rows = coreCommandRows();
const web = webCommands(rows);

describe("the command texts against the core command list", () => {
  it("reads the list, and the web shows a part of it", () => {
    expect(rows.length, COMMANDS_JSON).toBeGreaterThan(10);
    expect(web.length).toBeGreaterThan(5);
    expect(web.length).toBeLessThan(rows.length);
  });

  it("has a German and an English help for every row the web chat shows, from the list", () => {
    for (const row of web) {
      expect(row.help.en.trim(), `${row.id} has no English help`).not.toBe("");
      expect(row.help.de.trim(), `${row.id} has no German help`).not.toBe("");
      expect(row.help.de, `${row.id}: the German is the English`).not.toBe(row.help.en);
    }
  });

  it("keeps no copy of a command's help in the dictionary (card 588)", () => {
    const copies = Object.keys(dict).filter((key) => /^cmd\.[a-z-]+\.help$/.test(key));
    expect(copies).toEqual([]);
  });

  it("gives every row the web shows that takes words a template in both languages (card 588)", () => {
    const takesWords = web.filter((r) => r.takesArgs);
    expect(takesWords.length).toBeGreaterThan(3);
    for (const row of takesWords) {
      expect(row.usage, `${row.id} takes words and has no template`).not.toBeNull();
      const spelled = `/${row.sub === null ? row.name : `${row.name} ${row.sub}`} `;
      expect(row.usage?.en.startsWith(spelled), `${row.id}: ${row.usage?.en}`).toBe(true);
      expect(row.usage?.de.startsWith(spelled), `${row.id}: ${row.usage?.de}`).toBe(true);
    }
  });

  it("stands every row the web shows with a second word under its parent (card 588)", () => {
    const subs = web.filter((r) => r.sub !== null);
    expect(subs.length).toBeGreaterThan(5);
    for (const row of subs) {
      const parent = web.find((p) => p.sub === null && p.name === row.name && p.group === row.group);
      expect(parent, `${row.id} has no parent row`).toBeDefined();
    }
  });

  it("names every group the web shows", () => {
    for (const group of new Set(web.map((r) => r.group))) {
      const entry = dict[`cmd.group.${group}`];
      expect(entry, `cmd.group.${group} is missing`).toBeDefined();
      expect(entry?.de.trim()).not.toBe("");
      expect(entry?.en.trim()).not.toBe("");
    }
  });
});
