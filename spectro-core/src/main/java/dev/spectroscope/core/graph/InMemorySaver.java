package dev.spectroscope.core.graph;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.IntStream;
import java.util.stream.Stream;

/**
 * Thread memory for the lifetime of the process.
 *
 * <p>The store outlives the graph on purpose. A running application rebuilds its
 * graph when configuration changes and hands the same saver to the new one; if
 * the history lived on the compiled graph, every open conversation would lose
 * its past at that moment. Nothing here refers back to a graph.</p>
 *
 * <p>Growth is unbounded, matching the reference implementation: a long-running
 * server accumulates one entry per superstep per thread until it restarts. That
 * is the honest price of an in-memory saver and the reason the
 * {@link CheckpointSaver} seam exists.</p>
 *
 * <h2>The past does not change</h2>
 *
 * <p>A checkpoint is only worth taking if it still says the same thing later.
 * The runtime hands over the state it is still running on, so a node appending
 * to a list at superstep 2 is holding the very list superstep 1 filed away. The
 * python edition deep-copies everything against that; Java has no universal deep
 * copy, so this saver copies the container SPINE — maps, lists, sets and object
 * arrays, recursively, aliasing and cycles preserved — and shares every other
 * reference. Immutable leaves (strings, numbers, booleans) cost nothing shared;
 * a MUTABLE object a node keeps a handle on stays reachable, which is the same
 * boundary the engine itself draws ({@link Channel#appending} folds into fresh
 * unmodifiable lists for exactly this reason). The advice matches the python
 * edition's for uncopyable values: keep live handles out of graph state and pass
 * them through {@link RunConfig#configurable()} instead.</p>
 *
 * <p>The copy runs OUTSIDE the lock in both directions. It is the slow part and
 * it touches nothing shared, so holding the lock across it would stall every
 * other thread on this saver for the length of a corpus copy.</p>
 */
public final class InMemorySaver implements CheckpointSaver {

    private final Map<String, List<StateSnapshot>> threads = new HashMap<>();
    private final Object lock = new Object();

    @Override
    public RunConfig put(RunConfig config, Map<String, ?> values, List<String> next, Integer step,
                         String source) {
        String threadId = threadIdOf(config);
        String checkpointId = UUID.randomUUID().toString().replace("-", "");
        LinkedHashMap<String, Object> configurable = new LinkedHashMap<>(config.configurable());
        configurable.put("thread_id", threadId);
        configurable.put("checkpoint_id", checkpointId);
        RunConfig stored = new RunConfig(config.recursionLimit(), configurable);

        Map<String, Object> detached = detached(values);
        String createdAt = Instant.now().toString();

        synchronized (lock) {
            List<StateSnapshot> history = threads.computeIfAbsent(threadId,
                    key -> new ArrayList<>());
            int resolved = step != null ? step
                    : history.isEmpty() ? 0 : history.get(history.size() - 1).step() + 1;
            LinkedHashMap<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("source", source);
            metadata.put("step", resolved);
            metadata.put("parents", Map.of());
            history.add(new StateSnapshot(detached, next, stored, metadata, createdAt,
                    history.isEmpty() ? null : history.get(history.size() - 1).config(),
                    resolved));
        }
        return stored;
    }

    @Override
    public StateSnapshot get(RunConfig config) {
        String threadId = threadIdOf(config);
        String pinned = checkpointIdOf(config);
        List<StateSnapshot> history = copyOfHistory(threadId);

        if (pinned != null) {
            for (int index = history.size() - 1; index >= 0; index--) {
                StateSnapshot snapshot = history.get(index);
                if (pinned.equals(checkpointIdOf(snapshot.config()))) {
                    return handedOut(snapshot);
                }
            }
            return StateSnapshot.empty(config);
        }
        return history.isEmpty() ? StateSnapshot.empty(config)
                : handedOut(history.get(history.size() - 1));
    }

    @Override
    public Stream<StateSnapshot> list(RunConfig config, Map<String, Object> filter,
                                      RunConfig before, Integer limit) {
        // The config is validated FIRST — a thread-less config is a caller bug
        // whether or not the caller then asked for nothing.
        String threadId = threadIdOf(config);
        if (limit != null && limit <= 0) {
            return Stream.empty();
        }
        String pinned = checkpointIdOf(config);
        String cutoff = checkpointIdOf(before);
        List<StateSnapshot> history = copyOfHistory(threadId);

        if (cutoff != null) {
            int index = indexOf(history, cutoff);
            history = index >= 0 ? history.subList(0, index) : List.of();
        }
        if (pinned != null) {
            int index = indexOf(history, pinned);
            history = index >= 0 ? List.of(history.get(index)) : List.of();
        }

        // Newest first, narrowed on the stored references, detached one element
        // at a time — so a limit bounds the copying work, not just the answer.
        List<StateSnapshot> narrowed = history;
        Stream<StateSnapshot> newestFirst = IntStream.rangeClosed(1, narrowed.size())
                .mapToObj(fromEnd -> narrowed.get(narrowed.size() - fromEnd));
        if (filter != null && !filter.isEmpty()) {
            newestFirst = newestFirst.filter(snapshot -> matches(snapshot.metadata(), filter));
        }
        if (limit != null) {
            newestFirst = newestFirst.limit(limit);
        }
        return newestFirst.map(InMemorySaver::handedOut);
    }

