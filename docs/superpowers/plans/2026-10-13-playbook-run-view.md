# Playbook Run View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playbook run and a workflow run show as one living plan beside the chat, with who, model, input, output, documents, files, status and duration per step, the run's graph on top, and a wide mode.

**Architecture:** The runners emit a new additive event `run_step` (phases `run_start`, `step_start`, `step_end`, `run_end`) through the host into the session file and the socket. The web folds these events, plus the file tool events and text deltas of each step's agents, into `UiState.runs`. The dock's Plan panel renders the latest run compactly and opens itself at a run's start; a layout flag widens the same panel over the chat, with the run's graph on top. A new local-only route opens the documents a run recorded, dot folders included, never `.env` or `.git`.

**Tech Stack:** Java 21 (spectro-core, spectro-server, Spring Boot, Jackson, JUnit 5), TypeScript and React (spectro-web, vitest, React Flow via the existing `StateGraphView`).

**Spec:** `docs/superpowers/specs/2026-10-13-playbook-run-view-design.md` (approved 2026-10-13). Card: `kanban/586-a-playbook-run-shows-as-a-living-plan-beside-the-chat.md` in the home repo.

## Global Constraints

- Branch `card-586` in worktree `spectroscope-harness/worktrees/wt-card-586`, based on `integration/0.15.4` (`c7c16528`). Never push.
- Commits: explicit paths only, never `git add -A`; identity `git -c user.email=chris@spectroscope.ai -c user.name="Christopher Ezell" commit`; every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No em dashes or en dashes anywhere (code, comments, UI text, docs, commit messages).
- UI text in English and German (`spectro-web/src/i18n/i18n.ts`, entries `"key": { de: "...", en: "..." }`).
- `playbook_progress`, `plan`, `PlaybookRecorder` sidecar records and their readers stay unchanged; the runners keep emitting them.
- Texts in `run_step`: at most 4,000 characters (`input`, `output`), full length in `inputChars`, `outputChars`.
- Every numeric `static final` of governing shape carries `@Governs` (`GoverningNumbersDriftTest`); regenerate `numbers.json` with `-Dgoverning.rewrite=true` when you add one.
- No private network address in any file (`NoOperatorAddressesInTheRepoTest`); use `192.0.2.1` for a dead address.
- Tests: red first, saved to `kanban/evidence/586/red-<task>.log`; green to `green-<task>.log`; mutation bites from your own snapshot (never `git checkout`), logged to `bites-<task>.log`, `git diff` empty after each restore.
- Targeted runs only during tasks: `./gradlew :<module>:test --tests '<Class>' --rerun-tasks --no-build-cache` (redirect to a file, read `$?`, never pipe); `npx vitest run <files> --maxWorkers=2`; `npx tsc -b`; `npx eslint <files>`; `npx prettier --check <files>`. Never `npm run build` or `npm run gate` inside a task (they rewrite the tracked bundle).
- No CPU hog runs. No ports 8080 to 8100. Never attach to the owner's running app. Never read `~/.gradle/gradle.properties`, any `.env` or `~/.spectro/.env`.
- Modes: the panel and the wide view work in learn, light and developer.

## Review Focus

1. A session stored while a run was going (the server stopped, no `run_end`): reopened, its running entries must read "no end recorded", not "running" forever. Pinned in Task 6 (`foldRun` closes nothing by itself; `runViewOf(track, live=false)` reports `unfinished`) and Task 7 (the card shows it).
2. Two runs in one session: the panel shows the latest, the picker lists both, and every entry key carries the run id so a jump never lands in the other run. Pinned in Task 6 and Task 7.
3. A chat step whose main agent spawns its own subagents: files those descendants write belong to that step. Pinned in Task 6 (descendant join through `agent_spawn.parentId`).
4. A step that writes the same file twice (created, then changed): one row that says `created`. Pinned in Task 6.
5. A document path with spaces, unicode or `..`: the route resolves it inside the workspace or answers 404; the web encodes it. Pinned in Task 5 (route) and Task 9 (URL).

---

### Task 1: The `run_step` event

**Files:**
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/events/RunEvent.java` (the `@JsonSubTypes` list, the `permits` list, new records after `PlaybookPicked`)
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/events/PlaybookWireFreezeTest.java`
- Create: `spectro-core/src/test/java/dev/spectroscope/core/events/RunStepWireTest.java`

**Interfaces:**
- Produces: `RunEvent.RunStep` (record), `RunEvent.RunNode(String id, String name, String kind)`, `RunEvent.RunDoc(String doc, String path, String change)`, phase constants `RunStep.RUN_START`, `STEP_START`, `STEP_END`, `RUN_END`; JSON type name `run_step`.

- [ ] **Step 1: Write the failing tests**

`RunStepWireTest.java`:

```java
package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

/** Card 586: the run view's line on the wire, written and read back byte for byte. */
class RunStepWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void aStepEndRoundTripsWithItsDocumentsAndLeavesNullsOff() throws Exception {
        RunEvent.RunStep end = new RunEvent.RunStep("playbook", "abcdefabcdef", "playbook", RunEvent.RunStep.STEP_END,
                "Write plan", null, null, "write_plan", "step", 1,
                null, null, null, null, null,
                null, null, null,
                null, null,
                "done", 1200L, "worker-1", null,
                "the plan is written", 19, List.of(new RunEvent.RunDoc("plan", "docs/plan.md", "created")),
                null, null, null, null, null, 7L);
        String json = JSON.writeValueAsString(end);
        JsonNode tree = JSON.readTree(json);
        assertEquals("run_step", tree.get("type").asText());
        assertEquals("step_end", tree.get("phase").asText());
        assertEquals("created", tree.get("documents").get(0).get("change").asText());
        assertFalse(tree.has("performer"), "a null field stays off the wire: " + json);
        RunEvent back = JSON.readValue(json, RunEvent.class);
        assertInstanceOf(RunEvent.RunStep.class, back);
        assertEquals(end, back);
    }

    @Test
    void aRunStartCarriesItsForwardPath() throws Exception {
        RunEvent.RunStep start = new RunEvent.RunStep("playbook", "abcdefabcdef", "workflow", RunEvent.RunStep.RUN_START,
                "fanout-review", "review the diff",
                List.of(new RunEvent.RunNode("diff", "diff", "prompt"), new RunEvent.RunNode("review", "Review", "fanout")),
                null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null, 1L);
        RunEvent back = JSON.readValue(JSON.writeValueAsString(start), RunEvent.class);
        assertEquals(start, back);
    }
}
```

In `PlaybookWireFreezeTest.thePermittedRecordsAreUnchanged`, append `"RunStep"` after `"PlaybookPicked"` in the expected list, and add to `theRecordsAPlaybookRunEmitsKeepTheirComponents`:

```java
        // Card 586: the run view's line.
        assertEquals(List.of("agentId", "runId", "runKind", "phase", "name", "task", "nodes", "node", "kind", "entry",
                "performer", "role", "provider", "model", "picked", "input", "inputChars", "reads", "round",
                "maxRounds", "status", "durationMs", "childId", "children", "output", "outputChars", "documents",
                "label", "error", "stopReason", "result", "detail", "ts"), components(RunEvent.RunStep.class));
        assertEquals(List.of("id", "name", "kind"), components(RunEvent.RunNode.class));
        assertEquals(List.of("doc", "path", "change"), components(RunEvent.RunDoc.class));
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `./gradlew :spectro-core:test --tests '*RunStepWireTest*' --tests '*PlaybookWireFreezeTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/red-task1.log 2>&1; echo $?`
Expected: compile failure, `RunEvent.RunStep` does not exist.

- [ ] **Step 3: Add the records**

In the `@JsonSubTypes` list, after the `PlaybookPicked` line (add a comma to it):

```java
    @JsonSubTypes.Type(value = RunEvent.RunStep.class,          name = "run_step")         // additive (card 586)
```

In the `permits` list append `, RunEvent.RunStep` after `RunEvent.PlaybookPicked`.

After the `PlaybookPicked` record:

```java
    /**
     * Card 586: one line of a playbook or workflow run for the run view beside
     * the chat. A run says that it started (its name, task and forward path),
     * that a step or decision starts (who works on it, on which model, with
     * which input and which documents to read), how it ended (status,
     * duration, output, the documents it wrote, a decision's label and round),
     * and how the run ended. {@code phase} decides which fields are set; every
     * other field is null and left off the wire. Texts are cut at 4,000
     * characters, their full length rides beside them.
     *
     * @param agentId    {@code "playbook"} for both run kinds
     * @param runId      the run, the id its sidecar lines carry
     * @param runKind    {@code playbook} or {@code workflow}
     * @param phase      {@link #RUN_START}, {@link #STEP_START}, {@link #STEP_END} or {@link #RUN_END}
     * @param name       the run's name on run_start; the node's name on a step
     * @param task       what the run was asked, on run_start; null when none
     * @param nodes      the forward path on run_start
     * @param node       the node id, on a step
     * @param kind       {@code step}, {@code decision}, {@code prompt} or {@code fanout}, on a step
     * @param entry      1 for a node's first entry, 2 and on for a loop, on a step
     * @param performer  {@code chat} or {@code child}, on step_start
     * @param role       worker, explore, research, or the agent name, on step_start of a child
     * @param provider   the provider, on step_start
     * @param model      the model, on step_start
     * @param picked     true when the owner picked the model in the start sheet
     * @param input      the step's record text, cut
     * @param inputChars the full length of the record text
     * @param reads      the documents the step is told to read
     * @param round      a decision's round
     * @param maxRounds  a decision's ceiling
     * @param status     {@code done}, {@code failed} or {@code stopped}, on step_end
     * @param durationMs the step's or the run's duration
     * @param childId    the child of a child step or a review, on step_end
     * @param children   the children of a fan-out, on step_end
     * @param output     the answer, the child's result or the check's detail, cut
     * @param outputChars the full length of the output
     * @param documents  the documents the step wrote, on step_end
     * @param label      a decision's outcome, on step_end
     * @param error      what failed, on step_end
     * @param stopReason how the run stopped, on run_end
     * @param result     the end's result, on run_end
     * @param detail     what a person reads about the stop, on run_end
     * @param ts         epoch millis of emission
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunStep(String agentId, String runId, String runKind, String phase,
                   String name, String task, List<RunNode> nodes,
                   String node, String kind, Integer entry,
                   String performer, String role, String provider, String model, Boolean picked,
                   String input, Integer inputChars, List<RunDoc> reads,
                   Integer round, Integer maxRounds,
                   String status, Long durationMs, String childId, List<String> children,
                   String output, Integer outputChars, List<RunDoc> documents,
                   String label, String error,
                   String stopReason, String result, String detail,
                   long ts) implements RunEvent {

        /** The phase of the line that opens a run. */
        public static final String RUN_START = "run_start";
        /** The phase of the line that opens a step or decision. */
        public static final String STEP_START = "step_start";
        /** The phase of the line that closes a step or decision. */
        public static final String STEP_END = "step_end";
        /** The phase of the line that closes a run. */
        public static final String RUN_END = "run_end";
    }

    /**
     * Card 586: one node of a run's forward path.
     *
     * @param id   the node id
     * @param name the node's name
     * @param kind {@code step}, {@code decision}, {@code prompt} or {@code fanout}
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunNode(String id, String name, String kind) {}

    /**
     * Card 586: a document a step reads or wrote.
     *
     * @param doc    the playbook's document id
     * @param path   workspace-relative path
     * @param change {@code created} or {@code changed} for a written one; null for a read one
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record RunDoc(String doc, String path, String change) {}
```

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task1.log`. Expected: exit 0; `RunStepWireTest` 2 tests, `PlaybookWireFreezeTest` 2 tests, 0 failures (count them in the JUnit XML under `spectro-core/build/test-results/test/`).

- [ ] **Step 5: Bite and commit**

Bite: remove the `@JsonSubTypes` line for `run_step`; `RunStepWireTest` must go red; restore from your snapshot. Then:

```bash
git add spectro-core/src/main/java/dev/spectroscope/core/events/RunEvent.java spectro-core/src/test/java/dev/spectroscope/core/events/PlaybookWireFreezeTest.java spectro-core/src/test/java/dev/spectroscope/core/events/RunStepWireTest.java
git -c user.email=chris@spectroscope.ai -c user.name="Christopher Ezell" commit -F <message file>
```

Message: `Card 586: the run_step event` plus the trailer.

---

### Task 2: `RunSteps`, the line builder of one run

**Files:**
- Create: `spectro-core/src/main/java/dev/spectroscope/core/playbook/run/RunSteps.java`
- Create: `spectro-core/src/test/java/dev/spectroscope/core/playbook/run/RunStepsTest.java`
- Modify: `spectro-core/src/main/resources/governing/numbers.json` (regenerated)

**Interfaces:**
- Consumes: `RunEvent.RunStep`, `RunNode`, `RunDoc` from Task 1.
- Produces (package-private, used by Tasks 3 and 4):
  - `RunSteps(String runId, String runKind)`
  - `RunEvent.RunStep runStart(String name, String task, List<RunEvent.RunNode> nodes)`
  - `int enter(String node)` (1, then 2, 3 per node)
  - `RunEvent.RunStep stepStart(String node, String name, String kind, int entry, RunSteps.Start s)`
  - `RunEvent.RunStep stepEnd(String node, String name, String kind, int entry, RunSteps.End e)`
  - `RunEvent.RunStep runEnd(String stopReason, String result, String detail, long durationMs)`
  - `record Start(String performer, String role, String provider, String model, boolean picked, String input, List<RunEvent.RunDoc> reads, Integer round, Integer maxRounds)`
  - `record End(String status, long durationMs, String childId, List<String> children, String output, List<RunEvent.RunDoc> documents, String label, String error, Integer round, Integer maxRounds)`
  - `static String cut(String text)`; `static final int TEXT_CAP = 4_000`
  - status constants `DONE = "done"`, `FAILED = "failed"`, `STOPPED = "stopped"`

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 586: the lines of one run, the entry count of each node, and the cut of long texts. */
class RunStepsTest {

    @Test
    void entriesCountPerNode() {
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        assertEquals(1, lines.enter("fix"));
        assertEquals(1, lines.enter("review"));
        assertEquals(2, lines.enter("fix"));
    }

    @Test
    void aLongInputIsCutWithItsLengthBeside() {
        RunSteps lines = new RunSteps("abcdefabcdef", "playbook");
        String big = "x".repeat(RunSteps.TEXT_CAP + 10);
        RunEvent.RunStep start = lines.stepStart("w", "Write", "step", 1,
                new RunSteps.Start("chat", null, "anthropic", "claude-opus-5-5", false, big, List.of(), null, null));
        assertEquals(RunSteps.TEXT_CAP, start.input().length());
        assertEquals(RunSteps.TEXT_CAP + 10, start.inputChars());
        assertEquals("step_start", start.phase());
        assertEquals("playbook", start.agentId());
        assertNull(start.picked(), "an unpicked model leaves the flag off");
    }

    @Test
    void anEndCarriesStatusDocumentsAndCutOutput() {
        RunSteps lines = new RunSteps("abcdefabcdef", "workflow");
        RunEvent.RunStep end = lines.stepEnd("review", "Review", "fanout", 1,
                new RunSteps.End(RunSteps.DONE, 40L, null, List.of("explore-1", "explore-2"), "summary",
                        List.of(), null, null, null, null));
        assertEquals("done", end.status());
        assertEquals(List.of("explore-1", "explore-2"), end.children());
        assertEquals(7, end.outputChars());
        assertEquals("workflow", end.runKind());
        assertNull(end.documents(), "an empty document list stays off the wire");
    }

    @Test
    void cutKeepsNullAndShortTexts() {
        assertNull(RunSteps.cut(null));
        assertEquals("ok", RunSteps.cut("ok"));
        assertTrue(RunSteps.cut("y".repeat(5000)).length() == RunSteps.TEXT_CAP);
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `./gradlew :spectro-core:test --tests '*RunStepsTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/red-task2.log 2>&1; echo $?`
Expected: compile failure, `RunSteps` does not exist.

- [ ] **Step 3: Write `RunSteps`**

```java
package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.events.RunEvent;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Card 586: builds the {@code run_step} lines of one run and numbers the
 * entries of each node, so a loop shows as a second entry of the same node.
 */
final class RunSteps {

    /** The longest input or output a line carries: the run view shows the start of a text, the chat holds it whole. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    static final int TEXT_CAP = 4_000;

    static final String DONE = "done";
    static final String FAILED = "failed";
    static final String STOPPED = "stopped";

    /** What a step or decision starts with. */
    record Start(String performer, String role, String provider, String model, boolean picked, String input,
                 List<RunEvent.RunDoc> reads, Integer round, Integer maxRounds) {
    }

    /** What a step or decision ends with. */
    record End(String status, long durationMs, String childId, List<String> children, String output,
               List<RunEvent.RunDoc> documents, String label, String error, Integer round, Integer maxRounds) {
    }

    private final String runId;
    private final String runKind;
    private final Map<String, Integer> entries = new HashMap<>();

    RunSteps(String runId, String runKind) {
        this.runId = runId;
        this.runKind = runKind;
    }

    /** @param node a node id; @return 1 for its first entry, then 2, 3 */
    int enter(String node) {
        return entries.merge(node, 1, Integer::sum);
    }

    RunEvent.RunStep runStart(String name, String task, List<RunEvent.RunNode> nodes) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.RUN_START,
                name, task, nodes, null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null, now());
    }

    RunEvent.RunStep stepStart(String node, String name, String kind, int entry, Start s) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.STEP_START,
                name, null, null, node, kind, entry, s.performer(), s.role(), s.provider(), s.model(),
                s.picked() ? Boolean.TRUE : null, cut(s.input()), length(s.input()), emptyToNull(s.reads()),
                s.round(), s.maxRounds(), null, null, null, null, null, null, null, null, null, null, null, null,
                now());
    }

    RunEvent.RunStep stepEnd(String node, String name, String kind, int entry, End e) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.STEP_END,
                name, null, null, node, kind, entry, null, null, null, null, null, null, null, null,
                e.round(), e.maxRounds(), e.status(), e.durationMs(), e.childId(), emptyToNull(e.children()),
                cut(e.output()), length(e.output()), emptyToNull(e.documents()), e.label(), e.error(),
                null, null, null, now());
    }

    RunEvent.RunStep runEnd(String stopReason, String result, String detail, long durationMs) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.RUN_END,
                null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, durationMs, null, null, null, null, null, null, null, stopReason, result, detail, now());
    }

    /** @param text any text or null; @return its first {@link #TEXT_CAP} characters */
    static String cut(String text) {
        return text == null || text.length() <= TEXT_CAP ? text : text.substring(0, TEXT_CAP);
    }

    private static Integer length(String text) {
        return text == null ? null : text.length();
    }

    private static <T> List<T> emptyToNull(List<T> list) {
        return list == null || list.isEmpty() ? null : List.copyOf(list);
    }

    private static long now() {
        return System.currentTimeMillis();
    }
}
```

- [ ] **Step 4: Regenerate the registry and run the tests**

Run: `./gradlew :spectro-core:test --tests '*GoverningNumbersDriftTest*' -Dgoverning.rewrite=true --rerun-tasks --no-build-cache > /tmp/rewrite.log 2>&1` (red on purpose, it rewrites `numbers.json`), then:
`./gradlew :spectro-core:test --tests '*RunStepsTest*' --tests '*GoverningNumbersDriftTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/green-task2.log 2>&1; echo $?`
Expected: exit 0; `RunStepsTest` 4 tests, 0 failures.

- [ ] **Step 5: Bite and commit**

Bite: change `cut` to return `text` unchanged; `aLongInputIsCutWithItsLengthBeside` red; restore. Commit `RunSteps.java`, `RunStepsTest.java`, `numbers.json`: message `Card 586: RunSteps builds the lines of one run`.

---

### Task 3: The playbook runner emits `run_step`

**Files:**
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/playbook/run/PlaybookRunner.java` (`run()`, `end(...)`, `step(...)`, `decide(...)`, `check(...)`, new private helpers)
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/playbook/run/CheckResult.java` (third component `childId`)
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/playbook/run/ReviewCheck.java:92-100` (return the child id)
- Create: `spectro-core/src/test/java/dev/spectroscope/core/playbook/run/PlaybookRunStepsTest.java`

**Interfaces:**
- Consumes: `RunSteps` (Task 2), `RunEvent.RunStep`, `RunNode`, `RunDoc` (Task 1), the existing test fixtures `PlaybookRunnerTest.run(...)`, `FakeHost`, `VocabularyTest.LOOP`, `PlaybookRunnerTest.nested(...)`.
- Produces: the event order of the spec, section 1, for every playbook run. `CheckResult(String label, String detail, String childId)` with the two-argument constructor kept.

- [ ] **Step 1: Write the failing tests**

```java
package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 586: a playbook run tells the run view every step and decision. */
class PlaybookRunStepsTest {

    @TempDir Path tmp;

    static List<RunEvent.RunStep> lines(FakeHost host) {
        return host.events.stream().filter(RunEvent.RunStep.class::isInstance).map(RunEvent.RunStep.class::cast).toList();
    }

    static List<String> shape(List<RunEvent.RunStep> lines) {
        return lines.stream().map(l -> l.phase() + (l.node() == null ? "" : ":" + l.node() + "#" + l.entry())).toList();
    }

    @Test
    void aChatStepADecisionAndAChildStepEachOpenAndClose() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        host.replies.add("the plan is written");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        assertEquals(List.of("run_start", "step_start:write_plan#1", "step_end:write_plan#1",
                "step_start:plan_ok#1", "step_end:plan_ok#1", "step_start:build#1", "step_end:build#1", "run_end"),
                shape(l));

        RunEvent.RunStep start = l.get(0);
        assertEquals("playbook", start.runKind());
        assertEquals(List.of("write_plan", "plan_ok", "build"), start.nodes().stream().map(RunEvent.RunNode::id).toList());

        RunEvent.RunStep chatStart = l.get(1);
        assertEquals("chat", chatStart.performer());
        assertEquals("anthropic", chatStart.provider());
        assertTrue(chatStart.input().contains("Write: Plan at plan.md"), chatStart.input());

        RunEvent.RunStep chatEnd = l.get(2);
        assertEquals("done", chatEnd.status());
        assertEquals("the plan is written", chatEnd.output());
        assertEquals(List.of(new RunEvent.RunDoc("plan", "plan.md", "created")), chatEnd.documents());

