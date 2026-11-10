// The kit's own pin (finding 19, review 2026-08-14): ten test files carried a
// byte-identical read() and eight carried the same comment-blanker before this
// module existed. The risk of a hand-copy here is not style — a blanker whose
// regex drifts greedy silently blanks the CODE between two comments, and every
// guard built on it goes soft without a single test turning red. So the kit's
// semantics are pinned in their own right, once.

import { describe, expect, it } from "vitest";
import { blankBlockComments, read, stripComments } from "./source";

describe("read", () => {
  it("resolves relative to the URL the caller hands over", () => {
    const self = read("./source.test.ts", import.meta.url);
    expect(self).toContain("finding 19, review 2026-08-14");
  });
});

describe("blankBlockComments", () => {
  it("blanks a block comment to spaces, byte for byte", () => {
    expect(blankBlockComments("a/* x */b")).toBe("a       b");
  });

  it("keeps every newline so offsets and line numbers still line up", () => {
    const src = "a\n/* one\n two */\nb";
    const out = blankBlockComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("one");
  });

  it("is lazy: the code between two comments survives", () => {
    // A greedy regex would blank from the first /* to the LAST */ — taking the
    // declaration in the middle with it, and weakening every guard downstream.
    const out = blankBlockComments("/* a */ display: none; /* b */");
    expect(out).toContain("display: none;");
  });
});

describe("stripComments", () => {
  it("also drops line comments to the end of the line, keeping the newline", () => {
    const src = "keep(); // prose about a deleted class\nalso();";
    const out = stripComments(src);
    expect(out).toContain("keep();");
    expect(out).toContain("also();");
    expect(out).not.toContain("deleted class");
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });
});

// Card 605, task 12 fix round 1 item 11: a `/*` or `//` inside a string, a
// template or a regular expression is not a comment. The import dialog's hint
// path "~/.claude/projects/…/*.jsonl" opened a block comment that ran to the
// next `*/` and took most of the file with it.
describe("stripComments reads strings and regular expressions as code", () => {
  it("keeps a /* inside a string, and the code after it", () => {
    const src = 'hint("~/.claude/projects/…/*.jsonl");\nkeep(); /* gone */ also();';
    const out = stripComments(src);
    expect(out).toContain('"~/.claude/projects/…/*.jsonl"');
    expect(out).toContain("keep();");
    expect(out).toContain("also();");
    expect(out).not.toContain("gone");
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("keeps // inside single quotes, double quotes and a template", () => {
    const src = "a('http://x'); b(\"//y\"); c(`//z ${'/*'} w`); // drop\nd();";
    const out = stripComments(src);
    expect(out).toContain("a('http://x');");
    expect(out).toContain('b("//y");');
    expect(out).toContain("c(`//z ${'/*'} w`);");
    expect(out).not.toContain("drop");
    expect(out).toContain("d();");
  });

  it("keeps a regular expression with slashes and stars, and divides as code", () => {
    const src = "const re = /\\/\\*[\\s\\S]*?\\*\\//g; keep(); // drop\nconst half = a / b / c; also();";
    const out = stripComments(src);
    expect(out).toContain("const re = /\\/\\*[\\s\\S]*?\\*\\//g; keep();");
    expect(out).toContain("const half = a / b / c; also();");
    expect(out).not.toContain("drop");
  });

  it("reads the code inside a template's ${...} as code, nested templates too", () => {
    const src = "t(`a ${f(/* gone */ `in ${x}`)} b /* text */`); // drop\nkeep();";
    const out = stripComments(src);
    expect(out).not.toContain("gone");
    expect(out).toContain("`in ${x}`");
    expect(out).toContain(" b /* text */`);");
    expect(out).not.toContain("drop");
    expect(out).toContain("keep();");
  });

  it("an escaped quote does not end a string", () => {
    const out = stripComments('x("a \\" /* b"); keep();');
    expect(out).toBe('x("a \\" /* b"); keep();');
  });
});
