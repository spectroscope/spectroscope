package dev.spectroscope.core.graph;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.stream.Stream;

import static dev.spectroscope.core.graph.StateGraph.END;
import static dev.spectroscope.core.graph.StateGraph.START;

/**
 * A frozen graph, ready to run and already able to describe itself.
 *
 * <p>Execution is Pregel-style. One superstep runs the ENTIRE current frontier,
 * collects every node's update, and only then applies them. A node never sees a
 * sibling's write from its own superstep — if updates were applied as they
 * arrived, a node could read a sibling's write and the run would stop being
 * reproducible. Determinism is the product: a run that cannot be replayed cannot
 * be watched.</p>
 *
 * <p>Frontier order is declaration order throughout, never a hash set's order.
 * It decides how two nodes writing the same last-write-wins channel resolve, so
 * an unordered collection anywhere in the walk would make the same graph give
 * two answers.</p>
 *
 * <p>The frontier runs its nodes one after another. The python edition runs them
 * concurrently, and every property above survives either way: what makes a
 * superstep a superstep is that no update is applied until every node has
 * returned, not that the nodes overlap in time. Concurrency here is a
 * performance question, and it is deliberately not answered yet.</p>
 *
 * <h2>Watching a run</h2>
 *
 * <p>A sink is any {@code Consumer} of a record map — that is the entire
 * protocol, so an exporter stays a function until it needs to be more. Hand one
 * to {@link StateGraph#compile(Consumer)} and the drawing is written IMMEDIATELY,
 * in this constructor, before a node has run; the run then lights it up.
 * A fan-out to both artifact files needs no class of its own, because each file
 * refuses the other's vocabulary and the refusal IS the routing:</p>
 *
 * <pre>{@code
 * try (GraphArtifact lifecycle = new GraphArtifact(stem);
 *      StateArtifact values = new StateArtifact(stem)) {
 *     graph.compile(record -> { lifecycle.accept(record); values.accept(record); },
 *                   StatePolicy.summary());
 * }
 * }</pre>
 *
 * <p>Observation may never alter the observed. Both the BUILDING of a record and
 * the writing of it sit inside an absorbing catch: a sink that throws cannot
 * abort a run and cannot replace an exception already in flight — which matters
 * because {@code graph_end} is written from a {@code finally}, so a naive
 * implementation lets a full disk arrive at the caller with the real failure
 * demoted to a cause. Records are built behind a supplier, so a run without a
 * sink pays nothing: a retrieval node's update is the whole retrieved corpus, and
 * measuring it for nobody would be a cost the caller never asked for.</p>
 */
public final class CompiledGraph {

    private static final Logger LOG = LoggerFactory.getLogger(CompiledGraph.class);

    /** How many hex characters name a run. Long enough to tell two turns apart. */
    private static final int RUN_ID_LENGTH = 12;

    /**
     * The superstep ceiling a run gets when the caller names none.
     *
     * <p>LangGraph 1.x's own number, counted rather than read: a runaway
     * single-node cycle runs exactly this many iterations there. An earlier 25
     * was a margin chosen against one caller's loop, and it is the obvious wrong
     * guess — a corrective-RAG graph configured for four rewrites legitimately
     * needs 27 supersteps, so at 25 an operator got a working system on LangGraph
     * and a recursion failure here.</p>
     */
    public static final int DEFAULT_RECURSION_LIMIT = 10007;

    /**
     * How many frontiers are kept to name a cycle in the failure message. A
     * ceiling of ten thousand must not quietly turn into ten thousand retained
     * frontiers.
     */
    private static final int RETAINED_FRONTIERS = 16;

    private final GraphSpec spec;
    private final Topology topology;
    private final Map<String, List<String>> edgesFrom = new LinkedHashMap<>();
    private final Map<String, List<NamedBranch>> branchesFrom = new LinkedHashMap<>();
    private final Consumer<Map<String, Object>> sink;
    private final StatePolicy statePolicy;
    private final CheckpointSaver checkpointer;
    private final AtomicInteger sinkFailures = new AtomicInteger();
    private final AtomicBoolean warned = new AtomicBoolean();

    /** A branch carried with the name the topology gave it. */
    private record NamedBranch(GraphSpec.Branch branch, String name) {
    }

    CompiledGraph(GraphSpec spec) {
        this(spec, null, null, null);
    }

