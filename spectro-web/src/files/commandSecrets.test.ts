// Card 605, final fix wave item 1: the credentials of one shell command. Each
// case slices the command at the hit, so the masked range is pinned. Vectors
// are joined at run time, so no credential-shaped literal sits in this file.

import { describe, expect, it } from "vitest";
import { commandCredentials, POSITION_RULE } from "./commandSecrets";
import { findCredentials } from "./secrets";
import { shellRisk } from "./shellRisk";

const read = (command: string) => commandCredentials(command, shellRisk(command, "/w"));
const ranges = (command: string) => read(command).hits.map((h) => [h.rule, command.slice(h.start, h.end)]);

const HEAD = ["Abc", "123"].join("");
const TAIL = ["Xy9", "Qq7zz"].join("");

describe("a password assignment in a command", () => {
  it("masks to the end of its shell word, past a comma, a semicolon, a quote or a bracket", () => {
    for (const [mark, quote] of [
      [",", "'"],
      [";", "'"],
      ["'", '"'],
      [")", "'"],
      ["]", '"'],
    ]) {
      const value = `${HEAD}${mark}${TAIL}`;
      const command = `curl -d ${quote}password=${value}${quote} https://api.example.com/login`;
      const { hits } = read(command);
      expect(
        hits.map((h) => h.rule),
        mark,
      ).toEqual(["password-assignment"]);
      expect(command.slice(hits[0].start, hits[0].end), mark).toBe(`password=${value}`);
      // The secret is the whole value; the rule's own shorter value is one more spelling of it.
      expect(hits[0].secret, mark).toBe(value);
      expect(hits[0].aliases, mark).toEqual([HEAD]);
    }
  });

  it("an unquoted word ends where the shell ends it", () => {
    const command = `export PASSWORD=${HEAD}${TAIL};echo done`;
    expect(ranges(command)).toEqual([["password-assignment", `PASSWORD=${HEAD}${TAIL}`]]);
  });

  it("a value made of letters is a password in a command (1d)", () => {
    const letters = ["correct", "horse", "staple"].join("");
    expect(ranges(`curl -d password=${letters} https://api.example.com`)).toEqual([
      ["password-assignment", `password=${letters}`],
    ]);
    // Results and file content keep the identifier skip.
    expect(findCredentials(`password=${letters}`).hits).toEqual([]);
  });
});

describe("a URL's userinfo in a command", () => {
  it("masks from after :// to the last @ of the authority, the host stays", () => {
    const at = `${HEAD}@${TAIL}`;
    const command = `psql postgres://bob:${at}@db.example.com/x -c 'select 1'`;
    const { hits } = read(command);
    expect(hits.map((h) => [h.rule, command.slice(h.start, h.end), h.secret])).toEqual([
      ["url-userinfo", `bob:${at}`, at],
    ]);
  });

  it("a password the rule reads whole keeps its range", () => {
    const command = `psql postgres://bob:${HEAD}${TAIL}@db.example.com/x`;
    expect(ranges(command)).toEqual([["url-userinfo", `bob:${HEAD}${TAIL}`]]);
  });
});

describe("values in credential positions", () => {
  it("a position value is a credential of its own rule", () => {
    const command = `curl -H "Cookie: session=${HEAD}${TAIL}" https://a.example.com`;
    const { hits } = read(command);
    expect(hits.map((h) => [h.rule, command.slice(h.start, h.end), h.secret])).toEqual([
      [POSITION_RULE, `session=${HEAD}${TAIL}`, `session=${HEAD}${TAIL}`],
    ]);
  });

  it("the credential part is the secret, the whole value one more spelling", () => {
    const command = `sudo curl -u bob:${HEAD}${TAIL} https://a.example.com`;
    const { hits } = read(command);
    expect(hits.map((h) => [h.rule, command.slice(h.start, h.end), h.secret, h.aliases])).toEqual([
      [POSITION_RULE, `bob:${HEAD}${TAIL}`, `${HEAD}${TAIL}`, [`bob:${HEAD}${TAIL}`]],
    ]);
  });

  it("a position that overlaps a rule's hit widens it, so the value has one label", () => {
    const token = ["Rk7Tq2Vw9", "Xz4Lm8Pn3Hs6"].join("");
    const command = `curl -H "Authorization: Bearer ${token},x" https://a.example.com`;
    const { hits } = read(command);
    expect(hits.map((h) => [h.rule, command.slice(h.start, h.end)])).toEqual([
      ["bearer", `Bearer ${token},x`],
    ]);
    expect(hits[0].aliases).toEqual([`${token},x`, `Bearer ${token},x`]);
  });

  it("placeholders of the rules and of the positions are counted together", () => {
    expect(read('curl -u "bob:$PASS" -d token=$TOKEN https://a.example.com').placeholders).toBe(2);
  });
});