        RunEvent.RunStep checkEnd = l.get(4);
        assertEquals("decision", checkEnd.kind());
        assertEquals("pass", checkEnd.label());

        RunEvent.RunStep childStart = l.get(5);
        assertEquals("child", childStart.performer());
        assertEquals("worker", childStart.role());
        assertEquals(List.of(new RunEvent.RunDoc("plan", "plan.md", null)), childStart.reads());
        RunEvent.RunStep childEnd = l.get(6);
        assertNotNull(childEnd.childId());
        assertTrue(childEnd.childId().startsWith("worker-"), childEnd.childId());

        RunEvent.RunStep end = l.get(7);
        assertEquals("done", end.stopReason());
        assertEquals("done", end.result());
    }

    @Test
    void aLoopGivesTheSameNodeASecondEntryAndTheDecisionItsRounds() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> ends = lines(host).stream()
                .filter(x -> "step_end".equals(x.phase()) && "plan_ok".equals(x.node())).toList();
        assertEquals(List.of("fail", "fail", "exhausted"), ends.stream().map(RunEvent.RunStep::label).toList());
        assertEquals(List.of(1, 2, 3), ends.stream().map(RunEvent.RunStep::entry).toList());
        assertEquals(List.of(1, 2, 2), ends.stream().map(RunEvent.RunStep::round).toList());
        assertTrue(ends.stream().allMatch(x -> Integer.valueOf(2).equals(x.maxRounds())));
    }

    @Test
    void aChangedDocumentSaysChanged() throws IOException {
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        Files.writeString(ws.resolve("plan.md"), "# Tasks\nold\n");
        FakeHost host = new FakeHost(ws);
        host.onChat.put("write_plan", h -> PlaybookRunnerTest.write(h.workspace.resolve("plan.md"), "# Tasks\nnew\n"));
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        RunEvent.RunStep end = lines(host).stream()
                .filter(x -> "step_end".equals(x.phase()) && "write_plan".equals(x.node())).findFirst().orElseThrow();
        assertEquals("changed", end.documents().get(0).change());
    }

    @Test
    void aFailedChatStepClosesAsFailedAndTheRunEnds() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.stopReasons.add("error");
        host.replies.add("the backend refused");
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        List<RunEvent.RunStep> l = lines(host);
        RunEvent.RunStep end = l.stream().filter(x -> "step_end".equals(x.phase())).findFirst().orElseThrow();
        assertEquals("failed", end.status());
        assertTrue(end.error().contains("the backend refused"), end.error());
        assertEquals("step_failed", l.get(l.size() - 1).stopReason());
    }

    @Test
    void aStopClosesTheRunningStepAsStopped() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.onChat.put("write_plan", h -> h.signal.cancel());
        PlaybookRunnerTest.run(tmp, VocabularyTest.LOOP, host);

        RunEvent.RunStep end = lines(host).stream().filter(x -> "step_end".equals(x.phase())).findFirst().orElseThrow();
        assertEquals("stopped", end.status());
        assertEquals("aborted", lines(host).get(lines(host).size() - 1).stopReason());
    }

    @Test
    void aRefusedRunOpensAndClosesWithoutSteps() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.nobodyToAsk = true;
        PlaybookRunnerTest.run(tmp, PlaybookRunnerTest.nested(2, 2), host);

        assertEquals(List.of("run_start", "run_end"), shape(lines(host)));
        assertEquals("refused", lines(host).get(1).stopReason());
    }
}
```

Check before you rely on them: `PlaybookRunnerTest.write(Path, String)` exists as a static helper (add it, package-private, if it is private there); `RunStop.STEP_FAILED` is `"step_failed"`, `RunStop.ABORTED` is `"aborted"`, `RunStop.REFUSED` is `"refused"` (read `RunStop.java`; use the constants in the assertions if the strings differ); a human check without anybody to ask is refused before any node (`refusals(...)` with `canAsk` false).

- [ ] **Step 2: Run them to see them fail**

Run: `./gradlew :spectro-core:test --tests '*PlaybookRunStepsTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/red-task3.log 2>&1; echo $?`
Expected: 6 failures, no `run_step` lines.

- [ ] **Step 3: Return the review child**

`CheckResult.java`:

```java
public record CheckResult(String label, String detail, String childId) {

    /** A result no child produced. */
    public CheckResult(String label, String detail) {
        this(label, detail, null);
    }
```

`ReviewCheck.run`, both returns: `return new CheckResult(null, r.outcome(), r.childId());` and `return new CheckResult(label, "[" + r.childId() + "] " + (label == null ? "named no label" : "answered " + label), r.childId());`.

- [ ] **Step 4: Emit from the runner**

Add a field and the run lines:

```java
    private final RunSteps lines;
```

In the constructor: `this.lines = new RunSteps(setup.runId(), "playbook");`.

In `run()`, directly after the `host.emit(RunEvent.PlaybookProgress.started(...))` line:

```java
        host.emit(lines.runStart(p.name(), setup.task(), forwardNodes()));
```

In `end(...)`, after the `PlaybookProgress.ended` emit:

```java
        host.emit(lines.runEnd(stop, result, detail, System.currentTimeMillis() - began));
```

New helpers at the end of the class:

```java
    /** Card 586: the forward path as the run view lists it. */
    private List<RunEvent.RunNode> forwardNodes() {
        List<RunEvent.RunNode> out = new ArrayList<>();
        for (String id : status.keySet()) {
            out.add(new RunEvent.RunNode(id, nameOf(id), kindOf(id)));
        }
        return out;
    }

    private String kindOf(String id) {
        for (Playbook.Node n : p.nodes()) {
            if (n.id().equals(id)) {
                return n instanceof Playbook.Decision ? "decision" : "step";
            }
        }
        return "step";
    }

    /** Card 586: the documents a step reads, with the paths it is told. */
    private static List<RunEvent.RunDoc> reads(Playbook.Step s, Map<String, String> found) {
        List<RunEvent.RunDoc> out = new ArrayList<>();
        for (String id : s.consumes()) {
            String path = found.get(id);
            if (path != null) {
                out.add(new RunEvent.RunDoc(id, path, null));
            }
        }
        return out;
    }

    /** Card 586: the written documents, created when the path was not there before the step. */
    private List<RunEvent.RunDoc> written(Map<String, String> written, Map<String, Map<Path, Long>> before) {
        List<RunEvent.RunDoc> out = new ArrayList<>();
        written.forEach((id, path) -> {
            boolean existed = before.getOrDefault(id, Map.of()).keySet().stream()
                    .anyMatch(k -> host.workspace().relativize(k).toString().equals(path));
            out.add(new RunEvent.RunDoc(id, path, existed ? "changed" : "created"));
        });
        return out;
    }

    private static String statusOf(RunStopped stopped) {
        return RunStop.ABORTED.equals(stopped.reason()) ? RunSteps.STOPPED : RunSteps.FAILED;
    }
```

In `step(...)`: after `long t0 = ...;` add `int entry = lines.enter(s.id()); String output = null; Map<String, Map<Path, Long>> before = Map.of();`. Change the `before` line to assign (`before = snapshots(s.produces());`). Right after `recordStepStart(s, model, agent);` (the documents are known one line later, so emit after `StepPrompt.Prompt prompt = ...`):

```java
            host.emit(lines.stepStart(s.id(), s.name(), "step", entry, new RunSteps.Start(s.performer(),
                    "child".equals(s.performer()) ? (agent != null ? agent.name() : s.role() == null ? "worker" : s.role()) : null,
                    model.ref().provider(), model.ref().model(), setup.picks().containsKey(s.id()), prompt.record(),
                    reads(s, found), null, null)));
```

Keep the output: in the child branch after `childId = r.childId();` add `output = r.failed() ? r.outcome() : r.answer();`; in the chat branch after the turn add `output = turn.lastText();` (before the stop checks, so a failed turn carries its text too).

On success, after `recordStepEnd(s, childId, true, null, t0);`:

```java
            host.emit(lines.stepEnd(s.id(), s.name(), "step", entry, new RunSteps.End(RunSteps.DONE,
                    System.currentTimeMillis() - t0, childId, null, output, written(written, before), null, null, null, null)));
```

In the `RunStopped` catch, after `recordStepEnd(...)`:

```java
            host.emit(lines.stepEnd(s.id(), s.name(), "step", entry, new RunSteps.End(statusOf(stopped),
                    System.currentTimeMillis() - t0, childId, null, output, List.of(), null, stopped.getMessage(), null, null)));
```

In the `RuntimeException` catch, after `recordStepEnd(...)`:

```java
            host.emit(lines.stepEnd(s.id(), s.name(), "step", entry, new RunSteps.End(RunSteps.FAILED,
                    System.currentTimeMillis() - t0, childId, null, output, List.of(), null,
                    String.valueOf(failure.getMessage()), null, null)));
```

A step that throws before `stepStart` was emitted (model resolution, `agentOf`) must still open and close: emit `stepStart` with `null` provider and model at the top of the catch blocks when it was not emitted yet (keep a `boolean opened` flag set right after the `stepStart` emit).

In `decide(...)`: after `long t0 = ...;`:

```java
        int entry = lines.enter(d.id());
        host.emit(lines.stepStart(d.id(), d.name(), "decision", entry, new RunSteps.Start(null, null, null, null,
                false, null, List.of(), d.maxRounds() == null ? null : loops(state).getOrDefault(d.id(), 0) + 1,
                d.maxRounds())));
```

Before the `throw new RunStopped(reason, ...)` of the null-label branch:

```java
                host.emit(lines.stepEnd(d.id(), d.name(), "decision", entry, new RunSteps.End(RunSteps.FAILED,
                        System.currentTimeMillis() - t0, r.childId(), null, r.detail(), List.of(), null, r.detail(),
                        null, d.maxRounds())));
```

After `recordCheck(d, check, label, count, r.detail(), t0);` on the normal path:

```java
            host.emit(lines.stepEnd(d.id(), d.name(), "decision", entry, new RunSteps.End(RunSteps.DONE,
                    System.currentTimeMillis() - t0, r.childId(), null, r.detail(), List.of(), label, null,
                    d.maxRounds() == null ? null : count, d.maxRounds())));
```

Wrap the body of `decide` so a `RunStopped` from `stopIfCancelled(d.id())` also closes the entry: catch `RunStopped stopped` around the body, emit `stepEnd` with `statusOf(stopped)` unless an end was already emitted (a local `boolean closed`), rethrow.

- [ ] **Step 5: Run the tests to see them pass, and the neighbours**

Run: `./gradlew :spectro-core:test --tests 'dev.spectroscope.core.playbook.run.*' --rerun-tasks --no-build-cache > kanban/evidence/586/green-task3.log 2>&1; echo $?`
Expected: exit 0; `PlaybookRunStepsTest` 6 tests and every other class in the package green (count from the XML).

- [ ] **Step 6: Bite and commit**

Bites, one at a time: drop the `stepEnd` in the `RunStopped` catch (`aStopClosesTheRunningStepAsStopped` red); make `written(...)` always say `created` (`aChangedDocumentSaysChanged` red); drop `entry` counting (`aLoop...` red); drop the review `childId` (add an assertion first if no test sees it: a review check test in `ReviewAndHumanCheckTest` style that asserts `childId` on its `step_end`). Commit the five files: message `Card 586: the playbook runner tells the run view every step and decision`.

