import type { LangDef } from "./spec";

// JSON has three keywords and no comments. The empty `line` list is the honest
// spec, not an omission: a `//` in a JSON file is a syntax error, and colouring
// it as a comment would tell the reader their file is fine when it is not.
const KEYWORDS: ReadonlySet<string> = new Set(["true", "false", "null"]);

export const json: LangDef = {
  aliases: ["json"],
  extensions: ["json"],
  spec: { line: [], quotes: ['"'], keywords: KEYWORDS },
};
