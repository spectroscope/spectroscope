# Files report

Status: design, written 2026-11-10. The owner answered Q1 and Q2 on 2026-11-10 and ordered the build and the 0.16.1 release with the request itself. Card 605.

## Goal

The files tab (card 604) gets an export button. It writes a small forensic report of the session: which files were read, which were changed, created or deleted, each sorted by how critical it is. It is meant for a person who ran a session with a model they maybe should not have used. The report tells them whether only project files reached the model, or passwords and keys as well, and whether those were used.

The report comes as a PDF (through the print dialog), as an HTML file and as a CSV file. The mockup with invented data is `kanban/evidence/605/mockup/report.html` in the home folder (outside this repo), with a printed PDF beside it in `shots/`.

## The owner's request

Dictated on 2026-11-10, verbatim in `kanban/evidence/605/owner-words-2026-11-10.md` (home folder). In short: an export as a nice CSV, Word or PDF that shows which file was touched, changed or only read, sorted a little by criticality. It should work as a small forensic report: were passwords read, were they used. An export button in the files tab, then release 0.16.1.

## Proposals in this document (assistant's calls, open for the owner)

- R1. Three outputs from one report model: PDF through the existing print path, a self-contained HTML file, and a CSV file. No Word file: it would need a new library, and Word opens the HTML file as it is. The owner chose this (Q1).
- R2. Four levels: `critical` (secrets), `sensitive` (outside the project, network, personal data), `unknown` (a script whose effect the recording does not show) and `project` (files inside the workspace). The session's verdict is its highest level.
- R3. No credential and no file content is ever written into the report. A credential is named by its rule, its size band from `Redaction.bucket` (for example `17-32` bytes, never the exact length) and a label that counts up within the report (`credential 1`, `credential 2`). The same value keeps its label across calls, which is how "used again" shows. A command that carried one prints with the value replaced by `[credential 1: aws-akid]`. There is no hash fingerprint: for a short password an 8-digit hash prefix is enough to test a dictionary against, and the app still holds the recording for anyone who needs the value.
- R4. Credentials are found by a TypeScript twin of the twelve rules in `spectro-core/.../graph/Redaction.java`, kept equal by a drift test, plus one rule for password assignments such as `PASSWORD=`. Known placeholders (the AWS documentation key ending in `EXAMPLE`, `${VAR}`, `<...>`, `changeme`, etc.) are counted in the method section and do not raise the level.
- R5. The report says where the content went: every model the session called, read from the recorded `llm_exchange` events (provider, model, address), classed as this machine, another machine on the local network, or cloud. Older sessions without exchanges fall back to the provider and model of `run_start` and say the address was not recorded.
- R6. The report always covers the whole session. The agent filter and the time cursor of the tab do not apply, and the sheet says so. A model reading that is on screen is included with source `model` and never counts toward the verdict.
- R7. The report's own words come in English and German, chosen by the app language, and live in the report module the way `export/html.ts` keeps its chrome local: a file outlives the app it came from.
- R8. Network commands (`curl`, `wget`, `scp`, `rsync` to a host, `git push`, etc.) are a second way data can leave the machine besides the model. They get their own finding with the host and the files they send. The owner chose this (Q2).

## Calls made after the builder check (assistant's, open for the owner)

A fresh reviewer read this document as a builder on 2026-11-10 and asked eight questions. None needed the owner to plan; these are the calls, each marked in the text where it applies.