---

### Task 4: The workflow runner emits `run_step`

**Files:**
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/playbook/run/WorkflowRunner.java` (`run()`, `runStep(...)`, `prompt(...)`, `end(...)`)
- Create: `spectro-core/src/test/java/dev/spectroscope/core/playbook/run/WorkflowRunStepsTest.java`

**Interfaces:**
- Consumes: `RunSteps` (Task 2), the fixtures of `WorkflowRunnerTest` (read it first; reuse its workflow builders and its manager).
- Produces: `run_start` with `runKind` workflow and the steps as `nodes` (kind `prompt` or `fanout`, name the fan-out's `label` or the step id); per step `step_start` (performer `chat` for a prompt, `child` for a fan-out; provider and model of the chat; `input` the filled prompt or the agents' tasks joined with a newline) and `step_end` (`children`, `output` the answer, `status`); `run_end`.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 586: a workflow run tells the run view its prompt and fan-out steps. */
class WorkflowRunStepsTest {

    @TempDir Path tmp;

    @Test
    void aPromptStepAndAFanOutOpenAndCloseAndTheRunEnds() throws Exception {
        // Build the same two-step workflow (a prompt, then a fan-out with a join) that
        // WorkflowRunnerTest uses for its fan-out case, and run it the same way.
        WorkflowRunnerTest.Ran ran = WorkflowRunnerTest.promptThenFanout(tmp);

        List<RunEvent.RunStep> l = ran.host().events.stream().filter(RunEvent.RunStep.class::isInstance)
                .map(RunEvent.RunStep.class::cast).toList();
        assertEquals(List.of("run_start", "step_start", "step_end", "step_start", "step_end", "run_end"),
                l.stream().map(RunEvent.RunStep::phase).toList());
        assertEquals("workflow", l.get(0).runKind());
        assertEquals(List.of("prompt", "fanout"), l.get(0).nodes().stream().map(RunEvent.RunNode::kind).toList());
        assertEquals("chat", l.get(1).performer());
        assertTrue(l.get(1).input() != null && !l.get(1).input().isBlank());
        assertEquals("child", l.get(3).performer());
        assertTrue(l.get(4).children() != null && !l.get(4).children().isEmpty(), "the fan-out names its children");
        assertEquals("done", l.get(4).status());
        assertEquals("done", l.get(5).stopReason());
    }
}
```

If `WorkflowRunnerTest` has no reusable builder, add one there: `record Ran(FakeHost host, WorkflowRunner.Outcome out)` and `static Ran promptThenFanout(Path tmp)` built from the code its existing fan-out test runs. Do not change what that test asserts.

- [ ] **Step 2: Run it to see it fail**

Run: `./gradlew :spectro-core:test --tests '*WorkflowRunStepsTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/red-task4.log 2>&1; echo $?`
Expected: assertion failure, no `run_step` lines.

- [ ] **Step 3: Emit from the workflow runner**

Field and constructor: `private final RunSteps lines;` and `this.lines = new RunSteps(setup.runId(), "workflow");`.

In `run()` after `setup.recorder().record("workflow_start", start);`:

```java
        host.emit(lines.runStart(w.name(), setup.input(), w.steps().stream()
                .filter(s -> !(s instanceof Workflow.End))
                .map(s -> new RunEvent.RunNode(s.id(), s instanceof Workflow.Fanout f && f.label() != null ? f.label() : s.id(),
                        s instanceof Workflow.Prompt ? "prompt" : "fanout"))
                .toList()));
```

In `end(...)` after the recorder line: `host.emit(lines.runEnd(stop, result, detail, System.currentTimeMillis() - began));`.

Change `prompt(Workflow.Prompt p, String previous, CancelSignal signal)` to take the filled text: `prompt(Workflow.Prompt p, String text, CancelSignal signal)` and move the `fill(...)` call into `runStep`. In `runStep`, before the `switch`:

```java
        String kind = step instanceof Workflow.Prompt ? "prompt" : "fanout";
        String name = step instanceof Workflow.Fanout f && f.label() != null ? f.label() : step.id();
        int entry = lines.enter(step.id());
        String input = step instanceof Workflow.Prompt p ? fill(p.template().in(setup.lang()), previous, null)
                : ((Workflow.Fanout) step).agents().stream().map(a -> fill(a.task().in(setup.lang()), previous, null))
                        .collect(java.util.stream.Collectors.joining("\n"));
        host.emit(lines.stepStart(step.id(), name, kind, entry, new RunSteps.Start(
                step instanceof Workflow.Prompt ? "chat" : "child", null, host.chatModel().provider(),
                host.chatModel().model(), false, input, List.of(), round, null)));
```

Use `input` as the prompt's text (`case Workflow.Prompt p -> prompt(p, input, stepSignal);`). After `record(step, round, true, null, children, t0);`:

```java
            host.emit(lines.stepEnd(step.id(), name, kind, entry, new RunSteps.End(RunSteps.DONE,
                    System.currentTimeMillis() - t0, null, children, answer, List.of(), null, null, round, null)));
```

In the `RunStopped` catch after its `record(...)`:

```java
            host.emit(lines.stepEnd(step.id(), name, kind, entry, new RunSteps.End(
                    RunStop.ABORTED.equals(stopped.reason()) ? RunSteps.STOPPED : RunSteps.FAILED,
                    System.currentTimeMillis() - t0, null, children, answer, List.of(), null, stopped.getMessage(),
                    round, null)));
```

In the `RuntimeException` catch after its `record(...)`:

```java
            host.emit(lines.stepEnd(step.id(), name, kind, entry, new RunSteps.End(RunSteps.FAILED,
                    System.currentTimeMillis() - t0, null, children, answer, List.of(), null,
                    String.valueOf(failure.getMessage()), round, null)));
```

`name`, `kind`, `entry` and `input` are declared before the `try` so both catches see them.

- [ ] **Step 4: Run the tests to see them pass**

Run: `./gradlew :spectro-core:test --tests '*WorkflowRunStepsTest*' --tests '*WorkflowRunnerTest*' --tests '*WorkflowFanOutTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/green-task4.log 2>&1; echo $?`
Expected: exit 0, counts from the XML.

- [ ] **Step 5: Bite and commit**

Bite: drop the `children` on the success end (the fan-out assertion red); restore. Commit `WorkflowRunner.java`, `WorkflowRunStepsTest.java` (and `WorkflowRunnerTest.java` if you added the builder): message `Card 586: the workflow runner tells the run view its steps`.

---

### Task 5: The server carries `run_step` and serves a run's documents

**Files:**
- Create: `spectro-server/src/test/java/dev/spectroscope/server/session/RunStepSessionFileTest.java` (model it on `PlaybookConfirmFrameTest`, which proves the session file holds `playbook_progress`)
- Modify: `spectro-server/src/main/java/dev/spectroscope/server/workspace/WorkspaceController.java` (new route `/api/run-document`; extract the body serving of `/api/file` into `private ResponseEntity<byte[]> serve(Path requested)`)
- Create: `spectro-server/src/test/java/dev/spectroscope/server/workspace/RunDocumentRouteTest.java`
- Modify: the local-fence registration list the server pins (find it with `git grep -n "api/file" -- 'spectro-server/src/test/**/ApiLocalFenceRegistrationTest.java'`), and add `/api/run-document` beside `/api/file`

**Interfaces:**
- Consumes: `SessionStore.readSessionEvents(String id)` (`spectro-core/.../session/SessionStore.java:505`), `RunEvent.RunStep`, `WorkspaceController.rootFor(String)`, `resolveInside(Path, String)`, `LocalOrigin.isLocalOrigin(request)`.
- Produces: `GET /api/run-document?session=<id>&run=<12 hex>&path=<workspace-relative>`: 200 with the same typed bytes and headers as `/api/file`; 404 when the session's file names no such document of that run, for any `.git` segment, for a file name `.env` or starting with `.env.`, for a path outside the workspace, a directory, a missing file, a non-local caller; 400 for a malformed session or run id; 413 and 415 as `/api/file`.

- [ ] **Step 1: Write the failing tests**

`RunDocumentRouteTest` drives the controller the way the existing `WorkspaceControllerDotEntriesTest` does (read it; reuse its setup of a session id, a recorded workspace and a local request). Cases:

```java
    @Test void aRecordedDocumentUnderADotFolderOpens()            // .superpowers/sdd/x/task-1-report.md, recorded: 200, body equals the file
    @Test void aDocumentTheRunDidNotRecordIsRefused()               // same folder, other file: 404
    @Test void theRecordOfAnotherRunDoesNotOpenIt()                 // recorded under run bbbbbbbbbbbb, asked with aaaaaaaaaaaa: 404
    @Test void anEnvFileIsNeverServedEvenWhenRecorded()             // recorded ".env" and "conf/.env.local": 404 both
    @Test void aGitPathIsNeverServedEvenWhenRecorded()              // recorded ".git/config": 404
    @Test void aLinkOutOfTheWorkspaceIsRefused()                    // recorded "out.md" -> symlink to a file outside: 404
    @Test void aPathWithSpacesAndUnicodeOpens()                     // recorded "docs/Plan für Frogger.md": 200
    @Test void aClimbingPathIsRefused()                             // recorded "../x.md": 404
    @Test void aForeignCallerGetsNothing()                          // non-local request: 404
    @Test void aMalformedRunIdIsABadRequest()                       // run "zz": 400
```

Write the recorded documents into the session's file with `SessionStore`'s writer, one `RunEvent.RunStep` `step_end` line per case (`documents` holding the path).

`RunStepSessionFileTest`: start a playbook run through the socket as `PlaybookConfirmFrameTest` does; after its end, read the session file and assert it holds `run_step` lines with phases `run_start`, `step_start`, `step_end`, `run_end` in that order.

- [ ] **Step 2: Run them to see them fail**

Run: `./gradlew :spectro-server:test --tests '*RunDocumentRouteTest*' --tests '*RunStepSessionFileTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/red-task5.log 2>&1; echo $?`
Expected: the route tests fail with 404 for the allowed cases (no route); `RunStepSessionFileTest` passes already if Tasks 1 to 3 are merged (it proves the drain path; keep it).

- [ ] **Step 3: Add the route**

Extract everything after the segment check of `file(...)` (from `if (!Files.isRegularFile(requested))` to the end) into `private ResponseEntity<byte[]> serve(Path requested)` and call it from `file(...)`. Then:

```java
    /**
     * Card 586: a document a run recorded as written, also under a dot folder
     * such as {@code .superpowers/}. Only the exact path the session's own
     * record names for that run opens; {@code .env} files and anything under
     * {@code .git} never do, recorded or not.
     */
    @GetMapping("/api/run-document")
    public ResponseEntity<byte[]> runDocument(@RequestParam("session") String session,
            @RequestParam("run") String run, @RequestParam("path") String rel, HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build();
        }
        if (!run.matches("[0-9a-f]{12}")) {
            return ResponseEntity.badRequest().build();
        }
        Path base;
        try {
            base = rootFor(session);
        } catch (IllegalArgumentException badId) {
            return ResponseEntity.badRequest().build();
        } catch (NoWorkspaceResolved none) {
            return ResponseEntity.notFound().build();
        }
        if (!recorded(session, run, rel)) {
            return ResponseEntity.notFound().build();
        }
        Path realBase;
        Path requested;
        try {
            realBase = base.toRealPath();
            requested = resolveInside(realBase, rel);
        } catch (IOException outside) {
            return ResponseEntity.notFound().build();
        }
        for (Path segment : realBase.relativize(requested)) {
            if (".git".equals(segment.toString())) {
                return ResponseEntity.notFound().build();
            }
        }
        String fileName = requested.getFileName().toString();
        if (".env".equals(fileName) || fileName.startsWith(".env.")) {
            return ResponseEntity.notFound().build();
        }
        return serve(requested);
    }

    /** @return true when the session's file names {@code rel} as a document {@code run} wrote */
    private static boolean recorded(String session, String run, String rel) {
        try {
            for (RunEvent event : SessionStore.readSessionEvents(session)) {
                if (event instanceof RunEvent.RunStep s && run.equals(s.runId())
                        && RunEvent.RunStep.STEP_END.equals(s.phase()) && s.documents() != null
                        && s.documents().stream().anyMatch(d -> rel.equals(d.path()))) {
                    return true;
                }
            }
        } catch (IOException unreadable) {
            return false;
        }
        return false;
    }
```

Add the route to the local-fence registration list and to `docs/api-collections/endpoints.json` (Task 11 regenerates the collections).

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task5.log`, plus `--tests '*WorkspaceController*' --tests '*ApiLocalFence*'`. Expected: exit 0.

- [ ] **Step 5: Bite and commit**

Bites: skip `recorded(...)` (the not-recorded case red); drop the `.env` check (the env case red); drop the `.git` loop (the git case red); restore each. Commit the controller, the two new tests and the fence list: message `Card 586: the server serves a run's recorded documents, never .env or .git`.

---

### Task 6: The web folds a run

**Files:**
- Modify: `spectro-web/src/events.ts` (the `RunEvent` union)
- Create: `spectro-web/src/state/runView.ts`
- Create: `spectro-web/src/state/runView.test.ts`
- Modify: `spectro-web/src/state/reducer.ts` (`UiState.runs`, `initialState.runs = []`, the fold call at the top of `applyFrame`, `case "run_step"`, the `runEntry` tag on the user turn a chat step sends, near `reducer.ts:1381` where `by: "playbook"` is set)
- Modify: `spectro-web/src/testkit/archiveEvents.ts` (one run per cycle: `run_start`, a chat `step_start` and `step_end`, `run_end`)

**Interfaces:**
- Consumes: the event of Task 1 as TypeScript.
- Produces (exported from `state/runView.ts`):

```ts
export type EntryStatus = "running" | "waiting" | "done" | "failed" | "stopped";
export type NodeStatus = EntryStatus | "pending" | "skipped";
export interface RunDoc { doc: string; path: string; change?: "created" | "changed" }
export interface RunFile { path: string; change: "created" | "changed" | "unchanged" | "unknown" }
export interface RunEntry {
  key: string; // `${runId}:${node}:${entry}`
  runId: string;
  node: string;
  name: string;
  kind: string;
  entry: number;
  status: EntryStatus;
  startedTs: number;
  endedTs: number | null;
  durationMs: number | null;
  performer: "chat" | "child" | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  picked: boolean;
  agents: string[]; // "main" for a chat step; the child and its descendants for a child step
  input: string | null;
  inputChars: number | null;
  reads: RunDoc[];
  round: number | null;
  maxRounds: number | null;
  output: string | null;
  outputChars: number | null;
  documents: RunDoc[];
  files: RunFile[];
  shellCalls: number;
  liveLine: string | null;
  label: string | null;
  error: string | null;
  children: string[];
}
export interface RunTrack {
  runId: string;
  kind: "playbook" | "workflow";
  name: string;
  task: string | null;
  nodes: { id: string; name: string; kind: string }[];
  startedTs: number;
  endedTs: number | null;
  durationMs: number | null;
  stopReason: string | null;
  result: string | null;
  detail: string | null;
  entries: RunEntry[];
}
export function foldRun(runs: RunTrack[], event: RunEvent): RunTrack[];
export function nodeStatuses(run: RunTrack): Record<string, NodeStatus>;
export function currentEntry(run: RunTrack): RunEntry | null;
export function runningChatEntryKey(runs: RunTrack[]): string | null;
export function isUnfinished(run: RunTrack, live: boolean): boolean; // no run_end and the session is not live
```

- [ ] **Step 1: Write the failing tests**

`runView.test.ts` (complete; the events are built with a tiny helper):

```ts
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { currentEntry, foldRun, isUnfinished, nodeStatuses, runningChatEntryKey, type RunTrack } from "./runView";

const R = "abcdefabcdef";
let ts = 0;
const ev = (e: Record<string, unknown>): RunEvent => ({ ts: ++ts, ...e }) as unknown as RunEvent;
const step = (phase: string, node: string, more: Record<string, unknown> = {}): RunEvent =>
  ev({ type: "run_step", agentId: "playbook", runId: R, runKind: "playbook", phase, node, name: node, kind: "step", entry: 1, ...more });
const fold = (events: RunEvent[]): RunTrack[] => events.reduce(foldRun, [] as RunTrack[]);
const start = ev({
  type: "run_step", agentId: "playbook", runId: R, runKind: "playbook", phase: "run_start", name: "spectro", task: "baue Frogger",
  nodes: [{ id: "brainstorm", name: "Brainstorm", kind: "step" }, { id: "spec_ok", name: "Spec ok", kind: "decision" }, { id: "build", name: "Build", kind: "step" }],
});

describe("the run fold (card 586)", () => {
  it("opens a run and an entry, closes it with its output and documents", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat", provider: "anthropic", model: "claude-opus-5-5", input: "Playbook spectro, step Brainstorm" }),
      step("step_end", "brainstorm", { status: "done", durationMs: 1200, output: "spec written", documents: [{ doc: "spec", path: ".superpowers/spec.md", change: "created" }] }),
    ]);
    expect(runs).toHaveLength(1);
    const e = runs[0].entries[0];
    expect(e.key).toBe(`${R}:brainstorm:1`);
    expect(e.status).toBe("done");
    expect(e.output).toBe("spec written");
    expect(e.documents[0].path).toBe(".superpowers/spec.md");
    expect(e.agents).toEqual(["main"]);
  });

  it("joins the file writes of a chat step and keeps created when the file is changed again", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      ev({ type: "tool_call", agentId: "main", callId: "c1", name: "write_file", input: { path: "a.md", content: "x" } }),
      ev({ type: "tool_result", agentId: "main", callId: "c1", output: "Wrote: a.md", isError: false, fileChange: "created" }),
      ev({ type: "tool_call", agentId: "main", callId: "c2", name: "edit_file", input: { path: "a.md", old_string: "x", new_string: "y" } }),
      ev({ type: "tool_result", agentId: "main", callId: "c2", output: "Edited: a.md", isError: false, fileChange: "changed" }),
      ev({ type: "tool_call", agentId: "main", callId: "c3", name: "write_file", input: { path: "denied.md", content: "x" } }),
      ev({ type: "tool_result", agentId: "main", callId: "c3", output: "denied", isError: true }),
      ev({ type: "tool_call", agentId: "main", callId: "c4", name: "run_command", input: { command: "touch b" } }),
    ]);
    const e = runs[0].entries[0];
    expect(e.files).toEqual([{ path: "a.md", change: "created" }]);
    expect(e.shellCalls).toBe(1);
  });

  it("gives a child step its child and the child's descendants", () => {
    const runs = fold([
      start,
      step("step_start", "build", { performer: "child", role: "worker" }),
      ev({ type: "agent_message", from: "main", to: "worker-1", role: "task", state: "submitted", text: "t", label: "playbook:build" }),
      ev({ type: "agent_spawn", agentId: "explore-1", parentId: "worker-1", task: "look" }),
      ev({ type: "tool_call", agentId: "explore-1", callId: "c9", name: "write_file", input: { path: "deep.md", content: "x" } }),
      ev({ type: "tool_result", agentId: "explore-1", callId: "c9", output: "Wrote", isError: false, fileChange: "created" }),
    ]);
    const e = runs[0].entries[0];
    expect(e.agents).toEqual(["worker-1", "explore-1"]);
    expect(e.files.map((f) => f.path)).toEqual(["deep.md"]);
  });

  it("shows the live line, then waiting while the run asks, then running again", () => {
    let runs = fold([start, step("step_start", "brainstorm", { performer: "chat" }), ev({ type: "text_delta", agentId: "main", text: "first line\nsecond li" })]);
    expect(runs[0].entries[0].liveLine).toBe("second li");
    runs = [ev({ type: "question_asked", agentId: "main", callId: `pb-${R}-1`, questions: [] })].reduce(foldRun, runs);
    expect(runs[0].entries[0].status).toBe("waiting");
    runs = [ev({ type: "question_answered", callId: `pb-${R}-1`, answers: [] })].reduce(foldRun, runs);
    expect(runs[0].entries[0].status).toBe("running");
  });

  it("marks loops as entries, the never entered nodes skipped at the end, and stops a still running entry", () => {
    const runs = fold([
      start,
      step("step_start", "brainstorm", { performer: "chat" }),
      step("step_end", "brainstorm", { status: "done" }),
      step("step_start", "spec_ok", { kind: "decision", maxRounds: 2, round: 1 }),
      ev({ type: "run_step", agentId: "playbook", runId: R, runKind: "playbook", phase: "run_end", stopReason: "aborted" }),
    ]);
    const statuses = nodeStatuses(runs[0]);
    expect(statuses.brainstorm).toBe("done");
    expect(statuses.spec_ok).toBe("stopped");
    expect(statuses.build).toBe("skipped");
  });

  it("keeps two runs apart, the latest current", () => {
    const other = "bbbbbbbbbbbb";
    const runs = fold([
      start,
      ev({ type: "run_step", agentId: "playbook", runId: R, runKind: "playbook", phase: "run_end", stopReason: "done" }),
      ev({ type: "run_step", agentId: "playbook", runId: other, runKind: "workflow", phase: "run_start", name: "fanout-review", nodes: [] }),
      ev({ type: "run_step", agentId: "playbook", runId: other, runKind: "workflow", phase: "step_start", node: "diff", name: "diff", kind: "prompt", entry: 1, performer: "chat" }),
    ]);
    expect(runs.map((r) => r.runId)).toEqual([R, other]);
    expect(currentEntry(runs[1])?.key).toBe(`${other}:diff:1`);
    expect(runningChatEntryKey(runs)).toBe(`${other}:diff:1`);
  });

  it("says a stored run without an end is unfinished only when the session is not live", () => {
    const runs = fold([start, step("step_start", "brainstorm", { performer: "chat" })]);
    expect(isUnfinished(runs[0], false)).toBe(true);
    expect(isUnfinished(runs[0], true)).toBe(false);
  });

  it("returns the same array for an event that touches no run", () => {
    const runs: RunTrack[] = [];
    expect(foldRun(runs, ev({ type: "text_delta", agentId: "main", text: "x" }))).toBe(runs);
  });
});
```