    CompiledGraph(GraphSpec spec, Consumer<Map<String, Object>> sink, StatePolicy statePolicy) {
        this(spec, sink, statePolicy, null);
    }

    CompiledGraph(GraphSpec spec, Consumer<Map<String, Object>> sink, StatePolicy statePolicy,
                  CheckpointSaver checkpointer) {
        this.spec = spec;
        this.topology = Topology.of(spec);
        this.sink = sink;
        this.statePolicy = statePolicy;
        this.checkpointer = checkpointer;
        for (GraphSpec.Edge edge : spec.edges()) {
            edgesFrom.computeIfAbsent(edge.from(), key -> new ArrayList<>()).add(edge.to());
        }
        // The branch names are read back OUT of the topology rather than
        // recomputed: one naming algorithm, in the module that owns the drawing.
        // A second implementation would drift, and then the records would stop
        // agreeing with the picture they are supposed to light up.
        for (int index = 0; index < spec.branches().size(); index++) {
            GraphSpec.Branch branch = spec.branches().get(index);
            String name = topology.branches().get(index).name();
            branchesFrom.computeIfAbsent(branch.source(), key -> new ArrayList<>())
                    .add(new NamedBranch(branch, name));
        }

        // The drawing goes out HERE, before a node has run. That is the whole
        // property this package exists for: a viewer draws the machine first and
        // lights it up afterwards, so a run that dies in its first node still
        // left a picture behind.
        emit(() -> GraphRecords.graphTopology(topology, null));
    }

    /** The frozen graph this was compiled from. */
    public GraphSpec spec() {
        return spec;
    }

    /**
     * How much observation this graph has lost.
     *
     * <p>Silence would make a truncated artifact indistinguishable from a
     * crashed process, and a warning per record would let one full disk bury the
     * run in noise. This counter is the middle answer: readable afterwards, by
     * anyone who was not watching stderr at the time.</p>
     *
     * @return the number of records that could not be built or handed over since
     *         this graph was compiled
     */
    public int sinkFailures() {
        return sinkFailures.get();
    }

    /**
     * The tier every run of this graph records its values at.
     *
     * @return the policy, or {@code null} when values are not recorded at all
     */
    public StatePolicy statePolicy() {
        return statePolicy;
    }

    /**
     * The drawing, computed once at compile time and never recomputed — a
     * topology that could change between runs would make the view a guess.
     */
    public Topology topology() {
        return topology;
    }

    /**
     * Runs to completion from a plain channel map.
     *
     * @param input the starting channels
     * @return the end state
     * @throws Exception whatever a node or a decision threw
     */
    public GraphState invoke(Map<String, ?> input) throws Exception {
        return invoke(GraphState.of(input), RunConfig.defaults());
    }

    /**
     * Runs to completion under the default config.
     *
     * @param input the starting state
     * @return the end state
     * @throws Exception whatever a node or a decision threw
     */
    public GraphState invoke(GraphState input) throws Exception {
        return invoke(input, RunConfig.defaults());
    }

