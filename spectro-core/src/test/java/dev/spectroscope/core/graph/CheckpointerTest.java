package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The thread memory, ported from the python edition's {@code checkpoint.py} and
 * pinned by the harvested spec (rule 475: per-thread append-only list, uuid4-hex
 * checkpoint ids, step defaults to previous+1 else 0, metadata carries
 * {source, step, parents}, created_at is an ISO-8601 UTC instant, parent_config
 * chains to the previous snapshot, growth is unbounded).
 *
 * <p>The detach rules diverge from python where the language does: python
 * deep-copies everything including arbitrary objects, Java copies the container
 * SPINE (maps, lists, sets, arrays) and shares every other reference. The two
 * tests under "what the copy shares" pin that divergence on purpose, so a reader
 * meets it in a test name rather than in production.</p>
 */
class CheckpointerTest {

    private static RunConfig thread(String threadId) {
        return RunConfig.defaults().withConfigurable(Map.of("thread_id", threadId));
    }

    // -- put then get: the round trip ---------------------------------------- //

    @Test
    void putThenGetReturnsTheValues() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("question", "why"), List.of("retrieve"));

        StateSnapshot snapshot = saver.get(thread("t-1"));
        assertEquals(Map.of("question", "why"), snapshot.values());
    }

    @Test
    void getReturnsTheNewestCheckpoint() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("step", "one"), List.of());
        saver.put(thread("t-1"), Map.of("step", "two"), List.of());

        assertEquals("two", saver.get(thread("t-1")).values().get("step"));
    }

    @Test
    void anUnknownThreadGetsAnEmptySnapshotRatherThanAnError() {
        CheckpointSaver saver = new InMemorySaver();
        StateSnapshot snapshot = saver.get(thread("nobody"));

        assertTrue(snapshot.values().isEmpty(), "no history is the normal state of a first message");
        assertTrue(snapshot.next().isEmpty());
        assertEquals(-1, snapshot.step(), "-1 is 'before the first superstep'");
        assertNull(snapshot.metadata(), "matching what the python edition hands back");
        assertNull(snapshot.parentConfig());
    }

    @Test
    void nextAndStepSurviveTheRoundTrip() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of("grade", "web"), 4, "loop");

        StateSnapshot snapshot = saver.get(thread("t-1"));
        assertEquals(List.of("grade", "web"), snapshot.next());
        assertEquals(4, snapshot.step());
    }

    @Test
    void createdAtIsSetOnEveryStoredCheckpoint() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());

        String createdAt = saver.get(thread("t-1")).createdAt();
        assertNotNull(createdAt);
        // Parses as an instant or the assertion below throws — that IS the format check.
        assertNotNull(Instant.parse(createdAt));
    }

    @Test
    void stepCountsUpWithinAThreadWhenTheCallerDoesNotSay() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());
        saver.put(thread("t-1"), Map.of(), List.of());
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(2, saver.get(thread("t-1")).step(), "0, 1, 2 — the saver numbers the series");
    }

    @Test
    void stepKeepsCountingWhereTheThreadLeftOff() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of(), 6, "loop");
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(7, saver.get(thread("t-1")).step(),
                "a second run on the same thread continues the numbering rather than restarting it");
    }

    // -- addressing: the returned config names the stored checkpoint --------- //

    @Test
    void theReturnedConfigAddressesTheStoredCheckpoint() {
        CheckpointSaver saver = new InMemorySaver();
        RunConfig first = saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        saver.put(thread("t-1"), Map.of("turn", 2), List.of());

        Object checkpointId = first.configurable().get("checkpoint_id");
        assertNotNull(checkpointId, "an unaddressable checkpoint could never be read back");
        assertEquals(Map.of("turn", 1), saver.get(first).values(),
                "the pin must reach the first checkpoint although a newer one exists");
    }

    @Test
    void twoCheckpointsNeverShareAnId() {
        CheckpointSaver saver = new InMemorySaver();
        RunConfig first = saver.put(thread("t-1"), Map.of(), List.of());
        RunConfig second = saver.put(thread("t-1"), Map.of(), List.of());

        assertNotEquals(first.configurable().get("checkpoint_id"),
                second.configurable().get("checkpoint_id"));
    }

    @Test
    void anUnknownCheckpointIdIsAnUnknownThread() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("real", true), List.of());

        RunConfig bogus = RunConfig.defaults().withConfigurable(
                Map.of("thread_id", "t-1", "checkpoint_id", "no-such-checkpoint"));
        assertTrue(saver.get(bogus).values().isEmpty(),
                "a pin nobody wrote answers like a thread nobody wrote");
    }

    @Test
    void aConfigWithoutAThreadIdIsACallerBug() {
        CheckpointSaver saver = new InMemorySaver();
        IllegalArgumentException refusal = assertThrows(IllegalArgumentException.class,
                () -> saver.put(RunConfig.defaults(), Map.of(), List.of()));
        assertTrue(refusal.getMessage().contains("thread_id"), refusal.getMessage());

        assertThrows(IllegalArgumentException.class, () -> saver.get(RunConfig.defaults()));
        assertThrows(IllegalArgumentException.class,
                () -> saver.list(RunConfig.defaults()).count());
    }

    // -- metadata and the parent chain --------------------------------------- //

    @Test
    void metadataCarriesTheThreeKeysTheReferencePutsThere() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());

        Map<String, Object> metadata = saver.get(thread("t-1")).metadata();
        assertEquals("loop", metadata.get("source"));
        assertEquals(0, metadata.get("step"));
        assertEquals(Map.of(), metadata.get("parents"));
    }

    @Test
    void metadataStepIsTheSnapshotStep() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());
        saver.put(thread("t-1"), Map.of(), List.of());

        StateSnapshot snapshot = saver.get(thread("t-1"));
        assertEquals(snapshot.step(), snapshot.metadata().get("step"),
                "a reader may use either and must not meet two numbers");
    }

    @Test
    void theSourceOfACheckpointCanBeDeclared() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of(), null, "input");

        assertEquals("input", saver.get(thread("t-1")).metadata().get("source"));
    }

    @Test
    void parentConfigPointsAtThePreviousCheckpointOfTheThread() {
        CheckpointSaver saver = new InMemorySaver();
        RunConfig first = saver.put(thread("t-1"), Map.of(), List.of());
        saver.put(thread("t-1"), Map.of(), List.of());

        StateSnapshot newest = saver.get(thread("t-1"));
        assertEquals(first.configurable().get("checkpoint_id"),
                newest.parentConfig().configurable().get("checkpoint_id"),
                "the parent link is what turns a list into a chain");

        RunConfig oldestParent = saver.list(thread("t-1")).reduce((a, b) -> b).orElseThrow()
                .parentConfig();
        assertNull(oldestParent, "the first checkpoint of a thread has nothing before it");
    }

    // -- what the copy protects ---------------------------------------------- //

    @Test
    void storedValuesDoNotAliasTheCallerMap() {
        CheckpointSaver saver = new InMemorySaver();
        Map<String, Object> live = new HashMap<>();
        live.put("question", "why");
        saver.put(thread("t-1"), live, List.of());

        live.put("question", "rewritten");
        assertEquals("why", saver.get(thread("t-1")).values().get("question"),
                "the runtime is still running on the mapping it handed over");
    }

    @Test
    void aSnapshotIsNotRewrittenByALaterInPlaceAppend() {
        CheckpointSaver saver = new InMemorySaver();
        List<Object> docs = new ArrayList<>(List.of("chunk-1"));
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("docs", docs);
        saver.put(thread("t-1"), state, List.of());

        docs.add("chunk-2-added-later");
        assertEquals(List.of("chunk-1"), saver.get(thread("t-1")).values().get("docs"),
                "a node appending at superstep 2 must not rewrite what superstep 1 filed");
    }

    @Test
    void theProtectionReachesAllTheWayDown() {
        CheckpointSaver saver = new InMemorySaver();
        List<Object> inner = new ArrayList<>(List.of("kept"));
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("inner", inner);
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("outer", new ArrayList<>(List.of(nested)));
        saver.put(thread("t-1"), state, List.of());

        inner.add("smuggled");
        nested.put("also", "smuggled");

        @SuppressWarnings("unchecked")
        Map<String, Object> storedNested = (Map<String, Object>)
                ((List<Object>) saver.get(thread("t-1")).values().get("outer")).get(0);
        assertEquals(Map.of("inner", List.of("kept")), storedNested,
                "a shallow copy protects the mapping and nothing inside it");
    }

    @Test
    void twoReadsOfOneCheckpointHandOutIndependentContainers() {
        CheckpointSaver saver = new InMemorySaver();
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("docs", new ArrayList<>(List.of("chunk")));
        saver.put(thread("t-1"), state, List.of());

        StateSnapshot first = saver.get(thread("t-1"));
        ((List<Object>) first.values().get("docs")).add("edited-by-first-reader");

        assertEquals(List.of("chunk"), saver.get(thread("t-1")).values().get("docs"),
                "a reader merging into its snapshot must not be writing into the store");
    }

    // -- what the copy shares ------------------------------------------------ //

    @Test
    void oneObjectReachedFromTwoChannelsStaysOneObject() {
        CheckpointSaver saver = new InMemorySaver();
        List<Object> shared = new ArrayList<>(List.of("both"));
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("a", shared);
        state.put("b", shared);
        saver.put(thread("t-1"), state, List.of());

        StateSnapshot snapshot = saver.get(thread("t-1"));
        assertSame(snapshot.values().get("a"), snapshot.values().get("b"),
                "the copy preserves aliasing rather than silently doubling the value");
    }

    @Test
    void aSelfReferentialStateDoesNotRecurseForever() {
        CheckpointSaver saver = new InMemorySaver();
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("self", state);
        saver.put(thread("t-1"), state, List.of());

        Map<String, Object> stored = saver.get(thread("t-1")).values();
        assertSame(stored, stored.get("self"),
                "the cycle must survive the copy pointing at the COPY, not at the original");
    }

    @Test
    void aPojoLeafIsSharedNotCopied() {
        // The documented divergence from python: deepcopy there duplicates any
        // object, Java has no universal deep copy, so the spine walk shares
        // everything that is not a container. A mutable object a node keeps a
        // handle on therefore stays reachable — the advice is the same as the
        // python edition gives for uncopyable values: keep live handles out of
        // graph state.
        CheckpointSaver saver = new InMemorySaver();
        StringBuilder leaf = new StringBuilder("mutable");
        saver.put(thread("t-1"), Map.of("leaf", leaf), List.of());

        assertSame(leaf, saver.get(thread("t-1")).values().get("leaf"));
    }

    // -- history -------------------------------------------------------------- //

    @Test
    void historyIsNewestFirst() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        saver.put(thread("t-1"), Map.of("turn", 2), List.of());
        saver.put(thread("t-1"), Map.of("turn", 3), List.of());

        List<Object> turns = saver.list(thread("t-1")).map(s -> s.values().get("turn")).toList();
        assertEquals(List.of(3, 2, 1), turns,
                "the caller collects until it has enough and then reverses; oldest first would "
                        + "keep the opening turns and drop the ones the user is looking at");
    }

    @Test
    void historyOfAnUnknownThreadIsEmpty() {
        CheckpointSaver saver = new InMemorySaver();
        assertEquals(0, saver.list(thread("nobody")).count());
    }

    @Test
    void historyLimitKeepsTheNewest() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        saver.put(thread("t-1"), Map.of("turn", 2), List.of());
        saver.put(thread("t-1"), Map.of("turn", 3), List.of());

        List<Object> turns = saver.list(thread("t-1"), null, null, 2)
                .map(s -> s.values().get("turn")).toList();
        assertEquals(List.of(3, 2), turns);
    }

    @Test
    void aLimitOfZeroOrLessYieldsNothing() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(0, saver.list(thread("t-1"), null, null, 0).count());
        assertEquals(0, saver.list(thread("t-1"), null, null, -3).count(),
                "the number arrives from a query parameter and cannot be assumed sane");
    }

    @Test
    void aThreadLessConfigIsStillACallerBugWhenTheLimitIsZero() {
        CheckpointSaver saver = new InMemorySaver();
        assertThrows(IllegalArgumentException.class,
                () -> saver.list(RunConfig.defaults(), null, null, 0).count(),
                "a thread-less config is a caller bug whether or not the caller asked for nothing");
    }

    @Test
    void aLimitBeyondTheHistoryReturnsAllOfIt() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(2, saver.list(thread("t-1"), null, null, 50).count());
    }

    @Test
    void beforeYieldsOnlyTheCheckpointsOlderThanTheOneNamed() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        RunConfig second = saver.put(thread("t-1"), Map.of("turn", 2), List.of());
        saver.put(thread("t-1"), Map.of("turn", 3), List.of());

        List<Object> turns = saver.list(thread("t-1"), null, second, null)
                .map(s -> s.values().get("turn")).toList();
        assertEquals(List.of(1), turns, "before cuts the thread short of the one it names");
    }

    @Test
    void beforeWithoutACheckpointIdNarrowsNothing() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(2, saver.list(thread("t-1"), null, thread("t-1"), null).count());
    }

    @Test
    void beforeACheckpointThisThreadNeverHadYieldsNothing() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());

        RunConfig foreign = RunConfig.defaults().withConfigurable(
                Map.of("thread_id", "t-1", "checkpoint_id", "from-another-thread"));
        assertEquals(0, saver.list(thread("t-1"), null, foreign, null).count());
    }

    @Test
    void beforeCombinesWithLimit() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        saver.put(thread("t-1"), Map.of("turn", 2), List.of());
        RunConfig third = saver.put(thread("t-1"), Map.of("turn", 3), List.of());

        List<Object> turns = saver.list(thread("t-1"), null, third, 1)
                .map(s -> s.values().get("turn")).toList();
        assertEquals(List.of(2), turns, "narrow first, then keep the newest of what is left");
    }

    @Test
    void filterMatchesEveryPairAgainstTheMetadata() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of(), null, "input");
        saver.put(thread("t-1"), Map.of("turn", 2), List.of(), null, "loop");

        List<Object> turns = saver.list(thread("t-1"), Map.of("source", "input"), null, null)
                .map(s -> s.values().get("turn")).toList();
        assertEquals(List.of(1), turns);
    }

    @Test
    void anUnknownFilterKeyMatchesNothing() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(0, saver.list(thread("t-1"), Map.of("no_such_key", "x"), null, null).count());
    }

    @Test
    void anEmptyFilterNarrowsNothing() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of(), List.of());

        assertEquals(1, saver.list(thread("t-1"), Map.of(), null, null).count());
    }

    @Test
    void aPinnedCheckpointIdNarrowsTheHistoryToThatOne() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        RunConfig second = saver.put(thread("t-1"), Map.of("turn", 2), List.of());
        saver.put(thread("t-1"), Map.of("turn", 3), List.of());

        List<Object> turns = saver.list(second).map(s -> s.values().get("turn")).toList();
        assertEquals(List.of(2), turns);
    }

    @Test
    void historySnapshotsDoNotShareContainersWithEachOther() {
        CheckpointSaver saver = new InMemorySaver();
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("docs", new ArrayList<>(List.of("chunk")));
        saver.put(thread("t-1"), state, List.of());
        saver.put(thread("t-1"), state, List.of());

        List<StateSnapshot> history = saver.list(thread("t-1")).toList();
        assertNotSame(history.get(0).values().get("docs"), history.get(1).values().get("docs"));
    }

    @Test
    void historyIterationSeesAStableSnapshotOfTheThread() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("t-1"), Map.of("turn", 1), List.of());
        saver.put(thread("t-1"), Map.of("turn", 2), List.of());

        Stream<StateSnapshot> history = saver.list(thread("t-1"));
        saver.put(thread("t-1"), Map.of("turn", 3), List.of());

        assertEquals(2, history.count(),
                "a checkpoint landing mid-iteration must not extend a loop that is finishing");
    }

    // -- isolation and concurrency ------------------------------------------- //

    @Test
    void twoThreadsNeverSeeEachOther() {
        CheckpointSaver saver = new InMemorySaver();
        saver.put(thread("mine"), Map.of("secret", "a"), List.of());
        saver.put(thread("yours"), Map.of("secret", "b"), List.of());

        assertEquals("a", saver.get(thread("mine")).values().get("secret"));
        assertEquals("b", saver.get(thread("yours")).values().get("secret"));
        assertEquals(1, saver.list(thread("mine")).count());
    }

    @Test
    void threadsWritingOneThreadIdAtOnceProduceAnUnbrokenStepSeries() throws Exception {
        CheckpointSaver saver = new InMemorySaver();
        int writers = 8;
        int perWriter = 25;
        ExecutorService pool = Executors.newFixedThreadPool(writers);
        CountDownLatch go = new CountDownLatch(1);
        try {
            for (int i = 0; i < writers; i++) {
                pool.submit(() -> {
                    go.await();
                    for (int j = 0; j < perWriter; j++) {
                        saver.put(thread("shared"), Map.of(), List.of());
                    }
                    return null;
                });
            }
            go.countDown();
            pool.shutdown();
            assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }

        List<Integer> steps = saver.list(thread("shared")).map(StateSnapshot::step).toList();
        List<Integer> expected = new ArrayList<>();
        for (int i = writers * perWriter - 1; i >= 0; i--) {
            expected.add(i);
        }
        assertEquals(expected, steps, "a torn series would mean the step was read outside the lock");
    }
}
