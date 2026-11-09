# Files tab

Status: design, written 2026-11-09 for the owner's review. Card 604. Nothing is built.

## Goal

A session gets a tab `files` that shows what the run did to files: which file was touched when, by which agent and how, as seconds from the start of the run. Edits show the replaced text and its replacement in the style of a git diff. A switch at the top picks one of four views: all, diff, created files, operations. An explorer lists the files the run changed or read; a click shows what happened to the file.

The clickable mockup is `kanban/evidence/604/mockup/index.html` in the home folder (outside this repo). It uses invented data and is the reference for layout and behaviour.

## Decisions taken with the owner

| Question | Answer (owner, 2026-11-09) |
|---|---|
| Where the data comes from | Only what the session itself recorded. The server records nothing new for this tab, and nothing scans the working folder. |
| What an `edit_file` shows | The text it replaced and the text it put in its place. The whole file before and after is not needed. |
| What other file tools show | That the file was read, created or changed. |
| Shell commands | A heuristic finds the files a command probably changed and probably read. A trivial case such as `echo text > file` names the file and its text. A script whose effect cannot be read from the command is shown as "this script may have changed files", with a link that opens the script. |
| Default logic | The heuristic. |
| Model analysis | An extra button. The person picks the model for this analysis; it is not the default chat model, and a local model is allowed for sensitive data. The model reads the session's tool calls and says which file was changed how. |

The full wording is in `kanban/evidence/604/owner-words-2026-11-09.md` (home folder).

## Proposals in this document (assistant's calls, open for the owner)