- B1. Without a recorded workspace, only a secret-shaped path is `critical`, and only system folders (`/etc`, `/var`, `/private`, `/usr`, `/Library`, `/System`) and dot folders of a home folder (`/Users/<name>/.<x>`, `/home/<name>/.<x>`, `~/.<x>`) are `sensitive`. Everything else is `project`, no "read outside the project" finding is made, and the header says the workspace was not recorded.
- B2. "Used again" matches the secret part of a match, not the whole match: the token after `bearer`, the password of `url-userinfo`, the value of a password assignment, the whole match for the other rules. A value counts as used again when it appears in the input of a later call than the one where it was first seen.
- B3. The twin keeps the Java pattern strings unchanged, with one translation: a leading `(?i)` becomes the `i` flag. The drift test reads `Redaction.java`, unescapes each `Pattern.compile` string, applies that translation and compares name, order and source with the TypeScript table. Any other Java-only construct fails the test.
- B4. The placeholder rule is the list in section 3, not an open "etc.".
- B5. `FilesView` gets the session's title from `App` the way the other tabs get it; the id is the `viewKey`. An imported session uses its import title.
- B6. A printed command stops at the first heredoc marker `<<` and at 300 characters, followed by "(n more characters)". A heredoc body is file content and never printed.
- B7. `git push`, `npm publish` and an `rsync` or `scp` whose sources the line does not spell say "files not named by the command".
- B8. The fold's prompts do not include `steering_message`, so the report reads steering messages from the events itself.

## Decisions taken with the owner

| Question | Answer (owner, 2026-11-10) |
|---|---|
| Q1. Formats | PDF, HTML and CSV. No Word file. |
| Q2. Network commands | Yes, as their own finding (R8). |

## What exists today

- The files tab's fold `spectro-web/src/files/fold.ts` gives a `FileLedger`: every file call with its touches, each touch with kind (`read`, `create`, `change`, `overwrite`, `write`, `append`, `delete`, `unknown`), source (`recorded`, `probable`, `model`), time in seconds and agent. `FileRow` groups the touches per path. The shell heuristic `files/shell.ts` names the script a command runs and whether code ran inline.
- Exports: `export/save.ts` (`saveTextFile`, one blob download for any text), `export/html.ts` (self-contained HTML with themes and a print stylesheet), `components/ExportDialog.tsx` ("Print / save as PDF" through a sandboxed iframe that opens the print dialog). The desktop shell is Electron; the chat export already prints this way.
- Events: `run_start {provider?, model?, workspace?}`; `llm_exchange {agentId, kind, provider, model, url, requestBytes, ...}` since card 184; `tool_call {input}` and `tool_result {output, isError}`; the person's prompts, which the fold gathers as `FileLedger.prompts` from `run_start.prompt` and `user_message`; `steering_message` is not among them (B8).
- `files/FilesConsent.tsx` already classes an address and model as `local`, `localCloud` (a `:cloud` model behind a local server) or `remote` (`stayLocal`).
- `spectro-core/.../graph/Redaction.java` holds twelve named credential and personal-data rules: `private-key`, `anthropic-key`, `openai-key`, `aws-akid`, `github-pat`, `google-api-key`, `slack-token`, `bearer`, `jwt`, `url-userinfo`, `email`, `iban`. `RedactionTest.java` and the Python SDK share one vector table. The web has no copy.

## Measurements (2026-11-10, home folder `kanban/evidence/605/`)

Counted with `secret_census_native.py` and `secret_census_transcripts.py`; both print counts only, never a matched value or path. The patterns are a first version of the rules in section 2, so the figures rank the rules; they are not a coverage claim.

- 78 native session files in `~/.spectro/sessions`, 1,784 tool calls, 622 shell commands: 0 secret-shaped paths in a file tool, 1 environment dump, 5 network commands, 1 credential shape in a tool result (`census-native-2026-11-10.txt`).
- 11,629 Claude Code transcript files on this Mac, 515,619 tool calls, 337,897 `Bash` commands (`census-transcripts-2026-11-10.txt`). A secret-shaped path in `Read` 30 times (25 files), `Edit` 19, `Write` 9. A `Bash` command names a secret-shaped file 1,545 times (364 files), dumps the environment, keychain or a token 291 times (157 files), runs a network command 10,540 times (2,115 files). A credential shape appears in a tool result in 436 files and in a tool call input in 260 files.
- The largest rule by far is `aws-akid`: 3,332 hits in results and 1,337 in inputs. A raw text scan of the same transcripts (`placeholder_census_transcripts.py`, `akid_context_census.py`, `akid_shape_census.py`) counts 13,636 `aws-akid` shapes. 2,806 are the AWS documentation key ending in `EXAMPLE`. Of the other 10,830, all sit in readable text, not in encoded data; 10,801 start with `ASIA` (temporary credentials) and carry at least one digit, 25 start with `AKIA` and carry no digit, which a random key body has only 3.6 % of the time. Of 1,988 `url-userinfo` shapes, 131 have a placeholder password, 1,772 point at a local or example host and 85 elsewhere.