    /**
     * Runs to completion.
     *
     * <p>The run starts from the input folded THROUGH the reducers rather than
     * used as-is, so the seeding rules are the same whether or not there is a
     * past to continue from. It ends when the frontier is empty — everything
     * fell into END or had no outgoing edge; END is virtual and never executed.</p>
     *
     * <p>A node's own exception reaches the caller unchanged, never wrapped. A
     * caller that already catches its own failure type must keep working, and a
     * wrapper would also let a runtime concern demote the real failure to a
     * cause.</p>
     *
     * @param input  the starting state
     * @param config the ceiling and the caller's addressing map
     * @return the end state
     * @throws GraphRecursionException when the ceiling is reached without END
     * @throws Exception               whatever a node or a decision threw
     */
    public GraphState invoke(GraphState input, RunConfig config) throws Exception {
        int limit = config.resolvedRecursionLimit();
        String runId = newRunId();
        long began = System.nanoTime();
        int step = 0;

        try {
            // The threadId is on the wire only when a checkpointer is configured
            // (harvested rule 103): a graph without memory has no threads, and a
            // key nothing can look up would claim an identity that does not exist.
            emit(() -> GraphRecords.graphStart(runId,
                    checkpointer == null ? null : threadId(config), null));
            // Straight after graph_start and before any payload of this run: the
            // file is append-mode and holds several runs, so a reader meeting a
            // payload has to find the policy of THAT run above it. The tier is
            // read once here and carried down unchanged — one that could change
            // halfway through would make this line a lie about the ones below it.
            emit(() -> policyRecord(runId));

            GraphState state = loaded(input, config);
            List<String> frontier = nextFrontier(List.of(START), state, config, runId, step);
            persist(config, state, frontier);
            Deque<List<String>> recent = new ArrayDeque<>();

            while (!frontier.isEmpty()) {
                if (step >= limit) {
                    throw new GraphRecursionException(cycleMessage(limit, recent));
                }
                if (recent.size() == RETAINED_FRONTIERS) {
                    recent.removeFirst();
                }
                recent.addLast(frontier);

                // The whole frontier runs against ONE state and every update is held
                // back until the last node has returned. Collecting first is what
                // makes a superstep a superstep.
                List<Map.Entry<String, StateUpdate>> results = new ArrayList<>();
                for (String name : frontier) {
                    results.add(Map.entry(name, watched(name, state, config, runId, step)));
                }
                for (Map.Entry<String, StateUpdate> result : results) {
                    state = spec.schema().apply(state, result.getValue());
                }

                step++;
                List<String> sources = results.stream().map(Map.Entry::getKey).toList();
                frontier = nextFrontier(sources, state, config, runId, step);
                persist(config, state, frontier);
            }
            return state;
        } finally {
            int steps = step;
            long elapsed = (System.nanoTime() - began) / 1_000_000L;
            // From a finally, so a raised run, a recursion abort and a consumer
            // that walked away all leave an ending behind. A run whose last
            // record is a node_start is indistinguishable from a viewer that
            // lost a line.
            emit(() -> GraphRecords.graphEnd(runId, steps, elapsed, null));
        }
    }

    /**
     * Runs one node with its lifecycle recorded around it.
     *
     * <p>A node that fails leaves a {@code node_error} and then throws on
     * unchanged — a {@code node_start} with no ending would be unreadable. The
     * value payload comes AFTER the {@code node_end} it belongs to and carries
     * the node's OWN update rather than the merged state, so the two files join
     * on {@code (runId, node, superstep)} and a reader can see what was written
     * next to what was recorded.</p>
     */
    private StateUpdate watched(String name, GraphState state, RunConfig config, String runId,
                                int superstep) throws Exception {
        emit(() -> GraphRecords.nodeStart(runId, name, superstep, null));
        // Two clocks on purpose: ts is wall time, so the artifacts interleave
        // with the RunEvent wire; a duration is monotonic, so an NTP step cannot
        // make a node look instantaneous or negative.
        long began = System.nanoTime();
        StateUpdate update;
        try {
            update = wrapped(spec.nodes().get(name).run(state, config));
        } catch (Exception failure) {
            long elapsed = (System.nanoTime() - began) / 1_000_000L;
            emit(() -> GraphRecords.nodeError(runId, name, superstep, failure, elapsed, null));
            throw failure;
        }
        long elapsed = (System.nanoTime() - began) / 1_000_000L;
        StateUpdate written = update;
        emit(() -> GraphRecords.nodeEnd(runId, name, superstep, elapsed, written.channels(), null));
        emit(() -> StateRecords.statePayload(name, superstep, written.channels(), statePolicy,
                runId, null));
        return update;
    }

    /**
     * Builds a record and hands it over, or absorbs whatever that costs.
     *
     * <p>Lazy on purpose: with no sink the supplier is never called, so a run
     * nobody is watching never serializes an update to measure it. A builder
     * returning {@code null} is a DECLINE — the policy had nothing to record —
     * and is not a failure, so it is not counted.</p>
     *
     * <p>Only the ordinary tier is caught. An {@link Error} is the process
     * failing rather than the observation failing, and swallowing it here would
     * turn a dying JVM into a slightly larger counter.</p>
     */
    private void emit(Supplier<Map<String, Object>> builder) {
        if (sink == null) {
            return;
        }
        try {
            Map<String, Object> record = builder.get();
            if (record == null) {
                return;
            }
            sink.accept(record);
        } catch (RuntimeException failure) {
            sinkFailures.incrementAndGet();
            if (warned.compareAndSet(false, true)) {
                LOG.warn("a graph sink failed and the run went on unchanged: {}. Later failures "
                        + "are counted in sinkFailures() and not warned about again.",
                        failure.toString(), failure);
            }
        }
    }

