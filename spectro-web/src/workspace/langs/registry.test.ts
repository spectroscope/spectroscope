import { describe, expect, it } from "vitest";
import { hlLangForFence, hlLangForPath, tokenize, type HlLang } from "../highlight";
import { LANGS } from "./registry";

const ids = Object.keys(LANGS) as HlLang[];

// Every language file in this directory, found by the bundler rather than by a
// second list somebody has to remember to extend. `tokenize` looks a vocabulary
// up in LANGS and nothing else exposes one, so a file sitting here unregistered
// is dead weight that no fence and no filename can select — and it fails silently,
// because a language that is merely absent looks exactly like a language that was
// never written.
const MODULES: Record<string, Record<string, unknown>> = import.meta.glob(
  ["./*.ts", "!./*.test.ts", "!./registry.ts", "!./spec.ts"],
  { eager: true },
);

const fileIds: readonly string[] = Object.keys(MODULES)
  .map((path) => path.replace(/^\.\//, "").replace(/\.ts$/, ""))
  .sort();

// Sources picked to reach every branch of the tokenizer whichever language
// reads them: unterminated fences, a trailing backslash, CRLF, non-ASCII bytes.
// Any language may legitimately colour these differently; none may lose a byte.
const CORPUS: readonly string[] = [
  "",
  "\n",
  'a "b" c\n',
  "x = 42; // note\n/* block */\n",
  "# hash\n-- dash\n",
  "'unterminated\nnext line\n",
  "`tick ${x}\nmore`\n",
  "\"\"\"triple\"\"\" '''other'''\n",
  "trailing backslash \\",
  "0xFF 0b1010 1_000 1.5e-3 9L\n",
  "café ünïcode\r\n\ttab\n",
  '{"k": [1, true, null]}\n',
];

describe("language registry", () => {
  it("registers every language file in this directory", () => {
    // Named, not counted: the failure has to say which language is missing, or the
    // next reader diffs two lists by hand.
    expect(fileIds.filter((id) => !(id in LANGS))).toEqual([]);
  });

  it("keys every language by the binding its own file exports", () => {
    // Catches the copy-paste that files one language under another's key, which a
    // coverage count cannot see.
    for (const id of fileIds) {
      expect(LANGS[id as HlLang]).toBe(MODULES[`./${id}.ts`][id]);
    }
  });

  it("answers every alias and extension with a spec that reads", () => {
    // Resolving to an id is not enough: the id has to carry a vocabulary the
    // tokenizer can actually run. A half-built spec passes both lookups below and
    // then throws on the first render.
    const probe = 'x = 1; "s"\n';
    const reads = (lang: HlLang): string =>
      tokenize(probe, lang)
        .map((t) => t.text)
        .join("");
    for (const id of ids) {
      for (const alias of LANGS[id].aliases) {
        const found = hlLangForFence(alias);
        if (found === null) throw new Error(`fence ${alias} resolves to nothing`);
        expect(LANGS[found].spec.keywords).toBeInstanceOf(Set);
        expect(reads(found)).toBe(probe);
      }
      for (const ext of LANGS[id].extensions) {
        const found = hlLangForPath(`file.${ext}`);
        if (found === null) throw new Error(`extension ${ext} resolves to nothing`);
        expect(LANGS[found].spec.quotes).toBeInstanceOf(Array);
        expect(reads(found)).toBe(probe);
      }
    }
  });

  it("resolves every declared fence alias to its own language", () => {
    for (const id of ids) {
      for (const alias of LANGS[id].aliases) {
        expect(hlLangForFence(alias)).toBe(id);
      }
    }
  });

  it("resolves every declared extension to its own language", () => {
    for (const id of ids) {
      for (const ext of LANGS[id].extensions) {
        expect(hlLangForPath(`file.${ext}`)).toBe(id);
      }
    }
  });

  it("lets no two languages claim the same alias or extension", () => {
    // A duplicate cannot fail loudly on its own: the registry walk awards the
    // name to whichever language sorts later, so the loser simply stops being
    // reachable and its file sits there reading correct. One winner per key,
    // and the losing claim gets deleted rather than left to lose silently.
    const clashes: string[] = [];
    const claim = (kind: string, seen: Map<string, HlLang>, name: string, id: HlLang): void => {
      const prev = seen.get(name);
      if (prev !== undefined) clashes.push(`${kind} ${name}: ${prev} and ${id}`);
      seen.set(name, id);
    };
    const aliases = new Map<string, HlLang>();
    const extensions = new Map<string, HlLang>();
    for (const id of ids) {
      for (const alias of LANGS[id].aliases) claim("alias", aliases, alias, id);
      for (const ext of LANGS[id].extensions) claim("extension", extensions, ext, id);
    }
    expect(clashes).toEqual([]);
  });

  it("keeps every alias and extension in the shape the lookups can reach", () => {
    // Both lookups lower-case their input and strip the dot themselves, so an
    // upper-cased alias or a dotted extension is an entry nothing can ever hit.
    for (const id of ids) {
      for (const name of [...LANGS[id].aliases, ...LANGS[id].extensions]) {
        expect(name).toBe(name.toLowerCase());
        expect(name).not.toBe("");
        expect(name.startsWith(".")).toBe(false);
      }
    }
  });

  it("makes every language reachable by fence or by filename", () => {
    for (const id of ids) {
      expect(LANGS[id].aliases.length + LANGS[id].extensions.length).toBeGreaterThan(0);
    }
  });

  it("rejoins losslessly in every registered language", () => {
    // The one hard invariant, held open for whatever the registry grows into:
    // concatenating the emitted spans returns the input byte for byte.
    for (const id of ids) {
      for (const src of CORPUS) {
        const rejoined = tokenize(src, id)
          .map((t) => t.text)
          .join("");
        expect(rejoined).toBe(src);
      }
    }
  });

  it("does not read a language out of Object.prototype", () => {
    // A name lookup backed by a plain object answers `constructor` with a
    // function and `__proto__` with an object, and neither is nullish, so both
    // would survive a `?? null` and be returned as if they were a language.
    for (const probe of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(hlLangForFence(probe)).toBeNull();
      expect(hlLangForPath(`file.${probe}`)).toBeNull();
    }
  });
});
