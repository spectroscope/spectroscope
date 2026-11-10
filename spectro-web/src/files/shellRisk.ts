// Card 605: environment dumps and network commands in one shell line, for the
// files report (design section 3 and call B7). It reads the simple commands of
// the shell heuristic's tokenizer (shellTokens.ts), so quoted text and heredoc
// bodies are never commands. A `cd` inside the line is not followed: every path
// resolves against `cwd`. Command substitutions are not read either.

import { resolvePath } from "./paths";
import { segments, type Segment, type Word } from "./shellTokens";

export interface NetworkUse {
  tool: string; // "curl", "git push", "npm publish", ...
  host: string | null; // as written, without user and port; null when the line does not name it
  sends: string[]; // local files the command sends, resolved against cwd
  sendsNamed: boolean; // false when it also sends files the line does not name (B7)
}

export interface ShellRisk {
  envDump: string | null; // the first command that printed the environment or a stored secret
  network: NetworkUse[];
}

export function shellRisk(command: string, cwd: string | null): ShellRisk {
  const out: ShellRisk = { envDump: null, network: [] };
  readLine(command, cwd, out, 0);
  return out;
}

function readLine(line: string, cwd: string | null, out: ShellRisk, depth: number): void {
  for (const item of segments(line)) if (item !== "(" && item !== ")") run(item.words, item, cwd, out, depth);
}

// The command name.

const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "while", "until", "do"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The words from the command name on: reserved words and `NAME=value` assignments dropped. */
function commandWords(words: Word[]): Word[] {
  let k = 0;
  while (k < words.length && (RESERVED.has(words[k].text) || ASSIGNMENT.test(words[k].text))) k++;
  return words.slice(k);
}

/** A bare name, or the base name of an absolute path; a relative path is a local script. */
function commandName(text: string): string | null {
  if (!text.includes("/")) return text;
  return text.startsWith("/") ? (text.split("/").pop() ?? null) : null;
}

function run(words: Word[], seg: Segment, cwd: string | null, out: ShellRisk, depth: number): void {
  const [head, ...args] = commandWords(words);
  if (!head || head.dynamic || depth > 4) return;
  const name = commandName(head.text);
  if (name === null) return;
  if (name === "env") {
    const rest = parse(args, ENV).operands;
    if (commandWords(rest).length === 0) dumped(out, "env");
    else run(rest, seg, cwd, out, depth + 1);
    return;
  }
  const wrapper = WRAPPERS.get(name);
  if (wrapper) {
    const p = parse(args, wrapper);
    if (name === "command" && has(p, "-v", "-V")) return; // a lookup, not a run
    return run(p.operands.slice(wrapper.skip ?? 0), seg, cwd, out, depth + 1);
  }
  if (SHELLS.has(name)) {
    const p = parse(args, SHELL);
    const script = p.operands[0];
    if (has(p, "-c") && script && !script.dynamic) readLine(script.text, cwd, out, depth + 1);
    return;
  }
  const dump = dumpOf(name, args);
  if (dump !== null) dumped(out, dump);
  const found = NETWORK.get(name)?.(args, seg, cwd);
  if (found) out.network.push(found);
}

function dumped(out: ShellRisk, what: string): void {
  if (out.envDump === null) out.envDump = what;
}

// Options: a small getopt that keeps every option in order (curl repeats -T and -d).

interface Spec {
  short?: string; // short options that take a value
  long?: string[]; // long options that take a value
  posix?: boolean; // the first operand ends the options
  skip?: number; // wrappers: operands to drop before the command (the duration of `timeout`)
}
interface Parsed {
  options: { name: string; value: Word | null }[];
  operands: Word[];
}

const part = (w: Word, text: string): Word => ({ text, dynamic: w.dynamic, glob: w.glob });

