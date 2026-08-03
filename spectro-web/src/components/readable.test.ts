// The readable rendering of a transcript line, and the corruption it must not
// commit.
//
// The specimens are REAL lines, read off disk, harvested from the owner's own
// transcripts. Hand written strings would pass while the claim on screen was
// false: what this module gets wrong, it gets wrong on the escaping, and the
// escaping is the one thing a hand written fixture never reproduces. The two
// constructed cases below say so at the point of use.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEAD_CHARS, MAX_EMBED_DEPTH, readable, readableText } from "./readable";

const fixture = (name: string): string[] =>
  readFileSync(fileURLToPath(new URL(`../import/fixtures/${name}`, import.meta.url)), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());

const heavy = fixture("cc-heavy.jsonl");

/** A real assistant record whose Bash command is a python heredoc: real line
 *  breaks AND, inside the script, a literal backslash followed by an n. */
const HEREDOC = heavy[3];
/** A real SessionStart hook record: its stdout is a JSON document inside a
 *  string, and that document's leaf is markdown. */
const HOOK = heavy[6];
/** A real tool result that stringified a document that had itself stringified
 *  one: the browser's stored design prefs, read back through a tool. */
const NESTED = fixture("cc-nested.jsonl")[0];

describe("readable, on a command that carries its own escape", () => {
  // THE test. 1265 real Bash commands in the corpus carry a literal backslash
  // and n as CONTENT. A string replace of those two characters would rewrite
  // somebody's command inside a pane that calls itself the source, which is
  // this card's defect wearing a new coat. The only safe unescape is another
  // JSON.parse, and after the first parse a two character backslash n is
  // content by definition.
  it("leaves a bash heredoc alone", () => {
    const command = readable(HEREDOC).blocks.find((b) => b.kind === "text" && b.text.includes("re.finditer"));

    expect(command, "the command should open as a text block").toBeDefined();
    // The two characters, side by side, exactly as the file records them.
    expect(command!.text).toContain("replace('&#10;','\\n    ')");
    // and the heredoc's REAL line breaks are real
    expect(command!.text).toContain("\nimport re,glob\n");
    expect(command!.path).toBe("message.content[0].input.command");
  });
});

describe("readable, on a document inside a string", () => {
  it("parses a hook stdout twice and reaches the markdown", () => {
    const { parsed, blocks } = readable(HOOK);

    expect(parsed).toBe(true);
    const doc = blocks.find((b) => b.path === "attachment.stdout");
    expect(doc?.kind).toBe("json");
    expect(doc?.depth).toBe(1); // one parse beyond the line itself
    expect(doc?.text).toContain('"hookEventName": "SessionStart"');

    const leaf = blocks.find((b) => b.path === "attachment.stdout.hookSpecificOutput.additionalContext");
    expect(leaf?.kind).toBe("text");
    expect(leaf?.text).toContain("# project notes\n\nline one of the context.\n");
    expect(leaf?.text.includes("\\n"), "no escape survives into the leaf").toBe(false);
  });

  it("handles a doubly stringified document", () => {
    const blocks = readable(NESTED).blocks;

    const once = blocks.find((b) => b.path === "toolUseResult.stdout");
    expect(once?.depth).toBe(1);
    expect(once?.kind).toBe("json");

    const twice = blocks.find((b) => b.path === "toolUseResult.stdout.stored");
    expect(twice?.depth).toBe(2);
    expect(twice?.kind).toBe("json");
    expect(twice?.text).toContain('"design": "paper"');
  });

  // Without the object-or-array guard, "12" comes back a number and "true" a
  // boolean, which is corruption dressed up as prettification.
  it("refuses to turn a numeric string into a number", () => {
    // Constructed: the corpus has no line that pins the guard on its own.
    const line = JSON.stringify({ exitCode: "12", ok: "true", empty: "" });

    const blocks = readable(line).blocks;

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('"exitCode": "12"');
    expect(blocks[0].text).toContain('"ok": "true"');
  });

  it("stops recursing at depth 3", () => {
    // Constructed: the deepest real record in 57402 corpus lines is two
    // documents deep, so nothing measured reaches the stop.
    // Five documents, one inside the next: the walk opens four of them and
    // leaves the fifth standing where it is, escaped.
    const inner = JSON.stringify({ a: JSON.stringify({ deep: "value" }) });
    const line = JSON.stringify({ d: JSON.stringify({ c: JSON.stringify({ b: inner }) }) });

    const blocks = readable(line).blocks;

    expect(Math.max(...blocks.map((b) => b.depth))).toBe(MAX_EMBED_DEPTH);
    expect(blocks.some((b) => b.depth > MAX_EMBED_DEPTH)).toBe(false);
    // The document at the stop keeps its last string escaped, in place, rather
    // than opening a fourth one.
    const last = blocks[blocks.length - 1];
    expect(last.depth).toBe(MAX_EMBED_DEPTH);
    expect(last.text).toContain('\\"deep\\"');
  });

  it("returns the line untouched when it is not JSON", () => {
    const { parsed, blocks } = readable("this line is not JSON at all {");

    expect(parsed).toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: "text",
      path: "",
      depth: 0,
      text: "this line is not JSON at all {",
    });
  });

  // An opened string would otherwise be printed twice at full length: once
  // escaped in the skeleton, once opened below it.
  it("shortens an opened string where it stood", () => {
    const skeleton = readable(HOOK).blocks[0];

    expect(skeleton.depth).toBe(0);
    expect(skeleton.text).toContain('"stdout": "{\\n  \\"hookSpecificOutput\\": {\\n');
    expect(skeleton.text).toContain("…");
    expect(skeleton.text.length).toBeLessThan(HOOK.length);
  });

  // 3.89% of corpus lines carry emoji, and the head lands wherever it lands.
  it("never shortens a string through the middle of a character", () => {
    const face = `${"x".repeat(HEAD_CHARS - 1)}\u{1F600}${"y".repeat(20)}\nreal break`;
    const line = JSON.stringify({ note: face });

    const head = readable(line).blocks[0].text;

    expect(head).toContain(`${"x".repeat(HEAD_CHARS - 1)}…`);
    expect(head).not.toContain("\\ud83d");
  });
});

describe("readableText", () => {
  it("names every opened block by its path and keeps the real line breaks", () => {
    const text = readableText(HOOK);

    expect(text).toContain("attachment.stdout.hookSpecificOutput.additionalContext");
    expect(text).toContain("# project notes\n\nline one of the context.\n");
  });

  it("hands back a line that is not JSON exactly as it arrived", () => {
    expect(readableText("nope")).toBe("nope");
  });
});