    /**
     * The list of references, taken once, under the lock. Iterating the live
     * list instead would let a concurrent write keep extending a loop that is
     * trying to finish.
     */
    private List<StateSnapshot> copyOfHistory(String threadId) {
        synchronized (lock) {
            return new ArrayList<>(threads.getOrDefault(threadId, List.of()));
        }
    }

    /**
     * Reads {@code configurable.thread_id}, or refuses. A checkpoint without a
     * thread is unaddressable — it could never be read back. Guessing a default
     * would put every caller's state in one shared bucket.
     */
    private static String threadIdOf(RunConfig config) {
        Object named = config == null ? null : config.configurable().get("thread_id");
        String threadId = named == null ? null : String.valueOf(named);
        if (threadId == null || threadId.isEmpty()) {
            throw new IllegalArgumentException("This checkpointer requires a thread id: pass a "
                    + "RunConfig whose configurable map carries thread_id.");
        }
        return threadId;
    }

    /** The optional pin to one specific checkpoint rather than the newest. */
    private static String checkpointIdOf(RunConfig config) {
        Object named = config == null ? null : config.configurable().get("checkpoint_id");
        String checkpointId = named == null ? null : String.valueOf(named);
        return checkpointId == null || checkpointId.isEmpty() ? null : checkpointId;
    }

    private static int indexOf(List<StateSnapshot> history, String checkpointId) {
        for (int index = 0; index < history.size(); index++) {
            if (checkpointId.equals(checkpointIdOf(history.get(index).config()))) {
                return index;
            }
        }
        return -1;
    }

    private static boolean matches(Map<String, Object> metadata, Map<String, Object> filter) {
        for (Map.Entry<String, Object> pair : filter.entrySet()) {
            Object present = metadata == null ? null : metadata.get(pair.getKey());
            if (present == null ? pair.getValue() != null : !present.equals(pair.getValue())) {
                return false;
            }
        }
        return true;
    }

    /**
     * The stored checkpoint, with every container in it copied out — a reader
     * merging into its snapshot must not be writing into the store. Metadata
     * gets the same treatment for one line's worth of work: leaving it shared
     * would let a caller edit the store through {@code snapshot.metadata()}.
     */
    private static StateSnapshot handedOut(StateSnapshot snapshot) {
        return new StateSnapshot(detached(snapshot.values()),
                snapshot.next(), snapshot.config(), detached(snapshot.metadata()),
                snapshot.createdAt(), snapshot.parentConfig(), snapshot.step());
    }

    /** A copy of the state whose container spine no later writer can reach. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> detached(Map<String, ?> values) {
        if (values == null) {
            return null;
        }
        return (Map<String, Object>) copy(values, new IdentityHashMap<>());
    }

    /**
     * The spine walk: containers copied, aliasing and cycles preserved through
     * the memo — one object reached from two channels must stay one object, and
     * a self-referential state must come back pointing at the COPY.
     */
    private static Object copy(Object value, IdentityHashMap<Object, Object> memo) {
        if (value instanceof Map<?, ?> map) {
            Object already = memo.get(value);
            if (already != null) {
                return already;
            }
            LinkedHashMap<Object, Object> fresh = new LinkedHashMap<>();
            memo.put(value, fresh);
            map.forEach((key, entry) -> fresh.put(key, copy(entry, memo)));
            return fresh;
        }
        if (value instanceof List<?> list) {
            Object already = memo.get(value);
            if (already != null) {
                return already;
            }
            ArrayList<Object> fresh = new ArrayList<>(list.size());
            memo.put(value, fresh);
            for (Object entry : list) {
                fresh.add(copy(entry, memo));
            }
            return fresh;
        }
        if (value instanceof Set<?> set) {
            Object already = memo.get(value);
            if (already != null) {
                return already;
            }
            LinkedHashSet<Object> fresh = new LinkedHashSet<>();
            memo.put(value, fresh);
            for (Object entry : set) {
                fresh.add(copy(entry, memo));
            }
            return fresh;
        }
        if (value instanceof Object[] array) {
            Object already = memo.get(value);
            if (already != null) {
                return already;
            }
            Object[] fresh = new Object[array.length];
            memo.put(value, fresh);
            for (int index = 0; index < array.length; index++) {
                fresh[index] = copy(array[index], memo);
            }
            return fresh;
        }
        return value;
    }
}
