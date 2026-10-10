# P2 Playbook Format and the spectro Playbook Design

Sub-project 2 of the playbook concept (home repository, private, sections 3, 4 and 7). Written 2026-10-09 against `spectroscope-harness/spectro` main `1cba586c`. Target location after the 0.14.4 release run: `docs/superpowers/specs/2026-10-09-playbook-format-design.md` in the product repo. Nothing in this file names employer material.

## Goal

A playbook is a folder a team shares. Version 1 of the module reads such a folder, validates it, draws its graph, lists its steps with what each consumes, produces and runs on, and ships one playbook (spectro, built on spectropowers) that a button copies into a folder of the owner's choice. The developer mode is the third view mode and holds the module. Nothing runs by a playbook yet (P3) and nothing is edited with the mouse yet (P4).

## Owner decisions this spec follows

| Decision | Source |
|---|---|
| A playbook lives in a separate folder the owner picks, its own repository | D2 |
| For teams from the start: the file carries provider and model names with fallbacks, never keys, addresses, hooks or a wider permission mode | D3 |
| A switch per step: private or cheap | D4 |
| developer is a third mode now, learn without the tutorial plus the module, a third choice at first start | D5 |
| Names: playbook, step, decision, arrow, end | D6 |
| Human approval optional per step, default none; handover documents are the point | D13 |
| A chat step may carry a model too | D14 |
| spectropowers: copy of the fourteen superpowers skills, structure kept, house rules worked in, licence and provenance carried | D15 |
| A playbook is a superset of a plugin: skills, agents, hooks, commands, workflows, a meta JSON that is also the graph, a documentation HTML | D16 |
| The corporate process model is out | D17 |

## Today

- Modes: `ViewMode = "learn" | "light"` (`state/viewMode.ts:15`), an unknown word reads as learn (`:47 to 49`), `ModeSwitch.tsx:47, 57` label any third word "learn", the surface table has a column per mode (`state/surfaces.ts:48 to 87`), six tests pin the pair and four guard loops iterate the literal pair (`surfaces.guard.test.tsx:90, 124`, `firstStart.guard.test.tsx:107, 118`, `firstStart.test.ts:70`). Outside learn the tutorial question is answered off (`state/firstStart.ts:33, 49`). The first start screen draws its choices from `VIEW_MODES` (`ModeIntro.tsx:12`).
- Segments: `NavSegmentId = "sessions" | "fleets" | "stategraph"` (`navRows.ts:29`), rows in `navSegmentRows` (`:114 to 163`), the App arm at `App.tsx:2739`, the pane in its own chunk (`surfaceChunks.ts:60`).
- Drawing: `layoutStateGraph(topo, orientation)` (`stategraph/layout.ts:264`) over the web `Topology` (`entry`, `nodes {id,label}`, `edges {from,to,kind}`, `layout.ts:49 to 62`), consumed by `StateGraphView.tsx:168` and `lab/workflow/WorkflowLens.tsx:197`; a renderer that states sizes reads `PlacedNode.w` and `.h` (`layout.ts:121, 134`); the engine draws cycle edges as loops and never reverses them.
- The Java side has `Topology(schemaVersion, entry, nodes, edges, branches)` (`Topology.java:39 to 83`) with Jackson; no YAML library on either side (A3).
- Skills: `SkillLibrary.defaultRoots(cwd)` is the user root `~/.spectro/skills` and the project root `<cwd>/.spectro/skills` (`SkillLibrary.java:96 to 100`); a pack install advertises `<pack>:<name>` (`:102 to 110`); lookup is exact (`:197 to 199`); the skill frontmatter parser is flat key and value (`:555 to 580`). The vendored catalogue `.spectro/skills-catalogue/superpowers/` ships `LICENSE`, `PROVENANCE.json` and the skills (card 182, `SkillCatalogue.java`); `GET /api/skills` lists installed skills as `{name, folder, pack, description}`.
- Scaffold: `BundleController.scaffold` writes a map of files into a picked folder and refuses to overwrite (`BundleController.java:96 to 133`), behind the loopback and Origin fence.
- Workspace settings: a workspace file may not set process global keys; the loader strips and reports them (`SpectroConfig.java:1612 to 1613`, `1957 to 1966`).

## Design

### The bundle

```
<playbook>/
  playbook.json
  skills/<name>/SKILL.md ...
  agents/<name>.md
  hooks/hooks.json
  commands/<name>.md
  workflows/<name>.js
  templates/<document>.md
  docs/index.html
  LICENSE
  PROVENANCE.md
```

