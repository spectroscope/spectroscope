package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertIterableEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The merge contract, ported from the python edition's {@code state.apply_update}.
 * A reducer is only exercised on the SECOND write to its channel, so every rule
 * below is one that survives a smoke test and takes down a superstep later.
 */
class StateSchemaTest {

    private static final StateSchema TRACE = StateSchema.of(Channel.appending("trace"));

    @Test
    void theMergeReturnsANewStateAndNeverMutatesItsInputs() {
        GraphState before = GraphState.of(Map.of("question", "why"));
        GraphState after = TRACE.apply(before, StateUpdate.of("question", "how"));

        assertNotSame(before, after);
        assertEquals("why", before.get("question"), "the pre-superstep state must survive the merge");
        assertEquals("how", after.get("question"));
    }

    @Test
    void aNullUpdateReturnsACopyNotAnAlias() {
        GraphState before = GraphState.of(Map.of("question", "why"));
        GraphState after = TRACE.apply(before, null);

        assertNotSame(before, after, "an alias would let a caller share a state with the engine");
        assertEquals(before.values(), after.values());
    }

    @Test
    void anEmptyUpdateReturnsACopy() {
        GraphState before = GraphState.of(Map.of("question", "why"));
        assertNotSame(before, TRACE.apply(before, StateUpdate.none()));
    }

    @Test
    void anAbsentReducerChannelIsSeededRatherThanFoldedIntoNothing() {
        GraphState seeded = TRACE.apply(GraphState.empty(), StateUpdate.of("trace", List.of("router")));
        assertEquals(List.of("router"), seeded.get("trace"));
    }

    @Test
    void aNullReducerChannelIsSeededToo() {
        LinkedHashMap<String, Object> present = new LinkedHashMap<>();
        present.put("trace", null);
        GraphState seeded = TRACE.apply(GraphState.of(present), StateUpdate.of("trace", List.of("router")));
        assertEquals(List.of("router"), seeded.get("trace"));
    }

    @Test
    void theSecondWriteToAReducerChannelIsFolded() {
        GraphState once = TRACE.apply(GraphState.empty(), StateUpdate.of("trace", List.of("router")));
        GraphState twice = TRACE.apply(once, StateUpdate.of("trace", List.of("retrieve")));

        assertEquals(List.of("router", "retrieve"), twice.get("trace"));
        assertEquals(List.of("router"), once.get("trace"), "the fold must not append in place");
    }

    @Test
    void theFoldedListIsUnmodifiableSoNoLaterNodeCanRewriteAFiledSnapshot() {
        GraphState once = TRACE.apply(GraphState.empty(), StateUpdate.of("trace", List.of("router")));
        GraphState twice = TRACE.apply(once, StateUpdate.of("trace", List.of("retrieve")));

        @SuppressWarnings("unchecked")
        List<Object> folded = (List<Object>) twice.get("trace");
        assertThrows(UnsupportedOperationException.class, () -> folded.add("sneak"));
    }

    @Test
    void anUndeclaredChannelIsSimplySet() {
        GraphState after = TRACE.apply(GraphState.empty(), StateUpdate.of("diagnostic", 42));
        assertEquals(42, after.get("diagnostic"),
                "the schema is a declaration, not a gate on which keys may be written");
    }

    @Test
    void aLastWriteWinsChannelOverwrites() {
        StateSchema schema = StateSchema.of(Channel.lastWriteWins("answer"));
        GraphState first = schema.apply(GraphState.empty(), StateUpdate.of("answer", "a"));
        assertEquals("b", schema.apply(first, StateUpdate.of("answer", "b")).get("answer"));
    }

    @Test
    void channelsAreFoldedInTheUpdatesOwnKeyOrder() {
        List<String> folds = new ArrayList<>();
        StateSchema schema = StateSchema.of(
                Channel.reducing("zebra", (a, b) -> record(folds, "zebra", a, b)),
                Channel.reducing("alpha", (a, b) -> record(folds, "alpha", a, b)));
        GraphState seeded = schema.apply(GraphState.empty(),
                StateUpdate.of("zebra", 1).and("alpha", 1));

        schema.apply(seeded, StateUpdate.of("zebra", 2).and("alpha", 2));

        assertIterableEquals(List.of("zebra", "alpha"), folds,
                "the update's own write order decides the fold order, and it is never sorted");
    }

    private static Object record(List<String> folds, String channel, Object a, Object b) {
        folds.add(channel);
        return b;
    }

    @Test
    void aNonMapUpdateIsRefusedByTypeAndTruthinessNeverEntersIntoIt() {
        for (Object refused : List.of(List.of(), "", 0, false, List.of("x"), 0.0)) {
            InvalidUpdateException failure =
                    assertThrows(InvalidUpdateException.class, () -> StateUpdate.from(refused),
                            () -> refused + " must be refused exactly as [\"x\"] is");
            assertTrue(failure.getMessage().contains("Expected a map of channel updates"),
                    failure.getMessage());
        }
    }

    @Test
    void onlyNullAndAnEmptyMapMeanNoChannelsWritten() {
        assertNull(StateUpdate.from(null));
        assertTrue(StateUpdate.from(Map.of()).isEmpty());
    }

    @Test
    void anUpdateThatIsAlreadyAnUpdatePassesThroughTheDynamicSeam() {
        StateUpdate update = StateUpdate.of("a", 1);
        assertSame(update, StateUpdate.from(update));
    }

    @Test
    void anUpdateKeepsItsOwnWriteOrderAndIsNeverSorted() {
        assertIterableEquals(List.of("zebra", "alpha"),
                StateUpdate.of("zebra", 1).and("alpha", 2).channels().keySet());
    }

    @Test
    void aChannelWithNoReducerIsRefusedWhereItWasDeclared() {
        InvalidReducerException failure = assertThrows(InvalidReducerException.class,
                () -> Channel.reducing("trace", null));
        assertTrue(failure.getMessage().contains("trace"), failure.getMessage());
    }

    @Test
    void aSchemaWithNoChannelsIsALegitimateSchemaWhereEveryChannelOverwrites() {
        StateSchema bare = StateSchema.of();
        GraphState once = bare.apply(GraphState.empty(), StateUpdate.of("c", "x"));
        assertEquals("y", bare.apply(once, StateUpdate.of("c", "y")).get("c"));
    }

    @Test
    void theStateHandedOutCannotBeMutatedThroughItsValuesView() {
        Map<String, Object> values = GraphState.of(Map.of("a", 1)).values();
        assertThrows(UnsupportedOperationException.class, () -> values.put("b", 2));
    }

    @Test
    void aStateDetachesFromTheMapItWasBuiltFrom() {
        LinkedHashMap<String, Object> source = new LinkedHashMap<>();
        source.put("a", 1);
        GraphState state = GraphState.of(source);
        source.put("b", 2);

        assertNull(state.get("b"), "a caller must not be able to write into a state after the fact");
    }
}
