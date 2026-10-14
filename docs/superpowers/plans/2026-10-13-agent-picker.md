# Agent Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every view that shows one agent's data says which agent it shows, one picker over the main agent and every helper switches all of them at once, a helper's context view shows its fill, its model and the sizes of its parts, and plans are kept per writer.

**Architecture:** The core gives `AgentOptions` a switch `introspectionTexts`; the child builder turns introspection on with the texts off, so a helper emits a sizes-only `context_info` each turn (one line of about 363 bytes, the frame unchanged, a null `text` leaves the key off). The web folds a helper's `usage`, `context_info` and `run_start` into `UiState.helpers[id]` and every `plan` frame into `UiState.plans[writer]`. A module store `state/shownAgent.ts` keeps one choice per record in view; App resolves it once per render and hands the same `ShownAgent` and one `onPickAgent` to the chat's composer row and to the right panel. One component `AgentPicker` sits in the ring's popover, in the Plan panel and in the System context panel.

**Tech Stack:** Java 21 (spectro-core, JUnit 5, Jackson), TypeScript and React 19 (spectro-web, vitest 3, no DOM in the suite: `renderToStaticMarkup`, `testkit/driveComponent.tsx` and source-reading drift tests).

**Spec:** `docs/superpowers/specs/2026-10-13-agent-picker-design.md` (approved 2026-10-13, commit `8c0b0cb2`). Card: `kanban/593-every-agent-view-says-which-agent-it-shows.md` in the home repo. Surveys with file and line facts: `kanban/evidence/593/survey-context.md`, `survey-plan.md`, `survey-agents.md`.

## Global Constraints

- Branch `card-593` in worktree `spectroscope-harness/worktrees/wt-card-593`. Part A (Tasks 1 to 3) builds now, on `c7c16528` (the integration branch). Part B (Tasks 4 to 10) builds after card 586 has landed in the integration branch and `card-593` has been rebased onto it (Task 4). Never push.
- Commits: explicit paths only, never `git add -A`; identity `git -c user.email=chris@spectroscope.ai -c user.name="Christopher Ezell" commit`; every message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit a task before you bite it.
- No em dashes and no en dashes anywhere: code, comments, UI text, docs, test names, commit messages. Existing dashes in lines you do not otherwise touch stay as they are.
- UI text in English and German (`spectro-web/src/i18n/i18n.ts`, entries `"key": { de: "...", en: "..." }`). Every new key passes the four drift tests of that folder: both languages (`i18n.test.ts`), each placeholder once (`placeholderOnce.test.ts`), no card number or private path (`publicText.test.ts`), function replacement for slot fills (`slotFill.drift.test.ts`). Dictionary text names no card number.
- The wire stays additive: `context_info` keeps its shape and its type name, a null part `text` leaves the key off through the existing `@JsonInclude(NON_NULL)` on `ContextPart`, no new event type. The main agent (`SessionConnection.java:4395`) and the CLI (`SpectroCli.java:1023`) keep the texts; only the child builder switches them off.
- Every numeric `static final` of governing shape carries `@Governs` (`GoverningNumbersDriftTest`); this plan adds none in Java. The one new number in TypeScript, the task clip of 40 characters, is a named constant with a comment.
- No private network address in any file (`NoOperatorAddressesInTheRepoTest`); use `192.0.2.1` for a dead address.
- Tests: red first on the old code, saved to `kanban/evidence/593/red-<task>.log`; green to `green-<task>.log`; mutation bites from your own snapshot (`cp <file> <scratchpad>/<name>.snap` before the bite, `cp` it back after, never `git checkout`), logged to `bites-<task>.log`, `git diff --quiet -- <file>; echo $?` prints 0 after each restore. A guard that pins existing behaviour (a pin) is green at once and proves itself by its bite.
- Targeted runs only during tasks: `./gradlew :<module>:test --tests '<Class>' --rerun-tasks --no-build-cache` (redirect to a file, read `$?`, never pipe); `npx vitest run <files> --maxWorkers=2`; `npx tsc -b`; `npx eslint <files>`; `npx prettier --check <files>`. Counts come from the JUnit XML under `<module>/build/test-results/test/` or from the vitest summary line, not from the exit code alone. Never `npm run build` or `npm run gate` inside a task (they rewrite the tracked bundle); Task 10 runs the gates alone.
- No CPU hog runs. No ports 8080 to 8100. Never attach to the owner's running app. Never read `~/.gradle/gradle.properties`, any `.env` or `~/.spectro/.env`.
- Modes: the ring's picker works wherever the ring is drawn (learn, light, developer); the Plan and System context panels follow it wherever the dock offers them.
- Part B line numbers below were measured on `c7c16528` before the 586 merge. Every Part B task starts by re-reading the merged file and moving its edits to where the code is now.

## Review Focus

1. A resumed session reuses a helper id (`explore-1` again, the counter lives per connection, `SubagentManager.java:131`): the roster upserts one row, the helper slot takes the newer run's figures and model, and the picker lists it once. Pinned in Task 5.
2. A `usage` line of the pseudo agent `session-title` (Copilot credits) puts a parentless row into the roster: the picker leaves it out, and a choice naming it resolves to the root with `missing` set; with `rootAgentId` known the root is never that row. Pinned in Task 6 and Task 7.
3. A helper picked before its first turn (state `submitted`, no `run_start`, no `usage`, no slot in `helpers`): the ring shows 0 %, the popover shows no model line, `ctx.window.unknown` and `ctx.helperNoSnapshot`, and nothing throws on the missing slot. Pinned in Task 6 (`figuresOf`) and Task 8.
4. A `window_override` or a `context_cleared` while a helper is shown: the root's fields move, the helper's slot is the same object as before, and the helper popover draws no window row. Pinned in Task 5 and Task 8.
5. Escape with the picker's list closed: the picker does not handle it, so the popover's own document listener closes the popover; with the list open the picker handles it and stops propagation, so one Escape closes the list and the next the popover. Pinned in Task 7.

---

## Part A: core and wire, built now on `c7c16528`

### Task 1: `AgentOptions.introspectionTexts`

**Files:**
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/AgentOptions.java` (record javadoc `@param` list ending at :120, record header :122-141, a new compat constructor before the card 503 one at :143, builder field after :651, builder setter after :691, `build()` :835-842)
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/config/V0144ArityCompatTest.java:37-38` (`APPENDED_TO_OPTIONS`)
- Create: `spectro-core/src/test/java/dev/spectroscope/core/AgentOptionsIntrospectionTextsTest.java`

**Interfaces:**
- Produces: the record component `Boolean introspectionTexts` (last, after `agentMessaging`); `AgentOptions.Builder.introspectionTexts(boolean)`; a public 30-argument compat constructor with the card 503 arity that passes `null` for the new component.

- [ ] **Step 1: Write the failing tests**

`AgentOptionsIntrospectionTextsTest.java`:

```java
package dev.spectroscope.core;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Constructor;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/** Card 593: the switch that keeps the part texts off a helper's context_info. */
class AgentOptionsIntrospectionTextsTest {

    @Test
    void theBuilderCarriesTheSwitchAndLeavesItUnsetByDefault() {
        AgentOptions unset = AgentOptions.builder().provider(request -> List.of()).build();
        assertNull(unset.introspectionTexts(), "unset keeps the texts, as every caller before this card");

        AgentOptions off = AgentOptions.builder()
                .provider(request -> List.of())
                .introspection(true)
                .introspectionTexts(false)
                .build();
        assertEquals(Boolean.FALSE, off.introspectionTexts());
        assertEquals(Boolean.TRUE, off.introspection());
    }

    @Test
    void theCard503ArityStillBuildsAndKeepsTheTexts() throws Exception {
        Constructor<?> compat = Arrays.stream(AgentOptions.class.getConstructors())
                .filter(c -> c.getParameterCount() == 30)
                .findFirst()
                .orElseThrow(() -> new AssertionError("the 30-argument constructor of card 503 is gone"));
        AgentOptions built = (AgentOptions) compat.newInstance(new Object[30]);
        assertNull(built.introspectionTexts(), "a caller of the older arity keeps the texts");
    }
}
```

In `V0144ArityCompatTest.java:37-38` append the component to the options list:

```java
    /** AgentOptions also carries card 502's peer inbox, appended after v0.15.1, and card 593's text switch. */
    private static final List<String> APPENDED_TO_OPTIONS =
            List.of("sessionsPerChat", "careParagraph", "readSharePercent", "peerInbox", "agentMessaging",
                    "introspectionTexts");
```

- [ ] **Step 2: Run them to see them fail**

Run: `./gradlew :spectro-core:test --tests '*AgentOptionsIntrospectionTextsTest*' --tests '*V0144ArityCompatTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/red-task1.log 2>&1; echo $?`
Expected: compile failure, `introspectionTexts` does not exist. (Once it compiles, `V0144ArityCompatTest` would fail its premise until the component is appended; both ways red.)

- [ ] **Step 3: Add the component, the constructor and the builder setter**

Record javadoc, after the `@param agentMessaging` lines (:118-120):

```java
 * @param introspectionTexts  card 593: FALSE leaves the texts of the three
 *                            context parts off every {@code context_info} this
 *                            agent emits and keeps their character counts; null
 *                            or TRUE sends the texts. The child builder sets it
 *                            off, so a helper reports its sizes each turn while
 *                            the main agent and the CLI keep the texts
```

Record header: change the last line `Boolean agentMessaging) {` to `Boolean agentMessaging,` and append a line `Boolean introspectionTexts) {`.

New compat constructor, placed directly before the card 503 one (before the javadoc at :143):

```java
    /** Compat: the arity of card 503, which knew no text switch (card 593).
     *  A caller without one keeps the texts on every {@code context_info}.
     *
     * @param provider the component of the same name
     * @param systemPrompt the component of the same name
     * @param registry the component of the same name
     * @param cwd the component of the same name
     * @param onPermission the component of the same name
     * @param agentId the component of the same name
     * @param parentId the component of the same name
     * @param initialMessages the component of the same name
     * @param providerName the component of the same name
     * @param maxTokens the component of the same name
     * @param compactionThreshold the component of the same name
     * @param introspection the component of the same name
     * @param thinking the component of the same name
     * @param hooks the component of the same name
     * @param llmWire the component of the same name
     * @param latency the component of the same name
     * @param progressGuard the component of the same name
     * @param maxTurns the component of the same name
     * @param continuationLeash the component of the same name
     * @param goal the component of the same name
     * @param steering the component of the same name
     * @param rtkFilter the component of the same name
     * @param sessionWindow the component of the same name
     * @param toolResultElision the component of the same name
     * @param toolGroupsOff the component of the same name
     * @param sessionsPerChat the component of the same name
     * @param careParagraph the component of the same name
     * @param readSharePercent the component of the same name
     * @param peerInbox the component of the same name
     * @param agentMessaging the component of the same name
     */
    public AgentOptions(LlmProvider provider,
                        String systemPrompt,
                        ToolRegistry registry,
                        Path cwd,
                        PermissionBroker onPermission,
                        String agentId,
                        String parentId,
                        List<ProviderMessage> initialMessages,
                        String providerName,
                        Integer maxTokens,
                        Integer compactionThreshold,
                        Boolean introspection,
                        Boolean thinking,
                        HookRunner hooks,
                        LlmWireRecorder llmWire,
                        dev.spectroscope.core.provider.ExchangeLatency latency,
                        dev.spectroscope.core.progress.ProgressGuard progressGuard,
                        Integer maxTurns,
                        dev.spectroscope.core.loop.ContinuationLeash continuationLeash,
                        dev.spectroscope.core.goal.SessionGoal goal,
                        dev.spectroscope.core.steering.SteeringInbox steering,
                        dev.spectroscope.core.tools.RtkFilter rtkFilter,
                        dev.spectroscope.core.session.SessionWindow sessionWindow,
                        String toolResultElision,
                        java.util.function.Supplier<java.util.Set<ToolGroup>> toolGroupsOff,
                        Integer sessionsPerChat,
                        String careParagraph,
                        Integer readSharePercent,
                        dev.spectroscope.core.peer.PeerInbox peerInbox,
                        Boolean agentMessaging) {
        this(provider, systemPrompt, registry, cwd, onPermission, agentId, parentId, initialMessages,
                providerName, maxTokens, compactionThreshold, introspection, thinking, hooks, llmWire,
                latency, progressGuard, maxTurns, continuationLeash, goal, steering, rtkFilter,
                sessionWindow, toolResultElision, toolGroupsOff, sessionsPerChat, careParagraph,
                readSharePercent, peerInbox, agentMessaging, null);
    }
```

The card 503 constructor at :176-206 keeps its body; its `this(...)` call now ends `..., peerInbox, null, null);` (one `null` for `agentMessaging`, one for `introspectionTexts`).

Builder: after `private Boolean agentMessaging; // nullable, the shipped on` (:651) add `private Boolean introspectionTexts; // nullable, the texts ride`. After the `introspection(boolean)` setter (:691) add:

```java
        /** Card 593: whether the three context parts carry their texts.
         *  @param value false sends the character counts only; true, or the
         *               builder left alone, sends the texts as before
         *  @return this builder */
        public Builder introspectionTexts(boolean value) { this.introspectionTexts = value; return this; }
```

`build()`: the constructor call ends `readSharePercent, peerInbox, agentMessaging, introspectionTexts);`.

- [ ] **Step 4: Run the tests to see them pass, and the javadoc**

Run the command of Step 2 with `green-task1.log`. Expected: exit 0; `AgentOptionsIntrospectionTextsTest` 2 tests, `V0144ArityCompatTest` 3 tests, 0 failures (count them in the XML).
Then: `./gradlew :spectro-core:javadoc --rerun-tasks --no-build-cache > kanban/evidence/593/javadoc-task1.log 2>&1; echo $?` Expected: exit 0, no `error:` line.

- [ ] **Step 5: Commit, then bite**

```bash
git add spectro-core/src/main/java/dev/spectroscope/core/AgentOptions.java spectro-core/src/test/java/dev/spectroscope/core/config/V0144ArityCompatTest.java spectro-core/src/test/java/dev/spectroscope/core/AgentOptionsIntrospectionTextsTest.java
git -c user.email=chris@spectroscope.ai -c user.name="Christopher Ezell" commit -F <message file>
```

Message: `Card 593: AgentOptions.introspectionTexts` plus the trailer.

Bite (into `bites-task1.log`): in `build()` pass `null` instead of `introspectionTexts`; `theBuilderCarriesTheSwitchAndLeavesItUnsetByDefault` goes red; restore from your snapshot; `git diff --quiet -- spectro-core/src/main/java/dev/spectroscope/core/AgentOptions.java; echo $?` prints 0.

---

### Task 2: `Agent.contextInfo` sends sizes only when the texts are off