In `reducer.test.ts` add: a `run_step` `step_start` of a chat step followed by `run_start` with `origin: "playbook"` tags the user turn with `runEntry === "<runId>:<node>:1"`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/state/runView.test.ts src/state/reducer.test.ts src/state/archiveFold.test.ts --maxWorkers=2 > kanban/evidence/586/red-task6.log 2>&1; echo $?`
Expected: `runView.ts` missing.

- [ ] **Step 3: Add the type and the fold**

`events.ts`, in the union after `playbook_picked`:

```ts
  // Card 586: one line of a playbook or workflow run for the run view beside the chat.
  | {
      type: "run_step";
      agentId: string;
      runId: string;
      runKind: "playbook" | "workflow";
      phase: "run_start" | "step_start" | "step_end" | "run_end";
      name?: string;
      task?: string;
      nodes?: { id: string; name?: string; kind: string }[];
      node?: string;
      kind?: string;
      entry?: number;
      performer?: "chat" | "child";
      role?: string;
      provider?: string;
      model?: string;
      picked?: boolean;
      input?: string;
      inputChars?: number;
      reads?: { doc: string; path: string }[];
      round?: number;
      maxRounds?: number;
      status?: "done" | "failed" | "stopped";
      durationMs?: number;
      childId?: string;
      children?: string[];
      output?: string;
      outputChars?: number;
      documents?: { doc: string; path: string; change?: "created" | "changed" }[];
      label?: string;
      error?: string;
      stopReason?: string;
      result?: string;
      detail?: string;
      ts: number;
    } // additive
```

`state/runView.ts`: implement the exported functions above. Rules the code must follow (each is pinned by a test of Step 1):
- `foldRun` returns the same array object when the event does not touch a run: no runs and not a `run_step`; or the last run has ended and the event is not a `run_step`.
- `run_start` appends a track; `step_start` appends an entry (status `running`, `agents` `["main"]` for a chat performer, `[]` for a child until its task message); `step_end` finds the entry by node and entry number and sets status, ended time, duration, output, documents, label, error, round, children, `childId` (added to `agents` when missing); `run_end` sets the run's end fields and turns every `running` or `waiting` entry into `stopped`.
- Only the running entries of the last run join other events: `agent_message` with role `task` and label `playbook:<node>` (or `workflow:<node>`) sets the child; `agent_spawn` whose `parentId` is in an entry's `agents` adds the child to `agents` (and to `children` for a fan-out entry); `tool_call` of a file tool (`write_file`, `edit_file`, `Write`, `Edit`, `MultiEdit`) by one of the entry's agents remembers `callId -> path` (from `input.path` or `input.file_path`); `tool_result` with that `callId` adds or updates a file row (`isError` drops it; the first change word stays when it was `created`; a missing `fileChange` reads `unknown`); a `tool_call` named `run_command` or `Bash` counts `shellCalls`; `text_delta` of an entry agent appends to a buffer of at most 2,000 characters and sets `liveLine` to its last non-empty line; `question_asked` with a `callId` starting `pb-<runId>-` sets `waiting`, `question_answered` with that `callId` sets `running`.
- `nodeStatuses`: per node of `run.nodes`, the status of its latest entry; a node with no entry is `skipped` when the run has ended, else `pending`.
- `currentEntry`: the last entry with status `running` or `waiting`, else the last entry, else null.
- `runningChatEntryKey`: the key of the last run's running chat entry, else null.
- `isUnfinished`: `run.endedTs === null && !live`.
- Never mutate: return new arrays and objects for every change (the reducer relies on identity).

`reducer.ts`:
- `UiState`: `runs: RunTrack[];` with a doc comment `Card 586: the runs of this session, folded from run_step and the events of each step's agents.`; `initialState.runs: []`.
- At the top of `applyFrame` (before the `workspace_info` branch): `const runs = foldRun(traced.runs, event); if (runs !== traced.runs) traced = { ...traced, runs };` (make `traced` a `let`).
- In the switch: `case "run_step": return traced;` (the fold already ran; Task 10 adds the workflow lines here).
- Where `run_start` with `origin === "playbook"` creates the user turn with `by: "playbook"`, add `runEntry: runningChatEntryKey(traced.runs) ?? undefined`, and add `runEntry?: string` to the user turn type with the comment `Card 586: the run entry this prompt belongs to.`

`archiveEvents.ts`: in the cycle, after the `playbook_confirm` push, push a `run_start`, a chat `step_start` and `step_end`, and a `run_end` of run id `ar${c.toString(16).padStart(10, "0")}`; add `card 586's run_step` to the header list.

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task6.log`, plus `npx tsc -b`, `npx eslint src/state/runView.ts src/state/reducer.ts src/events.ts src/testkit/archiveEvents.ts`, `npx prettier --check` on the same files. Expected: all exit 0; `archiveFold.test.ts` keeps its slice budget.

- [ ] **Step 5: Bite and commit**

Bites: make `foldRun` always return a new array (the identity test red); drop the descendant join (the child step test red); let a second write overwrite `created` (the file test red); drop the `skipped` rule (the end test red). Commit the five files: message `Card 586: the web folds a run with its entries, files and live line`.

---

### Task 7: The compact run panel

**Files:**
- Create: `spectro-web/src/components/RunPanel.tsx`
- Create: `spectro-web/src/components/runPanelModel.ts` (pure texts and marks)
- Create: `spectro-web/src/components/runPanel.test.tsx`
- Create: `spectro-web/src/state/runReveal.ts` and `spectro-web/src/state/runReveal.test.ts`
- Create: `spectro-web/src/styles/run-panel.css` and import it in `spectro-web/src/styles/app.css` beside `playbook-run.css`
- Modify: `spectro-web/src/components/PlanTab.tsx` (render the run when there is one, the model's plan under it)
- Modify: `spectro-web/src/components/RightPanel.tsx` (pass `runs`, `planAgent`, `liveView`, `sessionId`, the callbacks to `PlanTab`)
- Modify: `spectro-web/src/App.tsx` (hand `view.runs` and `view.planAgent` to `RightPanel`; call `runRevealPushLive(batch)` beside `browserRevealPushLive(batch)` for the batch in view)
- Modify: `spectro-web/src/panels/dockOpeners.drift.test.ts` (add the two sites `state/runReveal.ts revealRunPanel openDockPanel` and `... openRightPanel`, each with a comment)
- Modify: `spectro-web/src/i18n/i18n.ts` (the `run.panel.*` keys below)

**Interfaces:**
- Consumes: `RunTrack`, `RunEntry`, `nodeStatuses`, `currentEntry`, `isUnfinished` (Task 6).
- Produces:

```ts
// RunPanel.tsx
export function RunPanel(props: {
  runs: RunTrack[];
  live: boolean;
  wide: boolean;
  onToggleWide: () => void;
  onJump: (entry: RunEntry) => void;
  onOpenPath: (run: RunTrack, path: string) => void;
}): JSX.Element;
// runReveal.ts
export function revealRunPanel(runId: string): void; // openRightPanel(); openDockPanel("plan"); once per run id
export function runRevealPushLive(batch: RunEvent[]): void; // a run_step run_start reveals
export function __resetRunRevealForTests(): void;
// runPanelModel.ts
export function statusMark(s: NodeStatus): string; // "[x]" done, "[>]" running, "[?]" waiting, "[!]" failed, "[-]" stopped, "[ ]" pending, "[~]" skipped; decisions use "<x>" etc.
export function durationText(ms: number | null): string; // "0:04", "2:14", "1:02:03"
export function whoText(lang: Lang, e: RunEntry): string; // "Chat" or "worker-1 (worker)", plus model and "picked"
export function decisionText(lang: Lang, e: RunEntry): string | null; // "Review, round 2 of 5: changes needed"
```

i18n keys (EN, DE):

| Key | en | de |
|---|---|---|
| `run.panel.title` | `Run: {name}` | `Lauf: {name}` |
| `run.panel.wide` | `wide` | `groß` |
| `run.panel.small` | `small` | `klein` |
| `run.panel.runs` | `Runs` | `Läufe` |
| `run.panel.running` | `running {time}` | `läuft {time}` |
| `run.panel.ended` | `ended after {time}: {result}` | `beendet nach {time}: {result}` |
| `run.panel.unfinished` | `no end recorded` | `kein Ende verzeichnet` |
| `run.panel.chat` | `Chat` | `Chat` |
| `run.panel.picked` | `picked` | `gewählt` |
| `run.panel.in` | `in` | `rein` |
| `run.panel.out` | `out` | `raus` |
| `run.panel.created` | `new` | `neu` |
| `run.panel.changed` | `changed` | `geändert` |
| `run.panel.shell` | `{n} shell commands, their files are not captured` | `{n} Shell-Befehle, ihre Dateien sind nicht erfasst` |
| `run.panel.round` | `round {round} of {max}` | `Runde {round} von {max}` |
| `run.panel.waiting` | `waits for you` | `wartet auf dich` |
| `run.panel.skipped` | `skipped` | `übersprungen` |
| `run.panel.modelPlan` | `Plan of the model` | `Plan des Modells` |

- [ ] **Step 1: Write the failing tests**

`runPanel.test.tsx` renders `RunPanel` with folded runs (build them with `foldRun` and the event helper of Task 6) and asserts:
- the title, the task and `running 0:42` style text for a live run; `no end recorded` for a stored run without `run_end` (`live: false`);
- one card per entry in time order, then the not entered nodes with `skipped` after the end or pending marks before it;
- a chat entry card shows `Chat` and the model; a child entry `worker-1 (worker)`; a picked model shows `picked`;
- `in` lists the read documents, `out` the written ones with `new` or `changed`, and the shell count line when `shellCalls > 0`;
- the running entry shows its `liveLine`; a waiting entry `waits for you`;
- a decision entry shows `round 2 of 5` and its label;
- a click on a card calls `onJump` with that entry; a click on a document calls `onOpenPath` with the run and its path; `wide` calls `onToggleWide`;
- the run picker lists both runs when there are two and switching shows the other's entries;
- German: render with the `de` language and assert `Lauf:`, `rein`, `raus`, `neu`.

`runReveal.test.ts`: a batch with `run_step` `run_start` opens the dock and the plan panel (spy on `openRightPanel`, `openDockPanel` from `state/layout`); a second batch of the same run id does not open again; a new run id does.

`PlanTab`: a test that with `runs` empty it renders the plan list exactly as today (snapshot of the existing rows), and with a run it renders the run and, when `planAgent` is not `playbook`, the model's plan under the heading `Plan of the model`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/runPanel.test.tsx src/state/runReveal.test.ts src/components/PlanTab.test.ts src/panels/dockOpeners.drift.test.ts --maxWorkers=2 > kanban/evidence/586/red-task7.log 2>&1; echo $?`
Expected: modules missing; the drift test red for the new sites once `runReveal.ts` exists.

- [ ] **Step 3: Build**

`runReveal.ts` follows `state/browserReveal.ts` line for line, keyed by run id:

```ts
// Card 586: a run that starts opens the run panel beside the chat, once per run.
import type { RunEvent } from "../events";
import { openDockPanel, openRightPanel } from "./layout";

const shown = new Set<string>();

export function revealRunPanel(runId: string): void {
  if (shown.has(runId)) return;
  shown.add(runId);
  openRightPanel();
  openDockPanel("plan");
}

export function runRevealPushLive(batch: RunEvent[]): void {
  for (const event of batch) {
    const e = event as { type?: string; phase?: string; runId?: string };
    if (e.type === "run_step" && e.phase === "run_start" && typeof e.runId === "string") revealRunPanel(e.runId);
  }
}

export function __resetRunRevealForTests(): void {
  shown.clear();
}
```

`RunPanel.tsx`: a header (title, task, status text, the run picker as a `<select>` when `runs.length > 1`, the `wide` or `small` button), a graph strip (one `<span>` per node of the run with `statusMark` and the node name in its `title`, decisions drawn with `<` `>`), then the cards. Card markup: `<article className="run-card run-card--{status}" data-entry={key}>` with a header row (mark, name, duration or `running`), `whoText`, `in` and `out` rows, the files list (at most 5 rows, then `+N`), the shell line, the live line for a running entry, the decision line. Each document and file path is a `<button type="button" className="run-path">` that calls `onOpenPath`. The card itself is a `<button>`-like region with `role="button"` and `tabIndex={0}` calling `onJump` on click and Enter. Selected run state lives in the component (`useState` of a run id, defaulting to the last run, following a new last run when it arrives).

`PlanTab.tsx`: new props `runs: RunTrack[]`, `planAgent: string | null`, `live: boolean`, `wide: boolean`, `onToggleWide`, `onJump`, `onOpenPath`. When `runs.length > 0`, render `<RunPanel .../>` and, when `plan` is non-empty and `planAgent !== "playbook"`, the existing list under `<h3 className="run-model-plan">{t(lang, "run.panel.modelPlan")}</h3>`. Otherwise render exactly what it renders today.