`playbook.json`, schema version 1:

```json
{
  "schema_version": 1,
  "id": "spectro",
  "name": "spectro",
  "description": "Brainstorm, spec, plan, build with review, finish.",
  "models": {
    "fast":     { "primary": { "provider": "ollama", "model": "qwen3:8b" }, "fallbacks": [] },
    "standard": { "primary": { "provider": "anthropic", "model": "claude-sonnet-5-5" }, "fallbacks": [] },
    "strong":   { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" }, "fallbacks": [] },
    "judge":    { "primary": { "provider": "anthropic", "model": "claude-fable-5-1" }, "fallbacks": [] }
  },
  "documents": {
    "ticket": { "name": "Ticket", "purpose": "What is wanted, with scenarios", "location": "kanban/{n}-{slug}.md",
                "template": "templates/ticket.md", "sections": ["Story", "Acceptance criteria", "Scenario"] },
    "spec":   { "name": "Spec", "purpose": "The design", "location": "docs/superpowers/specs/{date}-{slug}-design.md",
                "template": "templates/spec.md", "sections": ["Goal", "Design", "Requirements"] }
  },
  "checks": {
    "spec_sections": { "kind": "sections", "documents": ["spec"] },
    "tests_green":   { "kind": "command", "run": "{test}" },
    "spec_nod":      { "kind": "human", "ask": "Does the spec say what you want built?", "labels": ["yes", "no"] }
  },
  "vars": { "test": "./gradlew test --rerun-tasks --no-build-cache" },
  "start": "classify",
  "nodes": [
    { "kind": "decision", "id": "classify", "name": "Classify", "check": "classify_check", "outcomes": ["spike", "bounded", "architectural"] },
    { "kind": "step", "id": "brainstorm", "name": "Brainstorm", "performer": "chat", "skills": ["spectropowers:brainstorming"],
      "model": "strong", "privacy": "cheap", "permission": "inherit", "consumes": ["ticket"], "produces": ["spec"], "nod": false },
    { "kind": "decision", "id": "spec_ok", "name": "Spec complete", "check": "spec_sections", "max_rounds": 3 },
    { "kind": "end", "id": "done", "result": "done" }
  ],
  "arrows": [
    { "from": "classify", "to": "brainstorm", "on": "architectural" },
    { "from": "brainstorm", "to": "spec_ok" },
    { "from": "spec_ok", "to": "write_plan", "on": "pass" },
    { "from": "spec_ok", "to": "brainstorm", "on": "fail" },
    { "from": "spec_ok", "to": "done", "on": "exhausted" }
  ],
  "contents": {
    "skills": ["skills/spectropowers"],
    "agents": [], "hooks": [], "commands": [], "workflows": []
  }
}
```

Node kinds and fields:

| Kind | Fields |
|---|---|
| `step` | `id`, `name`, `goal` (optional text), `performer` (`chat` or `child`), `role` (child only: `explore`, `worker`, `research`), `skills` (installed names), `model` (a key of `models`), `privacy` (`private` or `cheap`), `permission` (`inherit`, `readonly`, `ask`, `auto`), `consumes`, `produces` (document ids), `nod` (boolean) |
| `decision` | `id`, `name`, `check` (a key of `checks`), `outcomes` (labels; omitted means the check's own labels: `pass`, `fail` for `sections`, `open_items`, `command`; the declared `labels` for `review` and `human`), `max_rounds` (required when any arrow out of this decision leads to a node that can reach this decision again; it adds the outcome `exhausted`) |
| `end` | `id`, `result` |

Checks: `sections` (documents, forbid), `open_items` (documents), `command` (run, with `{var}` substitution from `vars`), `review` (model, reads, labels), `human` (ask, labels, reads).

Rules the validator enforces (every violation names the node or key):

1. `schema_version` is 1. `id` matches `[a-z][a-z0-9-]*`.
2. Node ids are unique; `start` names a node; every node is reachable from `start`; every node can reach an `end`.
3. Every node that is not an `end` has exactly one arrow per outcome, and no arrow carries an outcome the node does not have. A `step` has one outgoing arrow with no `on`.
4. Every arrow that leads back to a node that can reach its source passes through a decision with `max_rounds` (every loop has a ceiling).
5. `model` names a key of `models`; `check` names a key of `checks`; `consumes` and `produces` name keys of `documents`; `skills` entries are non empty strings (whether they are installed is a load time finding, not a validation error).
6. `permission` is never `extended`. Keys named `apiKey`, `key`, `baseUrl`, `endpoint`, `address`, `hooks`, `mcpServers`, `autoApprove` anywhere in the file except as the list names of the `contents` object (whose entries are paths, rule 8) are refused with their path (a shared folder may not route material or widen rights, D3).
7. `vars` used in a `command` check are declared; locations use only declared vars plus `date`, `slug`, `n`.
8. Each path in `contents` exists under the folder and stays inside it (no `..`, no absolute path, no symlink escape).

Reserved for later, parsed and refused with "not supported in version 1": node kinds `split` and `join`, a `fallback_chain` on a step, a `sub_playbook`.

### The spectro playbook and spectropowers

The product ships one playbook as classpath resources under `bundled-playbooks/spectro/`. A route copies it into a folder the owner picks, refusing to overwrite, the way the starter scaffold does.

spectropowers is the vendored superpowers catalogue copy (`.spectro/skills-catalogue/superpowers`, MIT, Jesse Vincent) renamed to the pack `spectropowers`, every skill keeping its folder name and structure, with the house rules worked into the text (D15). `LICENSE` is the MIT text of the source; `PROVENANCE.md` names the source repository, the version from the catalogue's `PROVENANCE.json`, the date of the copy and every file that was changed with one line on what changed. The changes, one per conflict reader 10 found:

| Skill | Change |
|---|---|
| `brainstorming` | the bounded path writes a short numbered plan into the ticket before implementation; a ticket with technical and non functional requirements and Gherkin scenarios is the input of every path; after the spec, run chris-criticism (a stress test step) before the user review gate |
| `writing-plans` | the plan header names the ticket and the spec; explicit staging paths in every commit step |
| `subagent-driven-development` | architecture, language, repository and scope conflicts stop and go to the owner; rulings are written to the project's TASKS.md and CLAUDE.md, not only the final message; the ledger is kept, not deleted; implementers write the failing test first for every task; the implementer tier follows the model per role rule (building on opus, reading on sonnet, mechanical on haiku, judgment on fable); reviews may run in the background while the next task starts |
| `executing-plans` | same stop rule for conflicts; progress into TASKS.md |
| `test-driven-development` and `writing-good-tests` | the mutation probe is real (commit first, break the implementation, see red, restore), never mental |
| `verification-before-completion` | gates run with forced rerun and never through a pipe; UI work is verified in both themes at two widths in a browser |
| `finishing-a-development-branch` | merge with `--no-ff`; the rulings list goes into TASKS.md; after the final review, run chris-criticism once |
| `requesting-code-review` | the base is the merge base of the branch, never `HEAD~1` |
| `using-superpowers` | renamed to `using-spectropowers`; the rule that user instructions override skills is kept and stated first |

The playbook graph of spectro: classify (decision: spike, bounded, architectural); the architectural path brainstorm, spec check (sections), spec nod (human, optional, on in the shipped file), write plan, plan check, plan nod (on), setup worktree, build loop (implement task, review task, fix with a round limit of 5), final review, finish; the bounded path short design in chat, implement with TDD, finish; the spike path probe, recommendation, end. Model choices `fast`, `standard`, `strong`, `judge`. Document types ticket, spec, plan, task report, review report. A3's draft in the session scratchpad is the starting point; the validator proves the shipped file.

`docs/index.html` is generated from `playbook.json` by a deterministic script (`scripts/build_playbook_docs.py`, stdlib only): the graph as SVG (the same layout rules as the web, rank by longest path, loops drawn back), one section per step with its documents and model, one per document type with its sections, the licence and provenance. The second run is byte identical; a test runs the script and compares.

### The developer mode

`ViewMode = "learn" | "light" | "developer"`. developer opens everything learn opens, minus the tutorial (the existing rule for every mode but learn), plus the `playbook` segment. `SURFACES` gains a `developer` column; `tabRow` is `open` and `leveling` is `tutorial` in developer, so the two can no longer share one record. `ModeSwitch` labels and titles come from a map keyed by mode, and `asMode` reads `VIEW_MODES`. The guard loops derive from `VIEW_MODES`. `ModeIntro` gets `mode.intro.developer.*` strings. The six background gates stay on in developer.

### The playbook module

A fourth segment `playbook` (`NavSegmentId`), present only in developer, in its own chunk `playbook/PlaybookPane.tsx`:

- Folder picker: the known playbook folders (from `~/.spectro/playbooks.json`), the active one for the session's workspace, a text field to add a folder by absolute path, and a button "copy the spectro playbook into a folder" that calls the copy route and registers the folder.
- The graph: `layoutStateGraph` over the topology the server returns, drawn by `PlaybookGraph.tsx`, a renderer of its own that states a card size (label, model, performer) and reads `PlacedNode.w` and `.h`; decisions as diamonds, ends as rounded boxes, outcome labels on arrows from `RoutedEdge` label anchors.
- The step table: one row per step: name, performer, skills with "installed" or "not installed" (from `GET /api/skills`), model choice with the provider's state (from P1's registry rows when present, else the presence word from `/api/config`), privacy, documents consumed and produces, nod.
- Problems: the validator's findings, one line each with the node or key.
- A sentence stating that runs do not follow the playbook yet.

