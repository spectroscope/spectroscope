// Card 604: the shell heuristic. One case per rule row of section 2 of the
// design (docs/superpowers/specs/2026-11-09-files-tab-design.md), then the
// traps. Every case pins kind, path and the text field the view shows.

import { describe, expect, it } from "vitest";
import { shellTouches, type ShellTouch } from "./shell";

const W = "/w";
const touches = (command: string, cwd: string | null = W) => shellTouches(command, cwd).touches;
const short = (t: ShellTouch) => ({ path: t.path, kind: t.kind, folder: t.folder });
const shortAll = (command: string, cwd: string | null = W) => touches(command, cwd).map(short);

describe("shellTouches rules", () => {
  it("echoRedirectOverwritesWithItsText", () => {
    expect(touches("echo hi > out.txt")).toEqual([
      {
        written: "out.txt",
        path: "/w/out.txt",
        folder: false,
        kind: "overwrite",
        reason: "redirect > out.txt",
        content: "hi\n",
      },
    ]);
    expect(touches("printf 'a' >> log")).toEqual([
      {
        written: "log",
        path: "/w/log",
        folder: false,
        kind: "append",
        reason: "redirect >> log",
        appended: "a",
      },
    ]);
  });

  it("heredocIntoAFileCarriesTheBody", () => {
    const got = touches("cat > a.md <<'EOF'\n# T\nrm -rf /\nEOF");
    expect(got).toEqual([
      {
        written: "a.md",
        path: "/w/a.md",
        folder: false,
        kind: "overwrite",
        reason: "heredoc > a.md",
        content: "# T\nrm -rf /\n",
      },
    ]);
    expect(got.some((t) => t.kind === "delete")).toBe(false);
  });

  it("teeHeredocAppends", () => {
    expect(touches("tee -a f <<EOF\nx\nEOF")).toEqual([
      { written: "f", path: "/w/f", folder: false, kind: "append", reason: "tee -a f", appended: "x\n" },
    ]);
  });

  it("fileVerbs", () => {
    expect(shortAll("cp a b")).toEqual([
      { path: "/w/a", kind: "read", folder: false },
      { path: "/w/b", kind: "write", folder: false },
    ]);
    expect(shortAll("mv a b")).toEqual([
      { path: "/w/a", kind: "delete", folder: false },
      { path: "/w/b", kind: "create", folder: false },
    ]);
    expect(shortAll("rm f")).toEqual([{ path: "/w/f", kind: "delete", folder: false }]);
    expect(shortAll("mkdir -p d")).toEqual([{ path: "/w/d", kind: "create", folder: true }]);
    expect(shortAll("touch f")).toEqual([{ path: "/w/f", kind: "create", folder: false }]);
  });

  it("sedInPlaceCarriesASingleSubstitution", () => {
    expect(touches("sed -i '' 's/foo/bar/' x.ts")).toEqual([
      {
        written: "x.ts",
        path: "/w/x.ts",
        folder: false,
        kind: "change",
        reason: "sed -i x.ts",
        replaced: [{ old: "foo", new: "bar" }],
      },
    ]);
    const two = touches("sed -i -e 's/a/b/' -e 's/c/d/' x");
    expect(two.map(short)).toEqual([{ path: "/w/x", kind: "change", folder: false }]);
    expect(two[0].replaced).toBeUndefined();
  });

  it("gitRestoreNamesItsFiles", () => {
    expect(shortAll("git checkout -- a b")).toEqual([
      { path: "/w/a", kind: "change", folder: false },
      { path: "/w/b", kind: "change", folder: false },
    ]);
    expect(shortAll("git apply p.diff")).toEqual([
      { path: "/w/p.diff", kind: "read", folder: false },
      { path: "/w", kind: "unknown", folder: true },
    ]);
    expect(shortAll("git apply p.diff", null)).toEqual([
      { path: "p.diff", kind: "read", folder: false },
      { path: ".", kind: "unknown", folder: true },
    ]);
  });

  it("packageManagersChangeTheirManifest", () => {
    expect(shortAll("npm install x")).toEqual([
      { path: "/w/package.json", kind: "change", folder: false },
      { path: "/w/package-lock.json", kind: "change", folder: false },
    ]);
    expect(shortAll("uv add x")).toEqual([
      { path: "/w/pyproject.toml", kind: "change", folder: false },
      { path: "/w/uv.lock", kind: "change", folder: false },
    ]);
    expect(shortAll("cargo add x")).toEqual([
      { path: "/w/Cargo.toml", kind: "change", folder: false },
      { path: "/w/Cargo.lock", kind: "change", folder: false },
    ]);
  });

  it("readVerbsRead", () => {
    expect(shortAll("cat a | grep x")).toEqual([{ path: "/w/a", kind: "read", folder: false }]);
    expect(shortAll("head -5 b")).toEqual([{ path: "/w/b", kind: "read", folder: false }]);
    expect(shortAll("wc -l c")).toEqual([{ path: "/w/c", kind: "read", folder: false }]);
    expect(shortAll("ls d")).toEqual([{ path: "/w/d", kind: "read", folder: false }]);
  });

  it("aGrepWithoutAPathReadsItsFolder", () => {
    // A search, not a read of the folder's files (card 605).
    expect(touches("rg needle")).toEqual([
      { written: ".", path: "/w", folder: true, kind: "read", reason: 'rg "needle"', search: true },
    ]);
    expect(touches("grep -rn needle")).toEqual([
      { written: ".", path: "/w", folder: true, kind: "read", reason: 'grep "needle"', search: true },
    ]);
    expect(touches("grep -r -e needle")[0].reason).toBe('grep "needle"');
    expect(shortAll("cd web && rg needle")).toEqual([{ path: "/w/web", kind: "read", folder: true }]);
    expect(shortAll("rg needle", null)).toEqual([{ path: ".", kind: "read", folder: true }]);
    // Input fed on stdin is what they search, not the folder.
    expect(touches("git log | rg fix")).toEqual([]);
    expect(shortAll("rg needle < a.txt")).toEqual([{ path: "/w/a.txt", kind: "read", folder: false }]);
    // grep without -r and without a file reads its input, not the folder.
    expect(touches("grep needle")).toEqual([]);
    // With a path, the path.
    expect(shortAll("rg needle src")).toEqual([{ path: "/w/src", kind: "read", folder: false }]);
    // An unknown folder names nothing.
    expect(touches("cd $DIR && rg needle")).toEqual([]);
  });

  it("aFileReadByGrepOrLsIsNotAFolder", () => {
    // The live check of 2026-11-09 drew these as folders: NEXT-SESSION.md/.
    expect(shortAll("grep foo NEXT-SESSION.md")).toEqual([
      { path: "/w/NEXT-SESSION.md", kind: "read", folder: false },
    ]);
    expect(shortAll("grep -rn foo src")).toEqual([{ path: "/w/src", kind: "read", folder: false }]);
    expect(shortAll("ls -la /tmp/run/e08e93de.jsonl")).toEqual([
      { path: "/tmp/run/e08e93de.jsonl", kind: "read", folder: false },
    ]);
    expect(shortAll("rg foo notes.md")).toEqual([{ path: "/w/notes.md", kind: "read", folder: false }]);
    // The positive twin: where the command line says folder, it stays one.
    expect(shortAll("ls src/")).toEqual([{ path: "/w/src", kind: "read", folder: true }]);
    expect(shortAll("ls .")).toEqual([{ path: "/w", kind: "read", folder: true }]);
    expect(shortAll("ls ..", "/w/web")).toEqual([{ path: "/w", kind: "read", folder: true }]);
    expect(shortAll("grep -rn foo src/")).toEqual([{ path: "/w/src", kind: "read", folder: true }]);
    expect(shortAll("mkdir out")).toEqual([{ path: "/w/out", kind: "create", folder: true }]);
  });

  it("aScriptIsNamedWithUnknownEffect", () => {
    expect(shellTouches("python3 scripts/gen.py out/", W)).toEqual({
      touches: [
        {
          written: "scripts/gen.py",
          path: "/w/scripts/gen.py",
          folder: false,
          kind: "read",
          reason: "script python3",
        },
        { written: "out/", path: "/w/out", folder: true, kind: "unknown", reason: "script argument out/" },
      ],
      script: "/w/scripts/gen.py",
      inline: false,
    });
    for (const [command, script] of [
      ["node x.js", "/w/x.js"],
      ["bash x.sh", "/w/x.sh"],
      ["./run.sh", "/w/run.sh"],
    ]) {
      const reading = shellTouches(command, W);
      expect(reading.script).toBe(script);
      expect(reading.inline).toBe(false);
      expect(reading.touches.map(short)).toEqual([{ path: script, kind: "read", folder: false }]);
    }
  });

  it("inlineScriptHasNoLink", () => {
    const inline = {
      touches: [{ written: ".", path: "/w", folder: true, kind: "unknown", reason: "inline script" }],
      script: null,
      inline: true,
    };
    expect(shellTouches(`python -c "open('x','w')"`, W)).toEqual(inline);
    expect(shellTouches("python3 <<EOF\nopen('x', 'w').write('y')\nEOF", W)).toEqual(inline);
  });

  it("quietCommandsTouchNothing", () => {
    for (const command of ["git status", "git log", "pwd", "which node", "echo hi"]) {
      expect(shellTouches(command, W)).toEqual({ touches: [], script: null, inline: false });
    }
    // The positive twin: the same verbs with a redirect do name a file.
    expect(shortAll("git log > log.txt")).toEqual([{ path: "/w/log.txt", kind: "overwrite", folder: false }]);
  });
});