- P1. The tab sits after `trace`: `chat spectrum graph trace files text lab`.
- P2. Open in learn and developer, gone in light, like the other analysis tabs (`LEARN_ONLY` in `state/surfaces.ts`). No leveling rung, so it is open from the start.
- P3. The first cut has the four views, the time cursor, the agent filter, "open in trace", the heuristic and the model analysis. It has no syntax colouring in the diff and no persistence of model results.
- P4. Every file entry carries its source: `recorded` (a file tool named it), `probable` (the heuristic found it in a shell command) or `model` (the model's reading). The view never shows a probable or model entry as recorded.
- P5. Model results live in app state only, per session, like card 294's analysis. Running it again is another click.
- P6. The lab's file footprint and the lab map count native `edit_file` as a write, and native `grep` and `glob` as reads, through shared name sets with a read and write split (see section 1). This is a visible change to the lab tab: native edits appear there for the first time.

## Calls made after the builder check (assistant's, open for the owner)

A fresh reviewer read this document as a builder on 2026-11-09 and asked seven questions. None needed the owner's answer to plan; these are the calls made, each marked in the text where it applies.

- C1. One time axis per session, prompts as markers, a prompt column in the operations table.
- C2. The tab has its own cursor and does not drive the session's stepper.
- C3. Paths resolve against the session's workspace before they are compared.
- C4. Tool names: every name `toolViews.ts` already classifies, read from that file.
- C5. P6 uses a read and write split, and card 301's lab tests move with it.
- C6. `spectro-local` is not offered in the first cut; other local providers are.
- C7. Heuristic and model findings on the same call and path merge into one entry.
- C8. The user guide's web chapter gets a short section for the tab.

## What exists today

- Tabs: `VIEW_TABS` in `spectro-web/src/state/route.ts`; per-mode presence and lazy chunks in `state/surfaces.ts`; routes carry an optional event index (`#/session/<id>@<index>/<tab>`).
- Events: `tool_call {agentId, callId, name, input, ts}` and `tool_result {callId, output, isError, durationMs, fileChange?, ts}` in `spectro-web/src/events.ts`. `fileChange` is `created`, `changed` or `unchanged` for `write_file` and `edit_file` since card 269, absent on older sessions.
- Native tool inputs: `write_file {path, content}`, `edit_file {path, old_string, new_string, replace_all?}`, `read_file {path, offset?, limit?}`, `run_command {command}`, `grep`, `glob`, `list_dir` (`spectro-core/.../tools/StandardTools.java`).
- Imported Claude Code transcripts use `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `Bash`; `components/toolViews.ts` also knows VS Code names (`create_file`, `replace_string_in_file`, `run_in_terminal`, etc.) and the three spellings of the path field (`path`, `filePath`, `file_path`).
- `lab/fileTree.ts` (card 301B) folds paths per agent and imports its name sets from `lab/labScene.ts`. Its native set `DISK_TOOLS` is `read_file`, `write_file`, `list_dir`: a native `edit_file` is not counted at all, nor are native `grep` and `glob`. Measured below, 53 successful `edit_file` calls in the recorded sessions are missing from the lab's file tree today.
- `components/ToolViewBody.tsx` already renders one edit as before and after panes (`tv-diff`), and `state/fileOpenRequest.ts` (`requestOpenFile`) opens a file in the Files panel beside the chat.
- Card 294's run analysis (`components/AnalyzeRun.tsx`, `state/runAnalysis.ts`, `spectro-server/.../llm/AnalyzeController.java`) is the pattern for the model analysis: consent sheet that shows provider, model, address and the exact text before anything is sent, NDJSON stream, reasoning off, local-origin fences, digest never logged. It always uses the configured provider and refuses `spectro-local`; the files analysis needs an explicit provider and model per call instead.
- Providers are listed by `GET /api/providers` (`spectro-server/.../providers/ProvidersController.java`), models by `GET /api/models?provider=` (`spectro-server/.../session/SessionsController.java`).

## Measurements (2026-11-09, home folder `kanban/evidence/604/`)

- 78 native session files in `~/.spectro/sessions` (`measure_file_history.py`, output `measure-2026-11-09.txt`): 53 successful `edit_file`, 181 successful `write_file` (43 created and 11 overwrites among the 54 that carry `fileChange`; 127 older ones without it), 620 `run_command`.
- Shell census (`shell_census.py`, output `shell-census-2026-11-09.txt`), counted per command; one command can carry several labels. Of the 620 native commands, 110 name a written file (redirect 68, git writes 35, `cp`/`mv`/`rm`/`mkdir`/`touch`/`tee` etc. 20, heredoc into a file 9, `sed -i` 4), 98 run a script (42 a script file, 56 inline), 66 run a package manager or build tool, 465 contain a read verb. Over 335,518 `Bash` commands in the Claude Code transcripts on this Mac, 79,812 name a written file. The census splits on newlines, so heredoc bodies count as unknown segments; it is a rough count, good for ranking the rules, not a coverage figure.

## Design

### 1. The fold

A pure function `foldFiles(events): FileLedger` in a new module `spectro-web/src/files/fold.ts`. It runs over the same event list the other tabs get (live, loaded or imported) and is memoised per list.

```ts
type Source = "recorded" | "probable" | "model";
type TouchKind = "read" | "create" | "change" | "overwrite" | "write" | "append" | "delete" | "unknown";

interface FileTouch {
  path: string;          // exactly as the tool named it, normalised for display only
  folder: boolean;       // a folder or a search pattern, not a file
  kind: TouchKind;
  source: Source;
  reason: string;        // why this entry exists, shown next to it
  callIndex: number;     // index of the tool_call in the event list, for the trace link
  agentId: string;
  t: number;             // seconds from the run start
  replaced?: { old: string; new: string }[];  // edit_file, Edit, MultiEdit, sed s///
  content?: string;      // write_file, Write, heredoc, echo
  appended?: string;     // >> with known text
}

interface FileCall {     // one tool call that touched files, for the operations views
  callIndex: number; agentId: string; t: number; tool: string;
  line: string;          // path or command, one line
  failed: boolean;       // tool_result.isError or an ERROR answer
  script?: string;       // the script a shell command ran, when it names one
  touches: FileTouch[];
}
```

Rules:

- Seconds count from the session's first event. A session with several prompts keeps one axis: a native session records one `run_start` per prompt, an import records the first prompt as `run_start` and later ones as user turns, and each prompt becomes a numbered marker on the timeline. The operations table gets a prompt column. (C1)
- Paths are compared after resolving them (C3). A relative path resolves against the session's workspace: `run_start.workspace` for native sessions, the transcript's `cwd` for an import when the importer carries it (the Claude Code importer does not set `workspace` today; passing `cwd` through is an additive change). An absolute path inside the workspace shows relative to it, one outside shows in full. The shell heuristic starts in that same folder and follows `cd`. With no workspace known, paths stay as written and the explorer says so in one line.
- `write_file` and `Write`: `create` when `fileChange` is `created`, `overwrite` when `changed`, `write` with reason "existence not recorded" when the field is absent, and no change entry when `unchanged` (the call still lists, with "no change").
- `edit_file`, `Edit`, `MultiEdit`: `change`, with each old and new string pair in `replaced`. Nothing else is reconstructed.
- `read_file`, `Read`: `read`; a paged read keeps its range in `reason`.
- `grep`, `glob`, `list_dir`, `Glob`, `Grep`: `read` of a folder or pattern (`folder: true`).
- A call whose result is an error lists as failed and produces no touch.
- Subagent calls carry their own `agentId`; the agent filter works on it.
- The name sets come from one place, split into reads and writes. Today `lab/labScene.ts:221-228` and `lab/fileTree.ts:123` treat every native `DISK_TOOLS` name except `write_file` as a read, so adding `edit_file` to `DISK_TOOLS` alone would show edits as reads. Instead, a shared module exports a native read set (`read_file`, `list_dir`, `grep`, `glob`, `view_file`, `view_image`) and a native write set (`write_file`, `edit_file`), beside the existing imported sets; the fold, the lab map and the lab footprint all read them, and card 301's tests are updated to the new counts (P6, C5). No third copy of a name list.
- Tool vocabularies in scope: every name `components/toolViews.ts` already classifies as a read, a write, an edit or a shell call. That is the native names above, Claude Code (`Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `Bash`) and the VS Code names it knows (`create_file`, `replace_string_in_file`, `run_in_terminal`, etc.). The builder takes the list from that file rather than from this document. (C4)

