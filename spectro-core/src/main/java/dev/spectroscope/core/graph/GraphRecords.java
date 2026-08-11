package dev.spectroscope.core.graph;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The seven lifecycle records of {@code .graph.jsonl}: the drawing, and the light
 * that walks it.
 *
 * <p>One vocabulary, declared once. The runtime builds its records HERE and
 * nowhere else, so a viewer meets exactly one dialect however a line was
 * produced: {@code superstep} rather than step, {@code updateKeys} plus
 * {@code updateBytes} rather than channels, and the exception CLASS kept apart
 * from its message. A second builder somewhere in the runtime would drift, and
 * the records would stop agreeing with the picture they are meant to light up.</p>
 *
 * <p>None of these records may carry a caller's values. {@code node_end} is handed
 * the raw update and records only its SHAPE — which channels, and how many bytes
 * they came to — because a call site that has to remember to strip the values
 * will one day forget, and the forgetting is silent. Values live in
 * {@link StateRecords}, in a different file, behind an explicit policy.</p>
 */
public final class GraphRecords {

    /**
     * How much of a failure message is a diagnostic. Beyond this it is payload
     * wearing a diagnostic's coat — a message built by interpolating a retrieved
     * document is the measured shape, and this file is the one people attach to
     * bug reports.
     */
    static final int MESSAGE_LIMIT = 1000;

    private GraphRecords() {
    }

    /**
     * The drawing, wrapped and never reinterpreted.
     *
     * <p>The topology owns its own keys, {@code schema_version} included — the one
     * snake_case field in a camelCase dialect. This wrapper adds the envelope and
     * touches nothing inside, so a reader that knows the topology knows this
     * record. It carries NO {@code runId}: a drawing belongs to the graph, not to
     * one walk of it.</p>
     *
     * @param topology the compiled drawing
     * @param ts       epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record, {@code type} first and {@code ts} last
     */
    public static Map<String, Object> graphTopology(Topology topology, Long ts) {
        LinkedHashMap<String, Object> record = envelope("graph_topology");
        record.putAll(GraphJson.asMap(topology));
        return sealed(record, ts);
    }

    /**
     * @param runId    the run every record below this line belongs to
     * @param threadId the conversation, present only when a checkpointer is
     *                 configured and omitted entirely otherwise
     * @param ts       epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record
     */
    public static Map<String, Object> graphStart(String runId, String threadId, Long ts) {
        LinkedHashMap<String, Object> record = envelope("graph_start");
        put(record, "runId", runId);
        put(record, "threadId", threadId);
        return sealed(record, ts);
    }

    /**
     * @param runId     the run
     * @param node      the node entering
     * @param superstep the frontier it runs in, 0-based within THIS run
     * @param ts        epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record
     */
    public static Map<String, Object> nodeStart(String runId, String node, int superstep, Long ts) {
        LinkedHashMap<String, Object> record = envelope("node_start");
        put(record, "runId", runId);
        record.put("node", node);
        record.put("superstep", superstep);
        return sealed(record, ts);
    }

    /**
     * What a node finished having written — its shape, never its values.
     *
     * <p>{@code updateKeys} and {@code updateBytes} are ALWAYS present, as
     * {@code []} and {@code 0} for a node that wrote nothing. That pair is the
     * sentence "this node finished and wrote no channel", which is a different
     * fact from a missing payload line, so no emptiness rule may suppress it.
     * The keys stay in the node's OWN write order; sorting them would be a small
     * lie about what the node did.</p>
     *
     * @param runId      the run
     * @param node       the node that finished
     * @param superstep  the frontier it ran in
     * @param durationMs how long it took, measured on a monotonic clock
     * @param update     its own write, or {@code null} for none
     * @param ts         epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record
     */
    public static Map<String, Object> nodeEnd(String runId, String node, int superstep,
                                              long durationMs, Map<String, ?> update, Long ts) {
        LinkedHashMap<String, Object> record = envelope("node_end");
        put(record, "runId", runId);
        record.put("node", node);
        record.put("superstep", superstep);
        record.put("durationMs", durationMs);
        boolean wrote = update != null && !update.isEmpty();
        record.put("updateKeys", wrote ? new ArrayList<String>(update.keySet()) : List.of());
        // The TRUE size of the whole update, and it stays true even when an L2
        // payload holds a clipped view of the same write — that is what lets the
        // two files cross-check each other. Measuring may never take a run down,
        // so utf8Bytes falls back rather than throwing.
        record.put("updateBytes", wrote ? GraphJson.utf8Bytes(update) : 0);
        return sealed(record, ts);
    }

