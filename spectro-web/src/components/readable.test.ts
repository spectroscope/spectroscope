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
import {
  HEAD_CHARS,
  HEAVY_CHARS,
  HIDDEN_KINDS,
  MAX_EMBED_DEPTH,
  STRUCTURE_DEPTH,
  opaqueField,
  readable,
  readableText,
} from "./readable";

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

// Bytes that are not language. A thinking block's signature and an image's
// base64 are unreadable at every length, and together they are 61% of the
// owner's corpus by weight, so a pane that prints them where they stand prints
// nothing else. They are COLLAPSED, never dropped: the placeholder names the
// field, counts the characters and opens on request, and the clipboard still
// carries the whole thing.
describe("readable, on bytes nobody reads", () => {
  it("collapses a signature where it stands, whatever its length", () => {
    // A real thinking block, 1684 characters of signature. Measured over 706
    // signatures in one transcript: the median is 1564 and the shortest 356, so
    // a size rule alone would leave half of them on screen. This one is
    // collapsed because of what the field IS, not because of how big it got.
    const blocks = readable(heavy[1]).blocks;

    const sig = blocks.find((b) => b.path === "message.content[0].signature");
    expect(sig?.kind).toBe("hidden");
    expect(sig?.text).toHaveLength(1684);
    expect(sig?.text.startsWith("CAIS5wkKhwEIEBgCKkBc")).toBe(true);
    // and it stands shortened in the skeleton, so the record around it is readable
    expect(blocks[0].text).toContain("CAIS5wkKhwEIEBgCKkBc");
    expect(blocks[0].text).not.toContain(sig!.text);
  });

  it("collapses the base64 of an image the same way", () => {
    const blocks = readable(heavy[7]).blocks;

    const data = blocks.filter((b) => b.kind === "hidden");
    expect(data.map((b) => b.path)).toEqual([
      "message.content[0].content[0].source.data",
      "toolUseResult[0].source.data",
    ]);
    expect(data[0].text).toHaveLength(1200);
    // the media type beside it is short and stays where it is
    expect(blocks[0].text).toContain('"media_type": "image/jpeg"');
  });

  it("names the fields it treats as opaque, and nothing else", () => {
    expect(opaqueField("message.content[0].signature")).toBe(true);
    expect(opaqueField("message.content[0].source.data")).toBe(true);
    expect(opaqueField("toolUseResult.file.base64")).toBe(true);
    // a field that only ends in the same letters is a different field
    expect(opaqueField("message.content[0].data")).toBe(false);
    expect(opaqueField("message.signature_verified")).toBe(false);
    expect(opaqueField("message.content[0].text")).toBe(false);
  });

  it("collapses any single run too long to read, whatever it is called", () => {
    // Constructed: the fixtures are trimmed specimens, and the size rule needs a
    // string over the threshold. Measured: the longest single run of real prose
    // in one transcript is 1237 characters, so 2048 is above everything a person
    // wrote and below every blob.
    const line = JSON.stringify({ note: "z".repeat(HEAVY_CHARS + 1) });

    const blocks = readable(line).blocks;

    expect(blocks[1]?.kind).toBe("long");
    expect(blocks[1]?.path).toBe("note");
    expect(blocks[1]?.text).toHaveLength(HEAVY_CHARS + 1);
  });

  // The size rule and the name rule shared one kind, so they shared one
  // sentence, and the sentence belongs to the name rule: "characters that are
  // not text" was written for a signature and a base64 body.
  //
  // Dictation broke the premise the size rule was measured on. The module's own
  // header says the longest run anybody WROTE is a 1237 character shell
  // command; a dictated prompt has no line breaks in it at all and runs to
  // thousands. Card 141 turned those records into frames, so the row is now
  // reachable, and the pane printed "3.424 Zeichen, die kein Text sind" over
  // the owner's own German prompt. Measured over 4639 transcripts: 526 strings
  // are collapsed by size alone, and the fields they sit in are content (175),
  // text (61), reason (60), reasoning (55), summary (24) and thinking (10).
  // Language, nearly all of it.
  //
  // Collapsing them stays right. Calling them bytes does not, so the two rules
  // now carry two kinds and the pane has a sentence for each.
  it("keeps the two reasons for collapsing apart", () => {
    const dictated = "Okay, noch mal als Einordnung hier. Die Präsentation ist viel zu technisch. ";
    const prompt = dictated.repeat(50);
    expect(prompt.includes("\n")).toBe(false);
    expect(prompt.length).toBeGreaterThan(HEAVY_CHARS);

    const long = readable(JSON.stringify({ content: prompt })).blocks[1];
    const bytes = readable(heavy[1]).blocks.find((b) => b.path === "message.content[0].signature");

    // Both are carried whole and both are collapsed, and they are not the same
    // statement about what is underneath.
    expect(long.kind).toBe("long");
    expect(long.text).toBe(prompt);
    expect(bytes?.kind).toBe("hidden");
    expect(HIDDEN_KINDS).toEqual(["hidden", "long"]);
  });

  // opaqueField answers on the field NAME, at any length, which is what makes
  // it right for a 356 character signature. At length zero it produced a
  // collapsed block with nothing in it: "0 characters that are not text" over a
  // Show button that opened an empty pane, while the value stood complete in
  // the skeleton one line above. Measured over 4639 transcripts: 20 records in
  // 13 files carry an empty signature, against 73787 that carry a real one.
  it("collapses nothing when the opaque field is empty", () => {
    const blocks = readable(JSON.stringify({ signature: "", note: "ok" })).blocks;

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('"signature": ""');
  });

  it("leaves long readable prose open, however big it gets", () => {
    // Thinking, stdout and markdown carry real line breaks and are exactly what
    // the reader came for. Size alone must never hide them: only a single run
    // with no breaks in it is a candidate.
    const prose = `${"word ".repeat(HEAVY_CHARS)}\nand a second line`;
    const line = JSON.stringify({ thinking: prose });

    const block = readable(line).blocks[1];

    expect(block.kind).toBe("text");
    expect(block.text).toBe(prose);
  });
});