**Files:**
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/Agent.java` (`contextInfo` :1877-1917, `part` :1969-1977)
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/AgentTest.java` (a new test after `introspectionEmitsOneContextInfoPerTurnAndOnlyWhenEnabled`, which ends at :892)
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/events/RunEventJsonTest.java` (a new test after `everyEventTypeSurvivesAJacksonRoundTrip`, :53-60)

**Interfaces:**
- Consumes: `AgentOptions.introspectionTexts()` (Task 1).
- Produces: with `introspectionTexts` FALSE, every `ContextPart` of this agent's `context_info` has `text == null`, the same `chars` and `estTokens` as with texts, and the same `estimatedTokens` and `messages` on the frame; `renderConversation` and the schema text are not built then.

- [ ] **Step 1: Write the failing tests**

In `AgentTest.java`, after :892 (add `import static org.junit.jupiter.api.Assertions.assertNull;` if the file lacks it):

```java
    @Test
    void introspectionWithoutTextsKeepsEveryCountAndCarriesNoContent() {
        // Card 593: a helper reports the sizes of its parts, not the texts. Two
        // agents run the same script, so their counts have to agree part for
        // part; only the content differs.
        JsonNode input = JSON.createObjectNode().put("value", "42");
        List<LlmProvider.ProviderEvent> first = List.of(
                new LlmProvider.PToolCall("c1", "echo", input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        List<LlmProvider.ProviderEvent> second = List.of(
                new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        List<RunEvent.ContextInfo> withTexts = contextInfos(true, first, second);
        List<RunEvent.ContextInfo> sizesOnly = contextInfos(false, first, second);

        assertEquals(2, sizesOnly.size(), "one context_info per turn, texts or not");
        for (int turn = 0; turn < 2; turn++) {
            RunEvent.ContextInfo full = withTexts.get(turn);
            RunEvent.ContextInfo sizes = sizesOnly.get(turn);
            assertEquals(full.estimatedTokens(), sizes.estimatedTokens(), "turn " + turn);
            assertEquals(full.messages(), sizes.messages(), "turn " + turn);
            assertEquals(3, sizes.parts().size());
            for (int i = 0; i < 3; i++) {
                RunEvent.ContextPart a = full.parts().get(i);
                RunEvent.ContextPart b = sizes.parts().get(i);
                assertEquals(a.label(), b.label());
                assertEquals(a.chars(), b.chars(), "the full count stays on " + a.label());
                assertEquals(a.estTokens(), b.estTokens(), "the estimate stays on " + a.label());
                assertNull(b.text(), "no text on " + a.label());
            }
        }
        assertTrue(withTexts.get(0).parts().get(0).chars() > 0, "the system prompt is counted");
        assertEquals("test", withTexts.get(0).parts().get(0).text(), "an agent built with texts keeps them");
    }

    @SafeVarargs
    private static List<RunEvent.ContextInfo> contextInfos(boolean texts, List<LlmProvider.ProviderEvent>... turns) {
        FakeProvider provider = FakeProvider.scripted(turns);
        ToolRegistry registry = new ToolRegistry();
        registry.register(new EchoTool(false));
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)
                .introspectionTexts(texts)
                .build());
        return collect(agent).stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .toList();
    }
```

In `RunEventJsonTest.java`, after `everyEventTypeSurvivesAJacksonRoundTrip` (this one is a pin of the existing `NON_NULL`, green at once; Step 5 proves it bites):

```java
    @Test
    void aSizesOnlyContextPartLeavesTheTextKeyOffAndReadsBackEqual() throws Exception {
        // Card 593: a helper's context_info carries sizes only. The wire says
        // "no text" by leaving the key off, as every pre-content session did.
        RunEvent.ContextInfo sizes = new RunEvent.ContextInfo("explore-1", 1, 3, 2652, 100_000,
                List.of(new RunEvent.ContextPart("system prompt", 1200, 300, null),
                        new RunEvent.ContextPart("tool schemas", 4208, 1052, null),
                        new RunEvent.ContextPart("conversation", 5200, 1300, null)),
                15L, "fallback");
        String line = JSON.writeValueAsString(sizes);
        assertFalse(line.contains("\"text\""), "no text key on a sizes-only line: " + line);
        assertTrue(line.contains("\"chars\":1200"), "the full count rides: " + line);
        assertEquals(sizes, JSON.readValue(line, RunEvent.class));

        RunEvent.ContextInfo texts = new RunEvent.ContextInfo("main", 1, 3, 2652, 100_000,
                List.of(new RunEvent.ContextPart("system prompt", 1200, 300, "You are the main agent.")),
                15L, "fallback");
        assertTrue(JSON.writeValueAsString(texts).contains("\"text\":\"You are the main agent.\""),
                "a line with texts keeps them");
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `./gradlew :spectro-core:test --tests '*AgentTest*' --tests '*RunEventJsonTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/red-task2.log 2>&1; echo $?`
Expected: `introspectionWithoutTextsKeepsEveryCountAndCarriesNoContent` fails at `assertNull(b.text(), ...)` (the old code sends texts whatever the switch says); the wire test is green already.

- [ ] **Step 3: Read the switch in `contextInfo`**

Replace the lines from `String schemaText = advertised.stream()` through the `List<ContextPart> parts = List.of(...)` statement (:1902-1908) with the block below. `<the existing map lambda>` stands for the `.map(spec -> ...)` line of :1903 exactly as it is today, byte for byte, because it is the wire text of the main agent's tool schema part and the main agent's line must not change.

```java
        // Card 593: a helper reports sizes only. The texts of its parts stay
        // off the wire and are not rendered at all, so its line costs a few
        // hundred bytes where the main agent's costs tens of kilobytes.
        boolean texts = !Boolean.FALSE.equals(options.introspectionTexts());
        String schemaText = texts
                ? advertised.stream()
                        <the existing map lambda>
                        .reduce((a, b) -> a + "\n\n" + b).orElse("")
                : null;
        List<ContextPart> parts = List.of(
                part("system prompt", systemChars, texts ? systemForGauge : null),
                part("tool schemas", schemaChars, schemaText),
                part("conversation", conversationChars, texts ? renderConversation(messages) : null));
```

`part(...)` (:1975-1977) becomes null-safe, and its javadoc says so:

```java
    /** Builds one labeled slice of the context estimate, deriving its tokens as
     *  chars/4 and carrying the (capped) content itself, what actually rides
     *  to the provider, readable in the trace (card 86 follow-up).
     *  @param label the slice name shown by the introspection UI
     *  @param chars the raw character count behind the estimate
     *  @param text  the slice's content, capped here; null when the agent sends
     *               sizes only (card 593), and the wire then carries no text key */
    private static ContextPart part(String label, int chars, String text) {
        return new ContextPart(label, chars, chars / 4, text == null ? null : capped(text));
    }
```

- [ ] **Step 4: Run the tests to see them pass, with the neighbours**

Run: `./gradlew :spectro-core:test --tests '*AgentTest*' --tests '*RunEventJsonTest*' --tests '*ContextInfo*' --tests '*CareParagraphRingMeasurementTest*' --tests '*AgentToolGroupsTest*' --tests '*AgentGoalTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/green-task2.log 2>&1; echo $?`
Expected: exit 0, counts from the XML. Then `./gradlew :spectro-core:javadoc --rerun-tasks --no-build-cache > kanban/evidence/593/javadoc-task2.log 2>&1; echo $?` exit 0.

- [ ] **Step 5: Commit, then bite**

Commit `Agent.java`, `AgentTest.java`, `RunEventJsonTest.java`: message `Card 593: a context_info without texts keeps its counts`.

Bites, one at a time, into `bites-task2.log`: (a) `boolean texts = true;` in `contextInfo`, the new `AgentTest` case red; restore. (b) remove the `@JsonInclude(JsonInclude.Include.NON_NULL)` line above `record ContextPart` in `RunEvent.java:1208`, the wire pin red (`"text":null` appears); restore. `git diff --quiet` on both files prints 0.

---

### Task 3: The child builder reports sizes each turn

**Files:**
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/subagents/SubagentManager.java:1294` (after `.parentId(config.parentAgentId())` in the child builder chain :1284-1343)
- Modify: `spectro-core/src/main/java/dev/spectroscope/core/subagents/SubagentConfig.java:47-49` (the `@param compactionThreshold` sentence)
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/subagents/SubagentThresholdInheritanceTest.java:34-38` (class javadoc)
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/subagents/SubagentSessionWindowTest.java:34-39` (class javadoc)
- Create: `spectro-core/src/test/java/dev/spectroscope/core/subagents/SubagentContextSizesTest.java`

**Interfaces:**
- Consumes: `AgentOptions.Builder.introspectionTexts(boolean)` (Task 1), the sizes-only `contextInfo` (Task 2).
- Produces: every child the manager spawns emits one `context_info` per turn with `agentId` the child's id, three parts with full `chars` and `estTokens` and no `text`, `threshold`, `thresholdSource` and `contextWindow` as its own loop derived them (`Agent.java:1910-1916`).

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 593: a child built by the manager reports the sizes of its context
 * parts each turn and none of their texts; the parent keeps its texts.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class SubagentContextSizesTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Parent and child scripts kept apart by system prompt: every role prompt
     *  of RoleCatalog says "subagent", the parent's here does not. */
    private static final class RoutingProvider implements LlmProvider {
        final Queue<List<ProviderEvent>> parentTurns = new ConcurrentLinkedQueue<>();
        final Queue<List<ProviderEvent>> childTurns = new ConcurrentLinkedQueue<>();

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            boolean isChild = request.system().contains("subagent");
            List<ProviderEvent> turn = (isChild ? childTurns : parentTurns).poll();
            if (turn == null) {
                throw new IllegalStateException("no scripted turn left (child=" + isChild + ")");
            }
            return turn;
        }
    }

    private static JsonNode json(String content) {
        try {
            return JSON.readTree(content);
        } catch (Exception failure) {
            throw new AssertionError(failure);
        }
    }

    private static List<ProviderEvent> textTurn(String text) {
        return List.of(new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(5, 2),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<ProviderEvent> spawnTurn() {
        return List.of(new LlmProvider.PToolCall("c1", "spawn_agent",
                        json("""
                                {"type":"worker","task":"do the thing"}""")),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    /** One parent run that spawns one child; the parent introspects with texts. */
    private static List<RunEvent> spawnOnce() {
        RoutingProvider provider = new RoutingProvider();
        provider.parentTurns.add(spawnTurn());
        provider.parentTurns.add(textTurn("done"));
        provider.childTurns.add(textTurn("child done"));

        SubagentManager manager = new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .build());
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .introspection(true)
                .build());

        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream =
                     manager.run(parent, "delegate it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static List<RunEvent.ContextInfo> infosOf(List<RunEvent> events, String agentId) {
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .filter(info -> agentId.equals(info.agentId()))
                .toList();
    }

    @Test
    void aChildReportsItsPartSizesEachTurnWithoutTheirTexts() {
        List<RunEvent> events = spawnOnce();
        String childId = events.stream()
                .filter(RunEvent.AgentSpawn.class::isInstance)
                .map(RunEvent.AgentSpawn.class::cast)
                .map(RunEvent.AgentSpawn::agentId)
                .findFirst()
                .orElseThrow(() -> new AssertionError("a child really ran"));
        long childTurns = events.stream()
                .filter(RunEvent.TurnStart.class::isInstance)
                .map(RunEvent.TurnStart.class::cast)
                .filter(turn -> childId.equals(turn.agentId()))
                .count();
        assertTrue(childTurns >= 1, "the child ran at least one turn");

        List<RunEvent.ContextInfo> child = infosOf(events, childId);
        assertEquals(childTurns, child.size(), "one line per child turn");
        RunEvent.ContextInfo info = child.get(0);
        assertEquals(List.of("system prompt", "tool schemas", "conversation"),
                info.parts().stream().map(RunEvent.ContextPart::label).toList());
        for (RunEvent.ContextPart part : info.parts()) {
            assertNull(part.text(), "no text on " + part.label());
        }
        assertTrue(info.parts().get(0).chars() > 0, "the role prompt is counted");
        assertTrue(info.parts().get(2).chars() > 0, "the task is counted");
        assertEquals(info.parts().stream().mapToInt(RunEvent.ContextPart::estTokens).sum(),
                info.estimatedTokens(), "the estimate is the sum of its parts");
        assertNotNull(info.thresholdSource(), "the threshold and its source ride as on the parent");
    }

    @Test
    void theParentKeepsItsTexts() {
        List<RunEvent.ContextInfo> parent = infosOf(spawnOnce(), "main");
        assertEquals(2, parent.size(), "one line per parent turn");
        String system = parent.get(0).parts().get(0).text();
        assertNotNull(system, "the main agent's parts carry their texts");
        assertTrue(system.startsWith("You are the parent."), system);
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `./gradlew :spectro-core:test --tests '*SubagentContextSizesTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/red-task3.log 2>&1; echo $?`
Expected: `aChildReportsItsPartSizesEachTurnWithoutTheirTexts` fails at `assertEquals(childTurns, child.size())` with 0 child lines; `theParentKeepsItsTexts` is green (it pins what must not change).

- [ ] **Step 3: Switch introspection on in the child builder, without texts**

In `SubagentManager.java`, directly after the `.parentId(config.parentAgentId())` line (:1294):

```java
                // Card 593: a helper reports the sizes of its context parts
                // each turn, so the ring can show its fill against its own
                // window; the texts stay off the wire, the llm-wire sidecar
                // holds each request whole.
                .introspection(true)
                .introspectionTexts(false)
```

- [ ] **Step 4: Change the words that say children emit no `context_info`**

`SubagentConfig.java:47-49`, the end of the `@param compactionThreshold` sentence, becomes:

```java
 *                      153,216 from the shared provider, a 30x divergence from
 *                      a stated instruction. It was invisible at the time, because
 *                      children were built without introspection; since card 593 a
 *                      child's {@code context_info} names its threshold each turn
```

`SubagentThresholdInheritanceTest.java:34-38` (inside the class javadoc) becomes:

```java
 * spawned children that derived 153,216 from the same provider. A 30x
 * divergence from a stated instruction, and at the time an invisible one:
 * children were built without introspection. Since card 593 a child's
 * {@code context_info} names its threshold each turn; the measurement below
 * predates that and still holds.</p>
```

`SubagentSessionWindowTest.java:34-36` becomes:

```java
 * <p>The measurement is the one {@code SubagentThresholdInheritanceTest} uses:
 * a run whose window is decided asks the backend nothing. Since card 593 a
 * child's {@code context_info} names its window too, and the count below needs
 * no frame. With no session window
```

Keep the rest of each sentence as it is; re-read each javadoc once and make sure it still reads as one paragraph.

- [ ] **Step 5: Run the tests to see them pass, with the neighbours**

Run: `./gradlew :spectro-core:test --tests 'dev.spectroscope.core.subagents.*' --tests '*AgentBuildReachDriftTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/green-task3.log 2>&1; echo $?`
Expected: exit 0; `SubagentContextSizesTest` 2 tests and every other class of the package green, counts from the XML. `SubagentThresholdInheritanceTest` and `SubagentSessionWindowTest` count window questions, and `contextInfo` asks the provider nothing, so their counts do not move.
Then the server's child and window tests: `./gradlew :spectro-server:test --tests '*SessionChildBeltTest*' --tests '*SessionWindowOverrideTest*' --tests '*SessionWindowAnnounceTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/neighbours-server-task3.log 2>&1; echo $?` Expected: exit 0.
Then `./gradlew :spectro-core:javadoc --rerun-tasks --no-build-cache > kanban/evidence/593/javadoc-task3.log 2>&1; echo $?` exit 0.

- [ ] **Step 6: Commit, then bite**

Commit the five files: message `Card 593: a helper reports the sizes of its context parts each turn`.

Bites into `bites-task3.log`: (a) delete `.introspectionTexts(false)` from the child chain, the child case red at `assertNull(part.text(), ...)`; restore. (b) delete `.introspection(true)`, red at the count; restore. `git diff --quiet -- spectro-core/src/main/java/dev/spectroscope/core/subagents/SubagentManager.java; echo $?` prints 0.

---

## Part B: the web, after card 586 has landed

### Task 4: Rebase onto the integration branch and take a baseline

**Files:** none changed by hand.

- [ ] **Step 1: Check that 586 is in**

Run: `git -C worktrees/wt-card-593 log --oneline the integration branch -40 > kanban/evidence/593/base-log.txt; grep -ci 'card 586\|card-586' kanban/evidence/593/base-log.txt`
Expected: at least 1. If 0, stop here and report: Part B waits for 586.

- [ ] **Step 2: Rebase**

Run: `git status --porcelain` (empty), then `git rebase the integration branch > kanban/evidence/593/rebase.log 2>&1; echo $?`. Part A touches `AgentOptions.java`, `Agent.java`, `SubagentManager.java`, `SubagentConfig.java`, three core tests and `RunEventJsonTest.java`; 586 touches none of them, so a conflict is unexpected. If one appears, resolve it by reading both sides, never by taking one side blindly, and write what you did into `rebase.log`. Record `git rev-parse HEAD` and `git merge-base HEAD the integration branch` in `rebase.log`.

- [ ] **Step 3: Fresh dependencies**

Run: `cd spectro-web && npm ci > kanban/evidence/593/npm-ci.log 2>&1; echo $?` Expected: exit 0.

- [ ] **Step 4: Baseline**

Run, in `spectro-web`: `npx tsc -b > kanban/evidence/593/baseline-tsc.log 2>&1; echo $?` and `npx vitest run --maxWorkers=2 > kanban/evidence/593/baseline-vitest.log 2>&1; echo $?`. Both exit 0; write the vitest summary line (files, tests passed, skipped) into `baseline-vitest.log`'s last line by hand if the summary is not already its tail. Then the core: `./gradlew :spectro-core:test --tests '*SubagentContextSizesTest*' --tests '*AgentTest*' --tests '*AgentOptionsIntrospectionTextsTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/baseline-core.log 2>&1; echo $?` exit 0.

Nothing to commit.

---

### Task 5: The reducer keeps a helper's figures and one plan per writer

**Files:**
- Modify: `spectro-web/src/state/reducer.ts` (`AgentInfo.model` doc :297-302; `WindowAnnouncement` :361-371, the new type after it; `UiState.context` doc :414-416; `helpers` after `lastInputTokens` :423; `plans` after `planAgent` :464; `initialState` :553-554; `foldAgents` `run_start` :676-682; the child `run_start` branch :1337-1339; the `usage` case :1892-1895; `case "context_info"` :1998-2019; `case "plan"` :2048-2051)
- Modify: `spectro-web/src/state/storedSessionWindow.test.tsx:90-104` (one assertion)
- Modify: `spectro-web/src/testkit/archiveEvents.ts` (the header list and the child part of the cycle, after the child `run_start`)
- Modify: `spectro-web/src/lab/contextPeakMath.ts:15-22` (rule 1), `spectro-web/src/lab/flowmap/ctxTotalsSource.test.ts:4-5` (comment), `spectro-web/src/components/AgentsTab.tsx:63-67` (comment)
- Create: `spectro-web/src/state/helpersAndPlans.test.ts`

**Interfaces:**
- Consumes: 586's reducer hunks (`UiState.runs`, `case "run_step"`); the sizes-only child `context_info` of Part A as it arrives on the wire (`events.ts:215` already marks `text` optional).
- Produces (exported from `state/reducer.ts`):

```ts
export interface HelperFigures {
  lastInputTokens: number;
  context: ContextSnapshot | null;
  announcedWindow: WindowAnnouncement | null;
}
// UiState gains:
helpers: Record<string, HelperFigures>; // keyed by helper id, the root never lands in it
plans: Record<string, PlanStep[]>;      // keyed by the writer's agent id ("main", "playbook", ...)
// AgentInfo.model is set from a child's run_start model; plan and planAgent are unchanged.
```

- [ ] **Step 1: Re-read the merged reducer**

Open `state/reducer.ts` after the rebase and find the lines named above again (`grep -n 'announcedWindow: WindowAnnouncement\|case "context_info"\|case "plan"\|if (event.parentId != null)\|lastInputTokens:$\|planAgent: string | null' state/reducer.ts`). 586 added `runs` next to `plan` and `planAgent` and a `case "run_step"`; the edits below go beside them.

- [ ] **Step 2: Write the failing tests**

`state/helpersAndPlans.test.ts`:

```ts
// Card 593: a helper's figures in their own slot, one plan per writer, and the
// root's fields untouched by anything a child sends.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, reduceAll, type UiState } from "./reducer";
import { sessionHarness } from "../testkit/chatHost";

const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;
const M = "main";
const K = "explore-1";
const rootStart = ev({
  type: "run_start", runId: "r1", agentId: M, prompt: "go", model: "qwen2.5:7b", contextWindow: 32_768, windowSource: "model",
});
const childStart = (extra: Record<string, unknown> = {}): RunEvent =>
  ev({ type: "run_start", runId: "r2", agentId: K, parentId: M, prompt: "look", model: "minimax-m3:cloud", ...extra });
const info = (agentId: string, extra: Record<string, unknown> = {}): RunEvent =>
  ev({
    type: "context_info", agentId, turn: 1, messages: 3, estimatedTokens: 90, threshold: 22_937,
    thresholdSource: "window", contextWindow: 32_768, parts: [{ label: "system prompt", chars: 200, estTokens: 50 }],
    ...extra,
  });
const usage = (agentId: string, inputTokens: number, extra: Record<string, unknown> = {}): RunEvent =>
  ev({ type: "usage", agentId, inputTokens, outputTokens: 1, ...extra });
const plan = (agentId: string, steps: { text: string; status: string }[]): RunEvent => ev({ type: "plan", agentId, steps });
const steps3 = [
  { text: "read", status: "completed" },
  { text: "fix", status: "in_progress" },
  { text: "gate", status: "pending" },
];
const run = (events: RunEvent[], from: UiState = initialState): UiState => reduceAll(from, events);

describe("a helper's figures (card 593)", () => {
  it("a helper's usage writes its slot and leaves the root's fill alone", () => {
    const s = run([rootStart, usage(M, 1000), childStart(), usage(K, 300, { cacheReadTokens: 50 })]);
    expect(s.helpers[K]?.lastInputTokens).toBe(350);
    expect(s.lastInputTokens).toBe(1000);
    expect(s.helpers[M]).toBeUndefined();
  });

  it("a helper's context_info lands in its slot, the root's snapshot untouched by identity", () => {
    const before = run([rootStart, info(M)]);
    const after = reduce(before, info(K, { contextWindow: 1_000_000, thresholdSource: "model" }));
    expect(after.helpers[K]?.context?.contextWindow).toBe(1_000_000);
    expect(after.helpers[K]?.announcedWindow).toBeNull();
    expect(after.context).toBe(before.context);
    expect(after.context?.contextWindow).toBe(32_768);
  });

  it("a helper's run_start names its window until its first snapshot", () => {
    const before = run([rootStart]);
    const named = reduce(before, childStart({ contextWindow: 200_000, windowSource: "model" }));
    expect(named.helpers[K]?.announcedWindow).toEqual({ contextWindow: 200_000, thresholdSource: "model" });
    expect(named.announcedWindow).toBe(before.announcedWindow);
    const snapped = reduce(named, info(K));
    expect(snapped.helpers[K]?.announcedWindow).toBeNull();
    expect(snapped.helpers[K]?.context?.turn).toBe(1);
  });

  it("a child's run_start without a window leaves its slot alone", () => {
    const s = run([rootStart, childStart()]);
    expect(s.helpers[K]).toBeUndefined();
  });

  it("a child's run_start model reaches the roster; the root's model stays in runModel", () => {
    const s = run([rootStart, childStart()]);
    expect(s.agents.find((a) => a.id === K)?.model).toBe("minimax-m3:cloud");
    expect(s.agents.find((a) => a.id === M)?.model).toBeUndefined();
    expect(s.runModel).toBe("qwen2.5:7b");
  });

  it("a reused helper id takes the newer run's figures and keeps one roster row", () => {
    const s = run([
      rootStart, childStart(), usage(K, 100),
      childStart({ runId: "r3", model: "qwen2.5:7b" }), usage(K, 700),
    ]);
    expect(s.agents.filter((a) => a.id === K)).toHaveLength(1);
    expect(s.agents.find((a) => a.id === K)?.model).toBe("qwen2.5:7b");
    expect(s.helpers[K]?.lastInputTokens).toBe(700);
  });

  it("a child's context_info before its run_start still makes its slot", () => {
    const s = run([rootStart, info(K)]);
    expect(s.helpers[K]?.context).not.toBeNull();
  });

  it("window_override and context_cleared move the root's fields and not a helper's", () => {
    const before = run([rootStart, info(M), childStart(), usage(K, 300), info(K)]);
    const overridden = reduce(before, ev({ type: "window_override", tokens: 512_000, threshold: 358_400, thresholdSource: "window_override", contextWindow: 512_000 }));
    expect(overridden.context?.contextWindow).toBe(512_000);
    expect(overridden.helpers).toBe(before.helpers);
    const cleared = reduce(overridden, ev({ type: "context_cleared", agentId: M }));
    expect(cleared.helpers).toBe(before.helpers);
    expect(cleared.context?.parts.length).toBeLessThanOrEqual(overridden.context?.parts.length ?? 0);
  });

  it("starts empty", () => {
    expect(initialState.helpers).toEqual({});
    expect(initialState.plans).toEqual({});
  });
});

describe("one plan per writer (card 593)", () => {
  it("keeps the root's and the playbook's plans apart; plan and planAgent stay the latest frame", () => {
    const s = run([rootStart, plan(M, steps3), plan("playbook", [{ text: "[a] A", status: "pending" }])]);
    expect(s.plans[M]).toHaveLength(3);
    expect(s.plans.playbook).toHaveLength(1);
    expect(s.plan).toHaveLength(1);
    expect(s.planAgent).toBe("playbook");
  });

  it("the root plan survives the 13 child frame kinds and an empty child plan, by reference", () => {
    const kid = (o: Record<string, unknown>): RunEvent => ev({ agentId: K, ...o });
    const child: RunEvent[] = [
      kid({ type: "agent_spawn", parentId: M, task: "t" }),
      ev({ type: "agent_message", from: M, to: K, role: "task", state: "submitted", text: "t" }),
      kid({ type: "run_start", runId: "r2", parentId: M, prompt: "t" }),
      kid({ type: "turn_start", turn: 1 }),
      kid({ type: "thinking_delta", text: "h" }),
      kid({ type: "text_delta", text: "x" }),
      kid({ type: "tool_call", callId: "c", name: "read_file", input: {} }),
      kid({ type: "tool_result", callId: "c", output: "x", isError: false, durationMs: 1 }),
      kid({ type: "context_info", turn: 1, messages: 3, estimatedTokens: 9, threshold: 99, parts: [] }),
      kid({ type: "usage", inputTokens: 1, outputTokens: 1 }),
      kid({ type: "compaction", removedTurns: 1, summaryChars: 1 }),
      ev({ type: "run_end", runId: "r2", stopReason: "end_turn" }),
      ev({ type: "agent_message", from: K, to: M, role: "result", state: "completed", text: "ok" }),
      kid({ type: "plan", steps: [] }),
    ];
    expect(child).toHaveLength(14);
    let s = run([rootStart, plan(M, steps3)]);
    const rootPlan = s.plans[M];
    for (const e of child) {
      s = reduce(s, e);
      expect(s.plans[M], e.type).toBe(rootPlan);
    }
    expect(s.plans[K]).toEqual([]);
  });

  it("a session switch round trip through SessionSet keeps the plan", () => {
    const { set, sockets } = sessionHarness();
    const first = set.view().key;
    sockets[0].emit([rootStart, plan(M, steps3)]);
    const held = set.view().state.plans[M];
    expect(held).toHaveLength(3);
    const second = set.newChat();
    expect(second).not.toBe(first);
    set.select(first);
    expect(set.view().key).toBe(first);
    expect(set.view().state.plans[M]).toBe(held);
  });
});
```

In `storedSessionWindow.test.tsx`, inside `a child's context_info does not move the ring's denominator` (:90-104), after `expect(ringPercent(state)).toBe("30%");` add:

```ts
    // Card 593: the child's snapshot is not dropped any more, it lands in its own slot.
    expect(state.helpers.worker?.context?.contextWindow).toBe(32_768);
```

- [ ] **Step 3: Run them to see them fail**

Run, in `spectro-web`: `npx vitest run src/state/helpersAndPlans.test.ts src/state/storedSessionWindow.test.tsx --maxWorkers=2 > kanban/evidence/593/red-task5.log 2>&1; echo $?`
Expected: exit 1; `helpers` and `plans` are undefined on the state, the new cases throw or fail, the card 521 case fails on its new assertion.

- [ ] **Step 4: Fold**

`reducer.ts`, after the `WindowAnnouncement` interface (:371):

```ts
/** Card 593: what the ring shows for one helper: its last request size (the
 *  root's formula), its last sizes-only snapshot and the window its run_start
 *  named since that snapshot. The root's figures are the three fields of the
 *  same names on UiState. */
export interface HelperFigures {
  lastInputTokens: number;
  context: ContextSnapshot | null;
  announcedWindow: WindowAnnouncement | null;
}
```

`UiState.context` doc (:414-415): `/** Latest context_info snapshot of the run's own agent; a helper's lands in {@link UiState.helpers} (card 593). Latest wins, null until the first one. */`

After `lastInputTokens: number;` (:423):

```ts
  /** Card 593: the figures of every helper, by agent id: its last request
   *  size, its last sizes-only snapshot and the window its run_start named
   *  since. The root never lands here; its three fields are above. */
  helpers: Record<string, HelperFigures>;
```

After `planAgent: string | null;` (:464):

```ts
  /** Card 593: the latest plan of each writer, by agent id: the root's under
   *  its id, a playbook run's under "playbook". `plan` and `planAgent` keep
   *  the latest frame for the footer and the HTML export. */
  plans: Record<string, PlanStep[]>;
```

`initialState`: `helpers: {},` after `lastInputTokens: 0,` and `plans: {},` after `planAgent: null,`.

`AgentInfo.model` doc (:297-302):

```ts
  /** The model this agent ran on, when something said so: an import's launch
   *  record names the child's model (card 167), and since card 593 a live
   *  helper's own run_start does. The root's model is `runModel`. Absent, not
   *  null: a row with no chip is exactly a row nothing was said about. */
```

A helper for the slot, next to `upsertAgent` (:647):

```ts
/** Card 593: a helper's slot, blank until its first frame. */
function helperSlot(helpers: Record<string, HelperFigures>, id: string): HelperFigures {
  return helpers[id] ?? { lastInputTokens: 0, context: null, announcedWindow: null };
}
```

`foldAgents`, `case "run_start"` (:677-682): add one spread to the patch:

```ts
      return upsertAgent(agents, event.agentId, {
        parentId: event.parentId ?? null,
        state: "working",
        runId: event.runId,
        ...(event.parentId == null ? { label: null } : {}),
        // Card 593: a helper's own run names its model; the root's is runModel.
        ...(event.parentId != null && event.model !== undefined ? { model: event.model } : {}),
      });
```

The child `run_start` branch of `applyEvent` (:1337-1339):

```ts
      if (event.parentId != null) {
        // Card 593: the window a helper's run derived rides on its run_start
        // (card 521); the ring reads it for the helper until its first snapshot.
        const named = event.windowSource !== undefined || event.contextWindow !== undefined;
        if (!named) return { ...state, running: true };
        return {
          ...state,
          running: true,
          helpers: {
            ...state.helpers,
            [event.agentId]: {
              ...helperSlot(state.helpers, event.agentId),
              announcedWindow: announcement(event.contextWindow, event.windowSource),
            },
          },
        };
      }
```

The `usage` case, after the `lastInputTokens:` entry (:1892-1895), one more entry in the same object:

```ts
        // Card 593: a helper's fill, the root's formula, in its own slot.
        helpers:
          event.agentId === (state.rootAgentId ?? "main")
            ? state.helpers
            : {
                ...state.helpers,
                [event.agentId]: {
                  ...helperSlot(state.helpers, event.agentId),
                  lastInputTokens:
                    event.inputTokens + (event.cacheReadTokens ?? 0) + (event.cacheCreationTokens ?? 0),
                },
              },
```

`case "context_info"` (:1998-2019) becomes:

```ts
    case "context_info": {
      // No chat turn: introspection feeds the context ring and the trace
      // only. Latest snapshot wins. Card 521 kept a child's snapshot off the
      // root's fields, because the ring divided a parent's usage by a child's
      // window; card 593 gives the child its own slot, read when the ring
      // shows that child.
      const snapshot: ContextSnapshot = {
        turn: event.turn,
        messages: event.messages,
        estimatedTokens: event.estimatedTokens,
        threshold: event.threshold,
        // Spread rather than assign: a frame that stated no provenance must
        // leave the KEY absent, not present-and-undefined.
        ...(event.thresholdSource === undefined ? {} : { thresholdSource: event.thresholdSource }),
        ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
        parts: event.parts,
      };
      if (event.agentId !== (state.rootAgentId ?? "main")) {
        return {
          ...state,
          helpers: {
            ...state.helpers,
            [event.agentId]: { ...helperSlot(state.helpers, event.agentId), context: snapshot, announcedWindow: null },
          },
        };
      }
      return { ...state, announcedWindow: null, context: snapshot };
    }
```

`case "plan"` (:2048-2051):

```ts
    case "plan":
      // No chat turn: the Plan tab renders the writer's latest snapshot. Card
      // 593 keeps one per writer, so a playbook run and the main agent no
      // longer overwrite each other; plan and planAgent stay the latest frame.
      return {
        ...state,
        plan: event.steps,
        planAgent: event.agentId,
        plans: { ...state.plans, [event.agentId]: event.steps },
      };
```

`window_override` and `context_cleared` are not touched: they rewrite the root's fields only, which is what the test pins.

`testkit/archiveEvents.ts`: after the child `run_start` push (`push({ type: "run_start", runId: \`${run}-child\`, ...`), add:

```ts
  // Card 593: a helper reports the sizes of its parts, never their texts.
  push({
    type: "context_info",
    agentId: child,
    turn: 1,
    messages: 2,
    estimatedTokens: 60,
    threshold: 100_000,
    thresholdSource: "fallback",
    parts: [
      { label: "system prompt", chars: 120, estTokens: 30 },
      { label: "tool schemas", chars: 40, estTokens: 10 },
      { label: "conversation", chars: 80, estTokens: 20 },
    ],
  });
```

and in the header comment's list of what the cycles carry, after `card 584's playbook_start_refused)` add ` and card 593's sizes-only child context_info`.

Comments: `lab/contextPeakMath.ts:15-22` rule 1 becomes

```ts
// 1. A CHILD GETS NO PERCENTAGE. The harness carries a measured threshold for
//    the ROOT in UiState.context; a child's context_info (sizes only since
//    card 593) lands in the ring's helper slot, and this module does not read
//    it yet, a card of its own. A child's model is often on the wire, and
//    reading the published table for it would produce a percentage that looks
//    measured and is not. So a child prints its peak, a bar relative to the
//    biggest peak on the panel, and no percent sign, and the panel says why in
//    one line.
```

`lab/flowmap/ctxTotalsSource.test.ts:4-5`: `// ignores every other agent's (a child's, sizes only since card 593, belongs to the ring's helper slot, not to the root's totals).`

`components/AgentsTab.tsx:63-67`: `{/* The model this agent ran on, when its own run_start (card 593) or a transcript's launch record (card 167) said so. It is not the parent's: measured over ~/.claude/projects, 617 launch records name one across seven ids, and a haiku child under an opus parent is a normal line. Verbatim, "[1m]" suffix and all. */}`

- [ ] **Step 5: Run the tests to see them pass**

Run the command of Step 3 with `green-task5.log`, plus `npx vitest run src/state src/lab src/components/agentsTabAnalyze.test.tsx --maxWorkers=2 > kanban/evidence/593/green-task5-state.log 2>&1; echo $?` (this covers `reducer.test.ts`, `archiveFold.test.ts` with its slice budget, `contextCleared.test.ts` and the lab), then `npx tsc -b`, `npx eslint src/state/reducer.ts src/state/helpersAndPlans.test.ts src/testkit/archiveEvents.ts src/lab/contextPeakMath.ts src/components/AgentsTab.tsx`, `npx prettier --check` on the same files and `src/state/storedSessionWindow.test.tsx src/lab/flowmap/ctxTotalsSource.test.ts`. Expected: all exit 0.

- [ ] **Step 6: Commit, then bite**

Commit the seven files: message `Card 593: helpers keep their own figures and plans are kept per writer`.

Bites into `bites-task5.log`, one at a time, restore after each: (a) put `return state;` back as the first line of the helper branch of `context_info`, the slot cases and the card 521 assertion red; (b) write the helper's fill into `lastInputTokens` as well (drop the `event.agentId === ...` test in that entry), the first case red at `lastInputTokens` 1000; (c) write `plans` under `[M]` whatever the writer (`plans: { ...state.plans, main: event.steps }`), the per-writer case red; (d) rebuild every array of `plans` on each frame (`Object.fromEntries(Object.entries(state.plans).map(([k, v]) => [k, [...v]]))` spread into the new map), the identity case red.

---

### Task 6: The shown agent, one choice per record in view

**Files:**
- Create: `spectro-web/src/state/shownAgent.ts`
- Create: `spectro-web/src/state/shownAgent.test.tsx`

**Interfaces:**
- Consumes: `UiState.helpers`, `rootAgentId`, `agents` (Task 5).
- Produces:

```ts
export interface ShownAgent { id: string; rootId: string; isRoot: boolean; row: AgentInfo | null; missing: string | null }
export interface AgentPick { agents: readonly AgentInfo[]; shown: ShownAgent; onPick: (id: string | null) => void }
export interface RingView { picker: AgentPick; figures: HelperFigures }
export function useShownAgent(viewKey: string): string | null;        // null means the root
export function setShownAgent(viewKey: string, id: string | null): void;
export function forgetShownAgent(viewKey: string): void;
export function __resetShownAgentForTests(): void;
export function rootAgentIdOf(state: Pick<UiState, "rootAgentId" | "agents">): string;
export function shownAgentOf(state: Pick<UiState, "rootAgentId" | "agents">, choice: string | null): ShownAgent;
export function figuresOf(state: Pick<UiState, "lastInputTokens" | "context" | "announcedWindow" | "helpers">, shown: ShownAgent): HelperFigures;
export function ringOf(meta: { shown?: ShownAgent; onPickAgent?: (id: string | null) => void } | undefined, state: Pick<UiState, "agents" | "lastInputTokens" | "context" | "announcedWindow" | "helpers">): RingView | undefined;
```

- [ ] **Step 1: Write the failing tests**

```tsx
// Card 593: one agent choice per record in view, resolved against the roster.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "./reducer";
import { initialState } from "./reducer";
import {
  __resetShownAgentForTests,
  figuresOf,
  forgetShownAgent,
  ringOf,
  rootAgentIdOf,
  setShownAgent,
  shownAgentOf,
  useShownAgent,
} from "./shownAgent";

afterEach(() => __resetShownAgentForTests());

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id, parentId, label: null, task: "", state: "working", lastStatus: null, inTokens: 0, outTokens: 0, ...extra,
});
const roster = [row("main", null), row("explore-1", "main", { task: "look around" }), row("session-title", null)];
const state = { ...initialState, rootAgentId: "main", agents: roster };

function Probe({ k }: { k: string }) {
  return <i>{useShownAgent(k) ?? "root"}</i>;
}
const read = (k: string): string => renderToStaticMarkup(<Probe k={k} />);

describe("the store", () => {
  it("keeps one choice per view key and forgets it on request", () => {
    expect(read("live:a")).toBe("<i>root</i>");
    setShownAgent("live:a", "explore-1");
    setShownAgent("live:b", "worker-2");
    expect(read("live:a")).toBe("<i>explore-1</i>");
    expect(read("live:b")).toBe("<i>worker-2</i>");
    forgetShownAgent("live:a");
    expect(read("live:a")).toBe("<i>root</i>");
    expect(read("live:b")).toBe("<i>worker-2</i>");
    setShownAgent("live:b", null);
    expect(read("live:b")).toBe("<i>root</i>");
  });
});

describe("the resolver", () => {
  it("shows the root for no choice, with its roster row", () => {
    const shown = shownAgentOf(state, null);
    expect(shown).toMatchObject({ id: "main", rootId: "main", isRoot: true, missing: null });
    expect(shown.row?.id).toBe("main");
  });

  it("shows a helper for its id", () => {
    const shown = shownAgentOf(state, "explore-1");
    expect(shown).toMatchObject({ id: "explore-1", rootId: "main", isRoot: false, missing: null });
    expect(shown.row?.task).toBe("look around");
  });

  it("treats the root's own id as the root", () => {
    expect(shownAgentOf(state, "main").isRoot).toBe(true);
  });

  it("resolves a choice outside the roster to the root and says which id is gone", () => {
    expect(shownAgentOf(state, "worker-9")).toMatchObject({ id: "main", isRoot: true, missing: "worker-9" });
  });

  it("never shows the parentless session-title row and never takes it for the root", () => {
    expect(shownAgentOf(state, "session-title")).toMatchObject({ id: "main", isRoot: true, missing: "session-title" });
    const titleFirst = { ...initialState, rootAgentId: "main", agents: [roster[2], roster[0]] };
    expect(rootAgentIdOf(titleFirst)).toBe("main");
  });

  it("takes the root from rootAgentId on a standalone subagent transcript", () => {
    const standalone = { ...initialState, rootAgentId: "worker-3", agents: [row("worker-3", null)] };
    expect(shownAgentOf(standalone, null).id).toBe("worker-3");
  });

  it("falls back to the first parentless row, then to main, before any run", () => {
    expect(rootAgentIdOf({ ...initialState, agents: [row("main", null)] })).toBe("main");
    expect(rootAgentIdOf(initialState)).toBe("main");
    expect(shownAgentOf(initialState, null)).toMatchObject({ id: "main", isRoot: true, row: null, missing: null });
  });
});

describe("the figures", () => {
  const figured = {
    ...state,
    lastInputTokens: 1000,
    helpers: { "explore-1": { lastInputTokens: 350, context: null, announcedWindow: { contextWindow: 200_000, thresholdSource: "model" as const } } },
  };

  it("reads the root's three fields for the root", () => {
    expect(figuresOf(figured, shownAgentOf(figured, null))).toEqual({ lastInputTokens: 1000, context: null, announcedWindow: null });
  });

  it("reads a helper's slot for a helper, and zeros for a helper without one", () => {
    expect(figuresOf(figured, shownAgentOf(figured, "explore-1")).lastInputTokens).toBe(350);
    const fresh = { ...figured, agents: [...roster, row("worker-2", "main", { state: "submitted" })] };
    expect(figuresOf(fresh, shownAgentOf(fresh, "worker-2"))).toEqual({ lastInputTokens: 0, context: null, announcedWindow: null });
  });

  it("builds the ring's view only where App handed a selection", () => {
    expect(ringOf(undefined, figured)).toBeUndefined();
    expect(ringOf({}, figured)).toBeUndefined();
    const onPick = (): void => {};
    const ring = ringOf({ shown: shownAgentOf(figured, "explore-1"), onPickAgent: onPick }, figured);
    expect(ring?.picker.agents).toBe(figured.agents);
    expect(ring?.picker.onPick).toBe(onPick);
    expect(ring?.figures.lastInputTokens).toBe(350);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/state/shownAgent.test.tsx --maxWorkers=2 > kanban/evidence/593/red-task6.log 2>&1; echo $?` Expected: the module is missing.

- [ ] **Step 3: Write the module**

```ts
// Card 593: which agent the agent views show, one choice per record in view.
//
// The choice is not part of UiState: UiState is folded from wire events only,
// and a stored session on screen swaps in replay.state outside the
// SessionSet. A store keyed by the view key serves both and resets on a
// session switch, because the key changes. Nothing is persisted; a reload
// starts at the root.

import { useSyncExternalStore } from "react";
import type { AgentInfo, HelperFigures, UiState } from "./reducer";

/** The agent the views show, resolved against the roster. */
export interface ShownAgent {
  /** The agent whose figures the views show. */
  id: string;
  /** The root of the session, shown by default. */
  rootId: string;
  isRoot: boolean;
  /** The roster row of `id`, or null before the roster has it. */
  row: AgentInfo | null;
  /** A choice that is not in the roster; the views then show the root and say so. */
  missing: string | null;
}

/** What a picker needs: the roster, the shown agent and the pick. */
export interface AgentPick {
  agents: readonly AgentInfo[];
  shown: ShownAgent;
  /** null picks the root. */
  onPick: (id: string | null) => void;
}

/** What the ring shows: its picker and the shown agent's figures. */
export interface RingView {
  picker: AgentPick;
  figures: HelperFigures;
}

const choices = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The chosen agent id of a view, or null for the root. */
export function useShownAgent(viewKey: string): string | null {
  const get = (): string | null => choices.get(viewKey) ?? null;
  return useSyncExternalStore(subscribe, get, get);
}

/** @param id the helper to show, or null for the root */
export function setShownAgent(viewKey: string, id: string | null): void {
  if (id === null) choices.delete(viewKey);
  else choices.set(viewKey, id);
  notify();
}

export function forgetShownAgent(viewKey: string): void {
  if (choices.delete(viewKey)) notify();
}

/** Test-only. */
export function __resetShownAgentForTests(): void {
  choices.clear();
  notify();
}

/** The root of a session: the root run's agent, else the first roster row without a parent, else "main". */
export function rootAgentIdOf(state: Pick<UiState, "rootAgentId" | "agents">): string {
  if (state.rootAgentId !== null) return state.rootAgentId;
  const first = state.agents.find((a) => a.parentId === null);
  return first?.id ?? "main";
}

/** Resolves a choice against the roster. A choice that names no helper of the session shows the root and names what is gone. */
export function shownAgentOf(state: Pick<UiState, "rootAgentId" | "agents">, choice: string | null): ShownAgent {
  const rootId = rootAgentIdOf(state);
  const rootRow = state.agents.find((a) => a.id === rootId) ?? null;
  if (choice === null || choice === rootId) return { id: rootId, rootId, isRoot: true, row: rootRow, missing: null };
  const row = state.agents.find((a) => a.id === choice && a.parentId !== null) ?? null;
  if (row === null) return { id: rootId, rootId, isRoot: true, row: rootRow, missing: choice };
  return { id: choice, rootId, isRoot: false, row, missing: null };
}

/** The ring's figures for the shown agent: the root's three fields, or the helper's slot, zeros before its first frame. */
export function figuresOf(
  state: Pick<UiState, "lastInputTokens" | "context" | "announcedWindow" | "helpers">,
  shown: ShownAgent,
): HelperFigures {
  if (shown.isRoot) {
    return { lastInputTokens: state.lastInputTokens, context: state.context, announcedWindow: state.announcedWindow };
  }
  return state.helpers[shown.id] ?? { lastInputTokens: 0, context: null, announcedWindow: null };
}

/** What the ring shows for this view, or undefined where App handed no selection (the Lab's chat). */
export function ringOf(
  meta: { shown?: ShownAgent; onPickAgent?: (id: string | null) => void } | undefined,
  state: Pick<UiState, "agents" | "lastInputTokens" | "context" | "announcedWindow" | "helpers">,
): RingView | undefined {
  if (meta?.shown === undefined || meta.onPickAgent === undefined) return undefined;
  return {
    picker: { agents: state.agents, shown: meta.shown, onPick: meta.onPickAgent },
    figures: figuresOf(state, meta.shown),
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run the command of Step 2 with `green-task6.log`, plus `npx tsc -b`, `npx eslint src/state/shownAgent.ts src/state/shownAgent.test.tsx`, `npx prettier --check` on both. Expected: exit 0, 11 tests.

- [ ] **Step 5: Commit, then bite**

Commit both files: message `Card 593: the shown agent, one choice per record in view`.

Bites into `bites-task6.log`: (a) in `shownAgentOf` drop the `a.parentId !== null` condition, the session-title case red; (b) make a missing choice return `missing: null`, the outside-the-roster case red; (c) in `figuresOf` return the root's fields for a helper, the helper figures case red. Restore each.

---

### Task 7: The `AgentPicker`

**Files:**
- Create: `spectro-web/src/components/agentPickerModel.ts` (pure rows and keys)
- Create: `spectro-web/src/components/AgentPicker.tsx`
- Create: `spectro-web/src/components/agentPicker.test.tsx`
- Modify: `spectro-web/src/i18n/i18n.ts` (five `pick.*` keys after `"ctx.chars"`, :2681)
- Modify: `spectro-web/src/styles/panels.css` (one block after the `.context-unknown` rule, :862)

**Interfaces:**
- Consumes: `AgentPick`, `ShownAgent` (Task 6); `nextMenuIndex` (`panels/headerPanelControls.tsx:79`); `dismissesMenu`, `MODAL_LAYER` (`components/menuDismiss.ts`); `agent-dot` classes (`styles/panels.css:377-381`).
- Produces:

```ts
// agentPickerModel.ts
export const TASK_CLIP = 40;
export interface PickerRow { key: string; id: string | null; label: string | null; task: string; state: AgentInfo["state"] | null; working: boolean; ended: boolean }
export function pickerRows(agents: readonly AgentInfo[], shown: ShownAgent): PickerRow[];
export function clipTask(task: string): string;
export interface PickerState { open: boolean; index: number }
export interface PickerKey { state: PickerState; pick: number | null; handled: boolean }
export function pickerKey(state: PickerState, key: string, count: number): PickerKey;
// AgentPicker.tsx
export function AgentPicker(props: AgentPick): JSX.Element;      // stateful: open, active row, outside press
export function AgentPickerView(props: { lang: Lang; rows: PickerRow[]; shown: ShownAgent; open: boolean; index: number; idBase: string; onToggle: () => void; onKeyDown: (e: PickerKeyEvent) => void; onPickRow: (row: PickerRow) => void }): JSX.Element; // hook-free
export type PickerKeyEvent = { key: string; preventDefault: () => void; stopPropagation: () => void };
```

- [ ] **Step 1: Add the dictionary entries**

After `"ctx.chars": ...` (:2681):

```ts
  // The picker over the agents of the session, in the ring's popover and the Plan and System context panels.
  "pick.showing": { de: "Zeigt: {name}", en: "Showing: {name}" },
  "pick.main": { de: "Hauptagent", en: "Main agent" },
  "pick.aria": { de: "Agenten zum Anzeigen wählen", en: "Choose the agent to show" },
  "pick.ended": { de: "beendet", en: "ended" },
  "pick.missing": {
    de: "{id} ist nicht in dieser Session. Gezeigt wird der Hauptagent.",
    en: "{id} is not in this session. Showing the main agent.",
  },
```

- [ ] **Step 2: Write the failing tests**

```tsx
// Card 593: the picker over the agents of the session, driven without a DOM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "../state/reducer";
import { shownAgentOf } from "../state/shownAgent";
import { AgentPicker, AgentPickerView } from "./AgentPicker";
import { clipTask, pickerKey, pickerRows, TASK_CLIP } from "./agentPickerModel";
import { setLang } from "../state/lang";
import { drive, type El } from "../testkit/driveComponent";

afterEach(() => setLang("en"));

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id, parentId, label: null, task: "", state: "working", lastStatus: null, inTokens: 0, outTokens: 0, ...extra,
});
const agents = [
  row("main", null),
  row("explore-1", "main", { task: "read the plan and list every open question of the owner", state: "working" }),
  row("worker-2", "main", { label: "build_plan", task: "write it", state: "completed" }),
  row("session-title", null),
];
const state = { rootAgentId: "main", agents };
const root = shownAgentOf(state, null);
const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe("the rows", () => {
  it("list the root first, then every helper in roster order, and leave parentless pseudo agents out", () => {
    const rows = pickerRows(agents, root);
    expect(rows.map((r) => r.id)).toEqual([null, "explore-1", "worker-2"]);
    expect(rows[1]).toMatchObject({ working: true, ended: false, label: null });
    expect(rows[2]).toMatchObject({ working: false, ended: true, label: "build_plan", task: "write it" });
  });

  it("clip the task at 40 characters", () => {
    expect(TASK_CLIP).toBe(40);
    expect(clipTask("x".repeat(40))).toBe("x".repeat(40));
    expect(clipTask("x".repeat(41))).toBe("x".repeat(40) + "…");
    expect(pickerRows(agents, root)[1].task).toHaveLength(41);
  });
});

