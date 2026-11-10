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

// Task 11 item 1: a password value is the rest of its shell word, the next
// word after a name that ends in its sign, and the rest of a comment token,
// however short its part before the first terminator is.
describe("a password value however short its head (task 11 item 1)", () => {
  const SHORT = ["Ab"].join("");
  const REST = ["Cd2", "Ef3xQz"].join("");
  const ranged = (command: string) =>
    read(command).hits.map((h) => [h.rule, command.slice(h.start, h.end), h.secret]);

  it("runs to the end of the shell word past a terminator in its first six characters (1a)", () => {
    for (const mark of [",", '"', ";", ")"]) {
      const value = `${SHORT}${mark}${REST}`;
      const command = `curl -d 'password=${value}' https://api.example.com/login`;
      expect(ranged(command), mark).toEqual([["password-assignment", `password=${value}`, value]]);
    }
    const token = `${SHORT},${REST}`;
    const urlencode = `curl --data-urlencode 'token=${token}' https://api.example.com/login`;
    expect(ranged(urlencode)).toEqual([["password-assignment", `token=${token}`, token]]);
    const mysql = ["Ab1", ",Cd2", ";Ef3x"].join("");
    const login = `mysql --password='${mysql}' -e 'select 1'`;
    expect(ranged(login)).toEqual([["password-assignment", `password='${mysql}`, mysql]]);
  });

  it("counts only a whole value of six or more characters", () => {
    expect(read(`curl -d 'password=${SHORT},Cd' https://api.example.com/login`).hits).toEqual([]);
  });

  it("takes the next word when the word that holds the name ends in its sign (1b)", () => {
    for (const head of [["Ab1", "Cd2"].join(""), SHORT]) {
      const value = `${head},${["Ef3", "xQz"].join("")}`;
      for (const name of ["password=", "token:"]) {
        const command = `curl -d ${name} ${value} https://api.example.com/login`;
        expect(ranged(command), `${name} ${head.length}`).toEqual([
          ["password-assignment", `${name} ${value}`, value],
        ]);
      }
    }
  });

  it("masks a hit in a comment to the end of its token (1c)", () => {
    for (const head of [["Ab1", "Cd2"].join(""), SHORT]) {
      const value = `${head},${["Ef3", "xQz"].join("")}`;
      const command = `curl https://a.example.com # password=${value} more`;
      expect(ranged(command), String(head.length)).toEqual([
        ["password-assignment", `password=${value}`, value],
      ]);
    }
    // Any rule's hit in a comment runs to the end of its token.
    const pat = ["gh", "p_", "Zq4Lm8Rt2Vx6Bn0Ck3Hs7Jd1Wf5Gy9Pa2Ue6"].join("");
    const command = `git push # with ${pat},${REST} done`;
    expect(read(command).hits.map((h) => [h.rule, command.slice(h.start, h.end)])).toEqual([
      ["github-pat", `${pat},${REST}`],
    ]);
  });

  it("a value that holds another rule's credential is masked whole under that rule's label", () => {
    const pat = ["gh", "p_", "Zq4Lm8Rt2Vx6Bn0Ck3Hs7Jd1Wf5Gy9Pa2Ue6"].join("");
    const value = `${SHORT},${pat}`;
    const command = `curl -d 'token=${value}' https://api.example.com/login`;
    const { hits } = read(command);
    expect(hits.map((h) => [h.rule, command.slice(h.start, h.end), h.secret, h.aliases])).toEqual([
      ["github-pat", value, pat, [value]],
    ]);
  });

  it("a whole value decides once: a placeholder head of a real value counts no placeholder", () => {
    const value = `${"a".repeat(6)},${REST}`;
    const reading = read(`curl -d 'password=${value}' https://api.example.com/login`);
    expect([reading.hits.map((h) => h.secret), reading.placeholders]).toEqual([[value], 0]);
    // A variable stays one placeholder, whichever reader sees it.
    expect(read("curl -d token=$TOKEN https://a.example.com").placeholders).toBe(1);
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

// Task 10 item 9: a query value or a user name alone is masked but counts as a
// credential only when its name says so or a rule matches it.
describe("position values that are masked but not counted", () => {
  const masked = (command: string) => read(command).masked.map((m) => command.slice(m.start, m.end));
  const TOK = ["Rk7", "Tq2Vw9", "Xz4Lm8"].join("");
  const PAT = ["gh", "p_", "Zq4Lm8Rt2Vx6Bn0Ck3Hs7Jd1Wf5Gy9Pa2Ue6"].join("");

  it("a query value under a plain name and a user alone are masked, not counted", () => {
    const page = 'curl "https://api.example.com/x?page=20"';
    expect([read(page).hits, masked(page)]).toEqual([[], ["20"]]);
    const user = "curl -u bob https://a.example.com";
    expect([read(user).hits, masked(user)]).toEqual([[], ["bob"]]);
    const userinfo = `git push https://${TOK}@github.com/o/r.git main`;
    expect([read(userinfo).hits, masked(userinfo)]).toEqual([[], [TOK]]);
  });

  it("a name that says credential counts the value, and so does a rule that matches it", () => {
    // api_key is a password name to the rules as well, so the rule's hit holds the value.
    for (const [param, rule, range] of [
      ["api_key", "password-assignment", `api_key=${TOK}`],
      ["sig", POSITION_RULE, TOK],
    ]) {
      const command = `curl "https://api.example.com/x?${param}=${TOK}"`;
      expect(ranges(command), param).toEqual([[rule, range]]);
      expect(masked(command), param).toEqual([]);
    }
    const token = `git push https://${PAT}@github.com/o/r.git main`;
    expect(read(token).hits.map((h) => [h.rule, token.slice(h.start, h.end)])).toEqual([["github-pat", PAT]]);
    expect(masked(token)).toEqual([]);
    const query = `curl "https://api.example.com/x?q=${PAT}"`;
    expect(read(query).hits.map((h) => h.rule)).toEqual(["github-pat"]);
    // The shell joins quoted pieces the command text keeps apart, so only the
    // value as the shell reads it matches the rule; it counts as a position.
    const split = `curl "https://api.example.com/x?q=${PAT.slice(0, 2)}"'${PAT.slice(2)}'`;
    expect(read(split).hits.map((h) => h.rule)).toEqual([POSITION_RULE]);
    expect(masked(split)).toEqual([]);
  });
});
