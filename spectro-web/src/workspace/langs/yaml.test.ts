import { afterAll, describe, expect, it } from "vitest";
import { tokenize, type Token } from "../highlight";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";
import { yaml } from "./yaml";

// yaml's line in the registry lands in a separate wiring pass, so the engine
// cannot reach this spec by name yet. Registering it on the live map for the
// life of this file runs every assertion through the real tokenizer instead of a
// copy of it, and stays correct once the wiring lands: same key, same object.
// Vitest gives each test file its own module registry, so the teardown below is
// belt and braces against the day that isolation is turned off.
const REGISTRY = LANGS as Record<string, LangDef>;
const ALREADY_WIRED = "yaml" in REGISTRY;
REGISTRY.yaml = yaml;
afterAll(() => {
  if (!ALREADY_WIRED) delete REGISTRY.yaml;
});

const scan = (src: string): Token[] => tokenize(src, "yaml" as never);
const classOf = (src: string, needle: string): string | undefined =>
  scan(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  scan(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

// Ordinary compose file: quoted and unquoted scalars, a dotted image tag, a
// hyphenated enum value, a port mapping that looks like a time.
const COMPOSE = `# preview stack, one container per surface
version: "3.9"
services:
  web:
    image: spectro/web:0.4.0
    restart: on-failure
    ports:
      - "8080:8080"
    environment:
      SPECTRO_OTLP_ENABLED: true
      SPECTRO_DEBUG: no
    retries: 3
`;

// A workflow file exists in this test for one reason: every word in it sits in
// front of a colon or inside a hyphenated name, so the whole thing must come out
// without a single keyword. `on:` is the case that proves it.
const WORKFLOW = `on:
  push:
    branches: [main]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm run gate
`;

describe("yaml", () => {
  it("colours the words yaml resolves as literals rather than text", () => {
    expect(keywords(COMPOSE)).toEqual(expect.arrayContaining(["true", "no"]));
  });

  it("folds case, because a yaml boolean may be shouted", () => {
    expect(classOf("enabled: True\n", "True")).toBe("keyword");
    expect(classOf("cache: OFF\n", "OFF")).toBe("keyword");
  });

  it("colours both quote styles and the hash comment", () => {
    expect(classOf(COMPOSE, '"3.9"')).toBe("string");
    expect(classOf(COMPOSE, '"8080:8080"')).toBe("string");
    expect(classOf("name: 'spectro web'\n", "'spectro web'")).toBe("string");
    expect(scan(COMPOSE)[0]?.cls).toBe("comment");
  });

  it("colours a plain integer scalar", () => {
    expect(classOf(COMPOSE, "3")).toBe("number");
  });

  it("leaves keys plain even when the key is spelled like a literal", () => {
    // The whole file, and `on:` above all: a key is always followed by a colon,
    // which isGlue rejects, so no key can reach the keyword set.
    expect(keywords(WORKFLOW)).toEqual([]);
  });

  it("leaves a hyphenated value alone", () => {
    // `on-failure` is one enum value, not the literal `on` plus a word.
    const found = keywords(COMPOSE);
    expect(found).not.toContain("on");
    expect(found).not.toContain("failure");
  });

  it("leaves the single letters yaml 1.1 also accepts as booleans plain", () => {
    // `y` and `n` are booleans in yaml 1.1 and single letters everywhere else;
    // a list of one-letter items would light up end to end.
    expect(keywords("answers:\n  - y\n  - n\n")).toEqual([]);
  });

  it("colours the first word of a prose scalar, which is the accepted cost", () => {
    // Pinned rather than hidden: nothing here knows where a plain scalar ends, so
    // a sentence beginning with a literal reads as one. The alternative is to
    // drop yes/no/on/off and stop colouring the values half of yaml's config
    // files, which is the worse trade.
    expect(keywords("note: no longer used\n")).toEqual(["no"]);
  });

  it("rejoins losslessly", () => {
    for (const src of [COMPOSE, WORKFLOW, "text: don't stop\n", "block: |\n  two\n  lines\n"]) {
      expect(
        scan(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