### 2. The shell heuristic

A pure function `shellTouches(command, cwd): FileTouch[]` in `spectro-web/src/files/shell.ts`, called by the fold for `run_command`, `Bash` and `run_in_terminal`. Every result has `source: "probable"` and a `reason` that names the rule and the matched fragment.

It needs a real tokenizer: quotes, escapes, `&&`, `||`, `;`, pipes, subshells, and heredocs, whose body is text and never a command. A leading `cd dir &&` moves the base folder for the rest of the line. `/dev/null`, file descriptors and unresolved variables are skipped; a path outside the workspace is kept and shown in full.

Rules, ranked by the census:

| Pattern | Touch |
|---|---|
| `> f`, `>> f` after any command | `overwrite` or `append` of f; text known when the command is `echo` or `printf` with a literal |
| `cat > f <<EOF`, `cat >> f <<EOF`, `tee f <<EOF` | `create`/`overwrite` or `append` with the heredoc text |
| `cp a b`, `mv a b`, `rm f`, `mkdir d`, `touch f`, `ln`, `unzip`, `tar -x` | read a, write b; delete a, create b; delete f; create d; etc. |
| `sed -i ... f` | `change` of f; a single `s/x/y/` substitution goes into `replaced` |
| `git checkout -- f`, `git restore f`, `git apply`, `patch` | `change` of the named files, else `unknown` of the repo folder |
| `npm`/`pnpm`/`yarn` `install`/`add`/`remove`, `uv add`, `pip install` into a project, `cargo add` | `change` of the manifest and lockfile the tool usually writes |
| `cat`, `head`, `tail`, `less`, `wc`, `diff`, `grep`, `rg`, `awk`, `sed` without `-i`, `jq`, `ls`, `find`, `tree`, test runners with file arguments | `read` of the named files or folders |
| `python f.py`, `node f.js`, `bash f.sh`, `./f`, etc. | `read` of the script, `unknown` for every path-like argument, `script` set on the call |
| `python -c`, an interpreter fed a heredoc | `unknown`, reason "inline script", no link |
| `git status`, `git log`, `git diff`, `pwd`, `which`, `echo` without redirect | nothing |

A command that matches nothing lists in the operations with "no file named". The heuristic never reads command output; that is the model's job.

### 3. The model analysis

UI, in the tab's toolbar: a switch `heuristic | heuristic + model`. With the second, a model picker and a button "analyze with model" appear.

- The picker lists provider and model pairs from `/api/providers` and `/api/models`, local providers included (Ollama, LM Studio, llama.cpp and the other providers the registry runs on this machine or network). The built-in model `spectro-local` stays out of the first cut: the analysis path refuses it today for a wiring reason (`AnalyzeController.java:141` and `:190`), and enabling it is a piece of work of its own. (C6) It starts empty on first use, so nothing runs on the chat's default model by accident; afterwards it remembers the last pair chosen for this feature in `localStorage`, wrapped in try/catch.
- The button opens a consent sheet in the style of card 294: provider, model, address, a line that says whether the address is on this machine, and the exact text that will be sent, scrollable. Nothing is sent before the person confirms.
- What is sent (the digest): one line per file-relevant tool call with seconds, agent, tool, the path or the full command, and for shell commands their output cut to 2,000 characters. Contents written by `write_file` and `edit_file` are not sent. Total bound 60,000 characters, the same as card 294; above it the oldest outputs are cut first and the sheet says so.
- The model is asked for JSON: a list of `{callIndex, path, kind, reason}`. Each entry becomes a touch with `source: "model"` on that call. There is one touch per call and path (C7): when the model names a path the heuristic already named on the same call, the existing touch takes the more specific kind (create over change over unknown), gains the model's reason, and its tag shows both sources (`probable · model`). File counts do not change through such a merge. An answer that is not valid JSON shows as the model's text in a note and adds no touch. Entries that name a `callIndex` the digest did not contain are dropped.
- Server: a new endpoint, for example `POST /api/files/analyze {digest, provider, model, lang}`. It streams NDJSON like `/api/analyze` (meta line with provider, model and address, deltas, done or error). It keeps that endpoint's rules: reasoning off, the same two origin fences, the same body bound, the digest never logged, a fixed error sentence for an empty answer. It builds the provider for the requested pair instead of the configured default, and it allows local providers. A pre-flight `GET /api/files/analyze/engine?provider=&model=` answers whether that pair can run, so the button never fails after consent.
- The result lives in app state per session (P5). The status line says which model's reading is shown.

