// Card 605, task 11 fix round 2 item 1: the display net under the rule masks.
// Vectors are joined at run time, so no credential-shaped literal sits here.

import { describe, expect, it } from "vitest";
import { displayNet, HIDDEN_MASK, inLanguage } from "./displayNet";

const H = HIDDEN_MASK;
const cmd = (text: string) => displayNet(text, { command: true });
const prose = (text: string) => displayNet(text);
const PW = ["Ab", ",Cd2", "Ef3xQz"].join("");

describe("the display net", () => {
  it("hides a segment that mixes letters and digits", () => {
    expect(cmd(`curl -d 'password=${PW}' https://a.example.com`)).toBe(
      `curl -d 'password=Ab,${H}' https://a.example.com`,
    );
    expect(prose(`Use password=${PW} for db`)).toBe(`Use password=Ab,${H} for db`);
  });

  it("hides a segment of upper case, lower case and a symbol", () => {
    const word = ["Ab", "cd_Ef", "gh"].join("");
    expect(prose(`token ${word} here`)).toBe(`token ${H} here`);
    // Two kinds of letter without a symbol, or a symbol and one kind, stay.
    expect(prose("Authorization CamelCase snake_case")).toBe("Authorization CamelCase snake_case");
  });

  it("splits at blanks and at the brief's marks, and leaves segments under four characters", () => {
    const tail = ["Cd2", "Ef3x"].join("");
    for (const mark of [
      '"',
      "'",
      "`",
      "=",
      ":",
      ",",
      ";",
      "&",
      "?",
      "(",
      ")",
      "[",
      "]",
      "{",
      "}",
      "<",
      ">",
      "|",
    ])
      expect(prose(`a1b${mark}${tail}`), mark).toBe(`a1b${mark}${H}`);
    expect(prose("ab1 x9y")).toBe("ab1 x9y");
  });

  it("keeps the review's JSON and form bodies readable around the hidden value", () => {
    expect(cmd(`curl -d '{"password":"${PW}","opts":{"remember":true}}' https://api.acme.io/login`)).toBe(
      `curl -d '{"password":"Ab,${H}","opts":{"remember":true}}' https://api.acme.io/login`,
    );
    expect(cmd(`curl -d "password=${PW}&ts=$(date +%s)" https://api.acme.io/login`)).toBe(
      `curl -d "password=Ab,${H}&ts=$(date +%s)" https://api.acme.io/login`,
    );
  });

  it("leaves a path word, an option, a version, a number and an ISO time", () => {
    for (const word of [
      "/Users/a/proj/src/Test123.java",
      "~/.ssh/id_ed25519",
      "./gradlew2",
      "../lib/v8.so",
      "src/test/Parser2Test.java",
      "--http2",
      "--proxy-tlspassword",
      "-H",
      "v1.2",
      "1.2.3",
      "2.0.0-rc.1",
      "12345",
      "2026-11-10T08:00:09.000Z",
    ])
      expect(prose(`x ${word} y`), word).toBe(`x ${word} y`);
    // A word with a slash but no file name at its end is no path word.
    expect(prose(["x src/", "Ab1Cd2Ef3x"].join(""))).toBe(`x ${H}`);
    // A short option with a value glued to it is no option.
    expect(cmd(["mysql -p", "Ab1Cd2Ef3x"].join(""))).toBe(`mysql ${H}`);
  });

  it("leaves a URL's scheme and host and hides what mixes in its user, path or query", () => {
    const tok = ["Ab1Cd2", "Ef3xQz"].join("");
    expect(cmd(`curl https://api2.example.com:8443/v1/reset/${tok}?page=2#top`)).toBe(
      `curl https://api2.example.com:8443/v1/reset/${H}?page=2#top`,
    );
    expect(cmd(`git push https://bob:${tok}@git2.example.com/o/r.git main`)).toBe(
      `git push https://bob:${H}@git2.example.com/o/r.git main`,
    );
  });

  it("leaves the program of each command of a line, after an assignment too", () => {
    expect(cmd("python3 build.py && node18 x.js | grep2 y; TOKEN=1 pip3 install z")).toBe(
      "python3 build.py && node18 x.js | grep2 y; TOKEN=1 pip3 install z",
    );
    const v = ["Ab1Cd2", "Ef3xQz"].join("");
    // A separator inside quotes starts no command.
    expect(cmd(`echo "x; ${v}"`)).toBe(`echo "x; ${H}"`);
    expect(cmd(`$env:DB_PASSWORD = "${PW}"; Invoke-WebRequest https://a.example.com`)).toBe(
      `$env:DB_PASSWORD = "Ab,${H}"; Invoke-WebRequest https://a.example.com`,
    );
    // Prose has no program.
    expect(prose("python3 is fine")).toBe(`${H} is fine`);
  });

  it("passes the labels of the rule masks through", () => {
    for (const text of ["-p'[credential 1: password-assignment]'", "?page=[value]", `x ${H}`])
      expect(cmd(text), text).toBe(text);
    expect(cmd("https://[credential 2: url-userinfo]@db2.example.com/x")).toBe(
      "https://[credential 2: url-userinfo]@db2.example.com/x",
    );
  });

  it("names its marker in the reader's language", () => {
    expect(inLanguage(`a ${H} b`, "de")).toBe("a [verdeckt] b");
    expect(inLanguage(`a ${H} b`, "en")).toBe(`a ${H} b`);
    expect(H).toBe("[hidden]");
  });
});
