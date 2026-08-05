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
