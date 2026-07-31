import { afterAll, describe, expect, it } from "vitest";
import { tokenize, type Token } from "../highlight";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";
import { toml } from "./toml";

// See yaml.test.ts for why the spec is registered here: the registry line is a
// separate wiring pass, and the assertions are worth nothing unless they run
// through the real tokenizer.
const REGISTRY = LANGS as Record<string, LangDef>;
const ALREADY_WIRED = "toml" in REGISTRY;
REGISTRY.toml = toml;
afterAll(() => {
  if (!ALREADY_WIRED) delete REGISTRY.toml;
});

const scan = (src: string): Token[] => tokenize(src, "toml" as never);
const classOf = (src: string, needle: string): string | undefined =>
  scan(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  scan(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);
// Adjacent plain runs are merged by the tokenizer, so an uncoloured word is never
// a token of its own: ask which classes carry it instead.
const carriedBy = (src: string, word: string): string[] => [
  ...new Set(
    scan(src)
      .filter((t) => t.text.includes(word))
      .map((t) => t.cls),
  ),
];

// A manifest of the shape a workspace preview actually shows: tables, bare
// keys, a multi-line string, an offset date-time, a dotted table header.
const MANIFEST = `# what the release ships
[package]
name = "spectro-core"
version = "0.4.0"
edition = 2021
description = """
the agent orchestrator
you can watch
"""

[release]
notarized = true
bundled_models = false
cut_at = 2026-07-27T14:03:00Z

[profile.release]
opt-level = 3
`;

describe("toml", () => {
  it("colours the two booleans toml has", () => {
    expect(keywords(MANIFEST)).toEqual(["true", "false"]);
  });

  it("colours basic strings, literal strings and the multi-line form", () => {
    expect(classOf(MANIFEST, '"spectro-core"')).toBe("string");
    expect(classOf("path = 'C:\\raw\\dir'\n", "'C:\\raw\\dir'")).toBe("string");
    const multi = scan(MANIFEST).find((t) => t.text.startsWith('"""'));
    expect(multi?.cls).toBe("string");
    expect(multi?.text).toContain("you can watch");
  });

  it("colours the hash comment", () => {
    expect(scan(MANIFEST)[0]?.cls).toBe("comment");
  });

  it("colours integers", () => {
    expect(classOf(MANIFEST, "2021")).toBe("number");
    expect(classOf(MANIFEST, "3")).toBe("number");
  });

  it("does not accept a capitalised boolean", () => {
    // `True` is not a toml boolean. Colouring it would tell the reader their
    // file parses when it does not, which is the mistake json.ts refuses over
    // `//` comments.
    expect(keywords("notarized = True\n")).toEqual([]);
  });

  it("leaves the bare keys plain", () => {
    // `name`, `version` and `description` are not followed by a colon, so unlike
    // a yaml key they do reach the lookup. They stay plain because they are in
    // no keyword set: they are this file's words, not toml's.
    for (const key of ["name", "version", "edition", "notarized"]) {
      expect(carriedBy(MANIFEST, key)).toEqual(["plain"]);
    }
  });

  it("rejoins losslessly", () => {
    for (const src of [MANIFEST, 'x = """never closed\n', "y = 'unterminated\n", "z = inf\n"]) {
      expect(
        scan(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