## Design

### 1. The report model

A pure function `buildReport(events, ledger, reading) → FilesReport` in a new module `files/report.ts`. It runs on the whole event list and the heuristic ledger (plus the model reading when one is shown). The three renderers read only the `FilesReport`; none of them looks at events.

`FilesReport` holds: the session header (title, id, first and last event time, event count, agents, workspace), the verdict (highest level and the sentence parts), the destinations (section 4), the findings (section 3), one row per file with its level, what happened (read only, changed, created, deleted, sent), source, first time and call count, the counts per level and kind, the placeholder count, and the method lines.

Equal values are matched inside `buildReport` through a map from value to label. The value never leaves the function: the model keeps only rule, size band and label.

### 2. Levels

A path is classed once, after `resolvePath` against the workspace:

- `critical` when its name or a folder on its way is secret-shaped: `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.kdbx`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` and their variants, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `credentials` and `credentials.json`, `secrets.*`, `kubeconfig`, anything under `.ssh/`, `.aws/`, `.gnupg/`. Templates such as `.env.example` and `.env.sample` stay `project`.
- `sensitive` when it lies outside the workspace: another project, the home folder (shell history, `~/.config`, `~/Library`), the system.
- `project` otherwise. Without a recorded workspace the rule of B1 applies.

A finding takes the level of what it is about. The verdict is the highest level among findings and file rows; `unknown` sits between `sensitive` and `project`.

### 3. Findings

Each finding has a level, a kind, the call index, agent, time, source and a short text. The kinds:

- Secret file read, changed, created or deleted (`critical`): a `critical` path in any touch, recorded or probable.
- Credential in a tool result, in a tool call input, or in a prompt (`critical`): the rules of R4 over every `tool_result` output, every `tool_call` input (stringified), every prompt in `FileLedger.prompts` and every `steering_message` (B8). Placeholders (B4): a value ending in `EXAMPLE`, a value made of one repeated character, `${NAME}` or `$NAME`, a value in angle brackets, a value containing `example`, `placeholder`, `dummy`, `changeme`, `your_` or `xxxx` (any case), and the passwords `password`, `secret`, `test`, `admin`, `root` alone. An `aws-akid` whose 16-character body holds no digit is an upper-case word, not a key, and counts as a placeholder. A placeholder does not count.
- Credential used again (`critical`): a value seen earlier, in a result, an input or a prompt, appears in a later tool call input.
- Environment or keychain dump (`critical`): a shell segment whose command is bare `env`, `printenv`, `export -p`, bare `set`, `security find-generic-password` or `find-internet-password`, `gh auth token`, `aws configure get`, `op read`, `pass show`. Source `probable`.
- Network command (`sensitive`): `curl`, `wget`, `scp`, `sftp`, `rsync` with a remote side, `nc`, `ncat`, `ssh`, `git push`, `npm publish`, `http`. It names the host from the URL or `host:` argument and the files it sends (`-d @file`, `--data-binary @file`, `-F x=@file`, `-T file`, `--upload-file`, `--post-file`, the local sources of `scp` and `rsync`). Source `probable`.
- Read outside the project (`sensitive`): one finding per outside path.
- Personal data in results (`sensitive`): the `email` and `iban` rules, counted per rule, one finding for the session.
- Script with unknown effect (`unknown`): a call with `script` or `inline` set in the ledger.

Shell segments come from `files/shellTokens.ts`, the same tokenizer the heuristic uses, so a quoted `curl` inside an `echo` does not count.

### 4. Destinations

Every `llm_exchange` is grouped by provider, model and host. The host is classed: a loopback address is this machine (`localCloud` when the model ends in `:cloud` or `-cloud`, which `stayLocal` already decides; it takes `host:port`, so the URL is parsed first), a private address (10/8, 172.16/12, 192.168/16, 100.64/10, `*.local`, `*.ts.net`) is another machine on the local network, anything else is cloud. Each row shows the request count and the largest request in bytes; a sum would count the same context many times.

A finding about content that reached the model says where it went: the destinations of the same agent's exchanges after the call.

Without any `llm_exchange` the report falls back to `run_start`: providers `ollama`, `lmstudio`, `llamacpp` read as a local server with the address not recorded, `spectro-local` as the built-in model on this machine, every other named provider as cloud, and an absent provider as not recorded.

### 5. Outputs

- HTML: one self-contained file, the brand tokens in light and dark with a switch, a print stylesheet that forces the light page, no script beyond the switch, no external request. Layout as in the mockup: header, verdict, destinations, findings, counts per level, all files, limits, method.
- PDF: the same HTML printed from a hidden iframe, the way `ExportDialog` prints, so the system print dialog offers "Save as PDF". The sheet says that.
- CSV: one row per finding and one per touch, columns `level, time_s, clock, call, agent, tool, what, source, file, finding, detail, destination`. UTF-8 with a byte order mark so Excel reads the umlauts, comma separated, quoted per RFC 4180. A cell that starts with `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe, so a crafted path cannot run as a formula.
- File names follow `export/html.ts`: `spectroscope-files-report-<label>-<stamp>.html` and `.csv`.

