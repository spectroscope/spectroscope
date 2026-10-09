package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 490, criterion 5: four readers, one source.
 *
 * <p>The description of {@code spawn_agent} and {@code spawn_agents}, the
 * {@code maxItems} of the {@code spawn_agents} schema, the width check that
 * refuses a larger batch, and the first-token grace of a helper all read a
 * {@link SessionCount}. Before this card the width lived in three places and
 * only the constant could move: the schema literal was kept in sync by a
 * comment and the description was built once, at class load.</p>
 *
 * <p>Two halves. The first asks each reader, at several counts, for the value
 * the source derives, so a reader that stops reading the source goes red at
 * a count where its literal and the source part. The second pins the source's
 * own numbers at those counts, so moving the source moves this table. The
 * readers are asked through a real {@link SubagentManager}'s tools, between
 * runs, where they read the count the config carries.</p>
 */
class SessionCountDriftTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A fixed run budget of 30 s implies a median of 10 s for the grace. */
    private static final long RUN_BUDGET_MS = 30_000;

    private static final List<Integer> COUNTS = Arrays.asList(null, 2, 3, 6, 10);

    private static SubagentManager managerAt(Integer sessions) {
        return new SubagentManager(SubagentConfig.builder()
                .provider(request -> List.of())
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .sessionsPerChat(sessions)
                .build(), RUN_BUDGET_MS);
    }

    private static Tool tool(SubagentManager manager, String name) {
        return manager.tools().stream().filter(t -> t.name().equals(name)).findFirst().orElseThrow();
    }

    private static ObjectNode batchOf(int size) {
        ObjectNode input = JSON.createObjectNode();
        ArrayNode agents = input.putArray("agents");
        for (int i = 0; i < size; i++) {
            agents.addObject().put("type", "explore").put("task", "t" + i);
        }
        return input;
    }

    @Test
    void everyReaderReadsTheSessionCount() {
        List<String> drift = new ArrayList<>();
        for (Integer sessions : COUNTS) {
            SessionCount count = SessionCount.of(sessions);
            SubagentManager manager = managerAt(sessions);
            Tool one = tool(manager, "spawn_agent");
            Tool many = tool(manager, "spawn_agents");
            String at = "at sessionsPerChat " + sessions + ": ";

            // Reader 1: the descriptions.
            if (!many.description().contains("Starts up to " + count.batchWidth() + " subagents")) {
                drift.add(at + "spawn_agents does not offer " + count.batchWidth() + ": "
                        + many.description());
            }
            for (Tool spawn : List.of(one, many)) {
                if (!spawn.description().endsWith(count.limitSentence())
                        || count.isSet() != spawn.description().contains("In this chat at most")) {
                    drift.add(at + spawn.name() + " does not carry the count's sentence: "
                            + spawn.description());
                }
            }
            // Reader 2: the schema.
            int maxItems = many.inputSchema().path("properties").path("agents").path("maxItems").asInt();
            if (maxItems != count.batchWidth()) {
                drift.add(at + "maxItems is " + maxItems + ", the source says " + count.batchWidth());
            }
            // Reader 3: the width check. A batch of the width passes it (and then
            // meets the no-run refusal); one more is refused by width.
            String wide = many.execute(batchOf(count.batchWidth() + 1), null);
            String fits = many.execute(batchOf(count.batchWidth()), null);
            if (!wide.contains("at most " + count.batchWidth() + " parallel subagents")) {
                drift.add(at + "a batch of " + (count.batchWidth() + 1) + " is not refused by width: " + wide);
            }
            if (fits.contains("parallel subagents")) {
                drift.add(at + "a batch of " + count.batchWidth() + " is refused by width: " + fits);
            }
            // Reader 4: the grace a helper admitted now would get.
            long expected = Math.min(ChildBudget.GRACE_CEILING_MS,
                    RUN_BUDGET_MS + count.queuedAhead() * (RUN_BUDGET_MS / ChildBudget.P50_MULTIPLE));
            if (manager.firstTokenGraceMs() != expected) {
                drift.add(at + "the grace is " + manager.firstTokenGraceMs() + " ms, the source says "
                        + expected);
            }
        }
        assertTrue(drift.isEmpty(), String.join("\n", drift));
    }

    @Test
    void theSourceSaysTheseNumbers() {
        // count -> helpers at once, batch width, helpers ahead in the queue
        assertSource(null, 4, 4, 3);
        assertSource(2, 1, 4, 0);
        assertSource(3, 2, 4, 1);
        assertSource(6, 5, 5, 4);
        assertSource(10, 9, 9, 8);
    }

    private static void assertSource(Integer sessions, int helpers, int width, int ahead) {
        SessionCount count = SessionCount.of(sessions);
        assertEquals(helpers, count.helpersAtOnce(), "helpers at once, count " + sessions);
        assertEquals(width, count.batchWidth(), "batch width, count " + sessions);
        assertEquals(ahead, count.queuedAhead(), "helpers ahead, count " + sessions);
    }

    @Test
    void aChatAtThreeIsToldTwoAndAChatWithNoCountIsToldWhatV0144Said() {
        SubagentManager atThree = managerAt(3);
        assertTrue(tool(atThree, "spawn_agents").description().endsWith(
                        " In this chat at most 2 subagents run at the same time; further ones wait"
                                + " for a free slot."),
                tool(atThree, "spawn_agents").description());
        assertTrue(tool(atThree, "spawn_agent").description().endsWith(
                        " In this chat at most 2 subagents run at the same time; further ones wait"
                                + " for a free slot."),
                tool(atThree, "spawn_agent").description());

        SubagentManager unset = managerAt(null);
        assertEquals(RoleCatalog.SPAWN_AGENT_DESC, tool(unset, "spawn_agent").description());
        assertEquals(RoleCatalog.SPAWN_AGENTS_DESC, tool(unset, "spawn_agents").description());
        assertFalse(RoleCatalog.SPAWN_AGENTS_DESC.contains("In this chat"));
        assertEquals(4, tool(unset, "spawn_agents").inputSchema()
                .path("properties").path("agents").path("maxItems").asInt());
    }

    @Test
    void theContextViewShowsTheTextThatIsSent() {
        for (Integer sessions : COUNTS) {
            SubagentManager manager = managerAt(sessions);
            List<RoleCatalog.ToolSummary> shown = RoleCatalog.parentTools(SessionCount.of(sessions));
            assertEquals(tool(manager, "spawn_agent").description(), shown.get(0).description(),
                    "count " + sessions);
            assertEquals(tool(manager, "spawn_agents").description(), shown.get(1).description(),
                    "count " + sessions);
        }
    }

    @Test
    void aCountBelowTheFloorIsRefusedByName() {
        IllegalArgumentException refused = org.junit.jupiter.api.Assertions.assertThrows(
                IllegalArgumentException.class, () -> SessionCount.of(1));
        assertTrue(refused.getMessage().contains("sessionsPerChat"), refused.getMessage());
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> managerAt(1));
    }
}