describe("shellTouches traps", () => {
  it("a file descriptor duplication names no file", () => {
    expect(touches("npm test 2>&1")).toEqual([]);
  });

  it("a redirect to /dev/null names no file", () => {
    expect(touches("git fetch > /dev/null 2>&1")).toEqual([]);
  });

  it("a quoted > is text", () => {
    expect(touches('echo "a > b"')).toEqual([]);
  });

  it("cd moves the base for the rest of the line", () => {
    expect(shortAll("cd web && echo x > f")).toEqual([
      { path: "/w/web/f", kind: "overwrite", folder: false },
    ]);
  });

  it("cd back resolves against the moved base", () => {
    expect(shortAll("cd web; cd ..; touch g")).toEqual([{ path: "/w/g", kind: "create", folder: false }]);
    // The line above gives the same answer with no cd handling at all, so this
    // one carries the bite: a touch between the two moves lands inside web.
    expect(shortAll("cd web; touch a; cd ..; touch g")).toEqual([
      { path: "/w/web/a", kind: "create", folder: false },
      { path: "/w/g", kind: "create", folder: false },
    ]);
  });

  it("a quoted path keeps its space", () => {
    expect(touches('cp "my file.txt" b')[0]).toEqual({
      written: "my file.txt",
      path: "/w/my file.txt",
      folder: false,
      kind: "read",
      reason: "cp from my file.txt",
    });
  });

  it("a pipe into tee writes the file", () => {
    expect(shortAll("ls | tee list.txt")).toEqual([
      { path: "/w/list.txt", kind: "overwrite", folder: false },
    ]);
  });

  it("an unresolved variable is skipped", () => {
    expect(touches("echo x > $OUT")).toEqual([]);
    expect(touches("touch ${X}/a")).toEqual([]);
    expect(shortAll("touch ${X}/a b")).toEqual([{ path: "/w/b", kind: "create", folder: false }]);
  });

  it("a path outside the workspace is kept in full", () => {
    expect(shortAll("touch /tmp/x")).toEqual([{ path: "/tmp/x", kind: "create", folder: false }]);
  });
});