describe("the keys", () => {
  it("ArrowDown opens a closed list and is handled; another key is not", () => {
    expect(pickerKey({ open: false, index: 0 }, "ArrowDown", 3)).toEqual({ state: { open: true, index: 0 }, pick: null, handled: true });
    expect(pickerKey({ open: false, index: 0 }, "a", 3).handled).toBe(false);
  });

  it("Escape with the list closed is not handled, so the popover's own listener may act", () => {
    expect(pickerKey({ open: false, index: 1 }, "Escape", 3)).toEqual({ state: { open: false, index: 1 }, pick: null, handled: false });
  });

  it("Escape with the list open closes it and is handled", () => {
    expect(pickerKey({ open: true, index: 1 }, "Escape", 3)).toEqual({ state: { open: false, index: 1 }, pick: null, handled: true });
  });

  it("the arrows, Home and End move through nextMenuIndex and wrap", () => {
    expect(pickerKey({ open: true, index: 0 }, "ArrowDown", 3).state.index).toBe(1);
    expect(pickerKey({ open: true, index: 0 }, "ArrowUp", 3).state.index).toBe(2);
    expect(pickerKey({ open: true, index: 1 }, "End", 3).state.index).toBe(2);
    expect(pickerKey({ open: true, index: 2 }, "Home", 3).state.index).toBe(0);
  });

  it("Enter picks the active row and closes", () => {
    expect(pickerKey({ open: true, index: 2 }, "Enter", 3)).toEqual({ state: { open: false, index: 2 }, pick: 2, handled: true });
  });
});

