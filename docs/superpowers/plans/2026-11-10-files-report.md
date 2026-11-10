# Files Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Report" button in the files tab that writes a forensic report of the session as PDF (print), HTML and CSV: every file with its level, findings for secrets, credentials, environment dumps and network commands, and where the content went.

**Architecture:** Pure modules under `spectro-web/src/files/` build one `FilesReport` from the events and the files tab's ledger (`secrets.ts`, `levels.ts`, `shellRisk.ts`, `destinations.ts`, `report.ts`). Two renderers turn it into text (`reportHtml.ts`, `reportCsv.ts`). A sheet (`FilesReportSheet.tsx`) saves the files through `export/save.ts` and prints the HTML through a hidden iframe, the way `components/ExportDialog.tsx` prints.

**Tech Stack:** TypeScript, React 18, vitest, the repo's testkit (`testkit/driveComponent.ts`, `testkit/source.ts`). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-10-files-report-design.md` (read it before any task; R1 to R8 and B1 to B8 are referenced by name below).

## Global Constraints

- No new npm dependency, no new server endpoint. The only request is `GET /api/bundles` to the app's own server for the version line (`releaseVersion` in `components/about.ts`).
- No credential value, no part of one, no exact length and no hash of one in any output, test snapshot or log. A credential is shown as `[credential N: <rule>]` and described by rule and size band (`sizeBand`, the twin of `Redaction.bucket`: `1-8`, `9-16`, `17-32`, `33-64`, `65-128`, `129+` UTF-8 bytes).
- No file content in any output: paths, commands (masked and cut by `printableCommand`), counts and times only.
- The report never says a session is safe or that nothing leaked.
- A `probable` or `model` entry is never printed as `recorded`.
- Paths print as the files tab shows them: `shortenPath(path, workspace)` from `lab/fileTree.ts`.
- The report document's own words are local to `reportHtml.ts` and `reportCsv.ts` in English and German (the `export/html.ts` convention). The sheet's UI words are i18n keys `filesTab.report.*` in `i18n/i18n.ts`.
- Times are seconds from the first event, printed with `clockText(lang, seconds)` from `files/axis.ts` (the files tab's own format).
- Code comments and identifiers in English, no em or en dashes anywhere, no emoji.
- Every task: test first, see it red, then green; one mutation bite per new rule; commit with explicit paths.
- Working directory for web commands: `spectro-web/` of the worktree `spectroscope-harness/worktrees/wt-card-605`.

## Review Focus

- A session with thousands of tool results (91,963 events in the largest real session): building the report must stay linear and finish in well under a second for 10,000 events. Owner: Task 5 (`buildReport` timing test on a generated 10,000-event stream, under 1,000 ms).
- Upper-case words that look like key ids (`ASIA` + 16 capitals) must not turn a session critical. Owner: Task 1 (`isPlaceholder` / plausibility vectors).
- A credential inside a file path, a command or a prompt must still be masked when it lands in a CSV cell or an HTML attribute. Owner: Task 6 (leak guard over every output).
- A path or command that starts with `=`, `+`, `-`, `@` must not run as a formula in a spreadsheet. Owner: Task 6.
- An imported Claude Code session without `llm_exchange` and without `run_start.provider` must still get a destinations line ("not recorded"), not an empty table. Owner: Task 4.

---

### Task 1: Credential rules (`secrets.ts`)

**Files:**
- Create: `spectro-web/src/files/secrets.ts`
- Test: `spectro-web/src/files/secrets.test.ts`, `spectro-web/src/files/secrets.drift.test.ts`

**Interfaces:**
- Produces:
  - `interface CredentialRule { name: string; pattern: RegExp }` (pattern without the `g` flag; callers clone with `g`).
  - `const REDACTION_RULES: readonly CredentialRule[]`: the twelve rules of `Redaction.java` in its order, pattern sources byte-equal to the Java strings after unescaping; a leading `(?i)` becomes the `i` flag (B3).
  - `const CREDENTIAL_RULES: readonly CredentialRule[]`: the ten credential rules of `REDACTION_RULES` (without `email` and `iban`) followed by `PASSWORD_RULE`.
  - `const PASSWORD_RULE: CredentialRule` with name `password-assignment` and the pattern below.
  - `interface CredentialHit { rule: string; match: string; secret: string; start: number; end: number }`
  - `function findCredentials(text: string): { hits: CredentialHit[]; placeholders: number }`: every non-overlapping match of `CREDENTIAL_RULES` in rule order; a match inside an earlier hit is skipped; a placeholder is counted, not returned.
  - `function secretPart(rule: string, match: string): string` (B2): `bearer` the token after the word, `url-userinfo` the password between the last `:` and the `@`, `password-assignment` capture group 1, else the whole match.
  - `function isPlaceholder(rule: string, secret: string): boolean`
  - `function countPersonalData(text: string): { email: number; iban: number }`
  - `function sizeBand(value: string): string`
  - `function maskCredentials(text: string, label: (hit: CredentialHit) => string): string`: every hit replaced by `[${label(hit)}: ${hit.rule}]`.

- [ ] **Step 1: Write the failing tests**

`secrets.drift.test.ts`:
- `"the twin carries every Redaction.java rule in its order"`: read `../../../spectro-core/src/main/java/dev/spectroscope/core/graph/Redaction.java` with `read()` from `testkit/source.ts`; extract every `new Rule("<name>", Pattern.compile(<java string concatenation>))`; join adjacent string literals, unescape `\\` to `\`; strip a leading `(?i)` and remember it. Assert names and order equal `REDACTION_RULES.map(r => r.name)`, each source equals `rule.pattern.source`, and `(?i)` exactly where `pattern.flags` contains `i`.
- `"every reviewed vector of RedactionTest fires its own rule"`: parse the `REVIEWED_CREDENTIALS` rows of `spectro-core/src/test/java/dev/spectroscope/core/graph/RedactionTest.java` (string literals joined across `+`), and assert the first `REDACTION_RULES` rule that matches each value is the row's rule. Parse `NEAR_MISSES` and assert no rule matches. Assert at least 12 rows parsed (positive guard against a parser that reads nothing).

`secrets.test.ts`, each vector built at run time by concatenation so no credential-shaped literal sits in the source (`"AKIA" + "Q7H2M3KD5ZP4RT6W"`):
- `"finds an AWS key id in prose and returns its whole match as the secret"`.
- `"bearer and url-userinfo keep only the secret part"`: `"Authorization: Bearer " + tok` gives `secret === tok`; `"postgres://app:" + pw + "@db.internal/x"` gives `secret === pw`.
- `"password assignments"`: hits for `DB_PASSWORD=s3cr3t-Pa55`, `"password": "hunter2hunter2"`, `SECRET_KEY = 'q9w8e7r6t5'`, `export GITHUB_TOKEN=abcd1234efgh`; no hit for `password = getPassword()`, `token: ${{ secrets.X }}`, `API_KEY=$API_KEY`, `max_tokens: 100000`, `bypass=true`, `passenger=someone12`.
- `"placeholders are counted, not returned"`: `"AKIA" + "IOSFODNN7EXAMPLE"`, `DB_PASSWORD=changeme`, `DB_PASSWORD=<your_password>`, `DB_PASSWORD=xxxxxxxx`, `DB_PASSWORD=password` each give `hits.length === 0` and `placeholders === 1`.
- `"an upper-case word is not a key id"`: `"ASIA" + "PACIFICSALESTEAM"` and `"ACCA" + "DEMICTRANSCRIPTS"` (16-letter bodies) give no hit and count as placeholders; a body with two or more digits (`"AKIA" + "Q7H2M3KD5ZP4RT6W"`) is a hit. Plausibility rule for `aws-akid`: the 16 characters after the prefix hold at least one digit.
- `"personal data is counted separately"`: two emails and one compact IBAN give `{ email: 2, iban: 1 }`; `findCredentials` on the same text returns no hit.
- `"sizeBand follows Redaction.bucket"`: lengths 8, 9, 16, 17, 32, 33, 64, 65, 128, 129 bytes map to the six bands; a two-byte character counts two.
- `"maskCredentials replaces every hit and leaves the rest"`: `"x " + key + " y"` with label `() => "credential 1"` gives `"x [credential 1: aws-akid] y"`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run src/files/secrets.test.ts src/files/secrets.drift.test.ts`
Expected: FAIL, module `./secrets` not found.

- [ ] **Step 3: Implement `secrets.ts`**

`PASSWORD_RULE` pattern, exact:

```ts
/\b[A-Za-z0-9_-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?key)(?:[_-]?key)?["']?\s*[:=]\s*["']?([^\s"'`;,)\]}]{6,})/i
```

A password-assignment value that contains `(`, `[` or `{`, starts with `%` or `&`, or equals `null`, `None`, `undefined`, `true`, `false` is code, not a value: skip it without counting. A value starting with `$` or `<` goes through `isPlaceholder` like any other. `isPlaceholder` (B4): ends in `EXAMPLE`; one repeated character; `${NAME}` or `$NAME`; in angle brackets; contains `example`, `placeholder`, `dummy`, `changeme`, `your_`, `xxxx` (any case); equals `password`, `secret`, `test`, `admin`, `root` (any case); for `aws-akid` a body without a digit.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run src/files/secrets.test.ts src/files/secrets.drift.test.ts`
Expected: PASS. Bite once: change one character of the TypeScript `jwt` source and see the drift test fail, then restore.

- [ ] **Step 5: Commit**

```bash
git add spectro-web/src/files/secrets.ts spectro-web/src/files/secrets.test.ts spectro-web/src/files/secrets.drift.test.ts
git commit -m "Card 605: credential rules for the files report, a twin of Redaction.java"
```

### Task 2: Path levels (`levels.ts`)

**Files:**
- Create: `spectro-web/src/files/levels.ts`
- Test: `spectro-web/src/files/levels.test.ts`

**Interfaces:**
- Produces:
  - `type Level = "critical" | "sensitive" | "unknown" | "project"`
  - `const LEVEL_ORDER: readonly Level[] = ["critical", "sensitive", "unknown", "project"]`
  - `function higher(a: Level, b: Level): Level`
  - `function isSecretPath(path: string): boolean`
  - `function pathLevel(path: string, workspace: string | null): Level` (never returns `unknown`)
  - `function outsideWorkspace(path: string, workspace: string | null): boolean` (false when `workspace` is null)

- [ ] **Step 1: Write the failing test** `levels.test.ts`:
- `"secret names and folders are critical"`: `.env`, `/w/.env.local`, `/w/certs/server.pem`, `/w/a.key`, `x.p12`, `x.pfx`, `x.keystore`, `x.jks`, `vault.kdbx`, `~/.ssh/id_ed25519`, `/u/.ssh/config`, `/u/.aws/credentials`, `/u/.gnupg/pubring.kbx`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `credentials.json`, `secrets.yaml`, `kubeconfig` all give `critical` with workspace `/w` and with `null`.
- `"templates stay project"`: `/w/.env.example`, `/w/.env.sample`, `/w/.env.template`, `/w/.env.dist`, `/w/.env.defaults` give `project`.
- `"outside the workspace is sensitive"`: workspace `/Users/a/p`: `/Users/a/q/x.ts`, `/Users/a/.zsh_history`, `/etc/hosts`, `~/notes.md` give `sensitive`; `/Users/a/p/src/x.ts` and `/Users/a/p` give `project`; `/Users/a/p2/x` gives `sensitive` (prefix is not containment).
- `"without a workspace only system folders and home dot folders are sensitive"` (B1): `/etc/hosts`, `/var/log/x`, `/private/tmp/x`, `/usr/local/x`, `/Library/x`, `/System/x`, `/Users/a/.zshrc`, `/home/a/.config/x`, `~/.bash_history` give `sensitive`; `/Users/a/p/src/x.ts`, `src/x.ts` give `project`.
- `"higher picks the earlier level of LEVEL_ORDER"`.

- [ ] **Step 2: Run and see it fail**: `npx vitest run src/files/levels.test.ts`, module not found.
- [ ] **Step 3: Implement `levels.ts`**: match on the path's segments after splitting on `/`; a secret folder is any segment `.ssh`, `.aws`, `.gnupg`, `secrets`, `credentials`, `Keychains`.
- [ ] **Step 4: Run and see it pass**; bite: drop `.jks` from the list, see the test fail, restore.
- [ ] **Step 5: Commit** `git add spectro-web/src/files/levels.ts spectro-web/src/files/levels.test.ts` with message `Card 605: levels for the paths a session touched`.

### Task 3: Shell risk (`shellRisk.ts`)

**Files:**
- Create: `spectro-web/src/files/shellRisk.ts`
- Test: `spectro-web/src/files/shellRisk.test.ts`

**Interfaces:**
- Consumes: `segments`, `Segment`, `Word` from `files/shellTokens.ts`; `resolvePath` from `files/paths.ts`.
- Produces:
  - `interface NetworkUse { tool: string; host: string | null; sends: string[]; sendsNamed: boolean }` (`sends` resolved against `cwd`; `sendsNamed` false for B7)
  - `interface ShellRisk { envDump: string | null; network: NetworkUse[] }` (`envDump` is the command word that dumped, for example `printenv`)
  - `function shellRisk(command: string, cwd: string | null): ShellRisk`

The command name of a segment is its first word that is not an assignment (`NAME=value`). A heredoc body is never inspected.

- [ ] **Step 1: Write the failing test** `shellRisk.test.ts`:
- `"environment and keychain dumps"`: `env`, `env | sort`, `printenv`, `printenv GITHUB_TOKEN`, `export -p`, `export`, `set`, `security find-generic-password -s x -w`, `security find-internet-password -s x`, `security dump-keychain`, `gh auth token`, `aws configure get aws_secret_access_key`, `aws configure export-credentials`, `op read op://v/i/f`, `op item get x`, `pass show mail` each give a non-null `envDump`; `env FOO=1 node x.js`, `set -e`, `export FOO=1`, `echo env`, `echo "printenv"`, `security list-keychains` give `null`.
- `"curl names its host and the files it sends"`: `curl -X POST https://hooks.example.com/a -d @payload.json` gives `{ tool: "curl", host: "hooks.example.com", sends: ["<cwd>/payload.json"], sendsNamed: true }`; also `--data-binary @a`, `-F f=@b`, `-T c`, `--upload-file d`; `curl https://x.example.org` gives `sends: []`, `sendsNamed: true`.
- `"wget, scp, rsync"`: `wget --post-file=a.json https://h.example.com`; `scp a.txt b.txt user@h.example.com:/tmp/` sends both, host `h.example.com`; `scp user@h:/tmp/a .` sends nothing; `rsync -av dist/ deploy@h:/srv/` sends `dist/`; `rsync -av a/ b/` (no remote side) is not a network use.
- `"git push and npm publish do not name files"` (B7): `git push origin main` gives `{ tool: "git push", host: null, sends: [], sendsNamed: false }`; `npm publish` gives `tool: "npm publish"`; `git status` gives no network use.
- `"ssh, nc and httpie"`: `ssh h.example.com uptime` host `h.example.com`; `nc h.example.com 80`; `http POST https://api.example.com/x < body.json` sends `body.json`.
- `"quoted and heredoc text is not a command"`: `echo "curl https://x"` and a heredoc whose body holds `curl https://x` give no network use.

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement `shellRisk.ts`.** Host from the first word that is a URL (`scheme://[user@]host[:port]`) or a remote spec (`[user@]host:path`); `localhost` stays as written.
- [ ] **Step 4: Run and see it pass;** bite: remove `-T` from the curl send flags, see the test fail, restore.
- [ ] **Step 5: Commit** `git add spectro-web/src/files/shellRisk.ts spectro-web/src/files/shellRisk.test.ts` with message `Card 605: environment dumps and network commands in a shell line`.

### Task 4: Destinations (`destinations.ts`)

**Files:**
- Create: `spectro-web/src/files/destinations.ts`
- Test: `spectro-web/src/files/destinations.test.ts`

**Interfaces:**
- Consumes: `RunEvent` from `events.ts`.
- Produces:
  - `type Where = "this-machine" | "local-cloud" | "network" | "cloud" | "unknown"`
  - `interface Destination { key: string; provider: string | null; model: string | null; host: string | null; where: Where; requests: number; largestRequest: number | null; recorded: boolean }` (`recorded` false for the `run_start` fallback; `key` is `provider|model|host`)
  - `function hostWhere(host: string, model: string): Where`
  - `function destinations(events: readonly RunEvent[]): Destination[]`
  - `function reachedBy(events: readonly RunEvent[], agentId: string, fromIndex: number, all: readonly Destination[]): string[]`: the keys of the destinations of the same agent's `llm_exchange` events of kind `chat` or `compaction` after `fromIndex`; when there is none, every key of `all`.

- [ ] **Step 1: Write the failing test** `destinations.test.ts`:
- `"hosts are classed"`: `localhost`, `127.0.0.1`, `::1`, `[::1]`, `0.0.0.0` with `qwen2.5:7b` give `this-machine`; `localhost` with `minimax-m3:cloud` or `glm-5-cloud` gives `local-cloud`; `10.1.2.3`, `172.20.0.4`, `192.168.1.9`, `100.64.10.20`, `nas.local`, `box.tail1234.ts.net` give `network`; `172.32.0.1`, `api.anthropic.com` give `cloud`.
- `"exchanges group by provider, model and host"`: three `llm_exchange` events (two to `https://api.anthropic.com/v1/messages` with `requestBytes` 100 and 400, one to `http://localhost:11434/api/chat`) give two destinations, the first with `requests: 2`, `largestRequest: 400`, `where: "cloud"`, `recorded: true`.
- `"the run_start fallback"`: no exchanges, `run_start` with `provider: "ollama"` gives one destination `{ where: "unknown", host: null, recorded: false }` whose provider is `ollama`; `provider: "spectro-local"` gives `this-machine`; `provider: "anthropic"` gives `cloud`; no provider gives one destination with `provider: null`, `where: "unknown"`.
- `"reachedBy follows the agent"`: an exchange of agent `main` after index 5 and one of `helper-1` give `reachedBy(events, "main", 5, all)` the key of the first only; with no later exchange of that agent it returns every key.

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement `destinations.ts`.** Parse `url` with `new URL`; a URL that does not parse gives host `null` and `where: "unknown"`. Fallback provider classes: `ollama`, `lmstudio`, `llamacpp` and any provider not named below are `unknown`; `spectro-local` and `scripted` are `this-machine`; `anthropic`, `openai`, `gemini`, `copilot`, `openrouter` are `cloud`.
- [ ] **Step 4: Run and see it pass;** bite: drop the `100.64/10` range, see the test fail, restore.
- [ ] **Step 5: Commit** `git add spectro-web/src/files/destinations.ts spectro-web/src/files/destinations.test.ts` with message `Card 605: where a session's content went`.

### Task 5: The report model (`report.ts`)

**Files:**
- Create: `spectro-web/src/files/report.ts`
- Test: `spectro-web/src/files/report.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 4; `FileLedger`, `FileTouch`, `Source` from `files/fold.ts`; `shortenPath` from `lab/fileTree.ts`.
- Produces:

```ts
export type FindingKind =
  | "secret-file" | "credential-result" | "credential-input" | "credential-prompt"
  | "credential-used" | "env-dump" | "network" | "outside" | "personal-data" | "unknown-script";
export interface CredentialRef { label: string; rule: string; band: string }
export interface Finding {
  level: Level; kind: FindingKind; callIndex: number | null; eventIndex: number;
  agentId: string | null; t: number | null; source: Source;
  tool: string | null; file: string | null; // shortened path
  command: string | null; // printableCommand output, already masked
  credentials: CredentialRef[]; host: string | null; sends: string[]; sendsNamed: boolean;
  firstSeenCall: number | null; // credential-used: where the value was first seen
  reached: string[]; // destination keys
  count: number; // personal-data: matches; env-dump: output lines; else 1
}
export type What = "read" | "changed" | "created" | "deleted" | "sent";
export interface ReportFile {
  path: string; label: string; level: Level; what: What[]; sources: Source[];
  firstT: number | null; firstCall: number; calls: number;
}
export interface FilesReport {
  sessionId: string; title: string | null; version: string | null; exportedAt: number;
  workspace: string | null; firstTs: number | null; lastTs: number | null;
  events: number; agents: string[]; timed: boolean;
  verdict: Level; destinations: Destination[]; findings: Finding[]; files: ReportFile[];
  counts: Record<Level, Record<"read" | "changed" | "created" | "deleted", number>>;
  placeholders: number; personal: { email: number; iban: number };
}
export interface ReportInput {
  events: readonly RunEvent[]; ledger: FileLedger; sessionId: string;
  title: string | null; version: string | null; now: number;
}
export function buildReport(input: ReportInput): FilesReport;
export function printableCommand(line: string, mask: (text: string) => string): string;
```

Rules (spec sections 2 and 3): touch kinds `create` map to `created`, `delete` to `deleted`, `change`, `overwrite`, `write`, `append` to `changed`, `read` to `read`, `unknown` to nothing; a file a network command sends gets `sent`; when no ledger row has that path, the report adds a row with `what: ["sent"]` and `sources: ["probable"]`. A file row's level is `pathLevel`; `counts` places each file once under its most specific kind (created, deleted, changed, else read). Credential scanning visits events in index order: `tool_call` input (`JSON.stringify(input)`), `tool_result` output, the prompts of `ledger.prompts` at their `eventIndex`, and every `steering_message`. One label per distinct secret (`credential 1`, `credential 2` in order of first sight); a later `tool_call` whose input holds a secret first seen at an earlier event gives one `credential-used` finding per secret and call. A finding whose content reached the model (`secret-file` reads, `credential-result`, `credential-prompt`, `env-dump`, `outside`) gets `reached` from `reachedBy`. `unknown-script` comes from a ledger call with `script` or `inline`. The verdict is the highest level over findings and files. Findings sort by level, then time.

`printableCommand`: masks first, then cuts at the first `<<` and at 300 characters, appending ` (n more characters)` with the count of what was cut.

- [ ] **Step 1: Write the failing test** `report.test.ts` (events built with small helpers in the test; credential literals assembled at run time):
- `"a secret file read in a cloud session"`: `read_file .env` with a result holding an AWS key id, an exchange to `api.anthropic.com` after it; verdict `critical`; findings include `secret-file` (file `.env`, `source: "recorded"`, `reached` = the anthropic key) and `credential-result` with `credentials: [{ label: "credential 1", rule: "aws-akid", band: "17-32" }]`.
- `"a credential used again names both calls"`: the key returned by call A appears in the `run_command` input of call B; one `credential-used` finding with `callIndex` B, `firstSeenCall` A, and `command` containing `[credential 1: aws-akid]` and not the key.
- `"a credential the person typed"`: a `user_message` and a `steering_message` each with a token give two `credential-prompt` findings.
- `"env dump, network and outside reads"`: `printenv | sort` gives `env-dump` with `source: "probable"`; `curl ... -d @payload.json` gives `network` with host and `sends: ["payload.json"]`, and the file row for `payload.json` has `what` containing `sent`; `cat /etc/hosts` with workspace `/w` gives `outside`.
- `"a project-only session"`: edits and reads inside `/w`; `verdict: "project"`, no finding above `project`, `counts.project` right.
- `"placeholders do not raise the level"`: a result holding the AWS documentation key gives `placeholders: 1` and no `credential-result`.
- `"model entries keep their source"`: a ledger touch with `sources: ["model"]` appears in `files` with `sources: ["model"]` and does not change the verdict.
- `"printableCommand cuts heredocs and long lines"`: `cat > a <<'EOF'\nsecret body\nEOF` gives `cat > a` (trimmed) plus the cut note; a 400-character line gives 300 characters plus ` (100 more characters)`.
- `"ten thousand events stay fast"`: a generated stream of 10,000 events (2,500 calls with results, a few credentials) builds in under 1,000 ms.

- [ ] **Step 2: Run and see it fail.**
- [ ] **Step 3: Implement `report.ts`.**
- [ ] **Step 4: Run and see it pass;** bite: stop scanning `steering_message`, see `"a credential the person typed"` fail, restore.
- [ ] **Step 5: Commit** `git add spectro-web/src/files/report.ts spectro-web/src/files/report.test.ts` with message `Card 605: the files report model`.

### Task 6: HTML and CSV renderers

**Files:**
- Create: `spectro-web/src/files/reportHtml.ts`, `spectro-web/src/files/reportCsv.ts`
- Test: `spectro-web/src/files/reportHtml.test.ts`, `spectro-web/src/files/reportCsv.test.ts`, `spectro-web/src/files/reportLeak.test.ts`

**Interfaces:**
- Consumes: `FilesReport` from Task 5; `findCredentials` from Task 1; `clockText` from `files/axis.ts`; `Lang` from `i18n/i18n.ts`.
- Produces:
  - `function reportHtml(report: FilesReport, lang: Lang): string`: a whole document, the mockup's layout and sections (header, verdict, where the content went, findings, files by level, all files, what this report cannot see, method), brand tokens in light and dark with a switch button and `data-design="light"` as default, the print stylesheet of the mockup (`:root,:root[data-design]` inside `@media print`), every inserted string escaped. One inline script for the switch only; no external request.
  - `function reportCsv(report: FilesReport, lang: Lang): string`: BOM `\uFEFF`, header `level,time_s,clock,call,agent,tool,what,source,file,finding,detail,destination`, one row per finding, then one row per file touch; RFC 4180 quoting; a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading `'`; line ending `\r\n`.
  - `function reportFilename(ext: "html" | "csv", title: string | null, now: number): string`: `spectroscope-files-report-<slug>-<yyyymmdd-hhmm>.<ext>`, slug rule and UTC stamp as `exportFilename` in `export/html.ts`.

The verdict sentence and the limits come from the spec: with no finding above `project`, the verdict says which shapes were checked and that none was found; it never says safe. The mockup at `kanban/evidence/605/mockup/report.html` in the home folder fixes layout and section order; the brief for the task carries its path.

- [ ] **Step 1: Write the failing tests**
- `reportHtml.test.ts`: sections appear in the mockup's order in both languages; a `probable` source prints the word `probable`, never `recorded`; a title holding `<script>` prints escaped; a project-only report contains neither `safe` nor `sicher` as a word and contains the checked-shapes sentence; `@media print` and `data-design` are present; no `http://` or `https://` other than the destination hosts printed as text.
- `reportCsv.test.ts`: starts with the BOM; header exact; a path `a,"b"` is quoted as `"a,""b"""`; a path `=HYPERLINK("x")` prints as `'=HYPERLINK(""x"")` inside quotes; rows end with `\r\n`; one row per finding plus one per touch.
- `reportLeak.test.ts`: a fixture session full of credentials (in results, inputs, prompts, steering, a file path and a command, assembled at run time) built through `buildReport`; positive guard: the report has at least six credential findings; then `findCredentials(reportHtml(r, "en")).hits`, the same for `"de"` and for `reportCsv(r, "en")` are all empty, and none of the fixture's raw secrets is a substring of any output.

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement both renderers.**
- [ ] **Step 4: Run and see them pass;** bite: remove the formula guard, see the CSV test fail, restore; bite: print `command` unmasked in the HTML (use the raw line), see the leak test fail, restore.
- [ ] **Step 5: Commit** `git add` the five files with message `Card 605: HTML and CSV of the files report`.

### Task 7: The button and the sheet

**Files:**
- Create: `spectro-web/src/files/FilesReportSheet.tsx`
- Modify: `spectro-web/src/files/FilesView.tsx` (props, button after `FilesModelControls`), `spectro-web/src/files/files.css`, `spectro-web/src/i18n/i18n.ts` (`filesTab.report.*`), `spectro-web/src/App.tsx` (pass `title`)
- Test: `spectro-web/src/files/FilesReportSheet.test.tsx`, `spectro-web/src/files/FilesView.test.tsx`

**Interfaces:**
- Consumes: Tasks 5 and 6; `saveTextFile` from `export/save.ts`; `releaseVersion` from `components/about.ts`.
- Produces:
  - `FilesViewProps` gains `title: string | null` (App passes `sessionTitleOf(shownSessionId)` when an id is shown, else null).
  - `interface FilesReportSheetProps { lang: Lang; events: readonly RunEvent[]; ledger: FileLedger; sessionId: string; title: string | null; onClose: () => void; loadVersion?: () => Promise<string | null> }`
  - `function FilesReportSheet(props: FilesReportSheetProps): JSX.Element`

The button (`data-action="report"`, label `filesTab.report.button`, "Report" / "Report") opens the sheet. The sheet shows the verdict level and the verdict sentence, three buttons `data-action="report-pdf"`, `report-html`, `report-csv`, and the line `filesTab.report.scope` ("Covers the whole session; the filters of this tab do not apply." / "Umfasst die ganze Session; die Filter dieses Tabs gelten nicht."). PDF prints a hidden iframe (`sandbox="allow-same-origin allow-modals"`, `srcdoc` = `reportHtml`, then `contentWindow.print()` on load), with the note `filesTab.report.pdfNote` ("The print dialog offers Save as PDF." / "Der Druckdialog bietet Als PDF sichern an."). HTML and CSV go through `saveTextFile` with `text/html;charset=utf-8` and `text/csv;charset=utf-8`. The sheet is a `role="dialog"` with `aria-modal="true"`, keeps focus inside while open, closes on Escape and returns focus to the button. The ledger handed to the sheet is the one the tab shows (the merged ledger when a model reading is on screen).

- [ ] **Step 1: Write the failing tests**
- `FilesReportSheet.test.tsx` with `drive()`: the three buttons and the scope line render in both languages; HTML and CSV call a stubbed `saveTextFile` with the names from `reportFilename` and the right mime; Escape calls `onClose`; the verdict line of a fixture with a `.env` read says the level `critical`.
- `FilesView.test.tsx`: the header has a `data-action="report"` button; pressing it renders the sheet; the sheet gets the tab's shown ledger.
- `i18n`: every `filesTab.report.*` key has `en` and `de`.

- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement the sheet, the button, the CSS (files.css tokens only, no new colour), the keys and the App prop.**
- [ ] **Step 4: Run `npm run gate` and see it pass** (Expected: tsc, eslint, prettier, vitest, vite build all exit 0).
- [ ] **Step 5: Commit** explicit paths, message `Card 605: Report button and sheet in the files tab`.

### Task 8: Guide section

**Files:**
- Modify: `docs/guide-assets/parts/05-web-tabs.html` (in "The Files tab", after the model reading paragraph), `docs/USER-GUIDE.html`, `docs/USER-GUIDE-LIGHT.html`, `docs/USER-GUIDE.pdf`, `docs/USER-GUIDE-LIGHT.pdf`, `docs/guide-assets/pdf-stamp.txt`

- [ ] **Step 1:** Write one paragraph: the Report button, the three outputs, the four levels, what a finding is, that no credential value or file content is written, where the content went, and the limits. Run it through `humanizer` and `allen-tone-of-voice` (`tells.py`), no dashes.
- [ ] **Step 2:** Rebuild both editions and both PDFs with the `build_user_guide.py` ritual used for card 604 (dark, `--light`, Chrome print per edition with its own profile and a `timeout` guard, then `--stamp`).
- [ ] **Step 3:** Run `./gradlew :spectro-core:test --tests '*ConfigDocDriftTest' --rerun-tasks --no-build-cache` and see it pass.
- [ ] **Step 4: Commit** the six files, message `Card 605: guide section for the files report`.