function parse(args: Word[], spec: Spec): Parsed {
  const options: Parsed["options"] = [];
  const operands: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const t = a.text;
    if (t === "--") {
      operands.push(...args.slice(k + 1));
      break;
    }
    // A dynamic word that starts with `-` is an option with an unknown value (`--post-file=$F`).
    if (!t.startsWith("-") || t === "-") {
      if (spec.posix) {
        operands.push(...args.slice(k));
        break;
      }
      operands.push(a);
    } else if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq < 0 ? t : t.slice(0, eq);
      const takes = spec.long?.includes(name.slice(2)) ?? false;
      options.push({ name, value: eq >= 0 ? part(a, t.slice(eq + 1)) : takes ? (args[++k] ?? null) : null });
    } else {
      for (let q = 1; q < t.length; q++) {
        if (!spec.short?.includes(t[q])) {
          options.push({ name: "-" + t[q], value: null });
          continue;
        }
        const value = q + 1 < t.length ? part(a, t.slice(q + 1)) : (args[++k] ?? null);
        options.push({ name: "-" + t[q], value });
        break;
      }
    }
  }
  return { options, operands };
}

const has = (p: Parsed, ...names: string[]) => p.options.some((o) => names.includes(o.name));
const values = (p: Parsed, ...names: string[]): Word[] =>
  p.options.flatMap((o) => (o.value && names.includes(o.name) ? [o.value] : []));

