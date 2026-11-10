// Card 605: the credential rules of the files report. Every credential-shaped
// vector is joined at run time, so no such literal sits in this file: GitHub's
// push protection reads source, and RedactionTest.java does the same.

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_RULES,
  PASSWORD_RULE,
  REDACTION_RULES,
  countPersonalData,
  findCredentials,
  isPlaceholder,
  maskCredentials,
  ruleMatches,
  secretPart,
  sizeBand,
  type CredentialRule,
} from "./secrets";

const AKID = "AKIA" + "Q7H2M3KD5ZP4RT6W";
const TOKEN = "abcdefghij" + "0123456789KLMNOP";

const rulesAndSecrets = (text: string) => findCredentials(text).hits.map((h) => [h.rule, h.secret]);

describe("the rule tables", () => {
  it("lists the ten credential rules of the twin and then the password rule", () => {
    expect(CREDENTIAL_RULES.map((r) => r.name)).toEqual([
      ...REDACTION_RULES.map((r) => r.name).filter((n) => n !== "email" && n !== "iban"),
      "password-assignment",
    ]);
    expect(CREDENTIAL_RULES).toHaveLength(11);
    expect(CREDENTIAL_RULES[10]).toBe(PASSWORD_RULE);
    for (const rule of [...REDACTION_RULES, PASSWORD_RULE]) expect(rule.pattern.flags).not.toContain("g");
  });
});

describe("findCredentials", () => {
  it("finds an AWS key id in prose and returns its whole match as the secret", () => {
    const text = `the upload used ${AKID} last night`;
    const start = text.indexOf(AKID);
    expect(findCredentials(text)).toEqual({
      hits: [{ rule: "aws-akid", match: AKID, secret: AKID, start, end: start + AKID.length }],
      placeholders: 0,
    });
  });

  it("bearer and url-userinfo keep only the secret part", () => {
    expect(rulesAndSecrets("Authorization: Bearer " + TOKEN)).toEqual([["bearer", TOKEN]]);
    const pw = "hunter2" + "hunter2";
    expect(rulesAndSecrets("postgres://app:" + pw + "@db.internal/x")).toEqual([["url-userinfo", pw]]);
    // The user name holds no colon, so the first colon after the scheme ends it and a
    // colon inside the password stays in the password.
    const colon = "pa:ss" + "word9";
    expect(secretPart("url-userinfo", "postgres://app:" + colon + "@")).toBe(colon);
    expect(secretPart("aws-akid", AKID)).toBe(AKID);
    expect(secretPart("password-assignment", "DB_PASSWORD=" + "s3cr3t-Pa55")).toBe("s3cr3t-Pa55");
  });

  it("password assignments", () => {
    const assignments: [string, string, string][] = [
      ["DB_PASSWORD=", "s3cr3t-Pa55", ""],
      ['"password": "', "hunter2hunter2", '"'],
      ["SECRET_KEY = '", "q9w8e7r6t5", "'"],
      ["export GITHUB_TOKEN=", "abcd1234efgh", ""],
    ];
    for (const [head, value, tail] of assignments) {
      expect(rulesAndSecrets(head + value + tail), head).toEqual([["password-assignment", value]]);
    }
    for (const code of [
      "password = getPassword()",
      "token: ${{ secrets.X }}",
      "API_KEY=$API_KEY",
      "max_tokens: 100000",
      "bypass=true",
      "passenger=someone12",
    ]) {
      expect(findCredentials(code).hits, code).toEqual([]);
    }
  });

  it("a value that is code is skipped without counting", () => {
    for (const code of [
      "password = getPassword()",
      "token = tokens[index]",
      "secret = {value: 1}",
      "password=%(password)s",
      "PASSWORD=&password_ref",
      "token = undefined",
    ]) {
      expect(findCredentials(code), code).toEqual({ hits: [], placeholders: 0 });
    }
  });

  it("placeholders are counted, not returned", () => {
    for (const text of [
      "AKIA" + "IOSFODNN7EXAMPLE",
      "DB_PASSWORD=changeme",
      "DB_PASSWORD=<your_password>",
      "DB_PASSWORD=xxxxxxxx",
      "DB_PASSWORD=password",
    ]) {
      expect(findCredentials(text), text).toEqual({ hits: [], placeholders: 1 });
    }
  });

  it("an upper-case word is not a key id", () => {
    for (const word of ["ASIA" + "PACIFICSALESTEAM", "ACCA" + "DEMICTRANSCRIPTS"]) {
      expect(findCredentials(`see ${word} for the list`), word).toEqual({ hits: [], placeholders: 1 });
    }
    expect(rulesAndSecrets(AKID)).toEqual([["aws-akid", AKID]]);
    // One digit is enough.
    const oneDigit = "AKIA" + "QWERTYUIOPASDFG7";
    expect(rulesAndSecrets(oneDigit)).toEqual([["aws-akid", oneDigit]]);
  });

  it("an earlier rule wins an overlap, and hits come in text order", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl";
    expect(rulesAndSecrets("Authorization: Bearer " + jwt)).toEqual([["bearer", jwt]]);
    const pat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd012345";
    expect(rulesAndSecrets("GITHUB_TOKEN=" + pat)).toEqual([["github-pat", pat]]);
    expect(
      findCredentials("first DB_PASSWORD=" + "s3cr3t-Pa55" + " then " + AKID).hits.map((h) => h.rule),
    ).toEqual(["password-assignment", "aws-akid"]);
  });
});