### 6. The button

A button "Report" in the files tab's header, after the model controls. It opens a small sheet with the verdict line as a preview and three buttons: PDF, HTML, CSV. One line below them says: "Covers the whole session; the filters of this tab do not apply." The sheet closes on Escape and returns focus to the button.

### 7. Guide and release

A short section in the user guide's web tab chapter (`05-web-tabs.html`), both editions, and release notes `release-notes/v0.16.1.md`.

## Not in this work

- A Word file (Q1).
- Reading files on disk, the working folder or the provider's logs. The report uses the recording only.
- Scanning the content of files a script opened, or outputs the recording does not hold.
- A report over several sessions at once.

## Things that must not happen

- A credential value, any part of one, its exact length or a hash of it in the HTML, the PDF, the CSV, the sheet, a log line or a test snapshot.
- File content in the report. Paths (shortened to the workspace and `~` as the files tab shows them), commands with masked values, counts and times only.
- A verdict that says a session is safe or that nothing leaked. With no finding above `project` the report says what it checked and that it found none of these shapes.
- A probable or model entry printed as recorded.
- A network request when the report is built or saved.

## Tests

- `report.test.ts`: every level rule and every finding kind with a positive and a negative case; placeholders counted and not raising the level; `.env.example` stays `project`; a credential used again across two calls; a credential in a prompt; the verdict for a project-only session says what was checked.
- A twin test that parses `Redaction.java` and fails when a rule is added, renamed or changed there without the TypeScript copy; each rule bitten once with a vector from `RedactionTest.java`.
- A guard over all three outputs built from a fixture full of credentials: no rule matches anywhere in the HTML, CSV or sheet text.
- CSV: byte order mark, quoting of commas, quotes and newlines, and the formula guard.
- Destinations: loopback, `:cloud` behind loopback, private address, public host, and the `run_start` fallback.
- The sheet: opens, three buttons, Escape closes, focus returns; the PDF button prints the iframe.
- Live check against a fresh jar in Chrome on a real session, both designs, both languages, the PDF opened and read.

## Left to the builder

The exact wording of the report's sentences in both languages, the order of findings within a level (time order is the default), and how the sheet looks inside the tab's existing style.
