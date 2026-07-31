import { describe, expect, it, vi } from "vitest";
import { tokenize, type Token } from "../highlight";
import { cpp } from "./cpp";

// `tokenize` reaches a vocabulary only through the registry, keyed by id, so the
// definition under test is bound there for this module. The substitution is
// scoped to this file: it proves the language reads without depending on where
// the registry happens to list it.
vi.mock("./registry", async () => ({ LANGS: { cpp: (await import("./cpp")).cpp } }));

// A header of ordinary C++: templates, a namespace, both comment forms, and two
// members named after words C++ gives a meaning only in one position.
const SRC = `#include <memory>
#include <vector>

namespace spectro {

/* One paint's worth of spans, owned by the renderer. */
template <typename T>
class Frame : public Surface {
public:
    static constexpr const char *kName = "frame";

    explicit Frame(std::size_t width) : width_(width) {}
    bool empty() const noexcept override { return width_ == 0; }
    void push(T span) { spans_.push_back(std::move(span)); }

private:
    // Set once the last span lands; a frame is never resized after that.
    bool final = false;
    int module = 0;
    std::size_t width_ = 0;
    std::vector<T> spans_;
};

}  // namespace spectro
`;

const toks = (src: string): Token[] => tokenize(src, "cpp" as never);
const classOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

describe("cpp", () => {
  it("declares the names a reader will type", () => {
    expect(cpp.aliases).toEqual(expect.arrayContaining(["cpp", "c++"]));
    expect(cpp.extensions).toEqual(expect.arrayContaining(["cpp", "cc", "cxx", "hpp", "hh", "hxx"]));
  });

  it("colours the words C++ has and C does not", () => {
    expect(keywords(SRC)).toEqual(
      expect.arrayContaining(["namespace", "template", "typename", "class", "explicit", "noexcept"]),
    );
  });

  it("colours a string, a number and both comment forms", () => {
    expect(classOf(SRC, '"frame"')).toBe("string");
    expect(classOf(SRC, "0")).toBe("number");
    expect(toks(SRC).find((t) => t.text.startsWith("/*"))?.cls).toBe("comment");
    expect(toks(SRC).find((t) => t.text.startsWith("//"))?.cls).toBe("comment");
  });

  it("reads a preprocessor directive as code, not as a comment", () => {
    expect(keywords(SRC)).toContain("include");
    expect(toks(SRC).some((t) => t.cls === "comment" && t.text.includes("include"))).toBe(false);
  });

  it("colours override, which is a modifier wherever it appears", () => {
    expect(classOf(SRC, "override")).toBe("keyword");
  });

  it("leaves the members named after contextual keywords alone", () => {
    // `final` and `module` mean something to the compiler in exactly one position
    // and are ordinary names everywhere else. `class Frame final` loses its colour
    // as a result, but `class` beside it keeps the declaration readable.
    //
    // Read off the keyword list, not by finding the word: adjacent plain runs are
    // merged into one token, so an uncoloured identifier never stands alone.
    const kw = keywords(SRC);
    expect(kw).not.toContain("final");
    expect(kw).not.toContain("module");
    expect(toks(SRC).some((t) => t.cls === "plain" && t.text.includes("final"))).toBe(true);
  });

  it("loses an access label to the colon that follows it", () => {
    // A trailing `:` is glue, so `public:` is a fragment and stays plain while
    // `: public Surface` colours. The rule that keeps `in` out of uft.in.ua costs
    // this, and the label is punctuation-shaped enough to live without colour.
    expect(keywords("public:\n    int n = 0;\n")).not.toContain("public");
    expect(keywords("class Frame : public Surface {\n")).toContain("public");
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SRC,
      "auto x = 1'000'000;\nchar c = 'a';\n",
      "/* outer /* inner */ still open */\nint after = 1;\n",
      'auto s = R"(raw)";\n',
      'const char *s = "oops\nint n = 1;',
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
