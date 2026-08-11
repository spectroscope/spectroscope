package dev.spectroscope.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The two records that may hold a caller's values, and the only place the policy
 * is applied.
 *
 * <p>Three facts stay distinguishable across the two artifact files, and losing
 * any one of them costs a reader the ability to explain an absence: what a node
 * WROTE lives in the lifecycle file ({@code node_end.updateKeys} and
 * {@code updateBytes}), what was RECORDED lives in {@code state_payload.channels},
 * and WHY they differ lives in {@code state_policy}. Without the third, a missing
 * channel is ambiguous between "the node did not write it", "the policy denied
 * it" and "the recorder failed".</p>
 *
 * <p>The policy is applied HERE, before a record reaches any sink, so a record
 * that arrives at a sink is already safe.</p>
 */
public final class StateRecords {

    /** The vocabulary of {@code .state.jsonl}, and the words its sibling refuses. */
    static final List<String> STATE_TYPES = List.of("state_policy", "state_payload");

    private StateRecords() {
    }

    /**
     * The one record per run that explains every absence below it.
     *
     * @param policy the tier this run was started with
     * @param runId  the run, or {@code null} to leave it to the caller
     * @param ts     epoch milliseconds, or {@code null} to stamp it now
     * @return the record, {@code type} first and {@code ts} last
     */
    public static Map<String, Object> statePolicy(StatePolicy policy, String runId, Long ts) {
        LinkedHashMap<String, Object> record = new LinkedHashMap<>();
        record.put("type", "state_policy");
        put(record, "runId", runId);
        record.put("mode", policy.mode().wire());
        if (!policy.allowed().isEmpty()) {
            record.put("allowed", List.copyOf(policy.allowed()));
        }
        if (!policy.caps().isEmpty()) {
            record.put("caps", wireCaps(policy));
        }
        put(record, "recordCap", policy.recordCap());
        if (!policy.denied().isEmpty()) {
            record.put("denied", List.copyOf(policy.denied()));
        }
        record.put("redaction", policy.redaction());
        record.put("ts", ts == null ? System.currentTimeMillis() : ts);
        return record;
    }

    /**
     * What one node actually put on disk at one superstep.
     *
     * <p>Built from the node's OWN update, never the merged state, and never a
     * line with an empty {@code channels} object: "nothing was recordable" and
     * "the node wrote nothing" are different facts, and the second one is already
     * told by {@code node_end.updateKeys}.</p>
     *
     * @param node      the node that wrote
     * @param superstep the frontier it ran in
     * @param update    its own write, in its own write order
     * @param policy    the run's tier
     * @param runId     the run, or {@code null}
     * @param ts        epoch milliseconds, or {@code null} to stamp it now
     * @return the record, or {@code null} meaning "write no line"
     */
    public static Map<String, Object> statePayload(String node, int superstep, Map<String, ?> update,
                                                   StatePolicy policy, String runId, Long ts) {
        if (policy == null || !policy.enabled() || update == null || update.isEmpty()) {
            return null;
        }
        StateClipper clipper = new StateClipper(policy);
        LinkedHashMap<String, Object> channels = new LinkedHashMap<>();
        List<String> truncated = new ArrayList<>();
        update.forEach((channel, value) -> {
            if (!policy.recordsChannel(channel)) {
                return;
            }
            channels.put(channel, clipper.clip(value, policy.capFor(channel)));
            if (clipper.truncated()) {
                truncated.add(channel);
            }
        });
        if (channels.isEmpty()) {
            return null;
        }

        long stamp = ts == null ? System.currentTimeMillis() : ts;
        Map<String, Object> record = payload(node, superstep, channels, truncated, runId, stamp);
        Integer cap = policy.recordCap();
        if (cap == null || GraphJson.utf8Bytes(record) <= cap) {
            return record;
        }

        LinkedHashMap<String, Object> collapsed = new LinkedHashMap<>();
        channels.keySet().forEach(channel ->
                collapsed.put(channel, StateClipper.channelMarker(update.get(channel))));
        // Emitted WITHOUT a second check. With very many channels the collapsed
        // line can itself exceed the cap; looping until it fits would drop channel
        // names, and the names are the part that still lets a reader act.
        return payload(node, superstep, collapsed, List.copyOf(collapsed.keySet()), runId, stamp);
    }

    private static Map<String, Object> payload(String node, int superstep,
                                               Map<String, Object> channels, List<String> truncated,
                                               String runId, long ts) {
        LinkedHashMap<String, Object> record = new LinkedHashMap<>();
        record.put("type", "state_payload");
        put(record, "runId", runId);
        record.put("node", node);
        record.put("superstep", superstep);
        record.put("channels", channels);
        // OMITTED when empty, never present as []. An empty array would badge
        // every clean row as truncated in a viewer that only checks for the key.
        if (!truncated.isEmpty()) {
            record.put("truncated", List.copyOf(truncated));
        }
        record.put("ts", ts);
        return record;
    }

    private static Map<String, Object> wireCaps(StatePolicy policy) {
        LinkedHashMap<String, Object> caps = new LinkedHashMap<>();
        policy.caps().forEach((channel, cap) -> {
            if (cap instanceof StatePolicy.SampleCap sampled) {
                caps.put(channel, List.of("sample", sampled.keep(), sampled.bytes()));
            } else if (cap instanceof StatePolicy.ByteCap fixed) {
                caps.put(channel, fixed.bytes());
            }
        });
        return caps;
    }

    /**
     * A {@code null} field is omitted ENTIRELY — but only at the top level of a
     * record. A null nested inside {@code channels} survives, because "the node
     * wrote null" and "this was not recorded" are different statements.
     */
    private static void put(Map<String, Object> record, String key, Object value) {
        if (value != null) {
            record.put(key, value);
        }
    }
}