const ENV: Spec = { short: "uCS", long: ["unset", "chdir", "split-string"], posix: true };
const WRAPPERS = new Map<string, Spec>([
  ["sudo", { short: "ugpChDrtU", long: ["user", "group", "prompt", "chdir", "role", "type"], posix: true }],
  ["nohup", { posix: true }],
  ["time", { posix: true }],
  ["exec", { short: "a", posix: true }],
  ["command", { posix: true }],
  ["nice", { short: "n", long: ["adjustment"], posix: true }],
  ["timeout", { short: "sk", long: ["signal", "kill-after"], posix: true, skip: 1 }],
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL: Spec = { short: "o", long: ["rcfile", "init-file"], posix: true };

// Environment and keychain dumps (design section 3): the command printed
// variables or a stored secret to its output, which the model reads.

const SECURITY = new Set(["find-generic-password", "find-internet-password", "dump-keychain"]);
const AWS: Spec = {
  long: [
    "profile",
    "region",
    "output",
    "endpoint-url",
    "query",
    "color",
    "ca-bundle",
    "cli-read-timeout",
    "cli-connect-timeout",
    "cli-binary-format",
  ],
};
const OP: Spec = { long: ["account", "config", "encoding", "format", "session", "vault", "fields"] };

function dumpOf(name: string, args: Word[]): string | null {
  const ops = (spec: Spec = {}) => parse(args, spec).operands.map((w) => w.text);
  if (name === "printenv") return "printenv";
  if (name === "set") return args.length === 0 ? "set" : null;
  if (name === "export") {
    if (!args.every((a) => a.text === "-p")) return null;
    return args.length > 0 ? "export -p" : "export";
  }
  if (name === "security") {
    const [sub] = ops({ short: "p" });
    return sub !== undefined && SECURITY.has(sub) ? `security ${sub}` : null;
  }
  const [a, b] = ops(name === "aws" ? AWS : name === "op" ? OP : {});
  if (name === "gh" && a === "auth" && b === "token") return "gh auth token";
  if (name === "aws" && a === "configure" && (b === "get" || b === "export-credentials"))
    return `aws configure ${b}`;
  if (name === "op" && a === "read") return "op read";
  if (name === "op" && a === "item" && b === "get") return "op item get";
  if (name === "pass" && a === "show") return "pass show";
  return null;
}

// Hosts: `scheme://[user@]host[:port]` or a remote spec `[user@]host:path`, as written.

const URL_HOST = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]/]*\]|[^:/?#]*)/;
const REMOTE_HOST = /^(?:[^@/:]*@)?(\[[^\]/]*\]|[^:/@\s]+):/;
// curl, wget and httpie take a target without a scheme: `example.com/api`.
const BARE_HOST =
  /^(?:[^@/:\s]+@)?(localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|\[[0-9A-Fa-f:.]+\])(?::\d+)?(?:[/?#]|$)/;

const isRemote = (w: Word) => !w.dynamic && (URL_HOST.test(w.text) || REMOTE_HOST.test(w.text));

function hostOf(w: Word | null | undefined, bare = false): string | null {
  if (!w || w.dynamic) return null;
  const m = URL_HOST.exec(w.text) ?? REMOTE_HOST.exec(w.text) ?? (bare ? BARE_HOST.exec(w.text) : null);
  return m && m[1] !== "" ? m[1] : null;
}

/** The host of the first word that names one; with `bare`, a later pass takes a target without a scheme. */
function firstHost(words: Word[], bare = false): string | null {
  for (const w of words) {
    const h = hostOf(w);
    if (h !== null) return h;
  }
  if (!bare) return null;
  for (const w of words) {
    const h = hostOf(w, true);
    if (h !== null) return h;
  }
  return null;
}

/** The host of an ssh destination: `[user@]host`, `[user@]host:path` or `ssh://...`. */
function destination(w: Word | undefined): string | null {
  if (!w || w.dynamic) return null;
  const url = URL_HOST.exec(w.text);
  if (url) return url[1] || null;
  return /^(?:[^@]*@)?(\[[^\]]*\]|[^:@/\s]+)/.exec(w.text)?.[1] ?? null;
}

// Network commands (design section 3, R8).

type NetRule = (args: Word[], seg: Segment, cwd: string | null) => NetworkUse | null;

function networkUse(tool: string, host: string | null, sendsNamed = true): NetworkUse {
  return { tool, host, sends: [], sendsNamed };
}

/** Adds a file the command sends; a word the line does not spell makes the use unnamed. */
function send(u: NetworkUse, w: Word, cwd: string | null, text = w.text): void {
  if (w.dynamic) u.sendsNamed = false;
  else if (text !== "" && text !== "-") {
    const path = resolvePath(text, cwd);
    if (!u.sends.includes(path)) u.sends.push(path);
  }
}

/** A command that sends its standard input: a `<` file is sent, a pipe carries data the line does not name. */
function sendStdin(u: NetworkUse, seg: Segment, cwd: string | null): void {
  for (const r of seg.redirects)
    if (r.op === "<" && (r.fd === null || r.fd === 0) && r.target) send(u, r.target, cwd);
  if (seg.piped) u.sendsNamed = false;
}

const CURL: Spec = {
  short: "AbcCdDeEFHKmoPQrTtuUwxXyYz",
  long: [
    "data",
    "data-ascii",
    "data-binary",
    "data-raw",
    "data-urlencode",
    "json",
    "form",
    "form-string",
    "upload-file",
    "url",
    "request",
    "header",
    "output",
    "output-dir",
    "user",
    "user-agent",
    "referer",
    "cookie",
    "cookie-jar",
    "proxy",
    "proxy-user",
    "preproxy",
    "write-out",
    "max-time",
    "connect-timeout",
    "config",
    "cacert",
    "capath",
    "cert",
    "cert-type",
    "key",
    "key-type",
    "pass",
    "resolve",
    "connect-to",
    "retry",
    "retry-delay",
    "retry-max-time",
    "range",
    "continue-at",
    "dump-header",
    "oauth2-bearer",
    "limit-rate",
    "interface",
    "unix-socket",
    "abstract-unix-socket",
    "variable",
    "url-query",
    "aws-sigv4",
    "max-filesize",
    "max-redirs",
    "time-cond",
    "speed-limit",
    "speed-time",
    "quote",
    "telnet-option",
    "ftp-port",
    "local-port",
    "dns-servers",
    "doh-url",
    "proto",
    "proto-redir",
    "proxy-header",
    "socks5",
    "socks5-hostname",
    "netrc-file",
    "trace",
    "trace-ascii",
    "stderr",
    "mail-from",
    "mail-rcpt",
    "mail-auth",
    "request-target",
    "noproxy",
  ],
};
const CURL_DATA = ["-d", "--data", "--data-ascii", "--data-binary", "--json"];
const CURL_FORM = ["-F", "--form"];
const CURL_UPLOAD = ["-T", "--upload-file"];

function curl(args: Word[], seg: Segment, cwd: string | null): NetworkUse {
  const p = parse(args, CURL);
  const u = networkUse("curl", firstHost([...values(p, "--url"), ...p.operands], true));
  let stdin = false;
  const file = (w: Word, text: string) => {
    if (text === "-" && !w.dynamic) stdin = true;
    else send(u, w, cwd, text);
  };
  for (const { name, value: w } of p.options) {
    if (!w) continue;
    if (CURL_UPLOAD.includes(name)) file(w, w.text === "." ? "-" : w.text);
    else if (CURL_DATA.includes(name) && w.text.startsWith("@")) file(w, w.text.slice(1));
    else if (name === "--data-urlencode") {
      const m = /^[^=@]*@(.*)$/s.exec(w.text);
      if (m) file(w, m[1]);
    } else if (CURL_FORM.includes(name)) {
      const m = /^[^=]*=[@<]([^;]*)/s.exec(w.text);
      if (m) file(w, m[1]);
    }
  }
  if (stdin) sendStdin(u, seg, cwd);
  return u;
}

const WGET: Spec = {
  short: "OoaPiUtTwQleBDRAIXn",
  long: [
    "post-file",
    "post-data",
    "body-file",
    "body-data",
    "method",
    "header",
    "output-document",
    "output-file",
    "append-output",
    "directory-prefix",
    "input-file",
    "user-agent",
    "tries",
    "timeout",
    "wait",
    "quota",
    "level",
    "execute",
    "base",
    "domains",
    "reject",
    "accept",
    "include-directories",
    "exclude-directories",
    "user",
    "password",
    "http-user",
    "http-password",
    "referer",
    "load-cookies",
    "save-cookies",
    "ca-certificate",
    "certificate",
    "private-key",
    "bind-address",
    "limit-rate",
    "proxy-user",
    "proxy-password",
    "dns-timeout",
    "connect-timeout",
    "read-timeout",
    "waitretry",
    "config",
  ],
};

function wget(args: Word[], _seg: Segment, cwd: string | null): NetworkUse {
  const p = parse(args, WGET);
  const u = networkUse("wget", firstHost(p.operands, true));
  for (const w of values(p, "--post-file", "--body-file")) send(u, w, cwd);
  return u;
}

const HTTPIE: Spec = {
  short: "aAops",
  long: [
    "auth",
    "auth-type",
    "output",
    "print",
    "style",
    "session",
    "session-read-only",
    "verify",
    "cert",
    "cert-key",
    "cert-key-pass",
    "timeout",
    "proxy",
    "max-redirects",
    "max-headers",
    "boundary",
    "raw",
    "format-options",
    "response-charset",
    "response-mime",
    "ssl",
    "ciphers",
    "default-scheme",
    "pretty",
  ],
};
// httpie request items that read a file: `field@file`, `field=@file`, `field:=@file`, `@file`.
const HTTPIE_FILE = /^[^=:@]*(?::=@|=@|@)(.+)$/s;

function httpie(args: Word[], seg: Segment, cwd: string | null): NetworkUse {
  const p = parse(args, HTTPIE);
  const ops = p.operands;
  const method = ops.length > 1 && !ops[0].dynamic && /^[A-Za-z]+$/.test(ops[0].text) ? 1 : 0;
  const u = networkUse("http", firstHost(ops.slice(method, method + 1), true));
  for (const w of ops.slice(method + 1)) {
    const m = HTTPIE_FILE.exec(w.text);
    if (m) send(u, w, cwd, m[1]);
  }
  if (!has(p, "-I", "--ignore-stdin")) sendStdin(u, seg, cwd);
  return u;
}

const SCP: Spec = { short: "cDFiJloPSX" };
const SFTP: Spec = { short: "BbcDFiJloPRSsX" };
const RSYNC: Spec = {
  short: "efBTM@",
  long: [
    "exclude",
    "include",
    "filter",
    "exclude-from",
    "include-from",
    "files-from",
    "rsh",
    "rsync-path",
    "password-file",
    "log-file",
    "log-file-format",
    "port",
    "chmod",
    "chown",
    "usermap",
    "groupmap",
    "backup-dir",
    "suffix",
    "compare-dest",
    "copy-dest",
    "link-dest",
    "partial-dir",
    "temp-dir",
    "timeout",
    "contimeout",
    "bwlimit",
    "max-size",
    "min-size",
    "max-delete",
    "block-size",
    "remote-option",
    "out-format",
    "info",
    "debug",
    "iconv",
    "address",
    "sockopts",
    "modify-window",
    "checksum-choice",
    "compress-choice",
    "compress-level",
    "skip-compress",
    "outbuf",
  ],
};

/** scp and rsync: local sources are sent when the target is remote; no remote side, no network. */
function copy(tool: string, spec: Spec): NetRule {
  return (args, _seg, cwd) => {
    const p = parse(args, spec);
    const ops = p.operands;
    if (!ops.some((w) => isRemote(w) || w.dynamic)) return null;
    const u = networkUse(tool, firstHost(ops));
    const target = ops[ops.length - 1];
    if (ops.length > 1 && (isRemote(target) || target.dynamic)) {
      for (const s of ops.slice(0, -1)) if (!isRemote(s)) send(u, s, cwd);
    }
    if (has(p, "--files-from")) u.sendsNamed = false;
    return u;
  };
}

/** sftp moves the files its session or batch file names, never the line. */
function sftp(args: Word[]): NetworkUse {
  return networkUse("sftp", destination(parse(args, SFTP).operands[0]), false);
}

const SSH: Spec = { short: "BbcDEeFIiJLlmOoPpQRSWw" };

function ssh(args: Word[], seg: Segment, cwd: string | null): NetworkUse {
  const u = networkUse("ssh", destination(parse(args, SSH).operands[0]));
  sendStdin(u, seg, cwd);
  return u;
}

const NC: Spec = {
  short: "cegGIiMmOoPpsTVWwXx",
  long: [
    "exec",
    "sh-exec",
    "lua-exec",
    "proxy",
    "proxy-type",
    "proxy-auth",
    "source",
    "source-port",
    "wait",
    "idle-timeout",
    "output",
    "hex-dump",
    "allow",
    "allowfile",
    "deny",
    "denyfile",
    "max-conns",
  ],
};

function nc(tool: string): NetRule {
  return (args, seg, cwd) => {
    const p = parse(args, NC);
    const listen = has(p, "-l", "--listen");
    const target = p.operands[0];
    const u = networkUse(tool, listen || !target || target.dynamic ? null : target.text);
    sendStdin(u, seg, cwd);
    return u;
  };
}

const GIT: Spec = {
  short: "Cc",
  long: ["git-dir", "work-tree", "namespace", "config-env"],
  posix: true,
};
const PUSH: Spec = { short: "o", long: ["repo", "receive-pack", "exec", "push-option"] };

function git(args: Word[]): NetworkUse | null {
  const [sub, ...rest] = parse(args, GIT).operands;
  if (sub?.text !== "push") return null;
  const p = parse(rest, PUSH);
  // Only the repository names a host; a refspec such as `HEAD:main` looks like a remote spec.
  return networkUse("git push", firstHost([...values(p, "--repo"), ...p.operands.slice(0, 1)]), false);
}

const NPM: Spec = {
  short: "w",
  long: ["registry", "tag", "access", "otp", "workspace", "prefix", "userconfig", "cache"],
};

function npm(args: Word[]): NetworkUse | null {
  const p = parse(args, NPM);
  if (p.operands[0]?.text !== "publish") return null;
  return networkUse("npm publish", firstHost(values(p, "--registry")), false);
}

const NETWORK = new Map<string, NetRule>([
  ["curl", curl],
  ["wget", wget],
  ["http", httpie],
  ["scp", copy("scp", SCP)],
  ["rsync", copy("rsync", RSYNC)],
  ["sftp", sftp],
  ["ssh", ssh],
  ["nc", nc("nc")],
  ["ncat", nc("ncat")],
  ["git", git],
  ["npm", npm],
]);
