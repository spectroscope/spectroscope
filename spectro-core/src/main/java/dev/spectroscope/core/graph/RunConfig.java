package dev.spectroscope.core.graph;

import java.util.Map;

/**
 * What a run is started with: the ceiling on supersteps and the caller's own
 * addressing map.
 *
 * <p>Mirrors the wire shape the other edition's callers already write,
 * {@code {"recursion_limit": N, "configurable": {"thread_id": "..."}}}. Thread
 * identity is {@code configurable.thread_id} and nothing else identifies a
 * thread.</p>
 *
 * <p>An impossible ceiling is refused HERE, at construction, rather than at the
 * top of the loop. A run that was refused never began, so nothing downstream may
 * carry the beginning of one — and refusing at the seam where the number was
 * written is earlier than refusing where it is read.</p>
 *
 * @param recursionLimit the superstep ceiling, or {@code null} for
 *                       {@link CompiledGraph#DEFAULT_RECURSION_LIMIT}
 * @param configurable   the caller's addressing map; never {@code null} after
 *                       construction
 */
public record RunConfig(Integer recursionLimit, Map<String, Object> configurable) {

    public RunConfig {
        if (recursionLimit != null && recursionLimit < 1) {
            throw new IllegalArgumentException(
                    "recursion_limit must be at least 1; got " + recursionLimit);
        }
        configurable = configurable == null ? Map.of() : Map.copyOf(configurable);
    }

    /** No ceiling of its own, nothing to address by. */
    public static RunConfig defaults() {
        return new RunConfig(null, Map.of());
    }

    /**
     * @param limit the superstep ceiling
     * @return a copy carrying it
     * @throws IllegalArgumentException when the limit is below 1
     */
    public RunConfig withRecursionLimit(int limit) {
        return new RunConfig(limit, configurable);
    }

    /**
     * @param configurable the addressing map, {@code thread_id} included
     * @return a copy carrying it
     */
    public RunConfig withConfigurable(Map<String, Object> configurable) {
        return new RunConfig(recursionLimit, configurable);
    }

    /** The ceiling this run actually runs under. */
    public int resolvedRecursionLimit() {
        return recursionLimit == null ? CompiledGraph.DEFAULT_RECURSION_LIMIT : recursionLimit;
    }
}
