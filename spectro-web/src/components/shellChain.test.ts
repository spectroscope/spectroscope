import { describe, expect, it } from "vitest";
import { breakShellChain } from "./shellChain";

describe("breaking a chained command", () => {
  it("puts each operator at the head of its own line", () => {
    expect(breakShellChain("cd /x && ls -la && echo done")).toBe("cd /x \n&& ls -la \n&& echo done");
  });

  it("breaks || too — the owner's own example ends with one", () => {
    expect(breakShellChain("a && b || echo nope")).toBe("a \n&& b \n|| echo nope");
  });

  it("leaves a command with no chain byte for byte", () => {
    const one = "git status --short";
    expect(breakShellChain(one)).toBe(one);
    expect(breakShellChain("")).toBe("");
  });

  it("does not touch a pipe", () => {
    expect(breakShellChain("ls | head -30")).toBe("ls | head -30");
  });
});

// The reason this is not a split(). Every one of these appears in the store.
describe("an && that is not an operator", () => {
  it("inside double quotes", () => {
    expect(breakShellChain('echo "=== a && b ===" && ls')).toBe('echo "=== a && b ===" \n&& ls');
  });

  it("inside single quotes, where nothing is special", () => {
    expect(breakShellChain("echo 'x && y' && ls")).toBe("echo 'x && y' \n&& ls");
  });

  it("inside a quote that contains the other quote", () => {
    expect(breakShellChain(`echo "it's && fine" && ls`)).toBe(`echo "it's && fine" \n&& ls`);
  });

  it("escaped", () => {
    expect(breakShellChain("echo a \\&\\& b && ls")).toBe("echo a \\&\\& b \n&& ls");
  });

  it("inside a command substitution, where it joins the inner command", () => {
    expect(breakShellChain("echo $(a && b) && ls")).toBe("echo $(a && b) \n&& ls");
  });

  // 767 of the 4,553 measured commands carry a heredoc, and this session's own
  // transcripts are full of `python3 - <<'PY' … PY` whose body is Python.
  it("inside a heredoc body", () => {
    const cmd = ["python3 - <<'PY'", 'print("a && b")', "PY", "echo after"].join("\n");
    expect(breakShellChain(cmd)).toBe(cmd);
  });

  it("but still breaks on the line that OPENS the heredoc", () => {
    const cmd = ["cat <<'EOF' > f && echo wrote", "body && more", "EOF"].join("\n");
    expect(breakShellChain(cmd)).toBe(["cat <<'EOF' > f \n&& echo wrote", "body && more", "EOF"].join("\n"));
  });

  it("and resumes after the terminator", () => {
    const cmd = ["cat <<EOF", "a && b", "EOF", "ls && pwd"].join("\n");
    expect(breakShellChain(cmd)).toBe(["cat <<EOF", "a && b", "EOF", "ls \n&& pwd"].join("\n"));
  });

  it("treats <<- and an unquoted word the same way", () => {
    const cmd = ["cat <<-EOF", "\ta && b", "\tEOF", "ls && pwd"].join("\n");
    expect(breakShellChain(cmd)).toBe(["cat <<-EOF", "\ta && b", "\tEOF", "ls \n&& pwd"].join("\n"));
  });

  it("is not fooled by a here-string", () => {
    expect(breakShellChain("jq . <<< '{}' && ls")).toBe("jq . <<< '{}' \n&& ls");
  });
});

describe("a command that already has newlines", () => {
  it("keeps them and does not double them", () => {
    expect(breakShellChain("a \\\n&& b")).toBe("a \\\n&& b");
  });

  it("never starts a line with a break it did not need", () => {
    expect(breakShellChain("&& weird")).toBe("&& weird");
  });
});

// The owner: "mache auch eine newline bei einem ; wie bei && weil das auch eine
// bash new line ist". He is right — 2,503 of 5,444 measured commands carry one.
describe("a semicolon is a newline too", () => {
  it("breaks AFTER itself, because it closes the step rather than opening one", () => {
    expect(breakShellChain("ls -la; echo done")).toBe("ls -la;\necho done");
  });

  it("swallows the space the separator used to need", () => {
    expect(breakShellChain("a ;   b")).toBe("a ;\nb");
  });

  it("mixes with && the way the shell reads them", () => {
    expect(breakShellChain("cd /x && ls; echo done")).toBe("cd /x \n&& ls;\necho done");
  });

  // 400 of the measured commands are a loop header. `for f in a b c\n; do`
  // is not a statement boundary and does not read as one.
  it("leaves a loop header alone", () => {
    expect(breakShellChain("for f in a b; do echo $f; done")).toBe("for f in a b; do echo $f; done");
    expect(breakShellChain("while read x; do echo $x; done")).toBe("while read x; do echo $x; done");
  });

  it("leaves an if header alone", () => {
    expect(breakShellChain("if [ -f x ]; then echo yes; fi")).toBe("if [ -f x ]; then echo yes; fi");
  });

  it("does not split a case terminator down the middle", () => {
    expect(breakShellChain("case $x in a) ls;; esac")).toBe("case $x in a) ls;; esac");
  });

  it("leaves a trailing semicolon where it is, rather than opening an empty line", () => {
    expect(breakShellChain("ls;")).toBe("ls;");
    expect(breakShellChain("ls;   ")).toBe("ls;   ");
  });

  it("is not fooled by a quoted or escaped one", () => {
    expect(breakShellChain('echo "a; b"; ls')).toBe('echo "a; b";\nls');
    // Two backslashes in the SOURCE so ONE reaches the function. The first
    // version of this line wrote `\;`, which JavaScript reads as a plain `;`,
    // so the test asserted about a string the code never saw — and failed
    // correctly, on a command that really does have three statements.
    expect(breakShellChain("echo a\\; b; ls")).toBe("echo a\\; b;\nls");
  });

  it("leaves one inside a substitution to the inner command", () => {
    expect(breakShellChain("echo $(a; b); ls")).toBe("echo $(a; b);\nls");
  });
});
