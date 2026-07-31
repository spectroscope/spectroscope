import { c } from "./c";
import { cpp } from "./cpp";
import { csharp } from "./csharp";
import { css } from "./css";
import { go } from "./go";
import { html } from "./html";
import { java } from "./java";
import { javascript } from "./javascript";
import { json } from "./json";
import { kotlin } from "./kotlin";
import { php } from "./php";
import { python } from "./python";
import { ruby } from "./ruby";
import { rust } from "./rust";
import { shell } from "./shell";
import type { LangDef } from "./spec";
import { sql } from "./sql";
import { swift } from "./swift";
import { toml } from "./toml";
import { typescript } from "./typescript";
import { yaml } from "./yaml";

/**
 * THE REGISTRY — every language the highlighter knows, keyed by its id.
 *
 * `HlLang` in highlight.ts is `keyof typeof LANGS`, and both name lookups are
 * assembled from these entries, so one line here teaches the whole module a
 * language. Nothing in highlight.ts is touched to add one.
 *
 * ── ADDING A LANGUAGE ────────────────────────────────────────────────────────
 *
 * 1. Create `src/workspace/langs/<id>.ts`. Copy `sql.ts`, the richest example
 *    (line comments, block comments, folded case). It exports exactly one
 *    binding — `export const <id>: LangDef` — with three fields:
 *
 *      aliases     the markdown fence names that select it (```rust, ```rs).
 *                  Lower-case. Claim every spelling a reader will actually
 *                  type, including dialect names, as `sql.ts` does.
 *      extensions  the file extensions that select it. Lower-case, NO dot.
 *      spec        line / block / triple / quotes / keywords / foldCase.
 *                  Only `line`, `quotes` and `keywords` are required; a
 *                  language without block comments simply omits `block`.
 *
 *    Keep the keyword set in a file-local `const KEYWORDS: ReadonlySet<string>`
 *    and do not export it. Nothing outside the file may read it.
 *
 * 2. Add two lines to THIS file: the `import { <id> } from "./<id>";` above, and
 *    `<id>,` in the LANGS record below. Keep both alphabetical. That is the
 *    whole wiring — there is no third place to edit. A file left out of this
 *    record is unreachable rather than broken: nothing imports it, so it compiles,
 *    passes its own suite and colours nothing. `registry.test.ts` reads the
 *    directory and fails on the gap, which is the only reason it cannot happen
 *    quietly.
 *
 * On a name two languages both want (`h`, `scss`, `ts`): a name belongs to exactly
 * one of them, and the losing claim must be DELETED from the other file, not left
 * in beside the winner. Both lookups are built by walking this record and setting
 * into a Map, so a duplicate does not clash — it silently awards the name to
 * whichever language is keyed later, which is alphabetical order and nobody's
 * intent. Say in a comment why the winner won.
 *
 * Then extend `highlight.test.ts`, which is where a language proves it reads:
 *
 *   - Add an entry to the `samples` record inside the `tokenize` describe. That
 *     is the lossless-rejoin test, the module's one hard invariant: the emitted
 *     spans concatenated must return the input byte for byte. Give it a sample
 *     carrying your comment, string and number forms. `registry.test.ts` already
 *     re-checks the invariant over a shared corpus for every registered
 *     language, so a gap fails loudly either way — but the shared corpus is not
 *     written in your syntax, and yours is what readers will look at.
 *   - Add a describe that names your own keywords, strings and comments, the way
 *     the `sql` and `javascript` blocks do.
 *
 * On choosing keywords: a word only lights up when it stands alone, because
 * `isGlue` rejects a word touching . / - _ @ :, so `in` inside `uft.in.ua` stays
 * plain. That makes a short, common word (`is`, `as`, `do`) safe. It does not
 * rescue a word that is more often an identifier than a keyword — `value`,
 * `name`, `type` will paint ordinary variables as syntax. Under-colour instead,
 * and say in a comment which words you left out and why, as `javascript.ts`
 * does for `get` and `set`.
 */
export const LANGS = {
  c,
  cpp,
  csharp,
  css,
  go,
  html,
  java,
  javascript,
  json,
  kotlin,
  php,
  python,
  ruby,
  rust,
  shell,
  sql,
  swift,
  toml,
  typescript,
  yaml,
  // `satisfies` rather than a type annotation: an annotation would widen the
  // keys to `string` and HlLang, derived from them, would stop naming languages.
} satisfies Record<string, LangDef>;