### Server

New package `dev.spectroscope.core.playbook` (core, so the P3 runner can use it): `Playbook` and its records, `PlaybookReader` (Jackson, strict: unknown fields are findings), `PlaybookValidator` (returns a list of `Finding(String path, String message)`), `PlaybookTopology` (a `Topology` for drawing: steps and decisions as nodes, arrows as edges with `conditional` kind and the outcome as the branch name, `__start__` and `__end__` from the engine's constants).

New package `dev.spectroscope.server.playbooks`: `PlaybookFolders` (`~/.spectro/playbooks.json`: known folders, active folder per workspace path), `PlaybookController`:

| Route | Does |
|---|---|
| `GET /api/playbooks` | known folders, the active one for `?workspace=` |
| `POST /api/playbooks/folders` `{dir}` | registers a folder that holds a `playbook.json`; fenced |
| `PUT /api/playbooks/active` `{workspace, dir}` | pins a folder to a workspace; fenced |
| `GET /api/playbooks/load?dir=` | the playbook, the topology, the findings, and per step the skill and model resolution |
| `POST /api/playbooks/bundled/spectro/copy` `{dir}` | copies the bundled playbook into the folder, refusing to overwrite; fenced |

Paths from the wire are resolved to real paths and must be directories; the loader reads only `playbook.json` and the files `contents` names, with a size cap of 1 MB per file and 200 files per folder.

## Requirements

1. A folder with the shipped spectro playbook loads with zero findings; the validator refuses each of the rules 1 to 8 with a finding that names the node or key (one test per rule).
2. The topology of the spectro playbook has one node per step and decision, `__start__` and `__end__`, one conditional edge per decision outcome, and the web layout places every node (no node at rank 0 except the start).
3. developer is a third mode: stored, read back after reload, labelled, offered at first start, with the tutorial answered off; every surface has a developer presence; the guard loops cover three modes.
4. The playbook segment is present only in developer; its chunk is never requested in learn or light.
5. The module shows the folder picker, the graph, the step table and the findings for the active folder; with no folder it shows the picker and the copy button only.
6. The copy route writes the bundled playbook into an empty folder and refuses a folder where any target exists (409 with the paths), the same as the scaffold route.
7. spectropowers carries `LICENSE` and `PROVENANCE.md`; a test asserts every spectropowers skill names its source skill in the provenance, and that the nine changes in the table above are present in the text (one marker sentence per change, tested as present).
8. `docs/index.html` builds deterministically; a test compares two runs byte for byte.
9. No key, address, hook or MCP server reaches the loader from a playbook file; the refusal names the path.
10. Both languages, both themes, two widths, no console errors.

## Out of scope

Running by a playbook (P3). Editing with the mouse and saving (P4). Spectrolyzr (P5). Installing a playbook's skills, agents, hooks and commands into the harness (P6); in P2 the step table only says whether a named skill is installed. Split and join. A playbook library in the user home.

## Acceptance scenarios

```
scenario: the spectro playbook is drawn in developer mode
  Given the window is in developer mode
  And the spectro playbook was copied into ~/playbooks/spectro and pinned to the workspace
  When the playbook segment opens
  Then the graph shows classify, brainstorm, spec complete, write plan and the build loop
  And the loop from the task review back to implement is drawn as a loop with its round limit
  And the step table lists brainstorm with spectropowers:brainstorming marked installed or not

scenario: a shared folder cannot route material
  Given a playbook.json with a step that carries "baseUrl": "http://10.0.0.5:8080"
  When the folder is loaded
  Then the findings name nodes[1].baseUrl as refused
  And nothing is drawn from that file

scenario: a loop without a ceiling is refused
  Given an arrow from fix back to implement with no decision carrying max_rounds on the way
  When the folder is loaded
  Then the finding names the arrow and asks for max_rounds
```
