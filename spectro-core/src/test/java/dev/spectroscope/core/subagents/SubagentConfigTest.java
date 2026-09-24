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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 231b: the builder replaces the telescoping compat constructors. The
 * defect class it ends is structural — a positional {@code null} in an
 * unlabeled slot is what hid the child llm-wire gap for a month, so from now
 * on every optional seam is set by NAME or not at all.
 */
class SubagentConfigTest {

    private static final LlmProvider PROVIDER = request -> List.of();
    private static final PermissionBroker ALLOW = request -> true;

    @Test
    void theBuilderCarriesEverySeamByName() {
        HookRunner hooks = HookRunner.load(List.of());
        LlmWireRecorder wire = new LlmWireRecorder(
                Path.of("build", "231-builder-probe.llm.jsonl"), 1024);
        List<Tool> webTools = List.of();

        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(ALLOW)
                .baseTools(List.of())
                .hooks(hooks)
                .llmWire(wire)
                .webTools(webTools)
                .build();

        assertSame(PROVIDER, config.provider());
        assertEquals(Path.of("."), config.cwd());
        assertEquals("main", config.parentAgentId());
        assertSame(ALLOW, config.onPermission());
        assertSame(hooks, config.hooks());
        assertSame(wire, config.llmWire(),
                "the recorder rides through the builder as the SAME instance —"
                        + " the whole point of card 231");
    }

    @Test
    void theOptionalSeamsDefaultExactlyLikeTheOldCompatArities() {
        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(ALLOW)
                .baseTools(List.of())
                .build();

        assertNull(config.hooks(), "no hooks means none, as the 5-arity promised");
        assertNull(config.llmWire(), "no recorder means children record nothing, stated by name");
        assertTrue(config.webTools().isEmpty(), "no web grant normalizes to an empty list");
    }

    @Test
    void anAbsentWebGrantNormalizesToEmptyThroughTheCanonicalConstructorToo() {
        SubagentConfig config = new SubagentConfig(
                PROVIDER, Path.of("."), "main", ALLOW, List.of(), null, null, null, null);
        assertTrue(config.webTools().isEmpty(),
                "the canonical constructor keeps the record's own normalization");
    }

    @Test
    void anAbsentBudgetNormalizesToTheDerivedOneWhoseFloorGoverns() {
        // Card 270: a config that names no budget still gets a real one. Nothing
        // has been measured through it, so the floor is what a child gets — never
        // a zero, and never the 120 s literal the card replaced.
        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(ALLOW)
                .baseTools(List.of())
                .build();

        assertEquals(SpectroConfig.DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000L,
                config.budget().runBudgetMs());
        assertTrue(config.budget().observedP50Ms().isEmpty(),
                "an unfed window has measured nothing and says so");
        assertTrue(config.budget().derivation().contains("nothing measured"),
                config.budget().derivation());
    }

    @Test
    void theOperatorsFloorReachesTheDerivedBudget() {
        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .budget(ChildBudget.derivedFrom(new ExchangeLatency()))
                .subagentBudgetSeconds(60)
                .build();
        assertEquals(60_000L, config.budget().runBudgetMs());
        assertEquals(60_000L, config.budget().floorMs());
    }

    @Test
    void anAbsentFloorMeansTheShippedTwoHours() {
        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .build();
        // The literal, not DEFAULT_SUBAGENT_BUDGET_SECONDS * 1000: a test that
        // restates the constant it is checking agrees with whatever the constant
        // becomes, and the name of this one is a claim about two hours.
        assertEquals(7_200_000L, config.budget().runBudgetMs());
    }

    @Test
    void theFloorGovernsWhenNoBudgetIsHandedIn() {
        // The other half of the canonical constructor: no budget at all plus an
        // operator's floor, which is the branch a face that names only its
        // number would take. The case above covers an absent floor, the one
        // below a budget that is handed in; this one is neither.
        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .subagentBudgetSeconds(60)
                .build();
        assertEquals(60_000L, config.budget().runBudgetMs());
        assertEquals(60_000L, config.budget().floorMs());
    }

    @Test
    void anExplicitBudgetStillWinsOverTheFloor() {
        ChildBudget fixed = ChildBudget.fixed(45_000L);
        SubagentConfig config = SubagentConfig.builder()
                .provider(PROVIDER)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .budget(fixed)
                .subagentBudgetSeconds(60)
                .build();
        assertEquals(45_000L, config.budget().runBudgetMs());
        assertSame(fixed, config.budget(),
                "withFloorMs returns itself on an override, which is what the record's"
                        + " javadoc promises; a copy carrying the same number would satisfy"
                        + " the assertion above and break that promise silently");
    }

    @Test
    void aFloorOfZeroIsRefusedByNameWhenABudgetIsHandedIn() {
        // The branch both shipped faces take: SessionConnection and SpectroCli
        // hand in a derived budget AND the operator's number, so the floor
        // arrives through withFloorMs rather than through the null branch.
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SubagentConfig.builder()
                        .provider(PROVIDER)
                        .cwd(Path.of("."))
                        .parentAgentId("main")
                        .budget(ChildBudget.derivedFrom(new ExchangeLatency()))
                        .subagentBudgetSeconds(0)
                        .build());
        assertTrue(refused.getMessage().contains("subagentBudgetSeconds"), refused.getMessage());
    }

    @Test
    void aFloorOfZeroIsRefusedByNameWhenNoBudgetIsHandedIn() {
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SubagentConfig.builder()
                        .provider(PROVIDER)
                        .cwd(Path.of("."))
                        .parentAgentId("main")
                        .subagentBudgetSeconds(0)
                        .build());
        assertTrue(refused.getMessage().contains("subagentBudgetSeconds"), refused.getMessage());
    }
}