    /**
     * At {@code off} nothing is built and no line is written — not even one
     * saying so. A library upgrade that silently began opening a
     * {@code .state.jsonl} would be a data incident, and a zero-byte file is
     * indistinguishable from "this run recorded nothing" to every reader there
     * is. Declining is not a failure, so it is not counted.
     */
    private Map<String, Object> policyRecord(String runId) {
        if (statePolicy == null || !statePolicy.enabled()) {
            return null;
        }
        return StateRecords.statePolicy(statePolicy, runId, null);
    }

    /** Twelve hex characters, enough to tell a retry from a second turn. */
    private static String newRunId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, RUN_ID_LENGTH);
    }

    /**
     * The caller's own thread identity, and nothing else. A run that named no
     * thread gets no invented one, because a minted identity would let two
     * unrelated runs look like one conversation to a reader. Non-string values
     * are stringified rather than refused: {@code configurable} is an untyped
     * map, and the wire field is a string in every edition.
     *
     * <p>Whether the identity reaches the WIRE is a separate predicate — the
     * spec has {@code threadId} present only when a checkpointer is configured,
     * and the {@code graph_start} call site conditions on exactly that. The
     * placeholder that stood here until the checkpointer arrived is gone, as its
     * own Javadoc promised; {@code ThreadMemoryTest} pins both halves now.</p>
     */
    private static String threadId(RunConfig config) {
        Object named = config.configurable().get("thread_id");
        return named == null ? null : String.valueOf(named);
    }

    // -- the checkpointer seam ------------------------------------------------ //

    /**
     * The state a run starts from.
     *
     * <p>With a checkpointer and a known thread, the incoming state is applied
     * to the persisted one THROUGH the reducers. That is the whole multi-turn
     * contract: the caller hands in a fresh, fully populated state every turn —
     * an empty accumulating channel included — and merging appends nothing,
     * while a plain overwrite would silently erase the history.</p>
     */
    private GraphState loaded(GraphState input, RunConfig config) {
        GraphState base = GraphState.empty();
        if (checkpointer != null && threadId(config) != null) {
            StateSnapshot prior = checkpointer.get(config);
            if (prior != null && !prior.values().isEmpty()) {
                base = GraphState.of(prior.values());
            }
        }
        return spec.schema().apply(base, StateUpdate.ofMap(input.values()));
    }

    /**
     * Hands one superstep boundary to the saver: the values as merged, and the
     * frontier that would run next. The step number is deliberately not passed —
     * it numbers a THREAD's history, not a run's supersteps, and a second turn
     * on the same thread has to continue the series rather than restart it.
     *
     * <p>Without a thread id there is nothing to file a snapshot under, so the
     * run simply goes unrecorded rather than failing: a graph run from a script
     * is a legitimate use; an unaddressable checkpoint is not. A saver that
     * throws is NOT absorbed the way a sink is — a checkpoint that cannot be
     * written is lost memory, not lost observation, and a caller relying on the
     * thread must hear about it.</p>
     */
    private void persist(RunConfig config, GraphState state, List<String> frontier) {
        if (checkpointer == null || threadId(config) == null) {
            return;
        }
        checkpointer.put(config, state.values(), frontier);
    }

    /**
     * The newest snapshot of a thread, or the one its config pins.
     *
     * <p>Raises without a checkpointer: a graph compiled without memory cannot
     * answer a thread question, and an empty snapshot here would dress a
     * configuration bug as an empty conversation. An unknown THREAD, by
     * contrast, returns an empty snapshot — no history is the normal state of a
     * first message. A third-party saver answering {@code null} is normalised to
     * that same empty snapshot, so both arrive at the caller looking alike.</p>
     *
     * @param config the addressing map; {@code configurable.thread_id} required
     * @return the snapshot; never {@code null}
     * @throws MissingCheckpointerException when this graph was compiled without one
     */
    public StateSnapshot getState(RunConfig config) {
        if (checkpointer == null) {
            throw new MissingCheckpointerException();
        }
        StateSnapshot snapshot = checkpointer.get(config);
        return snapshot == null ? StateSnapshot.empty(config) : snapshot;
    }

    /**
     * Every snapshot of a thread, newest first.
     *
     * @param config the addressing map; {@code configurable.thread_id} required
     * @return the thread's checkpoints, newest first, detached from the store
     * @throws MissingCheckpointerException when this graph was compiled without one
     */
    public Stream<StateSnapshot> getStateHistory(RunConfig config) {
        if (checkpointer == null) {
            throw new MissingCheckpointerException();
        }
        return checkpointer.list(config);
    }

    /**
     * A node's {@code null} return means "nothing changed", which the merge
     * already understands. The wrapper exists so the null never has to be
     * carried through a {@link Map#entry} that refuses it.
     */
    private static StateUpdate wrapped(StateUpdate update) {
        return update == null ? StateUpdate.none() : update;
    }

    /**
     * Where the run goes after these nodes.
     *
     * <p>Built by walking, per source in results order: first every static edge
     * out of that source in declaration order, then each branch out of it in
     * declaration order. Duplicates collapse keeping the first occurrence — a
     * fan-out reaching the same node by two routes runs it once — and END drops
     * out, because it is virtual.</p>
     *
     * <p>Conditional edges are evaluated against the state as it stands AFTER the
     * superstep merged. Deciding on the pre-merge state would route on the answer
     * to the previous question.</p>
     *
     * <p>Every edge actually walked is recorded, the one into END included, and
     * before the duplicates collapse — two routes reaching the same node are two
     * arrows even though the node runs once. The superstep on the record is the
     * one the edge leads INTO, which is why {@code into} is a parameter rather
     * than something read off the loop: a reader then sees arrows into a frontier
     * and afterwards that frontier's nodes lighting up.</p>
     */
    private List<String> nextFrontier(List<String> sources, GraphState state, RunConfig config,
                                      String runId, int into) throws Exception {
        LinkedHashSet<String> targets = new LinkedHashSet<>();
        for (String source : sources) {
            for (String target : edgesFrom.getOrDefault(source, List.of())) {
                emit(() -> GraphRecords.edgeTaken(runId, source, target, null, into, null));
                targets.add(target);
            }
            for (NamedBranch named : branchesFrom.getOrDefault(source, List.of())) {
                for (String target : route(named.branch(), state, config)) {
                    emit(() -> GraphRecords.edgeTaken(runId, source, target, named.name(), into,
                            null));
                    targets.add(target);
                }
            }
        }
        targets.remove(END);
        return List.copyOf(targets);
    }

    /** Resolves one conditional edge to node names; a collection return fans out. */
    private List<String> route(GraphSpec.Branch branch, GraphState state, RunConfig config)
            throws Exception {
        Object decision = branch.path().route(state, config);
        List<String> resolved = new ArrayList<>();
        if (decision instanceof Collection<?> many) {
            for (Object value : many) {
                resolved.add(mapTarget(branch, value));
            }
        } else {
            resolved.add(mapTarget(branch, decision));
        }
        return resolved;
    }

    /**
     * Translates one return value of a decision into a node name.
     *
     * <p>A path map is consulted first; a value that is already a node name (or
     * END) is honoured even when the map does not mention it, which is the
     * forgiving reading and costs nothing. Anything else is a routing bug, and
     * the message names the SOURCE NODE — decisions are routinely lambdas, so
     * their own name would say nothing.</p>
     */
    private String mapTarget(GraphSpec.Branch branch, Object value) {
        Map<String, String> pathMap = branch.pathMap();
        if (value instanceof String name) {
            if (pathMap != null && pathMap.containsKey(name)) {
                return pathMap.get(name);
            }
            if (END.equals(name) || spec.nodes().containsKey(name)) {
                return name;
            }
        }
        Object known = pathMap == null ? spec.nodes().keySet() : pathMap.keySet();
        throw new GraphValidationException("the conditional edge from '" + branch.source()
                + "' returned " + value + ", which is neither a node of this graph nor a key of "
                + "its path map (known: " + known + ")");
    }

    /**
     * Names the loop that ran out of supersteps.
     *
     * <p>Whoever hits this is looking at a hung request, so the message carries
     * the cycle itself and the knob that widens it, not just a number.</p>
     */
    private static String cycleMessage(int limit, Deque<List<String>> recent) {
        LinkedHashSet<String> cycling = new LinkedHashSet<>();
        recent.forEach(cycling::addAll);
        String route = cycling.isEmpty() ? "(nothing)" : String.join(" -> ", cycling);
        return "the graph took its recursion_limit of " + limit + " supersteps without reaching END; "
                + "it is cycling through " + route + ". Give the cycle an exit, or raise the ceiling "
                + "with RunConfig.withRecursionLimit(N).";
    }
}
