// Card 605: the credential rules of the files report. Every credential-shaped
// vector is joined at run time, so no such literal sits in this file: GitHub's
// push protection reads source, and RedactionTest.java does the same.

import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_RULES,
  INPUT_RULES,
  KEY_BODY_RULE,
  PASSWORD_RULE,
  REDACTION_RULES,
  countPersonalData,
  findCredentials,
  innerKeyLines,
  isPlaceholder,
  keyBlockHits,
  keyBlockKeys,
  keyBlockLines,
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

  it("key-body is a rule of the report, read on inputs only and not in the twin", () => {
    expect(INPUT_RULES.map((r) => r.name)).toEqual([...CREDENTIAL_RULES.map((r) => r.name), "key-body"]);
    expect(INPUT_RULES[INPUT_RULES.length - 1]).toBe(KEY_BODY_RULE);
    expect(KEY_BODY_RULE.pattern.flags).not.toContain("g");
    expect(REDACTION_RULES.map((r) => r.name)).not.toContain("key-body");
    expect(CREDENTIAL_RULES.map((r) => r.name)).not.toContain("key-body");
  });
});

describe("the key-body rule", () => {
  const half = ["MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Lp8Wk", "Nb3Vc6Hs1Jd5Gf0AhkiG9w0BAQEFAASC"];
  const line = half.join("");
  const asInput = (text: string) =>
    findCredentials(text, [], INPUT_RULES).hits.map((h) => [h.rule, h.secret]);

  it("a long mixed-case base64 run in an input is key material", () => {
    expect(asInput(`echo "${line}" >> k.pem`)).toEqual([["key-body", line]]);
    expect(asInput(`grep -c ${line} k.pem`)).toEqual([["key-body", line]]);
    expect(asInput(`KEY=${line}==`)).toEqual([["key-body", `${line}==`]]);
    // Forty characters is the shortest.
    expect(asInput(`x ${line.slice(0, 40)} y`)).toEqual([["key-body", line.slice(0, 40)]]);
    expect(asInput(`x ${line.slice(0, 39)} y`)).toEqual([]);
  });

  it("a hex hash, one-case runs and earlier hits are no key body", () => {
    const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    expect(asInput(`git show ${sha}`)).toEqual([]);
    expect(asInput(`git show ${sha.toUpperCase()}`)).toEqual([]);
    expect(asInput(`x ${"abcdefgh".repeat(6)} y`)).toEqual([]);
    // A run inside a hit of an earlier rule stays that hit.
    const pat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "abcdefghijklmnop0123";
    expect(asInput(`push ${pat}`)).toEqual([["github-pat", pat]]);
    // Results, prompts and the mask use CREDENTIAL_RULES, without key-body.
    expect(findCredentials(`echo "${line}"`).hits).toEqual([]);
  });

  it("paths, URLs, identifiers and a data URL header stay visible", () => {
    for (const text of [
      "git show 9fceb02d0ae598e95dc970b74767f19372d61af8",
      "cat spectro-core/src/main/java/dev/spectroscope/core/graph/StateGraph.java",
      // A digit and both cases: only the slash count keeps a path out.
      "cat src/test/java/dev/spectroscope/core/graph/l1/StateGraphL1BuilderTest.java",
      "cat node_modules/@scope/pkg/dist/index.js",
      "cat node_modules/@scope/pkg2/dist/esm/internal/helpers/createVersionMap.js",
      "curl https://aiplatform.googleapis.com/v1/projects/abc123/locations/europe-west4/models",
      // Both cases and no slash: only the digit keeps an identifier out.
      "new AbstractSingletonProxyFactoryBeanConfigurationHelper()",
    ]) {
      expect(asInput(text), text).toEqual([]);
    }
    // A data URL keeps its header; the payload after the comma is a run of its own.
    const url = `data:image/png;base64,${line}`;
    expect(asInput(`curl -d 'img=${url}' https://example.com/`)).toEqual([["key-body", line]]);
  });

  it("a PEM body line is key material, with up to three slashes", () => {
    const alphabet = ["ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz", "0123456789+/"].join("");
    const rand = seeded(6057);
    const pem = Array.from({ length: 64 }, () => alphabet[Math.floor(rand() * 64)]).join("");
    const slashes = (text: string) => text.split("/").length - 1;
    // Positive guard: the generated line holds slashes, a digit and both cases.
    expect(slashes(pem)).toBe(2);
    expect(pem).toMatch(/[0-9]/);
    expect(asInput(`echo "${pem}" >> k.pem`)).toEqual([["key-body", pem]]);
    expect(asInput(`grep -c ${pem} k.pem`)).toEqual([["key-body", pem]]);
    const three = pem.replace(/[a-z]/, "/");
    expect(slashes(three)).toBe(3);
    expect(asInput(`echo '${three}' >> k.pem`)).toEqual([["key-body", three]]);
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

  it("a value shaped like a plain identifier is code, after the placeholder test", () => {
    for (const code of [
      "password: string",
      "secret: string",
      "token = isPassword",
      "API_KEY=process.env.API_KEY",
      "self.token = config.secret",
    ]) {
      expect(findCredentials(code), code).toEqual({ hits: [], placeholders: 0 });
    }
    const values: [string, string, string][] = [
      ["DB_PASSWORD=", "s3cr3t-Pa55", ""],
      ['"password": "', "hunter2hunter2", '"'],
      ["SECRET_KEY = '", "q9w8e7r6t5", "'"],
    ];
    for (const [head, value, tail] of values) {
      expect(rulesAndSecrets(head + value + tail), head).toEqual([["password-assignment", value]]);
    }
    // Letters only, but a placeholder: the placeholder test comes first.
    expect(findCredentials("DB_PASSWORD=changeme")).toEqual({ hits: [], placeholders: 1 });
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
        // Upper and mixed case for the i flag, a double hyphen for the start that skips hyphens.
        "PASS",
        "--",
        "Api",
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

describe("private keys", () => {
  // The twin's pattern matches only the BEGIN header; findCredentials extends a hit
  // to its END marker, so the key body is part of the match and of the secret.
  const head = (kind: string) => "-----BEGIN " + kind + "PRIVATE" + " KEY-----";
  const tail = (kind: string) => "-----END " + kind + "PRIVATE" + " KEY-----";
  const BODY_A = ["MIIEowIBAAKCAQEA", AKID, "Nb3Vc6Hs1Jd5Gf0A"].join("\n");
  const BODY_B = ["MIIBVQIBADANBgkq", "hkiG9w0BAQEFAASC", "AT8wggE7AgEAAkEA"].join("\n");
  const pem = (kind: string, body: string) => `${head(kind)}\n${body}\n${tail(kind)}`;

  it("a key block is one hit from its header to its END marker, masked whole", () => {
    const block = pem("RSA ", BODY_A);
    const text = `key:\n${block}\nafter`;
    const start = text.indexOf(block);
    // The key id inside the body is part of the block, not a second hit.
    expect(findCredentials(text)).toEqual({
      hits: [{ rule: "private-key", match: block, secret: block, start, end: start + block.length }],
      placeholders: 0,
    });
    const masked = maskCredentials(text, () => "credential 1");
    expect(masked).toBe("key:\n[credential 1: private-key]\nafter");
    for (const line of BODY_A.split("\n")) expect(masked).not.toContain(line);
  });

  it("two different keys get two labels", () => {
    const a = pem("RSA ", BODY_A);
    const b = pem("", BODY_B);
    const { hits } = findCredentials(`${a}\n\n${b}\n`);
    expect(hits.map((h) => [h.rule, h.secret])).toEqual([
      ["private-key", a],
      ["private-key", b],
    ]);
    const labels = new Map<string, string>();
    const label = (h: { secret: string }) => {
      if (!labels.has(h.secret)) labels.set(h.secret, `credential ${labels.size + 1}`);
      return labels.get(h.secret) ?? "";
    };
    expect(maskCredentials(`${a} and ${b}`, label)).toBe(
      "[credential 1: private-key] and [credential 2: private-key]",
    );
  });

  it("a header without its END marker masks to the end of its string", () => {
    const open = `x ${head("EC ")}\n${BODY_A}\nnext: 1`;
    expect(maskCredentials(open, () => "credential 1")).toBe("x [credential 1: private-key]");
    // An END marker of another kind does not close the block.
    const crossed = `${head("RSA ")}\n${BODY_B}\n${tail("EC ")}\ntrailing`;
    expect(findCredentials(crossed).hits.map((h) => h.secret)).toEqual([crossed]);
    // Body lines that are not bare base64 lines are covered all the same.
    const echoes = `echo "${head("RSA ")}" > k.pem\necho "${BODY_B.split("\n")[0]}" >> k.pem`;
    expect(maskCredentials(echoes, () => "c")).toBe('echo "[c: private-key]');
    // A stop (the end of a string value) ends an open block, and an END marker past it does not count.
    const value = `${head("RSA ")}\n${BODY_B}`;
    const joined = `${value}", "next": "${tail("RSA ")}"`;
    expect(findCredentials(joined, [value.length]).hits.map((h) => h.secret)).toEqual([value]);
  });

  it("the PEM body decides which lines are body lines", () => {
    const lines = ["MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Lp8Wk", "Nb3Vc6Hs1Jd5Gf0AhkiG9w0BAQEFAASC"];
    const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    const bodyLines = (text: string) => keyBlockLines(findCredentials(text).hits[0]);
    // Header fields, an empty line, base64 lines; the text the block covers after its body is not body.
    const fields = `${head("RSA ")}\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00AA\n\n${lines.join("\n")}`;
    expect(bodyLines(`${fields}\n\nnext text\n${sha}\n`)).toEqual(lines);
    // A base64 start before a quote is a body line; the escape for a line break is a line break.
    expect(bodyLines(`'${head("RSA ")}\n${lines[0]}' > k.pem`)).toEqual([lines[0]]);
    expect(bodyLines(`printf '${head("RSA ")}\\n${lines[0]}\\n${lines[1]}' > k.pem`)).toEqual(lines);
    // Indented, as in a YAML block.
    expect(bodyLines(`  ${head("")}\n  ${lines.join("\n  ")}\nnext: 1`)).toEqual(lines);
    // Numbered by cat -n, by a numbered Read and by grep -n.
    for (const mark of ["\t", "→", ":"]) {
      const numbered = [head("RSA "), ...lines].map((l, i) => `${String(i + 1).padStart(6)}${mark}${l}`);
      expect(bodyLines(numbered.join("\n")), JSON.stringify(mark)).toEqual(lines);
    }
  });

  it("every listing's line numbers are taken off a body line", () => {
    const lines = ["MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Lp8Wk", "Nb3Vc6Hs1Jd5Gf0AhkiG9w0BAQEFAASC"];
    const listed: [string, (n: number) => string][] = [
      ["grep -rn", (n) => `id_rsa:${n}:`],
      ["grep -n -A", (n) => (n === 1 ? "1:" : `${n}-`)],
      ["blanks before a bar", (n) => `   ${n} | `],
      ["bat", (n) => `   ${n}   │ `],
      ["less -N", (n) => `${String(n).padStart(7)} `],
    ];
    for (const [name, mark] of listed) {
      const text = [head("RSA "), ...lines].map((l, i) => mark(i + 1) + l).join("\n");
      expect(keyBlockLines(findCredentials(text).hits[0]), name).toEqual(lines);
    }
    // A header field whose value starts with a number is still a field, not a numbered line.
    const field = `${head("RSA ")}\nComment: 2048-bit key\n\n${lines.join("\n")}`;
    expect(keyBlockLines(findCredentials(field).hits[0])).toEqual(lines);
  });

  it("what a nest of open blocks holds is found in one flat scan", () => {
    // `head -n 2` of six keys and an env file: each header opens a block to the end.
    const line = (i: number) => `MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Kq${i}Wz${i}`;
    const keys = Array.from(
      { length: 6 },
      (_, i) => `==> id_${i + 1} <==\n${head("RSA ")}\n${line(i + 1)}\n\n`,
    );
    const url = "postgres://app:" + "Hx7pLq2vZw" + "@db.internal/app";
    const [block, ...more] = findCredentials(`${keys.join("")}==> prod.env <==\nDATABASE_URL=${url}\n`).hits;
    expect(more).toEqual([]);
    // Headers inside the block take no room in that scan.
    expect(keyBlockHits(block).map((h) => h.rule)).toEqual(["url-userinfo"]);
    // One level of keys at a time, and the body lines of every header below its own.
    const inner = keyBlockKeys(block);
    expect(inner.map((h) => [h.rule, h.start])).toEqual([
      ["private-key", block.match.indexOf(head("RSA "), 1) + block.start],
    ]);
    expect(keyBlockKeys(inner[0])).toHaveLength(1);
    expect(keyBlockLines(block)).toEqual([line(1)]);
    expect(innerKeyLines(block)).toEqual([2, 3, 4, 5, 6].map(line));
    expect(keyBlockHits(findCredentials(`x ${AKID}`).hits[0])).toEqual([]);
    expect(keyBlockKeys(findCredentials(`x ${AKID}`).hits[0])).toEqual([]);
  });

  it("what an open block covers is found inside it", () => {
    const pw = "Hx7p" + "Lq2vZw";
    const token = "abcdefghij" + "0123456789KLMNOP";
    for (const [line, rule] of [
      [`AWS_SECRET_ACCESS_KEY=${pw}`, "password-assignment"],
      [`Bearer ${token}`, "bearer"],
      [`password: ${pw}`, "password-assignment"],
      [`Password: ${pw}`, "password-assignment"],
      [`postgres://app:${pw}@db.internal/app`, "url-userinfo"],
    ]) {
      const { hits } = findCredentials(`${head("RSA ")}\n${BODY_B}\n${line}\n`);
      expect(
        hits.map((h) => h.rule),
        line,
      ).toEqual(["private-key"]);
      expect(
        keyBlockHits(hits[0]).map((h) => h.rule),
        line,
      ).toEqual([rule]);
    }
  });

  it("a block names the credentials inside it and its body lines", () => {
    const body = ["MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Lp8WkNb3V", AKID, "c6Hs1Jd5Gf0A"].join("\n");
    const text = `see ${pem("RSA ", body)}`;
    const [block] = findCredentials(text).hits;
    expect(keyBlockHits(block).map((h) => [h.rule, h.secret, text.slice(h.start, h.end)])).toEqual([
      ["aws-akid", AKID, AKID],
    ]);
    // Twenty characters or more, base64 only; the 12-character line is too short to stand alone.
    expect(keyBlockLines(block)).toEqual(["MIIEowIBAAKCAQEAx9Ym4Qz7Rt2Lp8WkNb3V", AKID]);
    expect(keyBlockHits(findCredentials(`x ${AKID}`).hits[0])).toEqual([]);
  });

  it("a thousand headers in one text stay fast", () => {
    // Open headers, each with a body line, and headers inside an earlier block.
    const open = Array.from({ length: 1000 }, (_, i) => `${head("RSA ")}\nMIIEowIBAAKC${i}\nlog ${i}`).join(
      "\n",
    );
    const inside = `${head("RSA ")}\n${Array.from({ length: 1000 }, () => head("EC ")).join("\n")}\n${tail("RSA ")}`;
    // An open header covers the rest of the text, so the headers after it are inside it.
    for (const [name, text, count] of [
      ["open", open, 1],
      ["inside", inside, 1],
    ] as const) {
      const t0 = performance.now();
      const { hits } = findCredentials(text);
      const ms = performance.now() - t0;
      expect(hits, name).toHaveLength(count);
      expect(ms, `${name} took ${ms.toFixed(0)} ms`).toBeLessThan(200);
    }
  });
});