// A line the walk cannot finish.
//
// skeleton recurses once per structural level and costs more stack than
// JSON.stringify does, because the array branch adds a .map callback frame on
// top of the call. So there is a band where the line parses, every other face
// renders it, and this one throws RangeError. The throw happens inside a
// useMemo during render, react has no error boundary anywhere in this app and
// main.tsx mounts <App /> bare, so it takes the whole tree down: white screen,
// live session gone, one click on "readable".
//
// Real transcripts top out at structural depth 9, so this needs a hand-edited
// or foreign file. That is precisely what the import dialog accepts, and
// detect.ts's own comments say so.
describe("readable, on a line nested deeper than anything real", () => {
  const nest = (n: number): string => {
    let v: unknown = { deep: "value" };
    for (let i = 0; i < n; i++) v = [v];
    return JSON.stringify({ type: "text_delta", agentId: "main", payload: v });
  };

  it("comes back instead of taking the tab with it", () => {
    const line = nest(3000);
    // The line itself is fine: every other face renders it.
    expect(() => JSON.parse(line)).not.toThrow();
    expect(() => JSON.stringify(JSON.parse(line), null, 2)).not.toThrow();

    expect(() => readable(line)).not.toThrow();
    expect(() => readableText(line)).not.toThrow();
  });

  it("still says it parsed, and still carries the value", () => {
    // A fallback that claimed "this line is not JSON" would answer a crash with
    // a false sentence. The walk stops descending; the document is printed
    // whole by JSON.stringify, which is native and does not run out of stack.
    const { parsed, blocks } = readable(nest(3000));

    expect(parsed).toBe(true);
    expect(blocks[0].text).toContain('"deep": "value"');
  });

  it("opens everything a real record has, well past the deepest measured one", () => {
    // The deepest structural nesting in the corpus is 9. The cap has to sit far
    // enough above that for the rule to be theoretical, or it becomes a second
    // silent truncation.
    expect(STRUCTURE_DEPTH).toBeGreaterThan(32);
    let v: unknown = { signature: "s".repeat(400) };
    for (let i = 0; i < 12; i++) v = { down: [v] };

    const blocks = readable(JSON.stringify(v)).blocks;

    expect(blocks.some((b) => b.kind === "hidden")).toBe(true);
  });
});

describe("readableText", () => {
  it("carries a collapsed value into the clipboard whole", () => {
    // The pane collapses it; the clipboard does not. Copying always takes the
    // whole thing, or the reader walks away with a file they believe is
    // complete.
    const text = readableText(heavy[1]);

    expect(text).toContain("message.content[0].signature");
    expect(text).toContain(JSON.parse(heavy[1]).message.content[0].signature);
  });

  it("names every opened block by its path and keeps the real line breaks", () => {
    const text = readableText(HOOK);

    expect(text).toContain("attachment.stdout.hookSpecificOutput.additionalContext");
    expect(text).toContain("# project notes\n\nline one of the context.\n");
  });

  it("hands back a line that is not JSON exactly as it arrived", () => {
    expect(readableText("nope")).toBe("nope");
  });
});
