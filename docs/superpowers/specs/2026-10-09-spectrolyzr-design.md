# P5 Spectrolyzr Design

Sub-project 5 of the playbook concept (`konzept/PLAYBOOK.md`, sections 4, 8 and 9), card 484. Written 2026-10-09 against `spectroscope-harness/spectro` main `8d7fcf48` (release cut of 2026-10-09). Target location once the card starts: `docs/superpowers/specs/2026-10-09-spectrolyzr-design.md` in the product repo. Every `file:line` below is at `8d7fcf48` and relative to `spectroscope-harness/spectro` unless it names another root. P2 and P4 names (`PlaybookFolders`, `PlaybookReader`, `PlaybookValidator`, `PlaybookLoader`, the P4 writer) come from their spec and plan; none of that code exists at `8d7fcf48`. Nothing in this file names employer material.

## Goal

A wizard in the playbook segment generates a new project and, as an add-on, a playbook pinned to it. The owner picks an archetype, a language and add-ons, reads the file tree with one sentence per file, and presses Generate. The server renders the files from classpath templates composed by a small JSON manifest, writes them through the scaffold's refuse to overwrite logic, registers the playbook folder and pins it to the new project. The same choices give the same bytes. A CI job generates every archetype in every language and runs its own test command.

## Owner decisions this spec follows

| Decision | Source |
|---|---|
| A wizard inside the playbook module, named Spectrolyzr, spectro branded, the initializr's shape only, nothing from its corpus | D8 |
| A playbook lives in a separate folder the owner picks, not inside the project folder | D2 (see owner question 2: card 484 says otherwise) |
| A playbook names providers and models, never keys, addresses or a wider permission mode | D3 |
| JSON, no YAML | concept section 3 |
| The wizard chunk loads only in developer | card 484, non functional 2 |
| Generation runs on the server from classpath templates, no network | card 484, non functional 1 |

## Today

Measured at `8d7fcf48` (reader `konzept/playbook/readers/484-scaffold-and-starters.md`, anchors spot checked for this spec).

