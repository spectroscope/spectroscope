// Card 605: environment dumps and network commands in one shell line (design
// section 3 and call B7). The first six cases are the brief's; the rest pin
// the calls made in shellRisk.ts (wrappers, `sh -c`, standard input, hosts
// without a scheme, files the line does not spell).

import { describe, expect, it } from "vitest";
import { shellRisk, type NetworkUse } from "./shellRisk";

const W = "/w";
const dump = (line: string) => shellRisk(line, W).envDump;
const net = (line: string, cwd: string | null = W) => shellRisk(line, cwd).network;
const one = (line: string, cwd: string | null = W): NetworkUse => {
  const uses = net(line, cwd);
  expect(uses, line).toHaveLength(1);
  return uses[0];
};

describe("shellRisk", () => {
  it("environment and keychain dumps", () => {
    const dumps = [
      "env",
      "env | sort",
      "printenv",
      "printenv GITHUB_TOKEN",
      "export -p",
      "export",
      "set",
      "security find-generic-password -s x -w",
      "security find-internet-password -s x",
      "security dump-keychain",
      "gh auth token",
      "aws configure get aws_secret_access_key",
      "aws configure export-credentials",
      "op read op://v/i/f",
      "op item get x",
      "pass show mail",
    ];
    for (const line of dumps) expect(dump(line), line).not.toBeNull();
    const quiet = [
      "env FOO=1 node x.js",
      "set -e",
      "export FOO=1",
      "echo env",
      'echo "printenv"',
      "security list-keychains",
    ];
    for (const line of quiet) expect(dump(line), line).toBeNull();
  });

  it("curl names its host and the files it sends", () => {
    expect(net("curl -X POST https://hooks.example.com/a -d @payload.json")).toEqual([
      { tool: "curl", host: "hooks.example.com", sends: ["/w/payload.json"], sendsNamed: true },
    ]);
    expect(one("curl --data-binary @a https://h.example.com").sends).toEqual(["/w/a"]);
    expect(one("curl -F f=@b https://h.example.com").sends).toEqual(["/w/b"]);
    expect(one("curl -T c https://h.example.com").sends).toEqual(["/w/c"]);
    expect(one("curl --upload-file d https://h.example.com").sends).toEqual(["/w/d"]);
    expect(net("curl https://x.example.org")).toEqual([
      { tool: "curl", host: "x.example.org", sends: [], sendsNamed: true },
    ]);
  });

  it("wget, scp, rsync", () => {
    expect(net("wget --post-file=a.json https://h.example.com")).toEqual([
      { tool: "wget", host: "h.example.com", sends: ["/w/a.json"], sendsNamed: true },
    ]);
    expect(net("scp a.txt b.txt user@h.example.com:/tmp/")).toEqual([
      { tool: "scp", host: "h.example.com", sends: ["/w/a.txt", "/w/b.txt"], sendsNamed: true },
    ]);
    expect(net("scp user@h:/tmp/a .")).toEqual([{ tool: "scp", host: "h", sends: [], sendsNamed: true }]);
    expect(net("rsync -av dist/ deploy@h:/srv/")).toEqual([
      { tool: "rsync", host: "h", sends: ["/w/dist"], sendsNamed: true },
    ]);
    expect(net("rsync -av dist/ deploy@h:/srv/", null)[0].sends).toEqual(["dist/"]);
    expect(net("rsync -av a/ b/")).toEqual([]);
  });

  it("git push and npm publish do not name files", () => {
    expect(net("git push origin main")).toEqual([
      { tool: "git push", host: null, sends: [], sendsNamed: false },
    ]);
    expect(net("npm publish")).toEqual([{ tool: "npm publish", host: null, sends: [], sendsNamed: false }]);
    expect(net("git status")).toEqual([]);
  });

  it("ssh, nc and httpie", () => {
    expect(net("ssh h.example.com uptime")).toEqual([
      { tool: "ssh", host: "h.example.com", sends: [], sendsNamed: true },
    ]);
    expect(net("nc h.example.com 80")).toEqual([
      { tool: "nc", host: "h.example.com", sends: [], sendsNamed: true },
    ]);
    expect(net("http POST https://api.example.com/x < body.json")).toEqual([
      { tool: "http", host: "api.example.com", sends: ["/w/body.json"], sendsNamed: true },
    ]);
  });

  it("quoted and heredoc text is not a command", () => {
    expect(net('echo "curl https://x"')).toEqual([]);
    expect(net("cat > notes.md <<'EOF'\ncurl https://x\nprintenv\nEOF")).toEqual([]);
    expect(dump("cat > notes.md <<'EOF'\ncurl https://x\nprintenv\nEOF")).toBeNull();
    // The heredoc of a network command is text it sends, not a command or a file.
    expect(net("ssh h.example.com bash <<EOF\ncurl -T x https://y.example.com\nEOF")).toEqual([
      { tool: "ssh", host: "h.example.com", sends: [], sendsNamed: true },
    ]);
  });

  it("envDump names the command and its subcommand, the first dump wins", () => {
    expect(dump("printenv GITHUB_TOKEN")).toBe("printenv");
    expect(dump("env | sort")).toBe("env");
    expect(dump("export")).toBe("export");
    expect(dump("export -p")).toBe("export -p");
    expect(dump("set | grep TOKEN")).toBe("set");
    expect(dump("security find-generic-password -s x -w")).toBe("security find-generic-password");
    expect(dump("security -q dump-keychain")).toBe("security dump-keychain");
    expect(dump("gh auth token --hostname github.com")).toBe("gh auth token");
    expect(dump("aws --profile prod configure get region")).toBe("aws configure get");
    expect(dump("op --account a item get x --fields password")).toBe("op item get");
    expect(dump("pass show -c mail")).toBe("pass show");
    expect(dump("printenv HOME; set")).toBe("printenv");
    expect(dump("env -u HOME")).toBe("env");
    expect(dump("env FOO=1")).toBe("env");
    for (const line of ["gh auth status", "aws configure list", "op item list", "pass insert x", "set --"])
      expect(dump(line), line).toBeNull();
  });

  it("the command name skips assignments, reserved words and wrappers", () => {
    const h = { tool: "curl", host: "h.example.com", sends: [], sendsNamed: true };
    for (const line of [
      "FOO=1 curl https://h.example.com",
      "if curl -fs https://h.example.com; then echo up; fi",
      "! curl -fs https://h.example.com",
      "sudo -u root curl https://h.example.com",
      "timeout 10 curl https://h.example.com",
      "timeout -s KILL 10 curl https://h.example.com",
      "nohup curl https://h.example.com",
      "nice -n 5 curl https://h.example.com",
      "env -i FOO=1 curl https://h.example.com",
      "/usr/bin/curl https://h.example.com",
    ]) {
      expect(net(line), line).toEqual([h]);
      expect(dump(line), line).toBeNull();
    }
    expect(dump("sudo printenv")).toBe("printenv");
    expect(dump("sudo -E env")).toBe("env");
    for (const line of [
      "command -v curl",
      "which curl",
      "type ssh",
      "./curl https://h.example.com",
      "$CURL x",
    ])
      expect(net(line), line).toEqual([]);
  });

  it("a shell started with -c is read as a line of its own", () => {
    expect(net('bash -lc "curl -T a.txt https://h.example.com"')).toEqual([
      { tool: "curl", host: "h.example.com", sends: ["/w/a.txt"], sendsNamed: true },
    ]);
    expect(dump("sh -c 'printenv | sort'")).toBe("printenv");
    expect(dump("bash -euo pipefail -c env")).toBe("env");
    expect(net('bash -c "$CMD"')).toEqual([]);
    expect(net("bash deploy.sh h.example.com")).toEqual([]);
  });

  it("a host without a scheme, with a user or with a port", () => {
    expect(one("curl localhost:8080/health").host).toBe("localhost");
    expect(one("curl http://localhost:3000/x").host).toBe("localhost");
    expect(one("curl http://127.0.0.1:8080").host).toBe("127.0.0.1");
    expect(one("curl http://[::1]:8080/").host).toBe("[::1]");
    expect(one("curl -sS example.com/api").host).toBe("example.com");
    expect(one("wget h.example.com/f.tgz").host).toBe("h.example.com");
    expect(one("http POST api.example.com/x name=a").host).toBe("api.example.com");
    const userinfo = "https://u" + ":" + "p" + "@h.example.com:8443/x";
    expect(one(`curl ${userinfo}`).host).toBe("h.example.com");
    // Option values are not the target: a header, a referer, a proxy, a method.
    expect(
      one(
        'curl -X POST -H "Referer:https://a.example" -e https://r.example -x http://p.example:3128 b.example.com',
      ).host,
    ).toBe("b.example.com");
    expect(one("curl --url https://u.example.com -o out.json").host).toBe("u.example.com");
    expect(one("curl -sS").host).toBeNull();
  });

  it("more ways curl sends a file", () => {
    expect(one("curl --data-urlencode name@f.txt https://h.example.com").sends).toEqual(["/w/f.txt"]);
    expect(one("curl --data-urlencode a=b@c https://h.example.com").sends).toEqual([]);
    expect(one('curl -F "f=<g.txt" https://h.example.com').sends).toEqual(["/w/g.txt"]);
    expect(one('curl -F "f=@b.txt;type=text/plain" https://h.example.com').sends).toEqual(["/w/b.txt"]);
    expect(one("curl --json @j.json https://h.example.com").sends).toEqual(["/w/j.json"]);
    expect(one("curl -sSd@c.json https://h.example.com").sends).toEqual(["/w/c.json"]);
    expect(one("curl -T a -T b -T a https://h.example.com").sends).toEqual(["/w/a", "/w/b"]);
    expect(one("curl --data-raw @x https://h.example.com").sends).toEqual([]);
    expect(one("curl -d name=x https://h.example.com").sends).toEqual([]);
    expect(one("curl -o out.json https://h.example.com").sends).toEqual([]);
  });

  it("httpie file items", () => {
    expect(one("http -f POST https://h.example.com/u file@report.pdf name=x").sends).toEqual([
      "/w/report.pdf",
    ]);
    expect(one("http POST https://h.example.com @data.xml").sends).toEqual(["/w/data.xml"]);
    expect(one("http PUT https://h.example.com cfg:=@c.json note=@n.txt").sends).toEqual([
      "/w/c.json",
      "/w/n.txt",
    ]);
    expect(one("http https://h.example.com Accept:application/json email=a@b.example").sends).toEqual([]);
  });

  it("files the line does not spell", () => {
    expect(net('curl -T "$F" https://h.example.com')).toEqual([
      { tool: "curl", host: "h.example.com", sends: [], sendsNamed: false },
    ]);
    expect(one("curl -d @$BODY https://h.example.com").sendsNamed).toBe(false);
    expect(one('curl -F "f=@$F" https://h.example.com').sendsNamed).toBe(false);
    expect(one("wget --post-file=$F https://h.example.com").sendsNamed).toBe(false);
    // Inline data whose value is unknown is not a file.
    expect(one('curl -d "$DATA" https://h.example.com').sendsNamed).toBe(true);
    expect(net("scp a.txt $MORE h:/tmp/")).toEqual([
      { tool: "scp", host: "h", sends: ["/w/a.txt"], sendsNamed: false },
    ]);
    expect(net("rsync -a --files-from=list.txt . h:/srv/")).toEqual([
      { tool: "rsync", host: "h", sends: ["/w"], sendsNamed: false },
    ]);
    expect(net("sftp deploy@h.example.com")).toEqual([
      { tool: "sftp", host: "h.example.com", sends: [], sendsNamed: false },
    ]);
    expect(one("sftp h.example.com < cmds.txt").sends).toEqual([]);
  });

  it("standard input of a network command", () => {
    expect(net("cat a.txt | nc h.example.com 80")).toEqual([
      { tool: "nc", host: "h.example.com", sends: [], sendsNamed: false },
    ]);
    expect(one("tar c dist | ssh h.example.com 'tar x'").sendsNamed).toBe(false);
    expect(one("cat x | curl -d @- https://h.example.com").sendsNamed).toBe(false);
    expect(one("git log | http POST https://h.example.com").sendsNamed).toBe(false);
    expect(one("curl -T - https://h.example.com < big.bin").sends).toEqual(["/w/big.bin"]);
    expect(one("ssh h.example.com 'cat > /tmp/x' < a.txt").sends).toEqual(["/w/a.txt"]);
    expect(one("ncat --send-only h.example.com 9000 0< f.bin").sends).toEqual(["/w/f.bin"]);
    expect(one("ssh h.example.com 'cat <&3' 3< a.txt").sends).toEqual([]);
    // curl without `@-` or `-T -` does not read its input, httpie with -I neither.
    expect(one("curl https://h.example.com < a.json").sends).toEqual([]);
    expect(one("echo x | curl https://h.example.com").sendsNamed).toBe(true);
    expect(one("http -I POST https://h.example.com < b.json").sends).toEqual([]);
    // A heredoc or a here-string is text from the line, not a file.
    expect(net("curl -d @- https://h.example.com <<EOF\n{}\nEOF")).toEqual([
      { tool: "curl", host: "h.example.com", sends: [], sendsNamed: true },
    ]);
    expect(one("nc h.example.com 80 <<< ping").sendsNamed).toBe(true);
  });

  it("scp and rsync read their options and stay local without a remote side", () => {
    expect(net("scp a b")).toEqual([]);
    expect(one("rsync -av --exclude node_modules src/ h:/srv/").sends).toEqual(["/w/src"]);
    expect(one('rsync -e "ssh -p 2222" a/ h:/srv/').sends).toEqual(["/w/a"]);
    expect(one("scp -P 2222 -i id_deploy a.txt h:/tmp").sends).toEqual(["/w/a.txt"]);
    expect(net("scp h1:/a h2:/b")).toEqual([{ tool: "scp", host: "h1", sends: [], sendsNamed: true }]);
    expect(one("rsync -a ./a:b h:/srv/").sends).toEqual(["/w/a:b"]);
    expect(one("rsync -a src/ rsync://mirror.example.com/mod/").host).toBe("mirror.example.com");
    expect(one("rsync -a src/ backup::mod").host).toBe("backup");
    expect(one("scp a.txt $DEST").sends).toEqual(["/w/a.txt"]);
  });

  it("nc listening names no host", () => {
    expect(net("nc -l 8080")).toEqual([{ tool: "nc", host: null, sends: [], sendsNamed: true }]);
    expect(one("nc -w 3 h.example.com 22").host).toBe("h.example.com");
    expect(one("ssh -p 2222 -i id_deploy deploy@h.example.com uptime").host).toBe("h.example.com");
  });

  it("git push and npm publish name the host when the line spells it", () => {
    expect(one("git push git@github.com:o/r.git main").host).toBe("github.com");
    expect(one("git push origin HEAD:main").host).toBeNull();
    expect(one("git push --repo=https://git.example.com/r.git").host).toBe("git.example.com");
    expect(net("git -C repo push https://git.example.com/r.git")).toEqual([
      { tool: "git push", host: "git.example.com", sends: [], sendsNamed: false },
    ]);
    expect(one("npm publish --registry https://npm.example.com").host).toBe("npm.example.com");
    expect(one("npm --registry=https://npm.example.com publish --tag next").host).toBe("npm.example.com");
    for (const line of ["git fetch origin", "git log --oneline", "npm install", "npm run publish"])
      expect(net(line), line).toEqual([]);
  });

  it("paths resolve against cwd and a cd in the line is not followed", () => {
    expect(one("cd sub && curl -T a https://h.example.com").sends).toEqual(["/w/a"]);
    expect(one("curl -T a https://h.example.com", null).sends).toEqual(["a"]);
    expect(one("curl -T ~/x https://h.example.com").sends).toEqual(["~/x"]);
    expect(one("curl -T ../up/x https://h.example.com").sends).toEqual(["/up/x"]);
    expect(one("curl -T /etc/hosts https://h.example.com").sends).toEqual(["/etc/hosts"]);
  });

  it("several commands and subshells in one line", () => {
    const r = shellRisk("(cd x && env) ; curl https://a.example.com && scp f h:/tmp | cat", W);
    expect(r.envDump).toBe("env");
    expect(r.network).toEqual([
      { tool: "curl", host: "a.example.com", sends: [], sendsNamed: true },
      { tool: "scp", host: "h", sends: ["/w/f"], sendsNamed: true },
    ]);
    expect(shellRisk("", W)).toEqual({ envDump: null, network: [] });
  });

  it("malformed lines do not throw", () => {
    const lines = [
      "curl -d",
      "curl -T",
      "scp",
      "rsync -e",
      "git",
      "git push --repo",
      "npm publish --registry",
      "ssh",
      "nc -l",
      "http",
      "timeout",
      "sudo --",
      "env -u",
      "bash -c",
      "'unterminated curl https://h.example.com",
      "curl $(",
      "a | | b ;; && )",
      "<< EOF",
    ];
    for (const line of lines) expect(() => shellRisk(line, W), line).not.toThrow();
    expect(net("sudo --")).toEqual([]);
  });
});
