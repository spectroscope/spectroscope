package dev.spectroscope.core.graph;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One checkpoint: the state, and enough context to say where it sat.
 *
 * <p>The field list is the python edition's, in its order, minus one:
 * {@code interrupts} is not carried, because {@code interrupt()} does not exist
 * in either edition and a Java caller cannot write a defensive
 * {@code if (snapshot.interrupts())} against a field that is absent — the probe
 * that justified the python placeholder does not compile here, so the field
 * would be pure invention.</p>
 *
 * <p>{@code values} is deliberately handed out mutable: the measured caller
 * merges its next turn INTO the snapshot it read, and every read hands out a
 * fresh detached copy, so writing into one never reaches the store. The other
 * fields exist because a run you can watch needs them: {@link #next} says what
 * would have run, {@link #createdAt} puts the checkpoints on a clock,
 * {@link #config} addresses this exact one so it can be asked for again, and
 * {@link #parentConfig} addresses the one before it, which is what turns a list
 * into a chain.</p>
 *
 * @param values       the channels as they stood at this checkpoint; mutable,
 *                     caller-owned, detached from the store
 * @param next         the frontier that would have run next, immutable
 * @param config       the addressing of this checkpoint —
 *                     {@code configurable.{thread_id, checkpoint_id}}
 * @param metadata     {@code {source, step, parents}}, or {@code null} on the
 *                     empty snapshot of a thread nobody has written
 * @param createdAt    an ISO-8601 UTC instant, or {@code null} on the empty
 *                     snapshot
 * @param parentConfig the addressing of the previous checkpoint of the thread,
 *                     or {@code null} on the first one
 * @param step         this checkpoint's number in the THREAD's series — not the
 *                     run's superstep index; {@code -1} means "before the first
 *                     superstep", which is exactly what an unknown thread is
 */
public record StateSnapshot(
        Map<String, Object> values,
        List<String> next,
        RunConfig config,
        Map<String, Object> metadata,
        String createdAt,
        RunConfig parentConfig,
        int step) {

    public StateSnapshot {
        values = values == null ? new LinkedHashMap<>() : values;
        next = next == null ? List.of() : List.copyOf(next);
    }

    /**
     * The snapshot of a thread nobody has written: no values, no metadata, no
     * parent, step {@code -1} — echoing the config that was asked about, so the
     * caller can see which question this is the empty answer to.
     */
    public static StateSnapshot empty(RunConfig config) {
        return new StateSnapshot(new LinkedHashMap<>(), List.of(), config, null, null, null, -1);
    }
}
