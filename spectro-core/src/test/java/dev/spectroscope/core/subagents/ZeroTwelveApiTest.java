package dev.spectroscope.core.subagents;

import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.hooks.HookRunner;
import dev.spectroscope.core.provider.ExchangeLatency;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * Card 412: the two public members of spectro-core 0.12.0 that the 0.13.0
 * integration branch had lost, called here the way a 0.12.0 caller calls them.
 *
 * <p>This file uses both members directly, so when either is missing the test
 * source set does not compile. {@link ZeroTwelveSourceProbeTest} asks
 * {@code javac} the same question from a string and also checks the
 * deprecation warning.</p>
 */
@SuppressWarnings("deprecation")
class ZeroTwelveApiTest {

    private static final LlmProvider PROVIDER = request -> List.of();
    private static final PermissionBroker ALLOW = request -> true;
    private static final Path CWD = Path.of(".");

    @Test
    void theThirteenArgumentConstructorOf0120StillBuildsAConfig() {
        HookRunner hooks = HookRunner.load(List.of());
        LlmWireRecorder wire = new LlmWireRecorder(Path.of("build", "412-probe.llm.jsonl"), 1024);
        List<Tool> base = List.of();
        ChildBudget budget = ChildBudget.fixed(45_000L);

        SubagentConfig config = new SubagentConfig(PROVIDER, CWD, "main", ALLOW, base, hooks, wire,
                List.of(), budget, 5_000, 40, 2_048, Boolean.TRUE);

        assertSame(PROVIDER, config.provider());
        assertSame(hooks, config.hooks());
        assertSame(wire, config.llmWire());
        assertSame(budget, config.budget(), "an explicit override keeps winning, as in every arity");
        assertEquals(5_000, config.compactionThreshold());
        assertEquals(40, config.maxTurns());
        assertEquals(2_048, config.maxTokens());
        assertEquals(Boolean.TRUE, config.thinking());
        assertNull(config.subagentBudgetSeconds(), "0.12.0 had no floor setting to pass");
        assertNull(config.sessionWindow(), "0.12.0 had no session window to pass");
    }

    @Test
    void itBuildsTheRecordTheFourteenArgumentFormBuildsWithNoFloorSetting() {
        HookRunner hooks = HookRunner.load(List.of());
        ChildBudget budget = ChildBudget.fixed(45_000L);

        SubagentConfig thirteen = new SubagentConfig(PROVIDER, CWD, "main", ALLOW, List.of(), hooks,
                null, null, budget, 5_000, 40, 2_048, Boolean.FALSE);
        SubagentConfig fourteen = new SubagentConfig(PROVIDER, CWD, "main", ALLOW, List.of(), hooks,
                null, null, budget, 5_000, 40, 2_048, Boolean.FALSE, null);

        assertEquals(fourteen, thirteen);
    }

    @Test
    void underADerivedBudgetBothFormsShareTheWindowAndTheShippedFloor() {
        // A derived budget is rebuilt by the canonical constructor on every
        // call, and ChildBudget has no equals, so the two records cannot be
        // compared whole here. Every other component is, and the budget is
        // compared on what it reads: the window, the floor, the override flag.
        ExchangeLatency window = new ExchangeLatency();
        window.observe(92_200L);
        ChildBudget derived = ChildBudget.derivedFrom(window);

        SubagentConfig thirteen = new SubagentConfig(PROVIDER, CWD, "main", ALLOW, List.of(), null,
                null, null, derived, null, null, null, null);
        SubagentConfig fourteen = new SubagentConfig(PROVIDER, CWD, "main", ALLOW, List.of(), null,
                null, null, derived, null, null, null, null, null);

        assertSame(fourteen.provider(), thirteen.provider());
        assertEquals(fourteen.cwd(), thirteen.cwd());
        assertEquals(fourteen.parentAgentId(), thirteen.parentAgentId());
        assertSame(fourteen.onPermission(), thirteen.onPermission());
        assertEquals(fourteen.baseTools(), thirteen.baseTools());
        assertEquals(fourteen.hooks(), thirteen.hooks());
        assertEquals(fourteen.llmWire(), thirteen.llmWire());
        assertEquals(fourteen.webTools(), thirteen.webTools());
        assertEquals(fourteen.compactionThreshold(), thirteen.compactionThreshold());
        assertEquals(fourteen.maxTurns(), thirteen.maxTurns());
        assertEquals(fourteen.maxTokens(), thirteen.maxTokens());
        assertEquals(fourteen.thinking(), thirteen.thinking());
        assertEquals(fourteen.subagentBudgetSeconds(), thirteen.subagentBudgetSeconds());
        assertEquals(fourteen.sessionWindow(), thirteen.sessionWindow());
        assertSame(window, thirteen.budget().latency());
        assertSame(fourteen.budget().latency(), thirteen.budget().latency());
        assertEquals(fourteen.budget().floorMs(), thirteen.budget().floorMs());
        assertEquals(SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L, thirteen.budget().floorMs());
        assertFalse(thirteen.budget().isOverridden());
        assertEquals(fourteen.budget().runBudgetMs(), thirteen.budget().runBudgetMs());
    }

    @Test
    void floorMsCarriesTheDeprecatedAnnotation() throws NoSuchFieldException {
        // The probe's warning alone does not hold the annotation: javac also
        // marks a member deprecated from its javadoc @deprecated tag, and the
        // bite that removed the annotation left the probe green
        // (kanban/evidence/412/loop/bite-3.log in the home repo).
        assertNotNull(ChildBudget.class.getField("FLOOR_MS").getAnnotation(Deprecated.class),
                "FLOOR_MS is not annotated @Deprecated");
    }

    @Test
    void floorMsIsTheDefaultFloorTheBudgetUsesToday() {
        long shipped = ChildBudget.derivedFrom(new ExchangeLatency()).floorMs();
        assertEquals(shipped, ChildBudget.FLOOR_MS);

        SubagentConfig unset = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(CWD)
                .parentAgentId("main")
                .onPermission(ALLOW)
                .build();
        assertEquals(unset.budget().floorMs(), ChildBudget.FLOOR_MS,
                "a config with no floor setting runs its children on the floor FLOOR_MS names");
        assertEquals(SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L, ChildBudget.FLOOR_MS);
    }
}