### 4. The views

All four share the toolbar, the timeline and the selection (a call and a file). The mockup shows each one.

- Toolbar: view switch `all | diff | created | operations`, diff style `unified` or `before | after` (two choices, as in the mockup), agent chips, and the heuristic and model controls. Below them a summary line counts the files changed by file tools, the files probably changed by shell commands (or by the model's reading), the files only read, the shell commands and the scripts with unknown effect.
- The tab keeps its own cursor (C2). Dragging or playing it does not move the session's stepper, so chat, trace and lab stay where they are. When the tab opens from a route with an event index, its cursor starts at that event; "open in trace" seeks the shared stepper the way any route with an index does.
- Timeline: one row per path plus a row "shell commands". Each touch is a vertical line at its second: teal for create, amber for change, faint and short for read; dashed for `probable`, a ring for `model`. A cursor can be dragged or played; touches after the cursor are dimmed in every view. Clicking a line selects its call and file. Left and right arrow keys step through calls.
- Explorer: two groups, "changed or probably changed" and "read or probably read", as a folder tree. Each file shows a letter (A created, M changed, R read, D deleted, ? a script may have changed it) and its source tag; a dashed letter is not `recorded`. Files not yet touched at the cursor are dimmed with the second they first appear.
- Operations list (in `all`): the calls of the selected file, or all calls when none is selected.
- Detail: the call's seconds, agent, tool, "open in trace" (route with the call's event index) and, for a script, "open <script>" (`requestOpenFile`; disabled with a note when the session's folder is not available, as for many imported runs). Then one block per touch: source tag, path, kind, reason, and the text: replaced pairs as a diff, written content as added lines, appended text as added lines. A shell command shows its command and output first. "previous change" and "next change" step through the changes of the selected file.
- `diff`: explorer and a wide detail.
- `created`: one card per created file with its content when known, the creating call, and a link into the diff view.
- `operations`: a table of every call with seconds from the start, agent, operation, the call line, the files it touched with their source tags, and the tool; the detail sits below.

A live session updates as events arrive. The cursor follows the end until the person moves it.

### 5. Wiring

- `VIEW_TABS` gets `files` after `trace`; `SURFACES.files` is `LEARN_ONLY` with its own chunk (`files/FilesView.tsx`); route parsing, the shell command router (`/tab files` or its equivalent) and the surface guards pick it up from those tables.
- Strings in EN and DE through `spectro-web/src/i18n/i18n.ts`. Colours from tokens only, both designs.
- `components/ModeIntro.tsx` imports `VIEW_TABS` and must keep working with the new entry.
- The user guide gets a short section for the tab in its web chapter (`docs/guide-assets/parts/04-web-chat.html`), so the docs move with the feature. (C8)

## Not in this work

- Rebuilding whole files before and after, server-side snapshots, scanning the working folder, tracking the browser. (Owner, 2026-11-09.)
- Syntax colouring in the diff, persisting model results, reverting or editing files from the tab.

## Things that must not happen

- A probable or model entry that looks recorded.
- Anything sent to a model without the consent click, or on a model the person did not choose.
- A command output or digest written to a log.

## Tests

The house discipline applies: red first, mutation bites, full gates (`./gradlew test --rerun-tasks --no-build-cache`, `npm run gate`, `./gradlew javadoc`), live check against a freshly built jar in both designs and both languages.

- Fold: fixtures for each native and imported tool name, `fileChange` present and absent, failed calls, subagents, MultiEdit with several pairs.
- Heuristic: one fixture per rule row above, plus the traps: heredoc bodies that look like commands, `2>&1`, `> /dev/null`, quoted `>` inside a string, `cd x &&` prefixes, pipes into `tee`.
- A drift guard that the fold, the lab footprint and the lab map read the same name sets.
- Server: the endpoint's fences, body bound, explicit provider and model, local provider allowed, empty answer error, digest not logged.
- Component: the four views on a recorded fixture session, keyboard stepping, the consent sheet blocks sending until confirmed.

## Left to the builder

Component structure, the tokenizer's implementation, how `ProviderFactory` builds a provider for an explicit pair, the exact JSON prompt, and the layout breakpoints, as long as the result matches the mockup and the rules above.