    /**
     * A node that did not finish.
     *
     * <p>The class and the message are two fields and never one fused
     * {@code "Type: message"} string: a viewer groups by class, and a fused
     * string forces it to parse. A cancelled node is recorded here too — a
     * {@code node_start} with no ending is indistinguishable from a viewer that
     * lost a line.</p>
     *
     * @param runId      the run
     * @param node       the node that failed
     * @param superstep  the frontier it ran in
     * @param error      the exception, or a plain string for a caller-made failure
     * @param durationMs how long it ran before failing, or {@code null}
     * @param ts         epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record
     */
    public static Map<String, Object> nodeError(String runId, String node, int superstep,
                                                Object error, Long durationMs, Long ts) {
        LinkedHashMap<String, Object> record = envelope("node_error");
        put(record, "runId", runId);
        record.put("node", node);
        record.put("superstep", superstep);
        put(record, "durationMs", durationMs);
        record.put("error", className(error));
        record.put("message", message(error));
        return sealed(record, ts);
    }

    /**
     * One arrow the run actually walked, edges into END included.
     *
     * <p>{@code superstep} is the one the edge leads INTO, not the one it leaves,
     * so a reader walking the file sees arrows into a frontier and then that
     * frontier's nodes lighting up. {@code branch} appears only on a conditional
     * edge and names the SOURCE NODE — a decision is routinely a lambda, so its
     * own name would say nothing.</p>
     *
     * @param runId     the run
     * @param from      the source node id
     * @param to        the destination node id
     * @param branch    the branch name on a conditional edge, {@code null} otherwise
     * @param superstep the frontier this edge leads into
     * @param ts        epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record
     */
    public static Map<String, Object> edgeTaken(String runId, String from, String to, String branch,
                                                Integer superstep, Long ts) {
        LinkedHashMap<String, Object> record = envelope("edge_taken");
        put(record, "runId", runId);
        record.put("from", from);
        record.put("to", to);
        put(record, "branch", branch);
        put(record, "superstep", superstep);
        return sealed(record, ts);
    }

    /**
     * @param runId      the run
     * @param steps      the superstep count — the number a recursion limit is
     *                   measured against
     * @param durationMs the elapsed wall time, or {@code null}
     * @param ts         epoch milliseconds, or {@code null} to let the sink stamp it
     * @return the record
     */
    public static Map<String, Object> graphEnd(String runId, int steps, Long durationMs, Long ts) {
        LinkedHashMap<String, Object> record = envelope("graph_end");
        put(record, "runId", runId);
        record.put("steps", steps);
        put(record, "durationMs", durationMs);
        return sealed(record, ts);
    }

    // -- the envelope ---------------------------------------------------------- //

    private static LinkedHashMap<String, Object> envelope(String type) {
        LinkedHashMap<String, Object> record = new LinkedHashMap<>();
        record.put("type", type);
        return record;
    }

    /**
     * {@code ts} last, and left for the sink to stamp when the caller named none —
     * a caller-supplied timestamp is preserved verbatim, because the two artifact
     * files and the session file interleave by it and a re-stamp would reorder a
     * replay.
     */
    private static Map<String, Object> sealed(LinkedHashMap<String, Object> record, Long ts) {
        if (ts != null) {
            record.put("ts", ts);
        }
        return record;
    }

    /**
     * A {@code null} field is omitted ENTIRELY rather than written as null: an
     * absent key says "not applicable", which is a different statement from a
     * recorded null.
     */
    private static void put(Map<String, Object> record, String key, Object value) {
        if (value != null) {
            record.put(key, value);
        }
    }

    /** The literal {@code "Error"} for a plain string, so the field is never absent. */
    private static String className(Object error) {
        return error instanceof Throwable thrown ? thrown.getClass().getSimpleName() : "Error";
    }

    private static String message(Object error) {
        String text;
        if (error instanceof Throwable thrown) {
            // An exception with no message still has to carry SOMETHING: a null
            // message would be dropped by the omitted-null rule, and a node_error
            // with no message key reads as a record that lost a field.
            text = thrown.getMessage() == null ? thrown.getClass().getSimpleName() : thrown.getMessage();
        } else {
            text = String.valueOf(error);
        }
        if (text.codePointCount(0, text.length()) <= MESSAGE_LIMIT) {
            return text;
        }
        return text.substring(0, text.offsetByCodePoints(0, MESSAGE_LIMIT)) + "…";
    }
}