`RightPanel.tsx`: thread the new props through to `PlanTab` (the panel's badge count stays `plan?.length` when there is no run, and becomes the number of entries of the latest run when there is one).

`App.tsx`: `runRevealPushLive(batch)` inside the `if (info.inView)` block beside `browserRevealPushLive(batch)`; pass `runs={view.runs}`, `planAgent={view.planAgent}` to `RightPanel`. The `onJump`, `onOpenPath` and `wide` wiring arrive in Tasks 8 and 9; until then pass no-ops and `wide={false}`.

`run-panel.css`: tokens of the existing panels only (`styles/panels.css` variables); status colours from the existing `agent-card--*` palette; no new colour literals.

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task7.log`, plus `npx tsc -b`, eslint and prettier on every touched file. Expected: all exit 0.

- [ ] **Step 5: Bite and commit**

Bites: reveal on every batch (the second-batch case red); drop the `skipped` text (red); drop the German keys (the German case red). Commit every file of this task: message `Card 586: the run panel beside the chat`.

---

### Task 8: The wide view

**Files:**
- Modify: `spectro-web/src/state/layout.ts` (`runWide: boolean` in `LayoutState`, default `false`, persisted like the other fields; `setRunWide(on: boolean): void`)
- Modify: `spectro-web/src/App.tsx` (when `layout.runWide` and the dock shows the plan panel, the chat column is hidden and the dock takes the chat tab's full width)
- Create: `spectro-web/src/components/RunWideView.tsx`, `spectro-web/src/components/RunChain.tsx`, `spectro-web/src/state/useRunGraph.ts`
- Modify: `spectro-web/src/stategraph/StateGraphView.tsx` (optional prop `nodeLabels?: Record<string, string>`: the card label is `nodeLabels?.[id] ?? label`)
- Create: `spectro-web/src/components/runWideView.test.tsx`, `spectro-web/src/state/layoutRunWide.test.ts`
- Modify: `spectro-web/src/i18n/i18n.ts` (`run.wide.*` keys: `who` Wer / Who, `in` Rein / In, `out` Raus / Out, `files` Dateien / Files, `helpers` Helfer / Helpers, `inChat` Im Chat / In the chat, `noGraph` "Dieser Lauf hat keinen Graphen." / "This run has no graph.")

**Interfaces:**
- Consumes: Task 6 types; `fetchRunGraph(sessionId, runId)` from `state/playbookRuns.ts`; `StateGraphView` and `DEFAULT_VIEW` from `stategraph/`.
- Produces:

```ts
export function setRunWide(on: boolean): void; // layout.ts
export function useRunGraph(sessionId: string | null, run: RunTrack | null, live: boolean): string; // graph NDJSON, "" for a workflow run; polls every 1000 ms while the run has no end and live is true
export function RunWideView(props: { runs: RunTrack[]; sessionId: string | null; live: boolean; onSmall: () => void; onJump: (e: RunEntry) => void; onOpenPath: (run: RunTrack, path: string) => void }): JSX.Element;
export function RunChain(props: { run: RunTrack; selected: string | null; onSelect: (node: string) => void }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

`layoutRunWide.test.ts`: `setRunWide(true)` sets `runWide`, survives a reload of the store from storage, `setRunWide(false)` clears it.

`runWideView.test.tsx`:
- a playbook run renders `StateGraphView` with `nodeLabels` mapping node ids to names (mock `useRunGraph` to return a recorded graph NDJSON from `stategraph/scenarios` or a small literal with `graph_topology` and `node_start` lines);
- a workflow run renders `RunChain` with one link per node and no graph;
- the detail shows the current entry by default: `Who`, the model, `In` with the input text and the read documents, `Out` with the output, the written documents and the files, the helpers of a fan-out;
- a pick of another node (through `StateGraphView`'s `onView` with `picked` set, or a click in `RunChain`) shows that node's latest entry;
- `In the chat` calls `onJump`; `small` calls `onSmall`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/components/runWideView.test.tsx src/state/layoutRunWide.test.ts --maxWorkers=2 > kanban/evidence/586/red-task8.log 2>&1; echo $?`

- [ ] **Step 3: Build**

`useRunGraph` moves the polling of `playbook/PlaybookRunView.tsx` (lines 31 to 59) into a hook keyed by session and run id; it returns `""` without a request for a workflow run. `RunWideView` lays out a header (as the panel), the graph area (`StateGraphView` with `graphJsonl`, `stateJsonl={null}`, `source={run.runId}`, `view`, `onView`, `nodeLabels`) or `RunChain`, and the detail of the selected entry. `App.tsx`: when `layout.runWide` is true and the plan panel is the dock's shown panel, render `RunWideView` in the chat area's place and keep the dock column closed; `RunPanel`'s `onToggleWide` calls `setRunWide(true)`, `RunWideView`'s `onSmall` calls `setRunWide(false)`.

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task8.log`, plus `npx vitest run src/stategraph --maxWorkers=2`, `npx tsc -b`, eslint, prettier. Expected: exit 0.

- [ ] **Step 5: Bite and commit**

Bites: ignore `nodeLabels` (the label assertion red); default the selection to the first entry (the default case red). Commit the task's files: message `Card 586: the wide run view with the run's graph`.

---

### Task 9: Jumps into the chat and opening a run's files

**Files:**
- Create: `spectro-web/src/state/chatFocus.ts` and `spectro-web/src/state/chatFocus.test.ts`
- Create: `spectro-web/src/state/fileOpenRequest.ts` and `spectro-web/src/state/fileOpenRequest.test.ts`
- Modify: `spectro-web/src/components/Chat.tsx` and `spectro-web/src/components/ChatV2.tsx` (subscribe to the focus store; `data-run-entry` on a user turn with `runEntry`; `data-agent-thread` on a child's thread header (v1) and chip (v2); scroll the target into view, release the live pin as the search jump does at `Chat.tsx:686`, add the class `chat-focus` for 2 seconds)
- Modify: `spectro-web/src/workspace/WorkspaceTab.tsx` and `spectro-web/src/workspace/fileTabs.ts` (a `FileTab` may carry `url`; the tab subscribes to `fileOpenRequest` and opens the path; the preview fetches `tab.url ?? fileUrl(path, sessionId)`)
- Modify: `spectro-web/src/workspace/preview.ts` (`runDocumentUrl(sessionId: string, runId: string, path: string): string`)
- Modify: `spectro-web/src/App.tsx` (the `onJump` and `onOpenPath` handlers of Tasks 7 and 8)
- Modify: `spectro-web/src/panels/dockOpeners.drift.test.ts` (the Files panel opened by `onOpenPath`)

**Interfaces:**
- Consumes: `RunEntry.key`, `RunEntry.performer`, `RunEntry.agents` (Task 6).
- Produces:

```ts
// chatFocus.ts
export type ChatFocusTarget = { kind: "entry"; key: string } | { kind: "agent"; agentId: string };
export function requestChatFocus(target: ChatFocusTarget): void;
export function useChatFocus(): { target: ChatFocusTarget; seq: number } | null;
// fileOpenRequest.ts
export function requestOpenFile(path: string, url?: string): void;
export function useFileOpenRequest(): { path: string; url?: string; seq: number } | null;
// preview.ts
export function runDocumentUrl(sessionId: string, runId: string, path: string): string; // `/api/run-document?session=..&run=..&path=..`, each part encodeURIComponent
```

App handlers:

```ts
const onJump = (entry: RunEntry): void => {
  setRunWide(false);
  requestChatFocus(entry.performer === "child" && entry.agents[0] !== undefined
    ? { kind: "agent", agentId: entry.agents[0] }
    : { kind: "entry", key: entry.key });
};
const onOpenPath = (run: RunTrack, path: string): void => {
  const hidden = path.split("/").some((seg) => seg.startsWith("."));
  const session = view.workspace?.sessionId ?? null;
  requestOpenFile(path, hidden && session !== null ? runDocumentUrl(session, run.runId, path) : undefined);
  openRightPanel();
  openDockPanel("files");
};
```

- [ ] **Step 1: Write the failing tests**

- `chatFocus.test.ts`: a request is seen by a subscriber with an increasing `seq`; the same target twice gives two `seq` values.
- `fileOpenRequest.test.ts`: same for files; `runDocumentUrl("s-1", "abcdefabcdef", "docs/Plan für Frogger.md")` equals `/api/run-document?session=s-1&run=abcdefabcdef&path=docs%2FPlan%20f%C3%BCr%20Frogger.md`.
- A Chat test (in the style of `components/sendAgainAfterCommand.test.ts`, which hosts Chat with a real `SessionSet`): a user turn with `runEntry` renders `data-run-entry`; a focus request for that key scrolls it (spy on `Element.prototype.scrollIntoView`) and adds `chat-focus`.
- A WorkspaceTab test: a request with a `url` opens a tab whose preview fetches that url (spy on `fetch`).

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/state/chatFocus.test.ts src/state/fileOpenRequest.test.ts <the Chat and WorkspaceTab test files> --maxWorkers=2 > kanban/evidence/586/red-task9.log 2>&1; echo $?`

- [ ] **Step 3: Build**

`state/chatFocus.ts` (and `state/fileOpenRequest.ts` the same way with `{ path, url }`):

```ts
// Card 586: a request from the run view to show one place in the chat.
import { useSyncExternalStore } from "react";

export type ChatFocusTarget = { kind: "entry"; key: string } | { kind: "agent"; agentId: string };
type Request = { target: ChatFocusTarget; seq: number };

let current: Request | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function requestChatFocus(target: ChatFocusTarget): void {
  seq += 1;
  current = { target, seq };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useChatFocus(): Request | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Test-only. */
export function __resetChatFocusForTests(): void {
  current = null;
  seq = 0;
}
```

In `Chat.tsx` (and `ChatV2.tsx` with its own scroll container):

```ts
  const focus = useChatFocus();
  useEffect(() => {
    if (focus === null) return;
    const selector =
      focus.target.kind === "entry"
        ? `[data-run-entry="${CSS.escape(focus.target.key)}"]`
        : `[data-agent-thread="${CSS.escape(focus.target.agentId)}"]`;
    const el = scrollRef.current?.querySelector(selector);
    if (el == null) return;
    setPin(false); // reading, not following the stream (the search jump does the same)
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("chat-focus");
    const timer = setTimeout(() => el.classList.remove("chat-focus"), 2000);
    return () => clearTimeout(timer);
  }, [focus?.seq]);
```

The user turn renders `data-run-entry={turn.runEntry}` when set; the v1 thread header and the v2 chip of a child render `data-agent-thread={agentId}`. `WorkspaceTab.tsx` reads `useFileOpenRequest()` in an effect keyed by its `seq` and calls `setFiles((s) => openFile(s, path, url))`; `openFile` in `fileTabs.ts` takes an optional `url` and stores it on the new tab; the preview uses `tab.url ?? fileUrl(tab.path, sessionId)`.

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task9.log` plus `npx vitest run src/components/chat*.test.* src/workspace --maxWorkers=2`, `npx tsc -b`, eslint, prettier.

- [ ] **Step 5: Bite and commit**

Bites: drop `encodeURIComponent` on the path (the URL test red); drop `setPin(false)` in the focus jump (add an assertion that the pin is released); restore. Commit: message `Card 586: jumps from a run into the chat and opening a run's documents`.

---

### Task 10: The Playbook segment, the chat lines and workflow lines

**Files:**
- Modify: `spectro-web/src/playbook/PlaybookPane.tsx:465-490` (remove `PlaybookRunView`; add one line `Runs of this session: open` that switches to the chat tab and calls `setRunWide(true)` and `openDockPanel("plan")`)
- Delete: `spectro-web/src/playbook/PlaybookRunView.tsx` only after `git grep -n PlaybookRunView` shows no other user; move it to `_old/` is not used in this repo, so delete it in the same commit with its tests' updated expectations
- Modify: `spectro-web/src/playbook/playbookPaneStoredRun.test.tsx`, `spectro-web/src/playbook/playbookPane.test.tsx` (the run view is gone, the link is there)
- Modify: `spectro-web/src/state/playbookChat.ts` (`progressLine` start line carries `runId`), `spectro-web/src/state/reducer.ts` (the info turn type gets `runId?: string`; `case "run_step"` adds a start and an end info line for `runKind === "workflow"`)
- Modify: `spectro-web/src/components/Chat.tsx`, `ChatV2.tsx` (an info line with `runId` shows a button `open the run` that calls `revealRunPanel(runId)` and `setRunWide(false)`)
- Modify: `spectro-web/src/i18n/i18n.ts` (`chat.run.open` "Lauf ansehen" / "open the run"; `chat.wf.start` "Workflow {name} gestartet auf: {task}" / "Workflow {name} started on: {task}"; `chat.wf.startNoTask` "Workflow {name} gestartet" / "Workflow {name} started"; `chat.wf.end` "Der Workflow ist beendet: {words}.{more}" / "The workflow ended: {words}.{more}"; `pb.run.segmentLink` "Läufe dieser Session: öffnen" / "Runs of this session: open")
- Modify: `spectro-web/src/panels/dockOpeners.drift.test.ts` (the segment link and the chat button sites)
- Modify: `spectro-web/src/lab/labScene.ts`, `spectro-web/src/spectrum/spectrumModel.ts` and their existing tests (the `playbook` agent id is not an agent)

**Interfaces:**
- Consumes: `revealRunPanel` (Task 7), `setRunWide` (Task 8).
- Produces: no new module API.

- [ ] **Step 1: Write the failing tests**

- `playbookChat.test.ts`: the start line of `progressLine` carries `runId`.
- `reducer.test.ts`: a workflow `run_start` adds an info line with `infoKey` `chat.wf.start` and `runId`; a workflow `run_end` adds `chat.wf.end` with the stop words; a playbook `run_step` adds no line (the `playbook_progress` lines stay the only ones).
- A Chat test: the start line shows the `open the run` button and a click reveals the plan panel (spy on `openDockPanel`).
- `playbookPane.test.tsx`: no `.pb-run-view`; the link exists and a click calls `setRunWide(true)`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/state/playbookChat.test.ts src/state/reducer.test.ts src/playbook src/panels/dockOpeners.drift.test.ts --maxWorkers=2 > kanban/evidence/586/red-task10.log 2>&1; echo $?`

- [ ] **Step 3: Build**

`playbookChat.ts`, both start branches of `progressLine` add `runId: text(l.runId) ?? undefined` to the returned line (and the `ProgressLine` type gets `runId?: string`).

`reducer.ts`, the `run_step` case:

```ts
    case "run_step": {
      // Card 586: a workflow run has no playbook_progress, so its start and end
      // lines come from here; a playbook run keeps its own lines.
      if (event.runKind !== "workflow") return traced;
      if (event.phase === "run_start") {
        const name = event.name ?? "?";
        const task = event.task ?? null;
        return appendTurn(traced, task === null
          ? { kind: "info", text: `Workflow ${name} started`, tone: "neutral", infoKey: "chat.wf.startNoTask", infoVars: { name }, runId: event.runId }
          : { kind: "info", text: `Workflow ${name} started on: ${task}`, tone: "neutral", infoKey: "chat.wf.start", infoVars: { name, task }, runId: event.runId });
      }
      if (event.phase === "run_end") {
        const reason = event.stopReason ?? "?";
        const more = event.detail ? ` ${event.detail}` : "";
        return appendTurn(traced, { kind: "info", text: `The workflow ended: ${reason}.${more}`, tone: reason === "done" ? "neutral" : "warn", infoKey: "chat.wf.end", infoVars: { words: reason, more } });
      }
      return traced;
    }
```

Use the reducer's existing helper for appending an info turn (find it next to the `playbook_progress` case at `reducer.ts:1388`; if it is named differently, use that name). The info turn type gets `runId?: string`.

Chat: an info turn with `runId` renders, after its text, `<button type="button" className="chat-run-open" onClick={() => { setRunWide(false); revealRunPanel(turn.runId); }}>{t(lang, "chat.run.open")}</button>`. `revealRunPanel` opens the panel even after its once-per-run reveal: give it a second parameter `force = false` and pass `true` here.

`PlaybookPane.tsx`: replace the `<PlaybookRunView sessionId={...} />` element with:

```tsx
<p className="pb-run-link">
  <button type="button" onClick={() => { onShowChat(); setRunWide(true); openRightPanel(); openDockPanel("plan"); }}>
    {t(lang, "pb.run.segmentLink")}
  </button>
</p>
```

where `onShowChat` is the pane's existing way back to the chat tab (pass it from `App.tsx` as the pane already receives its navigation callbacks; read the pane's props first).

Lab and Spectrum: in `lab/labScene.ts` and `spectrum/spectrumModel.ts`, events whose `agentId` is `playbook` (`plan`, `playbook_progress`, `run_step`) do not create an agent card or lane; add one test in each module's existing test file that folds a `run_step` and asserts no card or lane named `playbook`.

- [ ] **Step 4: Run the tests to see them pass** with `green-task10.log`, plus `npx vitest run src/lab src/spectrum --maxWorkers=2`, `npx tsc -b`, eslint, prettier.

- [ ] **Step 5: Bite and commit**

Bites: emit the workflow line for playbook runs too (the playbook case red); restore. Commit: message `Card 586: the run view leaves the Playbook segment; the chat links to runs`.

---

### Task 11: Documentation

**Files:**
- Modify: `docs/guide-assets/parts/05-web-tabs.html` (the Plan panel paragraph: it shows a run's steps, opens itself at a run's start, wide mode)
- Modify: `docs/guide-assets/parts/11d-playbooks.html` (the run section: the run panel and wide view replace the run view of the Steps tab; "What a run leaves behind" names `run_step` in the session file and the document route)
- Modify: `docs/guide-assets/parts/15-ref-events.html` (a `run_step` entry in the style of the `playbook_progress` entry at line 91, marked `additive · card 586`, with the phases and fields)
- Modify: `docs/guide-assets/parts/16-ref-wire.html` (the event row)
- Modify: `docs/api-collections/endpoints.json` (`GET /api/run-document`, its fence, its 404 and 400 rules) and regenerate the Bruno and Postman collections with the generator's `--no-source-scan` (the source scan fails on main for reasons older than this card)

- [ ] **Step 1:** Run the guide drift tests first to see what they hold: `./gradlew :spectro-core:test --tests '*GuideDriftTest*' --tests '*ConfigDocDriftTest*' --tests '*RunEndGuideDriftTest*' --rerun-tasks --no-build-cache > kanban/evidence/586/docs-before.log 2>&1; echo $?` and the server's `WireDocDriftTest`.
- [ ] **Step 2:** Edit the parts; text through the rules of the house (no dashes, plain sentences, EN in the guide).
- [ ] **Step 3:** Run the same tests again (`docs-after.log`); they stay green with the parts changed. Do not rebuild `docs/USER-GUIDE.html`, `docs/USER-GUIDE-LIGHT.html` or the PDFs here: the integrator rebuilds and stamps them once on the integration branch.
- [ ] **Step 4:** Commit the parts, `endpoints.json` and the regenerated collections: message `Card 586: the guide and the API collections describe the run view`.

---

### Task 12: Verification

**Files:**
- Create: `kanban/evidence/586/VERIFY.md`
- Create: a Playwright script in the evidence folder (not in the repo) that loads the web app built from this branch, replays a recorded session with a playbook run (record one in Step 2), and takes screenshots

- [ ] **Step 1: Full gates, alone** (no other build on the machine): `./gradlew test --continue --rerun-tasks --no-build-cache`, the five javadoc tasks, `npm run gate` in `spectro-web`, `npm test` in `spectro-desktop`; logs and exit codes into the evidence folder; counts from the JUnit XML and the vitest summary; commit the bundle the web gate built in its own commit.
- [ ] **Step 2: A recorded run.** Build a jar of this branch into `/tmp`, start it with `-Duser.home=<temp home>` on a port outside 8080 to 8100, run `/run-with-playbook "write a one-line README"` with the bundled spectro playbook on the house test backend (Ollama `minimax-m3:cloud`, else `qwen2.5:7b`), stop the jar; keep the session file.
- [ ] **Step 3: Playwright** against the installed Chrome channel: the panel opening at the start, a running card with its live line, a finished card with a document under `.superpowers/` opened in the preview, the wide view with the graph, a workflow run as a chain; light and dark; 1280 and 420 pixels wide; zero console errors. Screenshots into the evidence folder.
- [ ] **Step 4: Live in the test app** (the integrator's test app build): the same run, a Stop during a step (the card turns `stopped`, the run ends), a jump from a card into the chat.
- [ ] **Step 5:** Write `VERIFY.md` (what ran, counts, screenshots, what was not done) and commit it in the home repo with explicit paths.