describe("isPlaceholder", () => {
  it("knows the placeholders of B4 and nothing else", () => {
    for (const value of [
      "AKIA" + "IOSFODNN7EXAMPLE",
      "aaaaaaaa",
      "${DB_PASSWORD}",
      "$DB_PASSWORD",
      "<token>",
      "my-Example-key",
      "PLACEHOLDER_VALUE",
      "dummy-secret-1",
      "ChangeMe123",
      "your_key_here",
      "abXXXXcd",
      "Password",
      "secret",
      "test",
      "ADMIN",
      "root",
    ]) {
      expect(isPlaceholder("password-assignment", value), value).toBe(true);
    }
    for (const value of ["s3cr3t-Pa55", "hunter2hunter2", "$2b$12$abcdefghij", "rootkit-99", "testing123"]) {
      expect(isPlaceholder("password-assignment", value), value).toBe(false);
    }
    expect(isPlaceholder("aws-akid", "ASIA" + "PACIFICSALESTEAM")).toBe(true);
    expect(isPlaceholder("aws-akid", AKID)).toBe(false);
    // The digit test belongs to aws-akid alone.
    expect(isPlaceholder("bearer", "abcdefghijklmnopqrst")).toBe(false);
  });
});

describe("countPersonalData", () => {
  it("personal data is counted separately", () => {
    const text =
      "Write to ada" + "@example.com or bob" + "@example.com, account DE89" + "370400440532013000.";
    expect(countPersonalData(text)).toEqual({ email: 2, iban: 1 });
    expect(findCredentials(text).hits).toEqual([]);
  });
});

describe("sizeBand", () => {
  it("sizeBand follows Redaction.bucket", () => {
    const bands: [number, string][] = [
      [8, "1-8"],
      [9, "9-16"],
      [16, "9-16"],
      [17, "17-32"],
      [32, "17-32"],
      [33, "33-64"],
      [64, "33-64"],
      [65, "65-128"],
      [128, "65-128"],
      [129, "129+"],
    ];
    for (const [bytes, band] of bands) expect(sizeBand("a".repeat(bytes)), `${bytes} bytes`).toBe(band);
    // UTF-8 bytes, not characters: five of these are ten bytes.
    expect(sizeBand("é".repeat(4))).toBe("1-8");
    expect(sizeBand("é".repeat(5))).toBe("9-16");
  });
});

describe("maskCredentials", () => {
  it("maskCredentials replaces every hit and leaves the rest", () => {
    expect(maskCredentials("x " + AKID + " y", () => "credential 1")).toBe("x [credential 1: aws-akid] y");
    const two = "a " + AKID + " b Bearer " + TOKEN + " c";
    expect(maskCredentials(two, (h) => (h.rule === "aws-akid" ? "credential 1" : "credential 2"))).toBe(
      "a [credential 1: aws-akid] b [credential 2: bearer] c",
    );
    expect(maskCredentials("DB_PASSWORD=changeme", () => "credential 1")).toBe("DB_PASSWORD=changeme");
    expect(maskCredentials("nothing here", () => "credential 1")).toBe("nothing here");
  });
});

/** A small seeded generator, so a failing text can be found again. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ruleMatches", () => {
  const byName = (name: string): CredentialRule => {
    const rule = [...REDACTION_RULES, PASSWORD_RULE].find((r) => r.name === name);
    if (rule === undefined) throw new Error(name);
    return rule;
  };
  const shape = (m: RegExpExecArray) => [m.index, m[0], m[1]];

  it("finds exactly what the plain pattern finds", () => {
    const words: Record<string, string[]> = {
      email: ["a", "Z9", ".", "-", "_", "%", "+", "@", "@", "x.io", "co", ".de", " ", ",", "/", "a-b"],
      "url-userinfo": [
        "https",
        "s3",
        "+",
        ".",
        "-",
        "_",
        "://",
        "://u:",
        ":",
        "u",
        "p@",
        "@",
        "/",
        " ",
        "a-b",
        "x:y@",
      ],
      "password-assignment": [
        "pass",
        "word",
        "wd",
        "token",
        "secret",
        "api",
        "_",
        "-",
        "key",
        "=",
        ":",
        " ",
        '"',
        "'",
        "abcdef",
        "123456",
        "(",
        "}",
        "a-b",
        "x",
      ],
    };
    const rand = seeded(605);
    for (const [name, vocabulary] of Object.entries(words)) {
      const rule = byName(name);
      const plain = new RegExp(rule.pattern.source, rule.pattern.flags + "g");
      const pick = () => vocabulary[Math.floor(rand() * vocabulary.length)];
      let found = 0;
      for (let i = 0; i < 600; i++) {
        const text = Array.from({ length: 1 + Math.floor(rand() * 30) }, pick).join("");
        const expected = [...text.matchAll(plain)].map(shape);
        found += expected.length;
        expect(ruleMatches(rule, text).map(shape), `${name}: ${JSON.stringify(text)}`).toEqual(expected);
      }
      // Positive guard: the generated texts do reach the rule.
      expect(found, name).toBeGreaterThanOrEqual(30);
    }
  });

  it("a long word costs linear time, not quadratic", () => {
    const tail = " ada" + "@example.com https://u:" + "pw123456" + "@h DB_PASSWORD=" + "s3cr3t-Pa55";
    for (const [shapeName, word] of [
      ["hex run", "0123456789abcdef".repeat(2500)],
      ["hyphen chain", "a-".repeat(20000)],
      ["dotted chain", "a.".repeat(20000)],
    ]) {
      const text = word + tail;
      const t0 = performance.now();
      const { hits } = findCredentials(text);
      const personal = countPersonalData(text);
      const ms = performance.now() - t0;
      expect(hits.map((h) => h.rule).sort(), shapeName).toEqual(["password-assignment", "url-userinfo"]);
      expect(personal.email, shapeName).toBe(1);
      expect(ms, `${shapeName} took ${ms.toFixed(0)} ms`).toBeLessThan(250);
    }
  });
});