describe("shellTouches beyond the brief's list", () => {
  it("arithmetic is not a redirect", () => {
    expect(touches("(( n > 5 )) && echo big")).toEqual([]);
    expect(shortAll("(( n > 5 )) && touch done")).toEqual([
      { path: "/w/done", kind: "create", folder: false },
    ]);
    expect(touches("[[ a > b ]] && echo yes")).toEqual([]);
  });

  it("a BSD ls flag does not swallow the folder", () => {
    expect(shortAll("ls -w d")).toEqual([{ path: "/w/d", kind: "read", folder: false }]);
  });

  it("a copy into . lands inside the folder", () => {
    expect(shortAll("cp ../x .", "/w/web")).toEqual([
      { path: "/w/x", kind: "read", folder: false },
      { path: "/w/web/x", kind: "write", folder: false },
    ]);
    expect(shortAll("mv a b dist/")).toEqual([
      { path: "/w/a", kind: "delete", folder: false },
      { path: "/w/dist/a", kind: "create", folder: false },
      { path: "/w/b", kind: "delete", folder: false },
      { path: "/w/dist/b", kind: "create", folder: false },
    ]);
  });

  it("links, archives and patches", () => {
    expect(shortAll("ln -s ../shared/a.ts a.ts")).toEqual([
      { path: "/w/a.ts", kind: "create", folder: false },
    ]);
    expect(shortAll("unzip -q x.zip -d out")).toEqual([
      { path: "/w/x.zip", kind: "read", folder: false },
      { path: "/w/out", kind: "unknown", folder: true },
    ]);
    expect(shortAll("tar xzf a.tgz -C out")).toEqual([
      { path: "/w/a.tgz", kind: "read", folder: false },
      { path: "/w/out", kind: "unknown", folder: true },
    ]);
    expect(shortAll("tar -czf b.tgz src")).toEqual([
      { path: "/w/src", kind: "read", folder: false },
      { path: "/w/b.tgz", kind: "write", folder: false },
    ]);
    expect(shortAll("patch -p1 < fix.diff")).toEqual([
      { path: "/w/fix.diff", kind: "read", folder: false },
      { path: "/w", kind: "unknown", folder: true },
    ]);
    expect(shortAll("patch a.c fix.diff")).toEqual([
      { path: "/w/fix.diff", kind: "read", folder: false },
      { path: "/w/a.c", kind: "change", folder: false },
    ]);
  });

  it("git commands that move the worktree, and the ones that do not", () => {
    expect(shortAll("git restore --staged a")).toEqual([]);
    expect(shortAll("git restore a")).toEqual([{ path: "/w/a", kind: "change", folder: false }]);
    expect(shortAll("git checkout -b feature")).toEqual([]);
    expect(shortAll("git switch main")).toEqual([{ path: "/w", kind: "unknown", folder: true }]);
    expect(shortAll("git -C web pull")).toEqual([{ path: "/w/web", kind: "unknown", folder: true }]);
    expect(shortAll("git rm --cached a")).toEqual([]);
    expect(shortAll("git mv a b")).toEqual([
      { path: "/w/a", kind: "delete", folder: false },
      { path: "/w/b", kind: "create", folder: false },
    ]);
    expect(shortAll("git reset --hard")).toEqual([{ path: "/w", kind: "unknown", folder: true }]);
    expect(shortAll("git stash list")).toEqual([]);
  });

  it("package managers: lockfile only, folder options, global installs", () => {
    expect(shortAll("npm install")).toEqual([
      { path: "/w/package-lock.json", kind: "change", folder: false },
    ]);
    expect(shortAll("npm --prefix web install -D x")).toEqual([
      { path: "/w/web/package.json", kind: "change", folder: false },
      { path: "/w/web/package-lock.json", kind: "change", folder: false },
    ]);
    expect(shortAll("npm install -g x")).toEqual([]);
    expect(shortAll("yarn")).toEqual([{ path: "/w/yarn.lock", kind: "change", folder: false }]);
    expect(shortAll("pip install -r requirements.txt")).toEqual([
      { path: "/w/requirements.txt", kind: "read", folder: false },
    ]);
  });

  it("pattern verbs skip their pattern", () => {
    expect(shortAll("grep -rn foo src/")).toEqual([{ path: "/w/src", kind: "read", folder: true }]);
    expect(shortAll("rg -e foo lib")).toEqual([{ path: "/w/lib", kind: "read", folder: false }]);
    expect(shortAll("jq --arg k v '.x' a.json")).toEqual([
      { path: "/w/a.json", kind: "read", folder: false },
    ]);
    expect(shortAll("sed -n '1,5p' f")).toEqual([{ path: "/w/f", kind: "read", folder: false }]);
    expect(shortAll("tail -n +10 g")).toEqual([{ path: "/w/g", kind: "read", folder: false }]);
    expect(shortAll("find src -name '*.ts'")).toEqual([{ path: "/w/src", kind: "read", folder: true }]);
    expect(shortAll("wc -l < h")).toEqual([{ path: "/w/h", kind: "read", folder: false }]);
  });

  it("test runners and wrappers reach the command they run", () => {
    expect(shortAll("npx vitest run src/files/shell.test.ts")).toEqual([
      { path: "/w/src/files/shell.test.ts", kind: "read", folder: false },
    ]);
    expect(shortAll("python3 -m pytest tests/test_a.py::test_x")).toEqual([
      { path: "/w/tests/test_a.py", kind: "read", folder: false },
    ]);
    expect(shellTouches("timeout 60 env DEBUG=1 node gen.mjs", W).script).toBe("/w/gen.mjs");
    expect(shellTouches("uv run scripts/x.py", W).script).toBe("/w/scripts/x.py");
  });

  it("other inline forms", () => {
    for (const command of [
      "bash -lc 'make all'",
      "node -e 'x()'",
      "cat a.py | python3",
      "python3 - <<EOF\nx\nEOF",
    ]) {
      const reading = shellTouches(command, W);
      expect(reading.inline).toBe(true);
      expect(reading.script).toBeNull();
      expect(reading.touches.filter((t) => t.reason === "inline script").map(short)).toEqual([
        { path: "/w", kind: "unknown", folder: true },
      ]);
    }
  });

  it("a subshell keeps its cd to itself", () => {
    expect(shortAll("(cd web && touch a); touch b")).toEqual([
      { path: "/w/web/a", kind: "create", folder: false },
      { path: "/w/b", kind: "create", folder: false },
    ]);
  });

  it("stderr redirects carry no text, stdout redirects do", () => {
    expect(touches("echo hi 2> err.log")).toEqual([
      {
        written: "err.log",
        path: "/w/err.log",
        folder: false,
        kind: "overwrite",
        reason: "redirect 2> err.log",
      },
    ]);
    expect(touches("echo -n hi &> both.log")[0].content).toBe("hi");
  });

  it("a null cwd keeps paths as written and still follows cd", () => {
    expect(shortAll("touch a; cd web; touch b; cd ..; cd ..; touch c", null)).toEqual([
      { path: "a", kind: "create", folder: false },
      { path: "web/b", kind: "create", folder: false },
      { path: "../c", kind: "create", folder: false },
    ]);
  });
});