describe("the markup", () => {
  const view = (shown = root, open = false, lang: "en" | "de" = "en"): string =>
    renderToStaticMarkup(
      <AgentPickerView lang={lang} rows={pickerRows(agents, shown)} shown={shown} open={open} index={0} idBase="p1" onToggle={() => {}} onKeyDown={() => {}} onPickRow={() => {}} />,
    );

  it("says what it shows, in both languages", () => {
    expect(view()).toContain("Showing: Main agent");
    expect(view(shownAgentOf(state, "explore-1"))).toContain("Showing: explore-1");
    expect(view(shownAgentOf(state, "explore-1"), false, "de")).toContain("Zeigt: explore-1");
  });

  it("is a listbox button with its rows as options, the shown one selected", () => {
    const html = view(shownAgentOf(state, "explore-1"), true);
    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*aria-expanded="true"/);
    expect(html).toContain('role="listbox"');
    expect((html.match(/role="option"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/<li[^>]*role="option"[^>]*aria-selected="true"[^>]*>(?:(?!<\/li>).)*explore-1/);
    expect(html).toContain("build_plan");
    expect(html).toContain(">ended<");
    expect(html).toContain('class="agent-dot agent-dot--working"');
  });

  it("disables the chevron with one agent and still says what it shows", () => {
    const alone = shownAgentOf({ rootAgentId: "main", agents: [agents[0]] }, null);
    const html = renderToStaticMarkup(
      <AgentPickerView lang="en" rows={pickerRows([agents[0]], alone)} shown={alone} open={false} index={0} idBase="p2" onToggle={() => {}} onKeyDown={() => {}} onPickRow={() => {}} />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Showing: Main agent");
  });

  it("names the id that is gone under the label", () => {
    const html = view(shownAgentOf(state, "worker-9"));
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain("worker-9 is not in this session. Showing the main agent.");
  });
});

describe("the component", () => {
  const picker = (tree: El[]): El => {
    const el = tree.find((e) => e.type === "div" && String(e.props.className ?? "").startsWith("agent-pick"));
    if (el === undefined) throw new Error("no picker root in this pass");
    return el;
  };
  const list = (tree: El[]): El | undefined => tree.find((e) => e.type === "ul");
  const press = (tree: El[], k: string) => {
    const e = key(k);
    (picker(tree).props.onKeyDown as (e: ReturnType<typeof key>) => void)(e);
    return e;
  };

  it("a click opens the list, ArrowDown and Enter pick the second row, and the list closes", () => {
    const onPick = vi.fn();
    const stops: boolean[] = [];
    drive(<AgentPicker agents={agents} shown={root} onPick={onPick} />, [AgentPicker], [
      (tree) => {
        expect(list(tree)).toBeUndefined();
        (tree.find((e) => e.type === "button")!.props.onClick as () => void)();
      },
      (tree) => {
        expect(list(tree)).toBeDefined();
        stops.push(press(tree, "ArrowDown").stopPropagation.mock.calls.length === 1);
      },
      (tree) => stops.push(press(tree, "Enter").stopPropagation.mock.calls.length === 1),
      (tree) => expect(list(tree)).toBeUndefined(),
    ]);
    expect(onPick).toHaveBeenCalledWith("explore-1");
    expect(stops).toEqual([true, true]);
  });

  it("Escape closes the list and stops there; a second Escape is left to the popover", () => {
    const stops: number[] = [];
    drive(<AgentPicker agents={agents} shown={root} onPick={() => {}} />, [AgentPicker], [
      (tree) => (tree.find((e) => e.type === "button")!.props.onClick as () => void)(),
      (tree) => stops.push(press(tree, "Escape").stopPropagation.mock.calls.length),
      (tree) => {
        expect(list(tree)).toBeUndefined();
        stops.push(press(tree, "Escape").stopPropagation.mock.calls.length);
      },
    ]);
    expect(stops).toEqual([1, 0]);
  });

  it("a click on a row picks it; the root row picks null", () => {
    const onPick = vi.fn();
    drive(<AgentPicker agents={agents} shown={shownAgentOf(state, "worker-2")} onPick={onPick} />, [AgentPicker], [
      (tree) => (tree.find((e) => e.type === "button")!.props.onClick as () => void)(),
      (tree) => {
        const rows = tree.filter((e) => e.type === "li");
        (rows[0].props.onClick as () => void)();
      },
    ]);
    expect(onPick).toHaveBeenCalledWith(null);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run src/components/agentPicker.test.tsx src/i18n --maxWorkers=2 > kanban/evidence/593/red-task7.log 2>&1; echo $?` Expected: the two modules are missing; the i18n suite is green with the new keys.

- [ ] **Step 4: Write the model and the component**

`agentPickerModel.ts`:

```ts
// Card 593: the picker's rows and keys, pure, so a test can drive them without a DOM.
import type { AgentInfo } from "../state/reducer";
import type { ShownAgent } from "../state/shownAgent";
import { nextMenuIndex } from "../panels/headerPanelControls";

/** How many characters of a helper's task a row shows. */
export const TASK_CLIP = 40;

export interface PickerRow {
  key: string;
  /** The helper's id, or null for the root row. */
  id: string | null;
  label: string | null;
  task: string;
  state: AgentInfo["state"] | null;
  working: boolean;
  ended: boolean;
}

export function clipTask(task: string): string {
  return task.length <= TASK_CLIP ? task : task.slice(0, TASK_CLIP) + "…";
}

/** The root first, then every roster row with a parent, in roster order. Parentless rows that are not the root (session-title) are left out. */
export function pickerRows(agents: readonly AgentInfo[], shown: ShownAgent): PickerRow[] {
  const rows: PickerRow[] = [{ key: shown.rootId, id: null, label: null, task: "", state: null, working: false, ended: false }];
  for (const a of agents) {
    if (a.parentId === null) continue;
    rows.push({
      key: a.id,
      id: a.id,
      label: a.label,
      task: clipTask(a.task),
      state: a.state,
      working: a.state === "submitted" || a.state === "working",
      ended: a.state === "completed" || a.state === "failed",
    });
  }
  return rows;
}

export interface PickerState {
  open: boolean;
  index: number;
}

export interface PickerKey {
  state: PickerState;
  /** The row to pick, by index, or null. */
  pick: number | null;
  /** True when the picker consumed the key; the caller then stops its propagation. */
  handled: boolean;
}

/** What a key does to the picker. Escape with the list closed is left alone on purpose: the popover's own listener closes on it. */
export function pickerKey(state: PickerState, key: string, count: number): PickerKey {
  if (!state.open) {
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
      return { state: { open: true, index: state.index }, pick: null, handled: true };
    }
    return { state, pick: null, handled: false };
  }
  if (key === "Escape") return { state: { open: false, index: state.index }, pick: null, handled: true };
  if (key === "Enter" || key === " ") return { state: { open: false, index: state.index }, pick: state.index, handled: true };
  if (key === "Tab") return { state: { open: false, index: state.index }, pick: null, handled: false };
  const moves = key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
  return { state: { open: true, index: nextMenuIndex(state.index, key, count) }, pick: null, handled: moves };
}
```

`AgentPicker.tsx`:

```tsx
// Card 593: one picker over the agents of the session, used by the ring's
// popover, the Plan panel and the System context panel. The label says what
// is shown; the list is a listbox the arrows walk. The stateful half is thin
// and the view is hook-free, so a test can press its handlers without a DOM.

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { AgentPick, ShownAgent } from "../state/shownAgent";
import { dismissesMenu, MODAL_LAYER } from "./menuDismiss";
import { pickerKey, pickerRows, type PickerRow, type PickerState } from "./agentPickerModel";

export type PickerKeyEvent = { key: string; preventDefault: () => void; stopPropagation: () => void };

export function AgentPicker({ agents, shown, onPick }: AgentPick) {
  const lang = useLang();
  const rows = pickerRows(agents, shown);
  const shownAt = Math.max(0, rows.findIndex((r) => (r.id ?? shown.rootId) === shown.id));
  const [state, setState] = useState<PickerState>({ open: false, index: shownAt });
  const ref = useRef<HTMLDivElement>(null);
  const idBase = useId();

  // An outside press closes the list; a press inside a modal above it does not.
  useEffect(() => {
    if (!state.open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      const inAnchor = ref.current?.contains(target) ?? false;
      const inModal = target instanceof Element && target.closest(MODAL_LAYER) !== null;
      if (dismissesMenu({ inAnchor, inModal })) setState((s) => ({ ...s, open: false }));
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [state.open]);

  const onKeyDown = (e: PickerKeyEvent): void => {
    const next = pickerKey(state, e.key, rows.length);
    if (next.handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    setState(next.state);
    if (next.pick !== null) onPick(rows[next.pick].id);
  };

  return (
    <AgentPickerView
      lang={lang}
      rows={rows}
      shown={shown}
      open={state.open}
      index={state.index}
      idBase={idBase}
      rootRef={ref}
      onToggle={() => setState((s) => ({ open: !s.open, index: shownAt }))}
      onKeyDown={onKeyDown}
      onPickRow={(row) => {
        setState((s) => ({ ...s, open: false }));
        onPick(row.id);
      }}
    />
  );
}

/** The picker as drawn; hook-free. */
export function AgentPickerView(props: {
  lang: Lang;
  rows: PickerRow[];
  shown: ShownAgent;
  open: boolean;
  index: number;
  idBase: string;
  rootRef?: RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onKeyDown: (e: PickerKeyEvent) => void;
  onPickRow: (row: PickerRow) => void;
}) {
  const { lang, rows, shown, open, index, idBase } = props;
  const alone = rows.length <= 1;
  const name = shown.isRoot ? t(lang, "pick.main") : shown.id;
  const rowId = (i: number): string => `${idBase}-${i}`;
  return (
    <div className={`agent-pick${open ? " agent-pick--open" : ""}`} ref={props.rootRef} onKeyDown={props.onKeyDown}>
      <button
        type="button"
        className="agent-pick-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={alone ? true : undefined}
        aria-label={t(lang, "pick.aria")}
        aria-activedescendant={open ? rowId(index) : undefined}
        onClick={alone ? undefined : props.onToggle}
      >
        <span className="agent-pick-showing">{t(lang, "pick.showing", { name })}</span>
        <span className="agent-pick-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {shown.missing !== null && <p className="agent-pick-missing">{t(lang, "pick.missing", { id: shown.missing })}</p>}
      {open && (
        <ul className="agent-pick-list" role="listbox" aria-label={t(lang, "pick.aria")}>
          {rows.map((row, i) => {
            const selected = row.id === null ? shown.isRoot : row.id === shown.id;
            return (
              <li
                key={row.key}
                id={rowId(i)}
                role="option"
                aria-selected={selected}
                className={`agent-pick-row${i === index ? " agent-pick-row--active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onPickRow(row)}
              >
                {row.working && row.state !== null && <span className={`agent-dot agent-dot--${row.state}`} aria-hidden="true" />}
                <span className="agent-pick-name mono">{row.id === null ? t(lang, "pick.main") : row.id}</span>
                {row.label !== null && <span className="agent-pick-label">{row.label}</span>}
                {row.task !== "" && <span className="agent-pick-task">{row.task}</span>}
                {row.ended && <span className="agent-pick-ended">{t(lang, "pick.ended")}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

`styles/panels.css`, after the `.context-unknown` rule:

```css
/* Card 593: the picker over the agents of the session, in the ring's popover and the Plan and System context panels. Block layout on purpose: the list pushes the content under it down and takes no side, so the popover's side rules stay as they are. */
.agent-pick { position: relative; margin: 0 0 var(--sp-3); }
.agent-pick-button { display: inline-flex; align-items: center; gap: var(--sp-2); max-width: 100%; background: none; border: 1px solid var(--border-strong); border-radius: 999px; padding: 2px var(--sp-3); color: var(--text); font-size: var(--fs-12); cursor: pointer; }
.agent-pick-button:hover { background: var(--surface-2); }
.agent-pick-button[aria-disabled="true"] { cursor: default; }
.agent-pick-button[aria-disabled="true"]:hover { background: none; }
.agent-pick-button[aria-disabled="true"] .agent-pick-chevron { opacity: 0.35; }
.agent-pick-showing { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-pick-missing { margin: var(--sp-1) 0 0; font-size: var(--fs-12); color: var(--warn); }
.agent-pick-list { list-style: none; margin: var(--sp-2) 0 0; padding: var(--sp-1); border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--surface); display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; }
.agent-pick-row { display: flex; align-items: center; gap: var(--sp-2); padding: 4px var(--sp-2); border-radius: 6px; cursor: pointer; font-size: var(--fs-12); min-width: 0; }
.agent-pick-row--active, .agent-pick-row:hover { background: var(--surface-2); }
.agent-pick-row[aria-selected="true"] .agent-pick-name { font-weight: 600; }
.agent-pick-name { flex: none; }
.agent-pick-label, .agent-pick-task, .agent-pick-ended { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

Every token above is one `panels.css` already uses (`--sp-1`, `--sp-2`, `--sp-3`, `--border-strong`, `--surface`, `--surface-2`, `--text`, `--text-faint`, `--warn`, `--fs-12`, `--radius-card`); check each with `grep -c 'var(--<name>)' src/styles/panels.css` before you rely on it, because an unknown custom property fails silently.

- [ ] **Step 5: Run the tests to see them pass**

Run the command of Step 3 with `green-task7.log`, plus `npx vitest run src/styles src/testkit src/panels/dockOpeners.drift.test.ts --maxWorkers=2 > kanban/evidence/593/green-task7-styles.log 2>&1; echo $?`, `npx tsc -b`, `npx eslint src/components/AgentPicker.tsx src/components/agentPickerModel.ts src/components/agentPicker.test.tsx`, `npx prettier --check` on those three, `src/i18n/i18n.ts` and `src/styles/panels.css`. Expected: all exit 0; 15 tests in `agentPicker.test.tsx`.

- [ ] **Step 6: Commit, then bite**

Commit the five files: message `Card 593: the agent picker`.

Bites into `bites-task7.log`: (a) in `pickerKey`, return `handled: true` for Escape on a closed list, the Escape key case and the component's second Escape case red; (b) in `pickerRows`, drop the `parentId === null` skip, the rows case red (`session-title` listed); (c) in `AgentPicker.onKeyDown`, stop propagation only when `next.pick !== null`, the ArrowDown step of the component case red. Restore each.

---

### Task 8: The context ring shows the picked agent

**Files:**
- Modify: `spectro-web/src/components/ContextRing.tsx` (`ContextRing` props :59-73 and its button :122-156, the popover call :158-168; `ContextPopover` :183-281)
- Modify: `spectro-web/src/components/ComposerMeta.tsx` (props :225-229, the ring element :256-264)
- Modify: `spectro-web/src/components/Chat.tsx` (the `composerMeta` prop type :220-228; the two `ComposerMeta` elements :1849-1858 and :1935-1943)
- Modify: `spectro-web/src/App.tsx` (`viewKey` :2256; after `const view = useMemo(...)` :2284; the `composerMeta: {` object :3205-3216; the pruning effect after `allSlots` :338)
- Modify: `spectro-web/src/i18n/i18n.ts` (`ctx.helperModel`, `ctx.helperNoParts`, `ctx.helperNoSnapshot`, `ring.aria`, in the block of Task 7)
- Modify: `spectro-web/src/styles/panels.css` (three rules in the block of Task 7)
- Modify: `spectro-web/src/components/ContextRing.test.tsx:130`, `spectro-web/src/state/contextCleared.test.ts:111` (the aria label moved to `ring.aria`)
- Create: `spectro-web/src/components/contextRingAgent.test.tsx`
- Create: `spectro-web/src/components/shownAgentWiring.drift.test.ts`

**Interfaces:**
- Consumes: `AgentPick`, `RingView`, `ShownAgent`, `useShownAgent`, `setShownAgent`, `forgetShownAgent`, `shownAgentOf`, `ringOf` (Task 6); `AgentPicker` (Task 7); `agentAccent` (`format.ts:111`).
- Produces: `ContextRing` and `ContextPopover` take `picker?: AgentPick` (absent draws the root as before, without a picker); `ComposerMeta` takes `ring?: RingView` (the draw condition stays the root's `lastInputTokens > 0`, the ring itself gets the shown agent's figures); `Chat`'s `composerMeta` takes `shown?: ShownAgent` and `onPickAgent?: (id: string | null) => void`; App resolves `shownAgent` once and exposes `onPickAgent`, both used again by Task 9.

- [ ] **Step 1: Re-read the merged files**

`grep -n 'composerMeta' src/components/Chat.tsx src/App.tsx`, `grep -n 'const view = useMemo\|const viewKey = \|const allSlots' src/App.tsx`, `grep -n '<ContextRing' src/components/ComposerMeta.tsx`. 586 did not touch these three places, but the numbers moved with its hunks above them.

- [ ] **Step 2: Add the dictionary entries**

In the Task 7 block:

```ts
  "ctx.helperModel": { de: "Modell {model}", en: "model {model}" },
  "ctx.helperNoParts": {
    de: "Helfer zeichnen die Größen ihrer Teile auf, nicht die Texte.",
    en: "Helpers record the sizes of their parts, not the texts.",
  },
  "ctx.helperNoSnapshot": {
    de: "Für {id} wurden in dieser Session keine Teile aufgezeichnet.",
    en: "No parts were recorded for {id} in this session.",
  },
  "ring.aria": { de: "Kontext von {name}, {pct} Prozent voll", en: "Context of {name}, {pct} percent full" },
```

- [ ] **Step 3: Write the failing tests**

`components/contextRingAgent.test.tsx`:

```tsx
// Card 593: the ring and its popover show the picked agent and say so.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo, ContextSnapshot } from "../state/reducer";
import { initialState } from "../state/reducer";
import { figuresOf, shownAgentOf, type AgentPick } from "../state/shownAgent";
import { ComposerMeta } from "./ComposerMeta";
import { ContextPopover, ContextRing } from "./ContextRing";
import { contextGauge, ringFrame } from "./contextRingMath";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id, parentId, label: null, task: "", state: "working", lastStatus: null, inTokens: 0, outTokens: 0, ...extra,
});
const agents = [row("main", null), row("explore-1", "main", { model: "minimax-m3:cloud" }), row("worker-2", "main", { state: "submitted" })];
const snapshot = (extra: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  turn: 2, messages: 5, estimatedTokens: 3000, threshold: 22_937, thresholdSource: "window", contextWindow: 32_768,
  parts: [
    { label: "system prompt", chars: 1200, estTokens: 300 },
    { label: "tool schemas", chars: 4000, estTokens: 1000 },
    { label: "conversation", chars: 6800, estTokens: 1700 },
  ],
  ...extra,
});
const base = { ...initialState, rootAgentId: "main", agents, lastInputTokens: 24_100, context: snapshot({ threshold: 143_001, contextWindow: 204_288 }), aiCredits: 0.42 };
const pick = (id: string | null, state = base): AgentPick => ({ agents: state.agents, shown: shownAgentOf(state, id), onPick: () => {} });

const popover = (state: typeof base, id: string | null, onWindowOverride: ((n: number | null) => void) | undefined = () => {}): string => {
  const picker = pick(id, state);
  const figures = figuresOf(state, picker.shown);
  const frame = ringFrame(figures.context, figures.announcedWindow);
  const gauge = contextGauge(frame.threshold, frame.contextWindow, frame.thresholdSource);
  return renderToStaticMarkup(
    <ContextPopover lastInputTokens={figures.lastInputTokens} context={figures.context} frame={frame} gauge={gauge} shownPct={Math.round((figures.lastInputTokens / gauge.denominator.value) * 100)} onWindowOverride={onWindowOverride} aiCredits={state.aiCredits} picker={picker} />,
  );
};
const ring = (state: typeof base, id: string | null): string => {
  const picker = pick(id, state);
  const figures = figuresOf(state, picker.shown);
  return renderToStaticMarkup(<ContextRing lastInputTokens={figures.lastInputTokens} context={figures.context} announcedWindow={figures.announcedWindow} onWindowOverride={undefined} aiCredits={null} picker={picker} />);
};
const withHelper = { ...base, helpers: { "explore-1": { lastInputTokens: 12_300, context: snapshot(), announcedWindow: null } } };

describe("the ring", () => {
  it("names the main agent in its label and shows no prefix", () => {
    const html = ring(base, null);
    expect(html).toContain('aria-label="Context of Main agent, 12 percent full"');
    expect(html).not.toContain("context-ring-agent");
  });

  it("puts a helper's id in front of its percentage, with the agent's dot colour", () => {
    const html = ring(withHelper, "explore-1");
    expect(html).toContain('aria-label="Context of explore-1, 38 percent full"');
    expect(html).toMatch(/class="context-ring-agent mono" style="--agent-color:var\(--agent-explore\)"/);
    expect(html).toContain("explore-1</span>");
    expect(html).toContain(">38%</span>");
  });

  it("shows 0 % for a helper before its first usage", () => {
    expect(ring(base, "worker-2")).toContain(">0%</span>");
  });
});

describe("the popover for the root", () => {
  it("carries the picker under the eyebrow and keeps the session window row and the credits", () => {
    const html = popover(base, null);
    expect(html.indexOf("agent-pick")).toBeGreaterThan(html.indexOf('class="eyebrow"'));
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain('class="context-override"');
    expect(html).toContain("context-credits");
  });
});

describe("the popover for a helper", () => {
  it("shows the picker, its headline, the compaction line, its model, its parts, the meta line and the note", () => {
    const html = popover(withHelper, "explore-1");
    expect(html).toContain("Showing: explore-1");
    expect(html).toMatch(/12\.3k of \S+ (loaded|model|set) window \(38%\)/);
    expect(html).toContain("compacts at");
    expect(html).toContain("model minimax-m3:cloud");
    expect(html).toContain("tool schemas");
    expect(html).toContain("messages: 5");
    expect(html).toContain("Helpers record the sizes of their parts, not the texts.");
  });

  it("leaves the session window row and the credits out", () => {
    const html = popover(withHelper, "explore-1");
    expect(html).not.toContain("context-override");
    expect(html).not.toContain("context-credits");
  });

  it("shows tokens alone and no percentage line for a helper without a window", () => {
    const noWindow = { ...base, helpers: { "explore-1": { lastInputTokens: 12_300, context: snapshot({ thresholdSource: "fallback", contextWindow: undefined, threshold: 100_000 }), announcedWindow: null } } };
    const html = popover(noWindow, "explore-1");
    expect(html).toContain('<p class="context-line tabular">12.3k</p>');
    expect(html).not.toMatch(/\(\d+%\)/);
    expect(html).toContain("No window");
  });

  it("says that no parts were recorded for a helper without a snapshot, and draws no model line without a model", () => {
    const html = popover(base, "worker-2");
    expect(html).toContain("No parts were recorded for worker-2 in this session.");
    expect(html).not.toContain("context-parts");
    expect(html).not.toContain("context-helper-model");
  });

  it("speaks German", () => {
    setLang("de");
    const html = popover(withHelper, "explore-1");
    expect(html).toContain("Zeigt: explore-1");
    expect(html).toContain("Modell minimax-m3:cloud");
    expect(html).toContain("Helfer zeichnen die Größen ihrer Teile auf, nicht die Texte.");
  });
});

describe("the row under the composer", () => {
  const meta = (state: typeof base, id: string | null): string => {
    const picker = pick(id, state);
    return renderToStaticMarkup(
      <ComposerMeta provider="ollama" model="qwen2.5:7b" status="open" onApplyProvider={() => {}} liveView lastInputTokens={state.lastInputTokens} aiCredits={null} context={state.context} onWindowOverride={() => {}} ring={{ picker, figures: figuresOf(state, picker.shown) }} />,
    );
  };

  it("draws the ring on the root's fill and shows the helper's figures in it", () => {
    const html = meta(withHelper, "explore-1");
    expect(html).toContain("context-wrap");
    expect(html).toContain("explore-1</span>");
    expect(html).toContain(">38%</span>");
  });

  it("draws no ring before the root's first usage, whatever is picked", () => {
    expect(meta({ ...withHelper, lastInputTokens: 0 }, "explore-1")).not.toContain("context-wrap");
  });
});
```

The `ctx.window.unknown` text is pinned by its English wording in the popover; read it from `i18n.ts` and put the exact words into the "No window" assertion.

`components/shownAgentWiring.drift.test.ts` (Task 9 extends it):

```ts
// Card 593: one selection drives every agent view. App resolves it once and
// hands the same ShownAgent and one pick to the chat's composer row and to
// the right panel; the composer row hands it to the ring. Read off disk (no
// DOM in this suite).
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const chat = stripComments(read("./Chat.tsx", import.meta.url));
const meta = stripComments(read("./ComposerMeta.tsx", import.meta.url));

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("App resolves the shown agent once per render", () => {
  it("reads the store by the view key and resolves against the view", () => {
    expect(count(app, "shownAgentOf(view, chosenAgent)")).toBe(1);
    expect(app).toContain("useShownAgent(viewKey)");
    expect(app).toMatch(/const onPickAgent = useCallback\(\(id: string \| null\) => setShownAgent\(viewKey, id\), \[viewKey\]\);/);
  });

  it("hands it to the chat through composerMeta", () => {
    const block = app.slice(app.indexOf("composerMeta: {"), app.indexOf("onWindowOverride:"));
    expect(block).toContain("shown: shownAgent,");
    expect(block).toContain("onPickAgent,");
  });

  it("forgets the choice of a record that closed", () => {
    expect(app).toContain("forgetShownAgent(");
  });
});

describe("the chat and the composer row hand it to the ring", () => {
  it("at both ComposerMeta sites of the chat", () => {
    expect(count(chat, "ring={ringOf(props.composerMeta, state)}")).toBe(2);
  });

  it("and the row gives the ring its picker and the shown agent's figures", () => {
    const ring = meta.slice(meta.indexOf("<ContextRing"), meta.indexOf("/>", meta.indexOf("<ContextRing")));
    expect(ring).toContain("picker={props.ring?.picker}");
    expect(ring).toContain("lastInputTokens={figures.lastInputTokens}");
    expect(ring).toContain("context={figures.context}");
    expect(ring).toContain("announcedWindow={figures.announcedWindow}");
  });
});
```

Update the two pins: `ContextRing.test.tsx:130` becomes `expect(html).toContain('aria-label="Context of Main agent, 57 percent full"');` and `contextCleared.test.ts:111` becomes `const pct = Number(/aria-label="Context of Main agent, (\d+) percent full/.exec(html)?.[1]);`.

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run src/components/contextRingAgent.test.tsx src/components/shownAgentWiring.drift.test.ts src/components/ContextRing.test.tsx src/state/contextCleared.test.ts --maxWorkers=2 > kanban/evidence/593/red-task8.log 2>&1; echo $?` Expected: exit 1; unknown props, the old aria literal, the wiring absent.

- [ ] **Step 5: Build**

`ContextRing.tsx`:
- Imports: add `import type { CSSProperties } from "react";`, `import { agentAccent, formatCredits, formatTokens } from "../format";` (extend the existing import), `import type { AgentPick } from "../state/shownAgent";`, `import { AgentPicker } from "./AgentPicker";`.
- `ContextRing` props: add `/** Card 593: which agent the ring shows and the picker over the session's agents. Absent draws the root as before the card, without a picker. */ picker?: AgentPick;`. In the body: `const lang = useLang(); const helper = props.picker !== undefined && !props.picker.shown.isRoot ? props.picker.shown : null;`.
- The button's `aria-label`: `aria-label={t(lang, "ring.aria", { name: helper === null ? t(lang, "pick.main") : helper.id, pct: shownPct })}`.
- Before `<span className="tabular">{shownPct}%</span>`:

```tsx
        {helper !== null && (
          <span className="context-ring-agent mono" style={{ "--agent-color": agentAccent(helper.id) } as CSSProperties}>
            <span className="context-ring-agent-dot" aria-hidden="true" />
            {helper.id}
          </span>
        )}
```

  The accent colours the dot. `format.ts:111` keeps the pastel accents off text, and the trace chips wear them on a dot too (`TraceView.tsx`, `trace-chip-dot`), so the spec's "coloured by agentAccent(id)" lands on the dot and the id keeps the theme's text colour.
- The `ContextPopover` element gets `picker={props.picker}`.
- `ContextPopover` props: add `picker?: AgentPick;`. In the body: `const helper = props.picker !== undefined && !props.picker.shown.isRoot ? props.picker.shown : null;`. Markup changes, in order:
  - after the eyebrow: `{props.picker !== undefined && <AgentPicker {...props.picker} />}`;
  - the headline: `{helper !== null && windowUnknown ? (<p className="context-line tabular">{formatTokens(lastInputTokens)}</p>) : (<p className="context-line tabular">... as today ...</p>)}`;
  - the credits line: `{helper === null && aiCredits !== null && (...)}`;
  - the named window line: `{helper === null && named !== null && (...)}` (the helper's window is in its headline);
  - the override row: `{helper === null && onWindowOverride !== undefined && (...)}`;
  - a model line before the parts: `{helper !== null && helper.row?.model !== undefined && (<p className="context-helper-model mono">{t(lang, "ctx.helperModel", { model: helper.row.model })}</p>)}`;
  - the parts branch: keep the table and the meta line for both; the note under them becomes `{helper === null ? (<the existing context-note paragraph of :272, unchanged>) : (<p className="context-note">{t(lang, "ctx.helperNoParts")}</p>)}`;
  - the no-snapshot branch: `helper === null ? (the existing additive note) : (<p className="context-note">{t(lang, "ctx.helperNoSnapshot", { id: helper.id })}</p>)`.

`ComposerMeta.tsx`: props add `/** Card 593: the picker and the figures of the agent the ring shows; absent draws the root's figures without a picker (the Lab's chat). */ ring?: RingView;` (import the type from `../state/shownAgent`). Before the `return`: `const figures = props.ring?.figures ?? { lastInputTokens: props.lastInputTokens, context: props.context, announcedWindow: props.announcedWindow ?? null };`. The ring element keeps its `props.lastInputTokens > 0` condition and becomes:

```tsx
      {props.lastInputTokens > 0 && (
        <ContextRing
          lastInputTokens={figures.lastInputTokens}
          context={figures.context}
          announcedWindow={figures.announcedWindow}
          aiCredits={props.aiCredits}
          picker={props.ring?.picker}
          onWindowOverride={ringWindowOverride(props.liveView, props.onWindowOverride)}
        />
      )}
```

`Chat.tsx`: the `composerMeta` type gets `/** Card 593: the agent the ring shows and the pick that changes every agent view. */ shown?: ShownAgent; onPickAgent?: (id: string | null) => void;` (import `type ShownAgent` and `ringOf` from `../state/shownAgent`). Both `<ComposerMeta {...props.composerMeta} ...>` elements get the attribute `ring={ringOf(props.composerMeta, state)}`.

`App.tsx`:
- import `{ forgetShownAgent, setShownAgent, shownAgentOf, useShownAgent } from "./state/shownAgent"`;
- after `const view = useMemo(...)`:

```ts
  // Card 593: the agent the agent views show, one choice per record in view,
  // resolved once and handed to the chat's composer row and the right panel.
  const chosenAgent = useShownAgent(viewKey);
  const shownAgent = useMemo(() => shownAgentOf(view, chosenAgent), [view, chosenAgent]);
  const onPickAgent = useCallback((id: string | null) => setShownAgent(viewKey, id), [viewKey]);
```

- in the `composerMeta: {` object, after `model: chip.model,`: `shown: shownAgent,` and `onPickAgent,`;
- after `const allSlots = ...` (:338):

```ts
  // Card 593: a closed record forgets its agent choice; a new chat is a new key.
  const liveViewKeys = allSlots.map((s) => `live:${s.key}`).join("|");
  const knownViewKeys = useRef<string[]>([]);
  useEffect(() => {
    const now = liveViewKeys === "" ? [] : liveViewKeys.split("|");
    for (const key of knownViewKeys.current) if (!now.includes(key)) forgetShownAgent(key);
    knownViewKeys.current = now;
  }, [liveViewKeys]);
```

`panels.css`, in the Task 7 block:

```css
.context-ring-agent { display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); }
.context-ring-agent-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--agent-color, var(--text-faint)); }
.context-helper-model { margin: 2px 0 0; font-size: var(--fs-12); color: var(--text-faint); }
```

- [ ] **Step 6: Run the tests to see them pass**

Run the command of Step 4 with `green-task8.log`, plus `npx vitest run src/components/ContextRingWindowOverride.test.tsx src/components/composerMeta.test.tsx src/components/windowOverridePath.test.tsx src/components/chatStoredModelPicker.test.tsx src/components/copilotFaces.test.tsx src/state/storedSessionWindow.test.tsx src/components/sendAgainAfterCommand.test.ts src/styles --maxWorkers=2 > kanban/evidence/593/green-task8-neighbours.log 2>&1; echo $?`, `npx tsc -b`, eslint and prettier on every touched file. Expected: all exit 0.

- [ ] **Step 7: Commit, then bite**

Commit every file of this task: message `Card 593: the context ring shows the picked agent`.

Bites into `bites-task8.log`: (a) in `ComposerMeta`, hand the ring `props.lastInputTokens` instead of `figures.lastInputTokens`, the "helper's figures" case and the wiring pin red; (b) in `ContextPopover`, draw the override row for a helper too, the "leaves out" case red; (c) in `App`, resolve with `shownAgentOf(view, null)`, the wiring pin red. Restore each.

---

### Task 9: The Plan and System context panels follow the picked agent

**Files:**
- Modify: `spectro-web/src/components/PlanTab.tsx` (586's version: props `plan`, `runs`, `planAgent`, `live`, `wide`, `onToggleWide`, `onJump`, `onOpenPath`)
- Modify: `spectro-web/src/components/SystemContextTab.tsx` (props :111-123, the early returns :157-158, the model line :179, the root `<div className="ctx">` :191)
- Modify: `spectro-web/src/components/RightPanel.tsx` (props :133-171 after 586, `selectedId` :215-216, `selectAgent` :239-242, `counts` :326-331, `bodyFor` :368-376)
- Modify: `spectro-web/src/App.tsx` (the `<RightPanel` element :3268-3290 after 586)
- Modify: `spectro-web/src/i18n/i18n.ts` (`plan.helperNone` after `"plan.completed"`, :1355)
- Modify: `spectro-web/src/components/PlanTab.test.ts` and 586's PlanTab render tests, wherever 586 put them (`grep -rln 'planAgent' src/components/*.test.*`): the props change
- Modify: `spectro-web/src/components/shownAgentWiring.drift.test.ts` (the RightPanel pins)
- Create: `spectro-web/src/components/planTabAgent.test.tsx`, `spectro-web/src/components/systemContextAgent.test.tsx`, `spectro-web/src/components/agentViewsAgree.test.tsx`

**Interfaces:**
- Consumes: `UiState.plans` (Task 5); `ShownAgent`, `AgentPick`, `shownAgent`, `onPickAgent` in App (Tasks 6 and 8); `AgentPicker` (Task 7); `PLAYBOOK_AGENT` (`state/planVerdict.ts:48`); 586's `RunPanel`, `RunTrack`, `RunEntry`.
- Produces:

```ts
// PlanTab.tsx
export function rootPlanRows(plans: Record<string, PlanStep[]>, rootId: string, hasRuns: boolean): PlanStep[] | null;
export function PlanTab(props: { plans: Record<string, PlanStep[]>; shown: ShownAgent; agents: readonly AgentInfo[]; onPickAgent: (id: string | null) => void; runs: RunTrack[]; live: boolean; wide: boolean; onToggleWide: () => void; onJump: (entry: RunEntry) => void; onOpenPath: (run: RunTrack, path: string) => void }): JSX.Element;
// SystemContextTab.tsx
export function modelLineOf(selected: AgentInfo | null, model: string | undefined, fetched: string | undefined): string;
// RightPanel props: `plan` and 586's `planAgent` go; `plans`, `shown`, `onPickAgent` come; `selectedId` state goes.
```

- [ ] **Step 1: Re-read the merged files**

`sed -n 1,80p src/components/PlanTab.tsx`, `grep -n 'selectedId\|selectAgent\|plan\b\|planAgent\|PlanTab\|SystemContextTab' src/components/RightPanel.tsx`, `grep -n '<RightPanel' -A 40 src/App.tsx | grep -n 'plan\|runs\|onJump'`, and the PlanTab tests 586 wrote. Move the edits below to where the code is now.

- [ ] **Step 2: Add the dictionary entry**

After `"plan.completed": ...`:

```ts
  "plan.helperNone": {
    de: "{id} führt keinen Plan. Helfer arbeiten nach ihrem Auftrag; den Plan führt der Hauptagent.",
    en: "{id} keeps no plan. Helpers work from their task; the main agent keeps the plan.",
  },
```

- [ ] **Step 3: Write the failing tests**

`components/planTabAgent.test.tsx`:

```tsx
// Card 593: the Plan panel names its agent, keeps the root's plan apart from a
// playbook's rows, and says that a helper keeps no plan.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo, PlanStep } from "../state/reducer";
import type { RunTrack } from "../state/runView";
import { shownAgentOf } from "../state/shownAgent";
import { PlanTab, rootPlanRows } from "./PlanTab";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const row = (id: string, parentId: string | null): AgentInfo => ({ id, parentId, label: null, task: "", state: "working", lastStatus: null, inTokens: 0, outTokens: 0 });
const agents = [row("main", null), row("explore-1", "main")];
const state = { rootAgentId: "main", agents };
const steps: PlanStep[] = [{ text: "read the files", status: "completed" }, { text: "write the tool", status: "in_progress" }];
const playbook: PlanStep[] = [{ text: "[a] Brainstorm", status: "pending" }];
const run: RunTrack = { runId: "abcdefabcdef", kind: "playbook", name: "spectro", task: null, nodes: [], startedTs: 1, endedTs: 2, durationMs: 1, stopReason: "done", result: "done", detail: null, entries: [] };

const tab = (plans: Record<string, PlanStep[]>, id: string | null, runs: RunTrack[] = []): string =>
  renderToStaticMarkup(
    <PlanTab plans={plans} shown={shownAgentOf(state, id)} agents={agents} onPickAgent={() => {}} runs={runs} live={false} wide={false} onToggleWide={() => {}} onJump={() => {}} onOpenPath={() => {}} />,
  );

describe("rootPlanRows", () => {
  it("prefers the root's plan, falls back to the playbook's rows only without a run, else nothing", () => {
    expect(rootPlanRows({ main: steps, playbook }, "main", false)).toBe(steps);
    expect(rootPlanRows({ playbook }, "main", false)).toBe(playbook);
    expect(rootPlanRows({ playbook }, "main", true)).toBeNull();
    expect(rootPlanRows({}, "main", false)).toBeNull();
    expect(rootPlanRows({ "worker-3": steps }, "worker-3", false)).toBe(steps);
  });
});

describe("the Plan panel", () => {
  it("heads the root's plan with the picker and lists its steps", () => {
    const html = tab({ main: steps, playbook }, null);
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain("write the tool");
    expect(html).not.toContain("Brainstorm");
  });

  it("shows the playbook's rows when the root has no plan and no run is on screen, as before", () => {
    expect(tab({ playbook }, null)).toContain("Brainstorm");
  });

  it("shows the empty text with the picker when nobody wrote a plan", () => {
    const html = tab({}, null);
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain("No plan yet");
  });

  it("with a run draws the run panel first, then the picker and the model's plan under its heading", () => {
    const html = tab({ main: steps }, null, [run]);
    expect(html.indexOf("Run:")).toBeGreaterThan(-1);
    expect(html.indexOf("Run:")).toBeLessThan(html.indexOf("agent-pick"));
    expect(html).toContain("Plan of the model");
    expect(html).toContain("write the tool");
  });

  it("with a run and only a playbook plan draws no playbook rows and no heading", () => {
    const html = tab({ playbook }, null, [run]);
    expect(html).not.toContain("Brainstorm");
    expect(html).not.toContain("Plan of the model");
    expect(html).toContain("agent-pick");
  });

  it("says that a helper keeps no plan and lists nothing", () => {
    const html = tab({ main: steps }, "explore-1");
    expect(html).toContain("Showing: explore-1");
    expect(html).toContain("explore-1 keeps no plan. Helpers work from their task; the main agent keeps the plan.");
    expect(html).not.toContain("agents-list");
    expect(html).not.toContain("write the tool");
  });

  it("speaks German", () => {
    setLang("de");
    expect(tab({ main: steps }, "explore-1")).toContain("explore-1 führt keinen Plan.");
  });
});
```

`components/systemContextAgent.test.tsx`:

```tsx
// Card 593: the System context panel names its agent before the server has answered, and a helper's model line is its own.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "../state/reducer";
import { shownAgentOf } from "../state/shownAgent";
import { modelLineOf, SystemContextTab } from "./SystemContextTab";

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({ id, parentId, label: null, task: "", state: "working", lastStatus: null, inTokens: 0, outTokens: 0, ...extra });
const agents = [row("main", null), row("explore-1", "main", { model: "minimax-m3:cloud" }), row("worker-2", "main")];
const state = { rootAgentId: "main", agents };

describe("the System context panel", () => {
  it("heads the tab with the picker while the context is still loading", () => {
    const shown = shownAgentOf(state, "explore-1");
    const html = renderToStaticMarkup(<SystemContextTab selected={shown.row} shown={shown} agents={agents} onPickAgent={() => {}} thinking={false} />);
    expect(html.indexOf("Showing: explore-1")).toBeGreaterThan(-1);
    expect(html.indexOf("agent-pick")).toBeLessThan(html.indexOf("ctx-empty"));
  });

  it("reads a helper's own model when it has one, else the session's model as before", () => {
    expect(modelLineOf(agents[1], "qwen2.5:7b", "boot-model")).toBe("minimax-m3:cloud");
    expect(modelLineOf(agents[2], "qwen2.5:7b", "boot-model")).toBe("qwen2.5:7b");
    expect(modelLineOf(agents[0], "qwen2.5:7b", "boot-model")).toBe("qwen2.5:7b");
    expect(modelLineOf(null, undefined, "boot-model")).toBe("boot-model");
  });
});
```

`components/agentViewsAgree.test.tsx`:

```tsx
// Card 593: one selection, three views. The popover, the Plan panel and the
// System context panel render from the same resolved choice and name the same agent.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "../state/reducer";
import { initialState } from "../state/reducer";
import { __resetShownAgentForTests, figuresOf, setShownAgent, shownAgentOf } from "../state/shownAgent";
import { ContextPopover } from "./ContextRing";
import { contextGauge, ringFrame } from "./contextRingMath";
import { PlanTab } from "./PlanTab";
import { SystemContextTab } from "./SystemContextTab";

afterEach(() => __resetShownAgentForTests());

const row = (id: string, parentId: string | null): AgentInfo => ({ id, parentId, label: null, task: "", state: "working", lastStatus: null, inTokens: 0, outTokens: 0 });
const state = { ...initialState, rootAgentId: "main", agents: [row("main", null), row("explore-1", "main")], lastInputTokens: 100 };

it("the three views name the picked helper, once each", () => {
  setShownAgent("live:k", "explore-1");
  // What App does once per render: read the store, resolve, hand out.
  const shown = shownAgentOf(state, "explore-1");
  const picker = { agents: state.agents, shown, onPick: () => {} };
  const figures = figuresOf(state, shown);
  const frame = ringFrame(figures.context, figures.announcedWindow);
  const gauge = contextGauge(frame.threshold, frame.contextWindow, frame.thresholdSource);
  const views = [
    renderToStaticMarkup(<ContextPopover lastInputTokens={figures.lastInputTokens} context={figures.context} frame={frame} gauge={gauge} shownPct={0} onWindowOverride={undefined} aiCredits={null} picker={picker} />),
    renderToStaticMarkup(<PlanTab plans={{}} shown={shown} agents={state.agents} onPickAgent={() => {}} runs={[]} live={false} wide={false} onToggleWide={() => {}} onJump={() => {}} onOpenPath={() => {}} />),
    renderToStaticMarkup(<SystemContextTab selected={shown.row} shown={shown} agents={state.agents} onPickAgent={() => {}} thinking={false} />),
  ];
  for (const html of views) expect(html.split("Showing: explore-1").length - 1).toBe(1);
});
```

Add to `shownAgentWiring.drift.test.ts`:

```ts
describe("the right panel follows the same selection", () => {
  const panel = stripComments(read("./RightPanel.tsx", import.meta.url));

  it("keeps no selection of its own any more", () => {
    expect(panel).not.toContain("selectedId, setSelectedId");
    expect(panel).toContain("const selected = shown.row;");
  });

  it("a click on an agent row picks it and opens the context panel, as before", () => {
    const site = panel.slice(panel.indexOf("const selectAgent = "), panel.indexOf("};", panel.indexOf("const selectAgent = ")));
    expect(site).toContain("onPickAgent(id);");
    expect(site).toContain('openDockPanel("context");');
    expect(panel).toContain("selectedId={shown.id}");
  });

  it("App hands it the resolved agent, the pick and the plans per writer", () => {
    // The element holds a nested <AnalyzeRun /> in its analyze prop, so the
    // slice ends at the workspace prop, which follows the three of this card.
    const mount = app.slice(app.indexOf("<RightPanel"), app.indexOf("workspace={dockWorkspace(", app.indexOf("<RightPanel")));
    expect(mount).toContain("shown={shownAgent}");
    expect(mount).toContain("onPickAgent={onPickAgent}");
    expect(mount).toContain("plans={view.plans}");
    expect(mount).not.toContain("plan={view.plan}");
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `npx vitest run src/components/planTabAgent.test.tsx src/components/systemContextAgent.test.tsx src/components/agentViewsAgree.test.tsx src/components/shownAgentWiring.drift.test.ts --maxWorkers=2 > kanban/evidence/593/red-task9.log 2>&1; echo $?` Expected: exit 1 on the missing props and pins.

- [ ] **Step 5: Build**

`PlanTab.tsx` (keep 586's `RunPanel` element exactly as it renders it):

```tsx
// The "Plan" tab of the right-docked panel: the plan of the agent the picker
// shows. The root's plan is its own writer's slot (UiState.plans, card 593),
// so a playbook run's rows and the main agent's plan no longer overwrite each
// other; a helper keeps no plan and the panel says so. With a run on screen
// (card 586) the run panel comes first. Reuses the agent-card CSS vocabulary
// (dot + badge) so it reskins across all brand designs. The wire status
// values stay English; the chrome labels localize.

import type { AgentInfo, PlanStep } from "../state/reducer";
import type { RunEntry, RunTrack } from "../state/runView";
import type { ShownAgent } from "../state/shownAgent";
import { PLAYBOOK_AGENT } from "../state/planVerdict";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { AgentPicker } from "./AgentPicker";
import { RunPanel } from "./RunPanel";
import { statusLabel } from "./todoList";

export { statusLabel };

/** The rows the panel shows for the root: its own plan, else, with no run on screen, a playbook's rows as before card 593. */
export function rootPlanRows(plans: Record<string, PlanStep[]>, rootId: string, hasRuns: boolean): PlanStep[] | null {
  return plans[rootId] ?? (hasRuns ? null : (plans[PLAYBOOK_AGENT] ?? null));
}

function PlanList({ rows, lang }: { rows: PlanStep[]; lang: Lang }) {
  return (
    <ul className="agents-list" aria-label="Plan">
      {rows.map((step, i) => (
        <li key={i}>
          <div className={`agent-card agent-card--${step.status}`}>
            <span className="agent-card-head">
              <span className={`agent-dot agent-dot--${step.status}`} aria-hidden="true" />
              <span className={`agent-badge agent-badge--${step.status}`}>{statusLabel(step.status, lang)}</span>
            </span>
            <span className="agent-card-task">{step.text}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PlanTab({ plans, shown, agents, onPickAgent, runs, live, wide, onToggleWide, onJump, onOpenPath }: {
  plans: Record<string, PlanStep[]>;
  shown: ShownAgent;
  agents: readonly AgentInfo[];
  onPickAgent: (id: string | null) => void;
  runs: RunTrack[];
  live: boolean;
  wide: boolean;
  onToggleWide: () => void;
  onJump: (entry: RunEntry) => void;
  onOpenPath: (run: RunTrack, path: string) => void;
}) {
  const lang = useLang();
  const hasRuns = runs.length > 0;
  const picker = <AgentPicker agents={agents} shown={shown} onPick={onPickAgent} />;
  const runPanel = hasRuns ? (
    <RunPanel runs={runs} live={live} wide={wide} onToggleWide={onToggleWide} onJump={onJump} onOpenPath={onOpenPath} />
  ) : null;
  if (!shown.isRoot) {
    return (
      <>
        {runPanel}
        {picker}
        <p className="agents-empty">{t(lang, "plan.helperNone", { id: shown.id })}</p>
      </>
    );
  }
  const rows = rootPlanRows(plans, shown.rootId, hasRuns);
  const empty = rows === null || rows.length === 0;
  return (
    <>
      {runPanel}
      {picker}
      {hasRuns && !empty && <h3 className="run-model-plan">{t(lang, "run.panel.modelPlan")}</h3>}
      {empty ? <p className="agents-empty">{t(lang, "plan.empty")}</p> : <PlanList rows={rows} lang={lang} />}
    </>
  );
}
```

If 586's `RunPanel` props differ from the line above, use 586's names; the test reads `Plan of the model` and the picker's order only.

`SystemContextTab.tsx`:
- props add `shown: ShownAgent; agents: readonly AgentInfo[]; onPickAgent: (id: string | null) => void;`;
- a pure line, exported, next to `profileFor`:

```ts
/** The model line: a helper's own model when its run named one (card 593), else the session's model, else what the boot config says. */
export function modelLineOf(selected: AgentInfo | null, model: string | undefined, fetched: string | undefined): string {
  const own = selected !== null && selected.parentId !== null ? selected.model : undefined;
  return own ?? model ?? fetched ?? NO_MODEL;
}
```

  where `NO_MODEL` is a module constant holding the one-character literal the line at :179 falls back to today (`model ?? ctx.model ?? "<that character>"`); copy it from there, so the panel shows what it showed before;
- `const shownModel = modelLineOf(selected, model, fetched?.model);` replaces :179 (`ctx.model` is read from `fetched`, which is the same object `ctx` spreads);
- the picker is the first child of the tab in every branch: the two early returns become `return (<div className="ctx">{picker}<p className="ctx-empty">...</p></div>)` with `const picker = <AgentPicker agents={agents} shown={shown} onPick={onPickAgent} />;` declared before them, and the main return puts `{picker}` as the first child of `<div className="ctx">`, before `<div className="ctx-head">`.

`RightPanel.tsx`:
- props: remove `plan: PlanStep[] | null` and 586's `planAgent`; add `plans: Record<string, PlanStep[]>; shown: ShownAgent; onPickAgent: (id: string | null) => void;` with the doc `/** Card 593: the agent the agent views show, resolved by App, and the pick that changes it. */`;
- delete `const [selectedId, setSelectedId] = useState<string | null>(null);` and the `selected` line; write `const selected = shown.row;`;
- `selectAgent`:

```ts
  // Picking an agent shows its context: the pick reaches every agent view
  // (card 593) and the context panel is revealed, as before.
  const selectAgent = (id: string): void => {
    onPickAgent(id);
    openDockPanel("context");
  };
```

- `counts.plan`: with no run `rootPlanRows(plans, shown.rootId, false)?.length`, with a run 586's entry count;
- `bodyFor`: `<AgentsTab agents={agents} selectedId={shown.id} onSelect={selectAgent} analyze={analyze} />`; `<PlanTab plans={plans} shown={shown} agents={agents} onPickAgent={onPickAgent} runs=... live=... wide=... onToggleWide=... onJump=... onOpenPath=... />` with 586's values; `<SystemContextTab selected={selected} shown={shown} agents={agents} onPickAgent={onPickAgent} provider={provider} model={model} thinking={thinking} toolGroups={toolGroups} />`.
- `useState` stays imported if something else in the file uses it (`fullPanel` does).

`App.tsx`, the `<RightPanel` element: replace `plan={view.plan}` (and 586's `planAgent={view.planAgent}`) with `plans={view.plans}`, and add `shown={shownAgent}` and `onPickAgent={onPickAgent}` right there, before `onClose={toggleRightPanel}` and above the `workspace={dockWorkspace(` prop (the wiring pin reads the element up to that prop).

586's PlanTab tests: change their props to `plans={{ main: [...] }}` (or `{ playbook: [...] }` where they tested the playbook branch), add `shown={shownAgentOf({ rootAgentId: "main", agents: [] }, null)}`, `agents={[]}`, `onPickAgent={() => {}}`; the case "with a run, when planAgent is not playbook, the model's plan under the heading" becomes "with a run and `plans.main`, the heading and the rows; with a run and only `plans.playbook`, neither". Do not weaken what they assert about the run panel.

- [ ] **Step 6: Run the tests to see them pass**

Run the command of Step 4 with `green-task9.log`, plus `npx vitest run src/components src/panels/dockOpeners.drift.test.ts src/state --maxWorkers=2 > kanban/evidence/593/green-task9-components.log 2>&1; echo $?`, `npx tsc -b`, eslint and prettier on every touched file. Expected: all exit 0; `dockOpeners.drift.test.ts` unchanged and green (`selectAgent` still calls `openDockPanel`).

- [ ] **Step 7: Commit, then bite**

Commit every file of this task: message `Card 593: the Plan and System context panels follow the picked agent`.

Bites into `bites-task9.log`: (a) in `rootPlanRows`, return `plans[PLAYBOOK_AGENT] ?? plans[rootId] ?? null`, the "prefers the root's plan" case red; (b) in `PlanTab`, render the list for a helper too, the helper case red; (c) in `modelLineOf`, ignore `selected.model`, the model line case red; (d) in `RightPanel.selectAgent`, drop `onPickAgent(id);`, the wiring pin red. Restore each.

---

### Task 10: Documentation and verification

**Files:**
- Modify: `docs/guide-assets/parts/05-web-tabs.html` (the Agents paragraph :193-196, the Plan paragraph :201-205, the System context paragraph :207 on)
- Modify: `docs/guide-assets/parts/04-web-chat.html:345-347` (the context ring bullet)
- Modify: `docs/guide-assets/parts/15-ref-events.html:141-150` (the `context_info` entry)
- Create: `kanban/evidence/593/verify.mjs` (Playwright, outside the repo), screenshots and logs in that folder, `kanban/evidence/593/VERIFY.md`
- Modify: `TESTBUILDS.md` (one row, if this task builds a test app)

- [ ] **Step 1: The guide's drift tests, before**

Run: `./gradlew :spectro-core:test --tests '*GuideDriftTest*' --tests '*ConfigDocDriftTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/docs-before.log 2>&1; echo $?` and `./gradlew :spectro-server:test --tests '*WireDocDriftTest*' --rerun-tasks --no-build-cache > kanban/evidence/593/docs-before-server.log 2>&1; echo $?`. Both exit 0.

- [ ] **Step 2: Edit the parts**

`05-web-tabs.html`:
- Agents paragraph, last sentence: `Selecting a card makes that agent the shown agent of the context ring, the Plan panel and the System context tab, and opens the System context tab.`
- Plan paragraph, first sentence: `The read-only, latest-wins snapshot of the main agent's plan, fed by the permission-free <code>update_plan</code> tool.` Then add after the existing last sentence: `A picker at the top of the panel says which agent it shows ("Showing: Main agent") and lists every helper of the session, working ones with a dot and ended ones marked; the same choice drives the context ring and the System context tab. A helper keeps no plan, and the panel says so when one is picked. A playbook run's rows and the main agent's plan are kept apart: the panel shows the main agent's plan, and the run panel above it shows the run.`
- System context paragraph: after the first sentence add: `The picker at the top of the tab chooses the agent; for a helper the model line reads the model its run named.`

`04-web-chat.html`, the context ring bullet, replace `clicking it opens the introspection popover above the ring (chapter 28).` with `clicking it opens the introspection popover above the ring (chapter 28). The popover's picker switches the ring to a helper: it then shows the helper's fill against the helper's own window, its model and the sizes of its parts, and the Plan panel and the System context tab follow the same choice.`

`15-ref-events.html`, the `context_info` entry: replace `Emitted once per turn when introspection is on;` with `Emitted once per turn when introspection is on, by the main agent with the part texts and, since the release of 2026-10-13, by every helper with the sizes only (no <code>text</code> key);`.

No dashes in the new sentences; the existing ones in those paragraphs stay.

- [ ] **Step 3: The guide's drift tests, after**

Run the two commands of Step 1 with `docs-after.log` and `docs-after-server.log`. Both exit 0. Do not rebuild `docs/USER-GUIDE.html`, `docs/USER-GUIDE-LIGHT.html` or the PDFs here; the integrator rebuilds and stamps them once on the integration branch.

- [ ] **Step 4: Commit the parts**

Commit the three parts: message `Card 593: the guide describes the agent picker`.

- [ ] **Step 5: Full gates, alone**

Nothing else may build on the machine (`ps -eo pid,args | grep -i 'gradle\|vitest' | grep -v grep` prints nothing of another session). Run, logs and exit codes into the evidence folder: `./gradlew test --continue --rerun-tasks --no-build-cache > kanban/evidence/593/gate-java.log 2>&1; echo $? > kanban/evidence/593/gate-java.exit`, the five javadoc tasks the same way (`gate-javadoc.log`), `npm run gate` in `spectro-web` (`gate-web.log`), `npm test` in `spectro-desktop` (`gate-desktop.log`). Count Java from the JUnit XML (files, tests, failures, errors, skipped) and the web from the vitest summary line; write both into `VERIFY.md`. Commit the bundle the web gate rewrote under `spectro-server/src/main/resources/static` in its own commit: message `Card 593: the web bundle built by the gate`.

- [ ] **Step 6: A recorded session with two helpers, on the jar**

Build the jar: `./gradlew :spectro-server:bootJar > kanban/evidence/593/live-bootjar.log 2>&1; echo $?`, then `cp spectro-server/build/libs/<the one jar> /tmp/593-spectro-server.jar` (the server dies when its jar is rebuilt under it, so always a copy). Start it in a fresh home on a port outside 8080 to 8100, the way `kanban/evidence/521/live-run.log` records it for card 521 (port 8111, `-Duser.home=<temp home>`); write the PID into `live-run.log`. Then run `verify.mjs`, which starts from `kanban/evidence/521/live.mjs` (its `seed`, `DESIGN` map `{ paper: "still", dark: "spectroscope" }`, `makeSession` over the page's own socket, the reopen by `#/session/<id>`) and does, on the house backend (Ollama `minimax-m3:cloud`, the 0.15.x exception; `qwen2.5:7b` only if the cloud model does not answer, and then say so):

1. One session with the prompt `Start two explore helpers at once: one lists the top-level folders of this workspace, the other counts the markdown files. Report both answers.`; wait for the root `run_end`; keep the session id.
2. For each design and each width of 800 and 1280 px: reopen the session by its link; click the ring (`.context-ring`); screenshot `593-<design>-<width>-popover-root.png`; open the picker (`.agent-pick-button` inside `.context-pop`) and click the `explore-1` row; screenshot `593-<design>-<width>-popover-helper.png`; read the popover's text; open the dock and the Plan panel (read `panels/headerPanelControls.tsx` for the header button and the strip button named `Plan`, `rp.plan`); screenshot `593-<design>-<width>-plan.png`; the System context tab (`rp.context`); screenshot `593-<design>-<width>-context.png`.
3. Assert into `live-report.json`: the popover for the helper contains `Showing: explore-1`, `model minimax-m3:cloud` (or the model that ran), three part rows with numbers and `Helpers record the sizes of their parts, not the texts.`; the Plan panel contains `Showing: explore-1` and `explore-1 keeps no plan`; the System context tab contains `Showing: explore-1`; a pick of `Main agent` in the Plan panel's picker turns the ring's label back to `Context of Main agent`; the console shows zero errors.
4. Stop the jar (`kill <pid>`), check `lsof -i :8111` is empty and no orphan with `ppid 1` from this run remains (`ps -eo pid,ppid,args | grep 593-spectro-server`), as `kanban/evidence/521/live-stop.txt` records it.

Also count on the session file of that run (`<temp home>/.spectro/sessions/<id>.jsonl`): `grep -c '"context_info"' <file>` (all lines), `grep '"context_info"' <file> | grep -c '"agentId":"explore-' ` (the helpers' lines, at least two), and `grep '"context_info"' <file> | grep '"agentId":"explore-' | grep -c '"text"'` (0). Write the three numbers into `VERIFY.md`.

- [ ] **Step 7: Live in the test app**

The owner's live check runs in a test app. Build it as `the release evidence folder's testbuild/README.md` describes (section A of `kanban/evidence/release-0.15.2/RECIPE.md`, the scripts under `testbuild/scripts/`, the build stops at `spectroscope.app`, never the DMG, because `build-desktop-runkit.sh` deletes the released DMG), from this branch's head, label `<version>-beta (card-593, <sha>, <date>)`, and add its row to `TESTBUILDS.md` in the same run. Do not start the app yourself: the owner starts it. Write into `VERIFY.md` the app path and the three things to look at: one chat on the house backend with a prompt that spawns an explore child; pick the child in the ring, the popover shows its fill, its model and three parts with sizes; the Plan panel says it keeps no plan; and the session file counts of Step 6 on that session (`grep -c '"context_info"' ~/.spectro/sessions/<id>.jsonl`, none of the child's lines with `"text"`).

- [ ] **Step 8: Write `VERIFY.md` and commit it in the home repo**

`VERIFY.md` holds: the commits of this branch (`git log --oneline the integration branch..card-593`), the gate counts with their method and date, the Playwright run (backend and model, session id, the assertions and their results, the screenshot names), the session file counts, the test app row, and what was not done and why. Commit it in the home repo with explicit paths (`kanban/evidence/593/VERIFY.md`, `kanban/evidence/593/verify.mjs`, the screenshots, the logs, `TESTBUILDS.md`): message `Card 593: verification evidence` with the trailer.
