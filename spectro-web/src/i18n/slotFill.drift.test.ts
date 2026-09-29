// A replace that fills a "{slot}" passes the value through a function
// replacement. Read off disk.
//
// Card 440: t() filled slots with String.prototype.replace and a string
// replacement, which reads $&, $`, $' and $$ in the value as patterns, so a file
// name holding one came out changed. The export's label() in markup.ts and the
// voice sheet's say() in VoiceNotice.tsx carried the same line.
//
// What this walks: every replace or replaceAll call in a shipped .ts or .tsx
// file under spectro-web/src whose pattern is a slot written in place, as the
// template `{${key}}`, a string or template literal "{name}", or a regex
// literal /\{name\}/. A slot pattern held in a variable, built with new RegExp,
// or filled with split and join is outside this guard.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** A replace whose pattern is a slot written in place, in one of the four shapes. */
const SLOT_FILL =
  /\.replace(?:All)?\(\s*(?:`\{\$\{[^`]*\}\}`|`\{\w+\}`|"\{\w+\}"|'\{\w+\}'|\/\\\{\w+\\\}\/[a-z]*)\s*,\s*([^\n]{0,40})/g;
/** The replacement is a function: `() => ...` or `(m) => ...` or `function`. */
const FUNCTION_REPLACEMENT = /^(\([\w\s,]*\)\s*=>|\w+\s*=>|function\b)/;

/** @return the replacement text of every slot fill in `source` */
function slotFills(source: string): string[] {
  return [...source.matchAll(SLOT_FILL)].map((m) => m[1] ?? "");
}

interface SlotFill {
  file: string;
  replacement: string;
}

const fills: SlotFill[] = srcFiles(SRC)
  .filter((f) => /\.tsx?$/.test(f) && !f.includes(".test."))
  .flatMap((f) =>
    slotFills(stripComments(srcText(f))).map((replacement) => ({
      file: f.slice(SRC.length),
      replacement,
    })),
  );

describe("every replace that fills a slot written in place inserts the value as written", () => {
  it("recognises each shape of slot it claims, and only slots", () => {
    const shapes: [string, boolean][] = [
      ["s.replace(`{${k}}`, String(v))", false],
      ["s.replace(`{n}`, x)", false],
      ['s.replace("{v}", value)', false],
      ["s.replace('{n}', String(n))", false],
      ["s.replace(/\\{n\\}/g, x)", false],
      ['s.replaceAll("{n}", x)', false],
      ["s.replace(`{${k}}`, () => String(v))", true],
      ['s.replace("{v}", () => value)', true],
      ["s.replace(/\\{n\\}/g, (m) => m)", true],
    ];
    for (const [source, isFunction] of shapes) {
      const found = slotFills(source);
      expect(found, source).toHaveLength(1);
      expect(FUNCTION_REPLACEMENT.test(found[0] ?? ""), source).toBe(isFunction);
    }
    // A quantifier in braces and a plain string are not slots.
    expect(slotFills('s.replace(/-{2,}/g, "-")')).toEqual([]);
    expect(slotFills('s.replace("{", "(")')).toEqual([]);
  });

  it("finds the slot fillers it knows about", () => {
    const files = new Set(fills.map((fill) => fill.file));
    for (const known of [
      "i18n/i18n.ts",
      "export/markup.ts",
      "export/document.ts",
      "components/VoiceNotice.tsx",
      "lab/flowmap/QueueNode.tsx",
    ]) {
      expect(files, known).toContain(known);
    }
  });

  it("fills each slot through a function replacement", () => {
    const strings = fills.filter((fill) => !FUNCTION_REPLACEMENT.test(fill.replacement));
    expect(strings).toEqual([]);
  });
});
