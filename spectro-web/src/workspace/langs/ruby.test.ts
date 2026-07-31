import { describe, expect, it } from "vitest";
import { tokenize, type HlLang, type Token } from "../highlight";
import { LANGS } from "./registry";
import { ruby } from "./ruby";
import type { LangDef } from "./spec";

// `tokenize` reaches its vocabulary through the registry and nothing else exposes
// a spec, so a spec is only reachable as a registered entry. Vitest gives each
// test file its own module graph, so this claim cannot reach another suite, and it
// is a no-op once the registry holds the same object under the same key.
const RB = "ruby" as HlLang;
(LANGS as Record<string, LangDef>)[RB] = ruby;

const toks = (src: string): Token[] => tokenize(src, RB);
const kw = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);
const clsOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;

// Ordinary code, not a keyword salad: a magic comment, a require, a class with
// an attr_reader, string interpolation, symbols, a block and an underscored int.
const SAMPLE = `# frozen_string_literal: true
require "json"

module Spectro
  class Session
    attr_reader :id, :events

    def initialize(id, path = nil)
      @id = id
      @events = []
      @path = path || "sessions/#{id}.jsonl"
    end

    def load
      return self unless File.exist?(@path)
      File.foreach(@path) do |line|
        @events << JSON.parse(line, symbolize_names: true)
      end
      self
    end

    def duration_ms
      first, last = @events.first, @events.last
      return 0 if first.nil? || last.nil?
      ((last[:at] - first[:at]) * 1_000).round
    end
  end
end
`;

describe("ruby", () => {
  it("colours the words a ruby file is actually made of", () => {
    expect(kw(SAMPLE)).toEqual(
      expect.arrayContaining([
        "require",
        "module",
        "class",
        "attr_reader",
        "def",
        "nil",
        "return",
        "self",
        "unless",
        "do",
        "true",
        "if",
        "end",
      ]),
    );
  });

  it("colours the magic comment, both string forms and the numbers", () => {
    expect(toks(SAMPLE)[0]?.cls).toBe("comment");
    expect(toks(SAMPLE)[0]?.text).toBe("# frozen_string_literal: true");
    expect(clsOf(SAMPLE, '"json"')).toBe("string");
    expect(clsOf(SAMPLE, '"sessions/#{id}.jsonl"')).toBe("string");
    expect(clsOf(SAMPLE, "0")).toBe("number");
    expect(clsOf(SAMPLE, "1_000")).toBe("number");
  });

  it("reads a =begin / =end block as one comment", () => {
    const src = "=begin\nAn essay about the parser.\nputs 1\n=end\nx = 2\n";
    const comment = toks(src).find((t) => t.cls === "comment");
    expect(comment?.text).toBe("=begin\nAn essay about the parser.\nputs 1\n=end");
    // The code after =end is code again.
    expect(clsOf(src, "2")).toBe("number");
  });

  it("opens a block comment only at the start of a line", () => {
    // `=begin` is a comment opener in column zero and an assignment anywhere else.
    // The pair has no closer in this file, so reading the assignment as an opener
    // greys out the rest of the FILE rather than the rest of the line — the one
    // unbounded mis-colour the module can make.
    const src = "t=begin_time\nelapsed = Time.now - t\nputs elapsed\n";
    // Nothing here is syntax, so every class but plain is a mis-colour. Asserted
    // over the set because the tokenizer merges adjacent plain runs, which leaves
    // no token spelled `Time` to ask about.
    expect(new Set(toks(src).map((t) => t.cls))).toEqual(new Set(["plain"]));
  });

  it("needs the whole word, so =beginning in column zero is not an opener", () => {
    const src = "=begin_time = 5\nputs 1\n";
    expect(toks(src).filter((t) => t.cls === "comment")).toEqual([]);
    expect(clsOf(src, "5")).toBe("number");
  });

  it("does not let an indented =end close the block early", () => {
    // Closing early is worse than it sounds: the prose after it is read as code,
    // and an apostrophe in it opens a string.
    const src = "=begin\n  =end is indented, so it is prose\nit's still prose\n=end\nx = 2\n";
    expect(toks(src).find((t) => t.cls === "comment")?.text).toBe(
      "=begin\n  =end is indented, so it is prose\nit's still prose\n=end",
    );
    expect(toks(src).some((t) => t.cls === "string")).toBe(false);
    expect(clsOf(src, "2")).toBe("number");
  });

  it("keeps an essay line that starts =endpoint inside the block", () => {
    const src = "=begin\n=endpoint docs live in the wiki\n=end\ny = 3\n";
    expect(toks(src).find((t) => t.cls === "comment")?.text).toBe(
      "=begin\n=endpoint docs live in the wiki\n=end",
    );
    expect(clsOf(src, "3")).toBe("number");
  });

  it("reads the pair through CRLF line endings", () => {
    // The line-start rule looks at the byte before the delimiter, which is the \n
    // of a CRLF pair as much as of a bare one; the carriage return sits at the
    // other end of the line, where it counts as the whitespace the closer needs.
    const src = "=begin\r\nprose\r\n=end\r\nx = 2\r\n";
    expect(toks(src).find((t) => t.cls === "comment")?.text).toBe("=begin\r\nprose\r\n=end");
    expect(clsOf(src, "2")).toBe("number");
  });

  it("leaves a ternary and a hash value plain, colon and all", () => {
    // The colon is not a delimiter here, which is what keeps the value half of
    // every hash and every ternary out of the string class.
    const src = "label = ok ? :yes : :no\nopts = { mode: :fast, retry: true }\n";
    expect(toks(src).some((t) => t.cls === "string")).toBe(false);
    expect(kw(src)).toEqual(["true"]);
  });

  it("leaves a symbol plain instead of calling it a string", () => {
    // A symbol may spell any reserved word, so both of these would light up
    // without the glue rule, and neither is syntax.
    const src = "state = :end\nsend(:class)\n";
    expect(toks(src).some((t) => t.cls === "string")).toBe(false);
    expect(kw(src)).toEqual([]);
  });

  it("does not colour a keyword reached through a dot or worn as a hash key", () => {
    // `nil` is the sharp case: bare it is the literal, but `.nil?` is a predicate
    // and `nil:` is a key, and both are far more frequent in real Ruby. Exactly
    // one of the two below is the literal.
    expect(kw("value = nil\nblank = value.nil?\n")).toEqual(["nil"]);
    expect(kw("render json: obj, if: cond\n")).toEqual([]);
    expect(kw("Range.new(rec.begin, rec.end)\n")).toEqual([]);
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SAMPLE,
      "=begin\nunterminated block\n",
      "s = 'it\\'s here'\nt = \"a#{b}c\"\n",
      "=begin\nfirst\n=end\n=begin\nsecond\n=end\n",
      "puts 'unterminated\nnext_line = 1\n",
      "# tail comment without a newline",
      "t=begin_time\nputs t\n",
      "=begin\n  =end indented\nreal\n=end\nx = 2\n",
      "=begin",
      "=end\n",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
