# Playbook run view

Status: design, approved in conversation on 2026-10-13, written for review. Card 586.

## Goal

A playbook run, and a workflow run, becomes one living plan beside the chat. Every step and every decision shows who works on it (the chat or which helper, on which model), what it was given (the task, its goal, the documents it reads), what came out (its answer, the documents it wrote, the files its agents changed), its status and its duration. The run's graph and the plan are one view. A compact panel opens beside the chat when a run starts; a button widens it to the full window.

## Decisions taken with the owner

| Question | Answer |
|---|---|
| Where to follow a run | Both: a compact panel beside the chat, and a wide view of the same panel |
| Which "workflow view" joins the plan | The run's graph (the lit state graph of the run) |
| The old run view in the Playbook segment | Replaced; the Playbook segment configures and edits only |
| Workflow runs (`/playbook workflow`) | Same view |
| Where the data comes from | A new event per step and decision, written to the session file |
| Compact panel | As in the mockup of 2026-10-13 (graph strip on top, one card per step) |
| Wide view | The panel takes the full width; "small" brings the chat back |
| Documents under dot folders such as `.superpowers/` | May open, but only files a run itself recorded as written documents; never `.env`, never anything under `.git` |
| Release | With the release of 2026-10-13 |

## What exists today

- The Plan panel (`spectro-web/src/components/PlanTab.tsx`) draws `{text, status}` rows of the latest `plan` event. During a playbook run the runner emits one `[id] name` row per forward-path node (`PlaybookRunner.emitPlan`), all branches included; a failed node stays `in_progress`. The panel is closed by default and nothing opens it.
- The run view (`spectro-web/src/playbook/PlaybookRunView.tsx`) sits in the Playbook segment, developer mode only, and polls the run list and the graph file every second. It shows a status line, the task and `StateGraphView` with node ids and timings.
- `playbook_progress` gives the chat three kinds of lines: start, step start, end (`RunEvent.PlaybookProgress`, frozen by `PlaybookWireFreezeTest`).
- The runner knows per step: performer, role or agent, provider and model, whether the model was picked, the step record text, the documents it reads (`documents` channel), the documents it wrote (`changed(...)`), the child id, the chat turn's last text or the child's outcome, success, duration; per decision: check kind, label, round count, detail. Most of it reaches only the sidecar (`<session>.playbook.jsonl`) or nothing.
- File tool events (`tool_call` with a path, `tool_result.fileChange`) carry the agent id but no step.
- A workflow run (`WorkflowRunner`) emits no plan, no start or end line and no graph file.

## Design

### 1. The event

A new additive RunEvent `run_step` (Java record `RunEvent.RunStep`, `@JsonInclude(NON_NULL)`), agent id `playbook` for both run kinds. Existing records, `playbook_progress` and `plan` included, stay unchanged; the runner keeps emitting them, so the chat lines, the footer rule and old readers behave as before.

Fields, by phase:

| Field | run_start | step_start | step_end | run_end |
|---|---|---|---|---|
| `runId`, `runKind` (`playbook` or `workflow`), `phase`, `ts` | yes | yes | yes | yes |
| `name` (playbook or workflow name), `task` | yes | | | |
| `nodes`: the forward path `[{id, name, kind}]` | yes | | | |
| `node`, `name`, `kind` (`step`, `decision`, `prompt`, `fanout`), `entry` (1 for the first entry of a node, then 2, 3 on a loop) | | yes | yes | |
| `performer` (`chat` or `child`), `role` (worker, explore, research, or the agent name) | | yes | | |
| `provider`, `model`, `picked` (true when the owner picked it in the start sheet) | | yes | | |
| `input`: the step record text, at most 4,000 characters, plus `inputChars` | | yes | | |
| `reads`: `[{doc, path}]` the documents the step is told to read | | yes | | |
| `round`, `maxRounds` (decisions with a loop) | | yes | yes | |
| `status`: `done`, `failed` or `stopped` | | | yes | |
| `durationMs` | | | yes | yes |
| `childId` (a child step, a review child), `children` (a fan-out) | | | yes | |
| `output`: the chat turn's last text, the child's result text, or the check's detail, at most 4,000 characters, plus `outputChars` | | | yes | |
| `documents`: `[{doc, path, change}]`, `change` is `created` or `changed` | | | yes | |
| `label` (the decision's outcome, `exhausted` included) | | | yes | |
| `error` | | | yes | |
| `stopReason`, `result`, `detail` | | | | yes |

Rules:
- Every `step_start` has exactly one `step_end` with the same `runId`, `node` and `entry`, also when the step fails, is stopped, or the host throws.
- `run_start` is emitted after the refusal check passes; a refused run emits `run_start` and `run_end` with `stopReason` refused and no steps.
- Texts are cut at 4,000 characters with the full length in `inputChars` or `outputChars`. The full texts stay where they are today: the chat turn, the child's thread, the llm wire.
- `documents.change` is `created` when the path was not in the step's snapshot before it ran, `changed` otherwise.

### 2. Where the runners emit it

- `PlaybookRunner`: `run_start` beside `playbook_progress` start (after the refusal check), `step_start` after model resolution in `step(...)` and at the top of `decide(...)`, `step_end` in every exit path of `step(...)` and `decide(...)` (beside `recordStepEnd` and `recordCheck`), `run_end` in `end(...)`. The review child's id comes back from `ReviewCheck.run` with its result.
- `WorkflowRunner`: `run_start` in `run()`, `step_start` and `step_end` per `prompt` and `fanout` step (a fan-out's `children` are the child ids it spawned, its `output` is the summary), `run_end` in `end(...)`. A workflow run has no graph file; `nodes` is its step list in order.
- The sidecar stays as it is.

### 3. Opening a run's documents

Amended on 2026-10-13 to the route as built (Task 5 and its straggler round; Task 11 of the plan).

`GET /api/run-document?session=<id>&run=<runId>&path=<path>` serves a file only when:
1. the session's file holds a `run_step` `step_end` of that run whose `documents` list names exactly that path; a document a step only reads is no record;
2. when the run's `run_start` carries `workspaceFingerprint` (the first 16 hex digits of the SHA-256 of the run's real working folder, never the path), the fingerprint of the session's current real folder equals it; a `run_start` without the field, written before it existed, skips this check;
3. no name is a secret, in any letter case, checked on the asked path and again on its real path: `.env`, a name starting with `.env.` or `.env-`, `.envrc`, `.netrc`, `.npmrc`, a name ending `.pem`, `.key`, `.p12` or `.pfx`, and no segment is `.git`, `.aws` or `.ssh`; a `.git` segment anywhere on the absolute real path refuses too;
4. the path, resolved to its real path, lies inside the session's workspace;
5. it is a regular file under the existing preview size cap, opened without following a link.

A malformed session or run id answers 400; everything else that is refused answers 404, so a refusal reads like a missing file. The route sits behind the same local fence as `/api/file` and answers a non-local caller with 404. The web opens such a document only on a press, never by polling: a path with a dot segment goes through this route, any other path through `/api/file`, and both open in the Files panel's preview. A read document's path is optional: a read without a path is shown as a name without a link.

How a run ended comes from its `run_end.stopReason` alone (`done`, `aborted` read as stopped, anything else failed); an exhausted decision reads "limit of N rounds reached".

### 4. Web state

- `events.ts` and the reducer learn `run_step`; a pure fold `state/runView.ts` turns the events of a session into runs: per run its kind, name, task, forward path, status, start and duration, and an ordered list of entries (one per `step_start`, loops give a second entry of the same node).
- Each entry carries its fields from section 1 and two joins made in the fold, in event order:
  - files: `tool_call` and `tool_result` of the entry's agents between its `step_start` and `step_end` (the child id and its descendants for a child step, `main` for a chat step), file tools only (`write_file`, `edit_file`, and the imported Write, Edit and MultiEdit), errored and denied calls left out, one row per path with the last `fileChange`; shell calls counted, not read;
  - live line: the last line of text the entry's agent streamed while the entry is running.
- A status `waiting` shows while a `question_asked` with a `pb-<runId>-` call id is open inside the entry.
- At `run_end` every node of the forward path that was never entered gets the status `skipped`.
- Sessions recorded before this card have no `run_step`; the panel then shows the `plan` list as today.
- The trace lists `run_step` rows like other events; the Lab, Spectrum and the agent roster do not turn the `playbook` agent id into an agent.

### 5. The compact panel

- The dock panel `plan` keeps its id. While the session has a run, it shows the run; a plan the model wrote with `update_plan` shows under it as "Plan of the model".
- It opens itself when a `run_step` `run_start` arrives (a new dock opener, added to `dockOpeners.drift.test.ts`).
- Top: the run's name, task, status and running time, a run picker when the session holds more than one run, and the "wide" button.
- Below: a graph strip of the forward path, one mark per node (done, running, waiting, failed, skipped, pending; decisions as diamonds).
- Below: one card per entry in time order, then the not yet entered nodes greyed. A card shows name, status, duration, who (chat or helper id, role), model (with "picked" when the owner picked it), "in" (the documents it reads), "out" (written documents with created or changed). The running entry is expanded with its live line. A decision shows its kind, outcome and round, for example "Review, round 2 of 5: changes needed".
- A click on a card scrolls the chat to the entry's turn (chat step) or opens its thread (child step) and marks it; a click on a document or file opens it in the preview.
- Available in learn, light and developer mode.

### 6. The wide view

- "Wide" turns the same panel to the full width of the chat tab; the chat collapses until "small". The setting lives in the layout state like the other dock settings.
- Top: the run's graph. A playbook run uses `StateGraphView` on the run's graph file, with node labels from the event's names and the node status from the entries; a workflow run draws its step list as a chain.
- Below: the selected entry in full (default: the running entry, else the last): who, model, picked; in (task, goal, read documents with paths, the step's input text); out (the output text, written documents, changed files with created or changed, the count of shell commands whose files are not captured); helpers of the step with their state; for a decision its rounds and outcomes. "In the chat" jumps to the entry.
- A click on a graph node selects that node's latest entry.

### 7. The Playbook segment

`PlaybookRunView` leaves the Steps tab. The segment keeps the definition graph, the step table, contents and workflow list, and gains one line "Runs of this session: open" that switches to the chat with the run panel wide. The run list route and the graph file route stay; the wide view uses the graph file route.

### 8. The chat

The `playbook_progress` start line gets a link "open the run" that opens the panel. Workflow runs get a start and an end line from `run_step` (`run_start`, `run_end`), worded "Workflow X started on: ..." and "The workflow ended. Result: ...".

## Error handling

- A runner exception between `step_start` and its end still emits `step_end` with `status` failed and the error (finally blocks).
- Stop emits `step_end` with `status` stopped for the running entry and `run_end` with the stop reason.
- An unreadable document path or a path outside the workspace never reaches an event: the runner only records paths it found inside the workspace.
- The web fold ignores a `step_end` without its `step_start` (cut sessions) and closes still running entries as `stopped` when the run's `run_end` arrives.

## Testing

- Core: `PlaybookRunner` with the fake host emits `run_step` in the order of section 1 for a chat step, a child step, a decision with a loop and an `exhausted` exit, a failed step, a stopped run, a refused run; documents with created and changed; output and input cut at 4,000 characters with the lengths. `WorkflowRunner` for prompt and fan-out steps. A freeze test for the new record's components and its JSON names.
- Server: the session file holds `run_step` lines; the document route serves a recorded path, refuses a path not recorded, `.env`, `.env.local`, a path under `.git`, a symlink out of the workspace, a directory, a foreign session.
- Web: the fold for every case above, the file join, `waiting`, `skipped`, legacy sessions; the panel and the wide view render tests; the dock opener; the archive fixture carries `run_step`; i18n EN and DE.
- Every new test red on the old code first; mutation bites on every guard.
- Browser: Playwright against the installed Chrome channel, both themes, a narrow and a wide window, a recorded run replayed into the web app.
- Live: in the test app, a run of the bundled spectro playbook against the house test backend, the panel opening, cards updating, a document under `.superpowers/` opening, Stop during a step.

## Not in this card

- Files written by shell commands, MCP tools or git; the card says how many shell commands ran.
- A diff view of a file before and after a step.
- Serving the sidecar to the web.
- Changing `playbook_progress`, `plan` or their readers.