describe("shellTouches review fixes", () => {
  it("a dotted operand without -- is a branch or tag, not a changed file", () => {
    const repo = [{ path: "/w", kind: "unknown", folder: true }];
    expect(shortAll("git checkout release.x")).toEqual(repo);
    expect(shortAll("git checkout v1.x")).toEqual(repo);
    expect(shortAll("git checkout main -- src/a.ts")).toEqual([
      { path: "/w/src/a.ts", kind: "change", folder: false },
    ]);
    expect(shortAll("git checkout .")).toEqual([{ path: "/w", kind: "change", folder: true }]);
  });

  it("a lost base drops relative paths and keeps absolute ones", () => {
    expect(touches("cd $DIR && touch a && touch /tmp/b")).toEqual([
      { written: "/tmp/b", path: "/tmp/b", folder: false, kind: "create", reason: "touch /tmp/b" },
    ]);
    expect(touches("cd - && touch a")).toEqual([]);
    expect(touches("cd && touch a")).toEqual([]);
    expect(touches("cd ~ && touch a")).toEqual([]);
    expect(shortAll("cd $DIR && cat ~/notes.md")).toEqual([
      { path: "~/notes.md", kind: "read", folder: false },
    ]);
    expect(shortAll("cd $DIR && cd /tmp && touch a")).toEqual([
      { path: "/tmp/a", kind: "create", folder: false },
    ]);
    expect(touches("cd $DIR && python3 -c 'x()'")).toEqual([]);
    expect(touches("git -C $DIR pull")).toEqual([]);
    expect(touches("npm --prefix $X install y")).toEqual([]);
    // The loss ends with the subshell that caused it.
    expect(shortAll("(cd $DIR && touch a); touch b")).toEqual([
      { path: "/w/b", kind: "create", folder: false },
    ]);
  });

  it("a frozen install writes neither manifest nor lockfile", () => {
    for (const command of [
      "npm install --frozen-lockfile",
      "yarn install --frozen-lockfile",
      "pnpm install --frozen-lockfile",
      "yarn install --immutable",
      "yarn --frozen-lockfile",
      "uv sync --locked",
      "uv sync --frozen",
    ]) {
      expect(touches(command)).toEqual([]);
    }
    expect(shortAll("uv add --frozen x")).toEqual([
      { path: "/w/pyproject.toml", kind: "change", folder: false },
    ]);
    // The positive twin: the same install without the flag names its lockfile.
    expect(shortAll("pnpm install")).toEqual([{ path: "/w/pnpm-lock.yaml", kind: "change", folder: false }]);
  });
});
