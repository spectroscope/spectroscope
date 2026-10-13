// Card 554, task 7: the German help of every chat command lives in this
// dictionary, the English one in the core list the terminal prints. Two
// copies of the English text would drift, so this reads the list off disk and
// holds the dictionary to it: every row the web chat can show has
// cmd.<id>.help in both languages, its English is the list's own, and every
// group the web shows has a label.

import { describe, expect, it } from "vitest";
import { dict } from "./i18n";
import { coreCommandRows, COMMANDS_JSON } from "../testkit/commandRows";
import { webCommands } from "../state/commandList";

const rows = coreCommandRows();
const web = webCommands(rows);

describe("the dictionary against the core command list", () => {
  it("reads the list, and the web shows a part of it", () => {
    expect(rows.length, COMMANDS_JSON).toBeGreaterThan(10);
    expect(web.length).toBeGreaterThan(5);
    expect(web.length).toBeLessThan(rows.length);
  });

  it("has a German and an English help for every row the web chat shows", () => {
    for (const row of web) {
      const entry = dict[`cmd.${row.id}.help`];
      expect(entry, `cmd.${row.id}.help is missing`).toBeDefined();
      expect(entry?.de.trim(), `cmd.${row.id}.help has no German`).not.toBe("");
    }
  });

  it("has the list's own English, word for word", () => {
    for (const row of web) {
      expect(dict[`cmd.${row.id}.help`]?.en, `cmd.${row.id}.help`).toBe(row.help.en);
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
