package dev.spectroscope.core.graph;

import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * The seam a persistent saver plugs into — three methods, and the shapes matter
 * as much as the names.
 *
 * <p>A thread is a conversation. Every superstep hands the saver the state as it
 * stood at the end of that step, and the thread keeps the whole series. That is
 * what turns a graph run from a function call into something with a past: a
 * second run on the same {@code thread_id} starts from where the first one
 * stopped, and the history is what a viewer replays.</p>
 *
 * <p>Two properties were measured against the real caller rather than chosen.
 * <strong>History comes back newest first</strong>: the caller collects turns
 * until it has enough, then reverses — oldest first would keep the OPENING turns
 * of a long conversation and drop the ones the user is looking at, without
 * raising anything. <strong>An unknown thread is not an error</strong>:
 * {@link #get} on a thread nobody has written returns an empty snapshot, because
 * "no history" is the normal state of a first message. A config that names no
 * thread is the opposite — an unaddressable checkpoint could never be read back,
 * so it is refused as the caller bug it is.</p>
 *
 * <p>A SQLite or Postgres saver implements these three and nothing else changes:
 * the runtime holds the seam, never the implementation.</p>
 */
public interface CheckpointSaver {

    /**
     * Appends a checkpoint to the thread and returns a config that addresses it.
     *
     * <p>An implementation MUST detach the values it stores from the mapping it
     * was handed; the runtime is still running on that mapping.</p>
     *
     * @param config the addressing map; {@code configurable.thread_id} required
     * @param values the state as it stands, still owned by the runtime
     * @param next   the frontier that will run next
     * @param step   this checkpoint's number in the thread's series, or
     *               {@code null} for one past the thread's last — so a caller
     *               that does not count gets a coherent series anyway
     * @param source what wrote this checkpoint; every checkpoint the runtime
     *               writes today is a {@code "loop"} one
     * @return a copy of {@code config} whose {@code configurable} additionally
     *         carries the {@code checkpoint_id} of the stored checkpoint
     * @throws IllegalArgumentException when the config names no thread
     */
    RunConfig put(RunConfig config, Map<String, ?> values, List<String> next, Integer step,
                  String source);

    /** {@link #put(RunConfig, Map, List, Integer, String)} with the defaults the runtime uses. */
    default RunConfig put(RunConfig config, Map<String, ?> values, List<String> next) {
        return put(config, values, next, null, "loop");
    }

    /**
     * The thread's newest checkpoint, or the one pinned by
     * {@code configurable.checkpoint_id}, or an empty snapshot.
     *
     * <p>What comes back is detached from the store: the measured caller merges
     * its next turn into the snapshot it read, and a shared container would mean
     * turn two's nodes writing into turn one's history.</p>
     *
     * @param config the addressing map; {@code configurable.thread_id} required
     * @return the snapshot; never {@code null}
     * @throws IllegalArgumentException when the config names no thread
     */
    StateSnapshot get(RunConfig config);

    /**
     * The thread's checkpoints, newest first, narrowed by three parameters.
     *
     * <p>{@code limit} has to bound the WORK, not just the answer: the expensive
     * part of a snapshot is detaching its values, so an implementation detaches
     * one element at a time and stops the moment the stream has enough. A limit
     * of zero or less yields nothing at all — the number arrives from a query
     * parameter and cannot be assumed sane. The config is still validated first;
     * a thread-less config is a caller bug whether or not the caller then asked
     * for nothing.</p>
     *
     * @param config the addressing map; a {@code checkpoint_id} in it pins the
     *               answer to that one checkpoint
     * @param filter matched against {@code metadata} pair by pair; an unknown
     *               key matches nothing, an empty or {@code null} filter
     *               narrows nothing
     * @param before only checkpoints strictly older than the one this config's
     *               {@code checkpoint_id} names; {@code null} — or a config
     *               without a {@code checkpoint_id} — narrows nothing
     * @param limit  at most this many, or {@code null} for all of them
     * @return the snapshots, newest first, each detached from the store
     * @throws IllegalArgumentException when the config names no thread
     */
    Stream<StateSnapshot> list(RunConfig config, Map<String, Object> filter, RunConfig before,
                               Integer limit);

    /** The whole history, newest first. */
    default Stream<StateSnapshot> list(RunConfig config) {
        return list(config, null, null, null);
    }
}