- A starter bundle is a record plus a Java text block (`spectro-server/src/main/java/dev/spectroscope/server/starter/StarterBundles.java:121 to 129`, `131 to 234`). `files(id, tool)` fills one `LinkedHashMap` of path to content in a switch over `GRADLE`, `MAVEN`, `PYTHON`, `BASH` (`StarterBundles.java:258 to 288`). No reason per file, no templating, no project name (`rootProject.name` is the bundle's fixed artifact, `:282`), no add-on mechanism. `BuildTool.of` maps every unknown word to `GRADLE` (`:106 to 117`).
- `GET /api/bundles` also feeds the window title and the About dialog with version and label (`BundleController.java:46 to 73`), so archetypes need a registry of their own.
- The scaffold route (`BundleController.java:96 to 149`) answers a blank 404 outside the local origin fence (`:99 to 101`), 400 on a blank `dir` (`:102 to 105`), 404 on an unknown bundle (`:106 to 109`), 400 when `dir` is not an existing directory (`:110 to 113`), 400 on a lexical escape (`:121 to 124`, `normalize` only, no real path), 409 `{message, conflicts}` with nothing written (`:125 to 134`), 500 `{message, written}` with no rollback (`:136 to 147`), 200 `{dir, written}` (`:148`). Pass two calls `Files.writeString` without `CREATE_NEW` (`:141`), so a file that appears between the passes is overwritten. `BundleControllerTest.java` covers 404, 400, 409 and 200; it has no test for the escape branch or the 500 branch.
- The starters picker is a 640 px modal opened from the sidebar row `starters` (`navRows.ts:28`, `App.tsx:1467`, `App.tsx:2492`), present in every mode (`state/surfaces.ts:62`). It has no steps, no tree and no reasons. No stepper component exists in `spectro-web/src`.
- Lazy views load from `state/surfaceChunks.ts`, one `import()` each (`surfaceChunks.ts:1 to 14`); a mode prefetches the chunks of the surfaces it opens when the browser is idle (`surfaceChunks.ts:96 to 105`). The state graph pane keeps its state lifted into App (`App.tsx:2739 to 2745`).
- P2 is not built: `NavSegmentId` has three members (`navRows.ts:29`), `ViewMode` has two (`state/viewMode.ts:15`; `state/surfaces.ts:43 to 45` builds its presence records from the pair).
- CI: `gate.yml` has three jobs, each with checkout, a toolchain, the gate and an `if: always()` step that reads the real test count and fails on zero (`.github/workflows/gate.yml:1 to 6`, `70 to 101`). No workflow has a matrix, a Python setup or a step that builds a starter.
- Versions the product builds with: Gradle 9.6.1 (`gradle/wrapper/gradle-wrapper.properties`), JUnit 5.10.2 (`gradle/libs.versions.toml:23`) with the platform launcher (`spectro-core/build.gradle.kts:51`), Node 22 in CI (`gate.yml:111 to 115`), TypeScript `~5.8.3` (`spectro-web/package.json:37`).
- Registries, checked with curl on 2026-10-09: npm `@spectroscope/sdk` answers 404 and npm `spectroscope` is an unrelated package (reader 484, section 5); PyPI `spectroscope` 0.1.0 exists. Central lists the `spectro-core` of the 2026-10-09 release cut as latest, equal to the tree version, and the release process bumps the tree before it publishes (reader 484, section 4, item 6).

## Design

### Archetypes (owner question 1)

Proposal: **service**, **library**, **cli**. Each exists naturally in all three languages, each has a test that needs no network and no outside service, and none depends on a spectroscope package, for two reasons: TypeScript has no product package to depend on (npm, above), and a Java archetype on `spectro-core` would go red in CI between the version bump and the Central publish. The link from the generated project to spectroscope is the playbook add-on.

Rejected as defaults, offered as alternatives for the owner:

- **knowledge base** (a Markdown tree with a link check). Its language axis is empty: TypeScript, Python and Java would generate the same files with a different link checker, so the language step means nothing for it.
- **agent** (a spectroscope SDK agent). The starters dialog already covers it for Java and Python; TypeScript has no SDK.

| Archetype | What it is | Its test |
|---|---|---|
| service | an HTTP server with one route `GET /health` answering `{"status":"ok"}`, port from `PORT`, default 8080 | starts the server on port 0, calls `/health`, asserts 200 and the body |
| library | one public function `greeting(name)` that returns `Hello, <name>.` | asserts the returned text and the refusal of a blank name |
| cli | a command `run(args)` that prints a greeting and returns an exit code, plus a thin entry point | asserts exit 0 and the output for one argument, exit 2 and a usage line for none |

### Languages

| Language | Toolchain | Dependencies | `test_command` |
|---|---|---|---|
| TypeScript | Node 22, ES modules, `node:test` | one dev dependency: `typescript` pinned exact to the version the product uses (`5.8.3`, from `spectro-web/package.json:37`) | `npm test` (compiles with `tsc`, then `node --test` over the compiled tests) |
| Python | Python 3.11 or newer, standard library only | none | `python3 -m unittest discover -s tests -t . -v` |
| Java | Java 21, Gradle Kotlin DSL, no wrapper (owner question 7) | JUnit 5.10.2 and the platform launcher, the versions the product uses | `gradle test` |

Java means Gradle only in version 1 (the card's scenario says Gradle; owner question 3). Maven stays in the starters dialog.

The project name is a wizard field. It must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and be at most 40 characters. Derived names: `py_module` (dashes to underscores) and `java_package` (dashes removed). A name whose derived identifier is a Python or Java keyword is refused with a 400 naming the field.

### File sets

Every language carries the same four common files, and every archetype adds its own sources and test. `@@...@@` marks a placeholder.

Common files:

| Path | TypeScript | Python | Java | Why (en) |
|---|---|---|---|---|
| build file | `package.json`, `tsconfig.json` | `pyproject.toml` | `settings.gradle.kts`, `build.gradle.kts` | Declares the project's name, version and toolchain in the form its build tool reads, so a fresh checkout needs no setup beyond that tool. |
| `.gitignore` | `node_modules/`, `dist/` | `__pycache__/`, `.venv/` | `build/`, `.gradle/` | Keeps build output and local caches out of the repository. |
| `README.md` | yes | yes | yes | Says what the project is and the three commands a person needs: build, test, run. |
| `CLAUDE.md` | yes | yes | yes | Tells a coding agent the layout, the test command and that a change starts with a failing test. |

Common means every archetype of the language receives the file. `package.json`, `pyproject.toml`, `build.gradle.kts` and `README.md` are rendered from one template per archetype, because scripts, entry points and run instructions differ; the other common files have one template per language.

Archetype files:

| Archetype | TypeScript | Python | Java |
|---|---|---|---|
| service | `src/server.ts`, `src/main.ts`, `test/server.test.ts` | `@@py_module@@/__init__.py`, `@@py_module@@/server.py`, `@@py_module@@/__main__.py`, `tests/__init__.py`, `tests/test_server.py` | `src/main/java/@@java_package@@/App.java`, `src/main/java/@@java_package@@/HealthHandler.java`, `src/test/java/@@java_package@@/AppTest.java` |
| library | `src/index.ts`, `test/index.test.ts` | `@@py_module@@/__init__.py`, `@@py_module@@/core.py`, `tests/__init__.py`, `tests/test_core.py` | `src/main/java/@@java_package@@/Greeting.java`, `src/test/java/@@java_package@@/GreetingTest.java` |
| cli | `src/cli.ts`, `src/main.ts`, `test/cli.test.ts` | `@@py_module@@/__init__.py`, `@@py_module@@/cli.py`, `@@py_module@@/__main__.py`, `tests/__init__.py`, `tests/test_cli.py` | `src/main/java/@@java_package@@/Cli.java`, `src/main/java/@@java_package@@/Main.java`, `src/test/java/@@java_package@@/CliTest.java` |

Why sentences for the archetype files, by role (each file gets the sentence of its role; the manifest stores one per file):

| Role | Why (en) |
|---|---|
| the logic (`server`, `core`, `Greeting`, `cli`, `Cli`, `HealthHandler`) | Holds the behaviour the test pins; the place a first real change goes. |
| the entry point (`main.ts`, `__main__.py`, `App.java` for the service, `Main.java`) | Starts the program; kept thin so the logic stays testable without it. |
| the test | The first test, so the test command reports at least one test and a green run means something. |
| `__init__.py` | Marks the folder as a package so the test can import it. |

The German sentence of each row is written with the template, not machine translated later. Both languages are required for every file (requirement 5).

### Add-ons

Three add-ons, any subset, applied in manifest order (never in click order):

| Add-on | Project files | Playbook folder | Why (en) of its main file |
|---|---|---|---|
| quality gate | TypeScript `scripts/gate.mjs`; Python `scripts/gate.py`; Java a `gate` task appended to `build.gradle.kts`; a "Quality gate" section appended to `README.md` and `CLAUDE.md` | none | Runs the type or lint check and the tests in one command and fails when zero tests ran. |
| CI | `.github/workflows/ci.yml` for the language: checkout, toolchain, install, then `@@check_command@@` | none | Runs the same check on every push and pull request that runs on the machine. |
| spectro playbook | a "Playbook" section appended to `CLAUDE.md` naming the playbook id `spectro` and saying the app pins its folder (no path is written: a path names the machine) | the P2 bundle `bundled-playbooks/spectro/**` with `vars.test` set to `@@check_command@@` | The way of working the agent follows in this project, with a model per step and handover documents. |

`check_command` is the language's gate command when the quality gate is chosen, otherwise its `test_command`. The gate commands: `node scripts/gate.mjs`, `python3 scripts/gate.py`, `gradle gate`. Gate scripts are run through their interpreter, so no file needs an execute bit (the writer cannot set one, reader 484 section 2).

The quality gate adds no dependency: TypeScript runs `tsc --noEmit` and the tests, Python runs `compileall` and `unittest`, Java adds `-Xlint:all -Werror` and a zero test listener to `check`.

The CI template pins the action majors the product's own `gate.yml` uses (`actions/checkout@v4`, `actions/setup-java@v4`, `gradle/actions/setup-gradle@v4`, `actions/setup-node@v4`, `gate.yml:31 to 42, 111`) and the Gradle version of the product wrapper, so one upgrade card moves both. Python needs `actions/setup-python`, which the product does not use; the template pins the major current on the build day (v7.0.0 on 2026-10-09, GitHub releases API). Newer majors exist for the others on 2026-10-09 (checkout v7.0.1, setup-java v6.0.1, setup-node v7.1.0, gradle/actions v6.4.0); moving both the product and the templates is a separate card.

### The manifest

`spectro-server/src/main/resources/spectrolyzr/manifest.json`, read once per process by a strict Jackson reader. Templates live beside it under `spectrolyzr/templates/<language>/...` with the suffix `.tmpl`, so neither the product's compiler nor its linters read them as sources.

```json
{
  "schema_version": 1,
  "archetypes": [
    { "id": "service", "name": { "en": "Service", "de": "Dienst" },
      "description": { "en": "An HTTP server with a health route and its test.", "de": "Ein HTTP-Server mit einer Health-Route und ihrem Test." } }
  ],
  "languages": [
    { "id": "python", "name": "Python",
      "commands": { "test": "python3 -m unittest discover -s tests -t . -v", "gate": "python3 scripts/gate.py" } }
  ],
  "addons": [
    { "id": "quality-gate", "name": { "en": "Quality gate", "de": "Quality Gate" }, "description": { "en": "...", "de": "..." } },
    { "id": "ci", "name": { "en": "CI", "de": "CI" }, "description": { "en": "...", "de": "..." } },
    { "id": "spectro-playbook", "name": { "en": "spectro playbook", "de": "spectro-Playbook" }, "description": { "en": "...", "de": "..." } }
  ],
  "parts": [
    { "id": "python-common", "when": { "language": "python" }, "root": "project",
      "put": [
        { "path": "pyproject.toml", "template": "python/common/pyproject.toml.tmpl",
          "why": { "en": "Declares the project's name, version and toolchain in the form its build tool reads, so a fresh checkout needs no setup beyond that tool.",
                   "de": "..." } }
      ] },
    { "id": "python-service", "when": { "language": "python", "archetype": "service" }, "root": "project",
      "put": [ { "path": "@@py_module@@/server.py", "template": "python/service/server.py.tmpl", "why": { "en": "...", "de": "..." } } ] },
    { "id": "python-quality-gate", "when": { "language": "python", "addon": "quality-gate" }, "root": "project",
      "put": [ { "path": "scripts/gate.py", "template": "python/quality-gate/gate.py.tmpl", "why": { "en": "...", "de": "..." } } ],
      "append": [ { "path": "README.md", "template": "python/quality-gate/README.append.tmpl" } ] },
    { "id": "spectro-playbook", "when": { "addon": "spectro-playbook" }, "root": "playbook",
      "import": { "from": "bundled-playbooks/spectro/",
                  "set_json": { "playbook.json": { "/vars/test": "@@check_command@@" } },
                  "why_by_prefix": [
                    { "prefix": "playbook.json", "why": { "en": "...", "de": "..." } },
                    { "prefix": "skills/", "why": { "en": "A spectropowers skill a step of the playbook loads.", "de": "..." } }
                  ] } }
  ]
}
```

Rules, enforced by a validator that a test runs over the shipped manifest and over every combination of choices (3 archetypes, 3 languages, 8 add-on subsets, 72 combinations):

1. `schema_version` is 1; ids are unique; every `when` names known ids; `when` keys combine with AND, an absent key matches any value.
2. Every template exists on the classpath, is UTF-8, holds no carriage return and uses only the closed placeholder set: `name`, `py_module`, `java_package`, `test_command`, `check_command`. An unknown `@@x@@` is a load error. `@@` was chosen because it collides with none of the five template languages; GitHub Actions' `${{ }}` stays usable in the CI template.
3. Every `put` carries `why.en` and `why.de`, non empty, one sentence, no dash used as punctuation.
4. In each combination no root receives the same path twice; every `append` targets a path an earlier part put in the same root; every imported file is matched by a `why_by_prefix` entry; `set_json` names only `playbook.json`.
5. Every path is relative, has no `..` segment and stays relative after substitution.

### Rendering

`Spectrolyzr.render(Manifest, Choices)` is a pure function: no filesystem beyond the classpath, no network, no clock, no random. It validates the choices (known ids, the name rule, keyword refusal), computes the five placeholders, walks the parts in manifest order and returns an ordered list of `RenderedFile(root, path, content, why)`. Appends change the content of an earlier file in place and keep its position. The import reads `bundled-playbooks/spectro/**` through `PathMatchingResourcePatternResolver` (the pattern of `BundledSkills.java:72 to 73`) and **sorts the relative paths** before use, because the resolver does not promise an order. `set_json` applies only to `playbook.json`: the file is read as a Jackson tree, the pointer is set, the tree is parsed through P2's `PlaybookReader` (a finding is a render error naming the file, because the bundle and not the choice is broken) and the record is written through P4's `PlaybookWriter.write(Playbook)` (card 483 criterion 3, the canonical form, in `spectro-core`). The writer takes the parsed record, not a JSON tree, which is why the reader sits in between. Because the bundled file is stored in the canonical form (P4 plan Task 1), the written file differs from the bundle by the one `vars.test` line. That writer is why card 484 waits for card 483.

Two renders of every combination compare equal byte for byte (card criterion 2). The output carries no date, no absolute path and no machine name (a test searches the bytes for `/Users/`, `/home/` and the output of `hostname`).

### The generate route and the writer

The scaffold's two passes move out of `BundleController` into `FolderWriter` (package `dev.spectroscope.server.starter`), used by the scaffold, by P2's copy route if it has its own copy of the logic by then, and by the generate route. Changes against today, all of them tested:

- Containment is checked twice: lexically as today, and against the real path of the nearest existing ancestor of each target, so a symlinked subfolder cannot carry a write outside the root.
- Pass two opens every file with `CREATE_NEW`. A file that appears between the passes fails that write instead of being overwritten, and the answer is a 409 that names it and lists what was written.
- An option, used only by the generate route, creates the target folder when it is missing and its parent exists (one level, never more). The scaffold keeps refusing a missing folder (owner question 8 covers whether the scaffold takes the two hardenings too; the proposal is yes, and its existing tests stay green unchanged).
- The 200 answer of the scaffold keeps `dir` as it is today (absolute and normalized), so the starters dialog sees no change.

New controller `SpectrolyzrController` in `dev.spectroscope.server.spectrolyzr`:

| Route | Body or query | Answer |
|---|---|---|
| `GET /api/spectrolyzr` | | `{ archetypes, languages, addons }`, names and descriptions in both languages |
| `GET /api/spectrolyzr/preview` | `archetype`, `language`, `addons` (comma list), `name` | 200 `{ files: [{root, path, why: {en, de}, size, content}], commands: {test, check} }`; 400 `{message, field}` on any unknown value (no silent fallback, unlike `BuildTool.of`) |
| `POST /api/spectrolyzr/generate` | `{archetype, language, addons, name, dir, playbookDir}` | fenced like the scaffold (blank 404); 400 `{message, field}`; 409 `{message, conflicts: {project: [...], playbook: [...]}}` with nothing written; 500 `{message, written: {project, playbook}}`; 200 `{project: {dir, written}, playbook: {dir, written} or null, pinned}` |

Generate checks both folders in pass one before it writes anything. `playbookDir` is required when the playbook add-on is chosen and must be neither the project folder nor inside it nor around it (D2; owner question 2). After both writes it calls P2's `PlaybookFolders.register(playbookDir)` and `pin(dir, playbookDir)` (P2 plan Task 4), so the playbook is pinned to the new project as a workspace path. The pin is keyed by the generated project folder and shows in the playbook segment once that folder is the window's workspace; the wizard does not switch the workspace (out of scope). The written playbook then loads through P2's loader with zero findings (card criterion 4); a route test asserts it.

### The wizard

A view of the playbook segment, in its own chunk `playbook/spectrolyzr/SpectrolyzrWizard.tsx`, listed in the `playbook` surface's `chunks` and loaded through `surfaceChunks.ts`. learn and light never open the playbook surface (P2), so they never request the chunk; developer prefetches it on idle like any other surface it opens. The pane header of P2's `PlaybookPane` gets two tabs, Playbook and New project.

Three steps on one rail, Back and Next on every step:

1. **Project**: three archetype cards (name, one line, the test it ships), a language choice of three, a name field with the rule shown under it.
2. **Add-ons**: three checkboxes with their description. With the playbook add-on on, a playbook folder field appears, prefilled with a sibling of the project folder (`<parent>/<name>-playbook`) and editable.
3. **Review**: a file tree on the left (folders collapsible, two roots when the playbook is chosen), the selected file's Why sentence and content on the right, a summary (archetype, language, add-ons, file count per root, the test and check commands, both folders), the project folder field with a Pick button (the native picker `POST /api/pick-workspace`, `WorkspacePickController.java:73`; a typed absolute path where the answer is 501), and Generate.

Generate shows the written count per root; a 409 lists the conflicting paths per folder and writes nothing; a 400 marks its field. The done state names both folders, says the playbook is pinned to the project, and offers Copy path. Opening the new folder as the session's workspace is not part of this card.

The wizard's choices live in a module store `state/spectrolyzr.ts` read through `useSyncExternalStore` (the pattern P2 Task 9 uses), so switching segments does not lose them and App gains no props. The preview is fetched on every change of choices. At 390 px the tree stacks above the reader. Colours come from tokens only. Every string exists in both languages under `lyzr.*`; the Why sentences come from the manifest in both languages (owner question 4).

The starters dialog stays as it is, in every mode (owner question 6).

### CI

A fourth job `spectrolyzr-gate` in `gate.yml`, `ubuntu-latest`, a matrix over `language: [typescript, python, java]` (the first matrix in the repo). Each leg:

1. checkout, `setup-java` 21 and `setup-gradle` (rendering needs the server module);
2. render with a Gradle task `:spectro-server:renderArchetypes` (a `JavaExec` over `dev.spectroscope.server.spectrolyzr.RenderAll`, no Spring context, no port, no running jar) into `$RUNNER_TEMP/lyzr/<archetype>-<variant>`, for the leg's language, each archetype in two variants: `bare` (no add-on) and `full` (all three);
3. the language's toolchain (`setup-node` 22; `setup-python`; `setup-gradle` with `gradle-version` equal to the product wrapper), then in every rendered folder the install step and `check_command`, outputs kept as files;
4. an `if: always()` step on the house pattern that counts the tests each folder ran and fails when any folder reports zero (JUnit XML for Java, the `Ran N tests` line for Python, the TAP `# tests N` line for TypeScript).

Generating through a JUnit test with a side effect, or through a started jar and curl, were the alternatives (reader 484, section 4); `JavaExec` needs no new CLI verb, no port and no fence. Determinism and the playbook's validation are asserted by the java-gate's unit tests; this job proves the generated folders build. Dependency resolution needs the network (npm for TypeScript, Central for JUnit); Python needs none. The run time of the job is not measured yet; the first green run records it in the card.

### Local mode, the neighbouring work

Session 9c4bc7 builds a Local mode switch per chat (cards 490 to 493, `kanban/493-the-local-mode-switch.md`): one switch in the gear writes a session count, tool groups off, a read share and a care paragraph for that chat, and with a pinned folder persists them through `PUT /api/settings/local`. Spectrolyzr does not write any `.spectro/settings*.json`: a playbook may not carry settings (D3), and the switch is per chat by design. Whether the wizard should offer a "local models" choice that maps the playbook's four model choices onto local providers and marks steps private (D4) is owner question 5; if yes, it reads P1's registry for which local providers answer and comes as its own card after 493.

## Requirements

1. The wizard in the playbook segment offers three archetypes, three languages and three add-ons, shows a file tree with one Why sentence per file and a summary, and writes into a picked folder, refusing to overwrite with the conflicting paths per folder (card criterion 1).
2. Every one of the 72 combinations renders twice to identical bytes; a test compares them (criterion 2).
3. Every archetype in every language, bare and full, runs green with its own check command in the `spectrolyzr-gate` job, and every folder reports more than zero tests (criterion 3).
4. The playbook written by the add-on loads through P2's loader with zero findings, its `vars.test` equals the project's check command, and its folder is registered and pinned to the generated project (criterion 4).
5. Every rendered file has a Why sentence in English and German; no template or Why sentence carries a dash used as punctuation, an employer word or an absolute path; `tools/prepush-scan.sh` runs over the branch range including the templates (criterion 5).
6. The generate route refuses unknown ids, an invalid name, a missing playbook folder when the add-on is on, a playbook folder inside or around the project, a lexical or symlink escape, and an existing target (409, nothing written); a file appearing between the passes is never overwritten.
7. The scaffold route's behaviour for the starters dialog is unchanged: its existing tests stay green without edits.
8. The wizard chunk is never requested in learn or light (non functional 2); generation makes no network call (non functional 1, asserted by rendering with no network access in a unit test, since `render` takes no client).
9. Template versions follow the product: the TypeScript pin equals the version in `spectro-web/package.json`, the JUnit version equals `gradle/libs.versions.toml`, the CI Gradle version equals the wrapper, the CI Node version equals `gate.yml`; a drift test reads all four.
10. Tests first with the red output kept, mutation probes after each commit, gates alone, both themes at 1280 and 390 px, no console errors (criterion 6).

## Out of scope

Opening the generated folder as the session's workspace. A Gradle wrapper in the Java archetype (owner question 7). Maven, bash, a TypeScript framework, a Python package manager. Archetypes that depend on a spectroscope package. Editing a generated playbook in the wizard (that is P4's editor, after generation). A ZIP download. Writing settings files. Running a build from the wizard.

## Owner questions

1. **The archetype list.** Proposal: service, library, cli. Alternatives: knowledge base, agent (reasons above).
2. **Where the playbook goes.** D2 says a separate folder, not inside the project; card 484 criterion 4 and its scenario write `playbook.json` into the generated folder. Options: (a) a separate folder, sibling by default, pinned to the project (this spec, follows D2); (b) inside the project folder at its root (follows the card's wording; `LICENSE` and `PROVENANCE.md` of the bundle then collide with project files); (c) inside the project at `.spectro/playbook/` (no collision, departs from D2). Switching from (a) to (c) is a change to the default path and one validation rule.
3. **Java means Gradle only** in version 1.
4. **Where the Why sentences live.** Proposal: in the manifest beside the file they explain, both languages, checked by one Java test. Alternative: ids in `i18n.ts` with a web test that reads the manifest.
5. **A local models choice** in the wizard, after the Local mode work of cards 490 to 493: now, later as its own card, or not at all.
6. **The starters dialog** stays separate and unchanged in every mode (proposal) or gives way to the wizard in developer.
7. **No Gradle wrapper**: the writer writes text, the wrapper needs a binary jar. Proposal: the README says to run `gradle wrapper` once. Alternative: teach the writer bytes and ship the jar as a resource.
8. **Hardening the old scaffold route** with the real path check and `CREATE_NEW` as well (proposal yes, behaviour for the dialog unchanged).
9. **What card 484 waits for.** Of card 483 this card needs only the canonical writer (P4 plan Task 1, one class in `spectro-core`). Options: (a) wait for all of 483 as the board says; (b) land the writer as its own small card after 481, so 484 and the editor build in parallel.

## Acceptance scenarios

```
scenario: a new Java service with CI and the spectro playbook
  Given the wizard in developer mode with archetype service, language Java and name ledger-api
  And the add-ons CI and spectro playbook
  When the owner generates into an empty folder ~/work/ledger-api
  Then the folder holds settings.gradle.kts, build.gradle.kts, the service sources, AppTest.java and .github/workflows/ci.yml
  And "gradle test" runs one test green in that folder
  And ~/work/ledger-api-playbook holds a playbook.json that loads with zero findings and whose vars.test is "gradle test"
  And the playbook folder is pinned to ~/work/ledger-api

scenario: nothing is overwritten
  Given ~/work/ledger-api already holds a README.md
  When the owner generates the same choices into it
  Then the answer lists README.md under the project folder
  And no file was written in either folder

scenario: the same choices give the same bytes
  Given archetype library, language Python and all three add-ons
  When the files are rendered twice
  Then every file is byte identical between the two renders

scenario: the wizard does not exist outside developer
  Given the window in learn mode
  When the app has loaded and the browser is idle
  Then no request for the chunk playbook/spectrolyzr/SpectrolyzrWizard was made
```

## Found in passing

- The Python starter README says the Python edition is not on PyPI (`StarterBundles.java:269 to 276`, the README text from `:292`), and `BundleControllerTest.java:75` pins the word "pre-release", while PyPI serves `spectroscope` 0.1.0 (reader 484, curl 2026-10-09). Whether that package matches the starter's imports was not checked. Its own card, not this one.
- P2's dash test reads only the nine rewritten spectropowers skills (P2 plan Task 6); the other five skills of the bundle keep whatever dashes upstream wrote, and the playbook add-on copies them. A gap for P2, recorded on card 481.
- The user guide has no starters chapter (reader 484 surprises); this card adds a Spectrolyzr section to the P2 playbook chapter.

## Not verified

- P2 and P4 code does not exist at `8d7fcf48`; every P2 and P4 class, route and writer named here is from their spec and plan, and the plan reads the real names before use.
- The exact summary line of the `tap` reporter of `node --test` on Node 22, and the Python version on `ubuntu-latest`. Each is checked in the plan task that first uses it. Checked on 2026-10-09 by reading the sources with curl: `gradle/actions` v4 `setup-gradle/action.yml` declares the `gradle-version` input; `actions/setup-python` v7 `action.yml` declares `python-version`; the Node v22.x `doc/api/test.md` documents glob arguments to `node --test` and a `tap` reporter.
- Whether P2's documentation builder renders `vars` into `docs/index.html`; if it does, the copied page shows the bundled test command. A test in the plan pins the answer.
- The run time of the CI job and the size of a preview answer: not measured.
- Nothing was compiled or run for this spec.
- The session id `9c4bc7` of the Local mode work is not verifiable from the board; the cards 490 to 493 and the worktrees `spectroscope-harness/worktrees/wt-card-490` to `wt-card-492` are (`git worktree list`, 2026-10-09).
