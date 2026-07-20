package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * Agent-as-a-tool plus event merge. Built ONCE per CLI session. tools()
 * returns the spawn tools for the PARENT agent's registry; run() replaces
 * agent.run() at the call site and merges parent and child events into one
 * stream. Children never receive the spawn tools, so nesting depth 1 is a
 * structural guarantee, not a runtime check. No System.out here: the core
 * speaks only events.
 */
public final class SubagentManager {

    public static final int MAX_PARALLEL_CHILDREN = 4;
    public static final long CHILD_TIMEOUT_MS = 120_000L;

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final JsonNode SPAWN_AGENT_SCHEMA = parseSchema("""
            { "type": "object", "required": ["type", "task"],
              "properties": {
                "type": { "type": "string", "enum": ["explore", "worker"] },
                "task": { "type": "string", "description": "Complete, self-contained assignment" } } }
            """);

    // maxItems mirrors MAX_PARALLEL_CHILDREN — keep the two in sync.
    private static final JsonNode SPAWN_AGENTS_SCHEMA = parseSchema("""
            { "type": "object", "required": ["agents"],
              "properties": {
                "agents": { "type": "array", "minItems": 1, "maxItems": 4,
                  "items": { "type": "object", "required": ["type", "task"],
                    "properties": {
                      "type": { "type": "string", "enum": ["explore", "worker"] },
                      "task": { "type": "string" } } } } } }
            """);

    private final SubagentConfig config;
    private final long childTimeoutMs;

    /** Per-type counters -> "explore-1", "worker-2". Synchronized access: parallel children draw concurrently. */
    private final Map<AgentType, Integer> counters = new EnumMap<>(AgentType.class);

    /**
     * One shared scheduler arms the per-child timeouts (it only ever runs the
     * tiny childSignal::cancel task, so a single platform thread suffices).
     * Daemon: it must never keep the JVM alive after the CLI exits.
     */
    private final ScheduledExecutorService timeoutScheduler =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "spectroscope-subagent-timeouts");
                thread.setDaemon(true);
                return thread;
            });

    /** Set per run (run()); volatile because children read them from their own threads. */
    private volatile MergedEventStream currentStream;
    private volatile CancelSignal currentParentSignal;

    /**
     * Production entry: the default per-child timeout of {@link #CHILD_TIMEOUT_MS} ms.
     *
     * @param config the parent-session wiring every child is built from
     */
    public SubagentManager(SubagentConfig config) {
        this(config, CHILD_TIMEOUT_MS);
    }

    /**
     * Visible for tests: the child timeout is the only knob worth turning there.
     *
     * @param config         the parent-session wiring every child is built from
     * @param childTimeoutMs per-child wall-clock budget in milliseconds
     */
    SubagentManager(SubagentConfig config, long childTimeoutMs) {
        this.config = config;
        this.childTimeoutMs = childTimeoutMs;
    }

    /**
     * The spawn tools for the PARENT registry. Children never receive these —
     * nesting depth 1 by construction.
     *
     * @return spawn_agent and spawn_agents, ready to register
     */
    public List<Tool> tools() {
        return List.of(new SpawnAgentTool(), new SpawnAgentsTool());
    }

    /**
     * The development tools for the PARENT registry — thin role wrappers over
     * the same worker spawn (no new agent types; specialization is prompt +
     * skill). Children never receive these either.
     *
     * @return build_plan, write_spec, develop and test, ready to register
     */
    public List<Tool> devTools() {
        return RoleCatalog.DEV_SPECS.stream().map(spec -> (Tool) new DevTool(spec)).toList();
    }

    /**
     * Replaces agent.run() at the call site: pumps the parent's events into
     * the same queue as the children's and returns the merged stream. If the
     * parent's agent loop is blocked inside a spawn tool's execute(), the
     * child events still flow — that is exactly what the shared queue is for.
     * One run at a time.
     *
     * @param parent  the fully built parent agent — its run() happens on the pump thread
     * @param prompt  the user prompt handed through to the parent
     * @param options signal and attachments; a missing signal gets a fresh one
     * @return the merged stream of parent and child events; ends when the parent run ends
     */
    public synchronized EventStream run(Agent parent, String prompt, RunOptions options) {
        if (currentStream != null) {
            throw new IllegalStateException("SubagentManager.run: a run is already active (one at a time).");
        }
        CancelSignal parentSignal = options.signal() != null ? options.signal() : new CancelSignal();
        List<RunEvent.Attachment> attachments =
                options.attachments() != null ? options.attachments() : List.of();
        MergedEventStream merged = new MergedEventStream(parentSignal::cancel);
        currentStream = merged;
        currentParentSignal = parentSignal;

        // Parent pump: ONE forwarder virtual thread drains the parent's own
        // EventStream into the shared queue. The children add themselves as
        // further producers from inside the spawn tools (runChild).
        Thread.ofVirtual().name("spectroscope-parent-pump").start(() -> {
            try (EventStream parentEvents = parent.run(prompt, new RunOptions(parentSignal, attachments))) {
                for (RunEvent event : parentEvents) {
                    merged.put(event);
                }
            } catch (RuntimeException failure) {
                merged.put(new RunEvent.ErrorEvent(config.parentAgentId(), describe(failure), now()));
            } finally {
                // The children are always finished here: their tool_results block
                // the parent's loop, run_end comes only afterwards -> end() is safe.
                currentStream = null;
                currentParentSignal = null;
                merged.end();
            }
        });
        return merged;
    }

    /**
     * "explore-1", "worker-2", ... — unique even when parallel children draw concurrently.
     *
     * @param type which per-type counter to draw from
     */
    private synchronized String nextChildId(AgentType type) {
        int next = counters.merge(type, 1, Integer::sum);
        return type.id() + "-" + next;
    }

    /**
     * Permission profile by construction: explore gets the read tools only, worker all base tools.
     *
     * @param type        decides the filter — worker keeps every base tool, explore only the read set
     * @param childId     stamped into the child's report_status messages
     * @param parentQueue where report_status publishes its status events
     * @return the child's registry: profile-filtered base tools plus report_status, never the spawn tools
     */
    private ToolRegistry registryFor(AgentType type, String childId, MergedEventStream parentQueue) {
        ToolRegistry registry = new ToolRegistry();
        config.baseTools().stream()
                .filter(tool -> type == AgentType.WORKER || RoleCatalog.EXPLORE_TOOL_NAMES.contains(tool.name()))
                .forEach(registry::register);
        // Every child (both types) may report progress — the A2A status channel.
        registry.register(new ReportStatusTool(childId, parentQueue));
        return registry;
    }

    /**
     * Builds one child agent, runs it, forwards its events, returns its final
     * text. Runs on a virtual thread of the spawn executor — that thread IS
     * the forwarder. Never throws: failures return as a String prefixed
     * "ERROR: " (tool convention), which the agent loop turns into a
     * tool_result with isError = true.
     *
     * @param type explore or worker
     * @param task the self-contained assignment — both the child's prompt and the visible A2A task
     * @return the child's final text (prefixed with id and token cost), or an "ERROR: " string
     */
    private String runChild(AgentType type, String task) {
        return runChild(type, task, task, null);
    }

    /**
     * The labeled variant behind the dev tools: wraps executeChild in the A2A
     * envelope — spawn edge, task message, then the result message on every path.
     *
     * @param type      the child profile — dev tools always pass worker
     * @param task      the full prompt the child runs on (dev tools compose a role preamble)
     * @param ownerTask the assignment as given by the requester — what the A2A task message shows
     * @param label     the dev tool that spawned this child, or null for plain spawns
     * @return the outcome forwarded to the requester — final text or an "ERROR: " string
     */
    private String runChild(AgentType type, String task, String ownerTask, String label) {
        MergedEventStream parentQueue = this.currentStream;
        CancelSignal parentSignal = this.currentParentSignal;
        if (parentQueue == null || parentSignal == null) {
            return "ERROR: spawn_agent only works inside SubagentManager.run.";
        }
        if (task == null || task.isBlank()) {
            return "ERROR: task must be a non-empty string.";
        }
        String childId = nextChildId(type);

        // The A2A envelope around the whole child run: the tree edge, then the
        // visible task assignment; at the end (every path) the result message.
        parentQueue.put(new RunEvent.AgentSpawn(childId, config.parentAgentId(), task, now()));
        parentQueue.put(new RunEvent.AgentMessage(config.parentAgentId(), childId,
                "task", "submitted", ownerTask, label, now()));

        String outcome = executeChild(type, task, childId, parentQueue, parentSignal);
        boolean failed = outcome.startsWith("ERROR:");
        parentQueue.put(new RunEvent.AgentMessage(childId, config.parentAgentId(),
                "result", failed ? "failed" : "completed", outcome, label, now()));
        return outcome;
    }

    /**
     * Builds and runs one child; returns its memo or an "ERROR: " string — never throws.
     *
     * @param type         profile deciding system prompt and tool registry
     * @param task         the prompt the child runs on
     * @param childId      the child's agentId, already drawn from the counter
     * @param parentQueue  the shared queue its events are forwarded into
     * @param parentSignal the parent's cancel — cancelling it cascades into the child's own signal
     */
    private String executeChild(AgentType type, String task, String childId,
                                MergedEventStream parentQueue, CancelSignal parentSignal) {
        // Cascading cancel + per-child timeout: the child gets its OWN signal.
        // The parent's signal cancels it (Ctrl+C ends the whole tree; onCancel
        // fires immediately if the parent is already cancelled — no race at
        // spawn time), and a scheduled task turns the SAME signal into the
        // per-child timeout. Never a Thread.sleep race, never Future.get(timeout).
        // The dedicated timedOut flag matters: closing the child's EventStream
        // (try-with-resources below) also cancels the child signal per the
        // stage-3 contract, so the signal state alone cannot distinguish
        // "finished normally" from "timed out".
        CancelSignal childSignal = new CancelSignal();
        parentSignal.onCancel(childSignal::cancel);
        AtomicBoolean timedOut = new AtomicBoolean(false);
        ScheduledFuture<?> timeout = timeoutScheduler.schedule(() -> {
            timedOut.set(true);
            childSignal.cancel();
        }, childTimeoutMs, TimeUnit.MILLISECONDS);

        // A subagent is simply another Agent instance from our own core.
        Agent child = new Agent(AgentOptions.builder()
                .provider(config.provider())          // the model lives in the provider
                .systemPrompt(RoleCatalog.SYSTEM_PROMPTS.get(type))
                .registry(registryFor(type, childId, parentQueue)) // + report_status; NEVER the spawn tools
                .onPermission(config.onPermission())  // same broker; request.agentId() names the asker
                .hooks(config.hooks())                // same guard — delegation must not bypass a blocking hook
                .cwd(config.cwd())
                .agentId(childId)
                .parentId(config.parentAgentId())     // the tree edge — the graph tab draws exactly this
                .build());

        StringBuilder lastTurnText = new StringBuilder();
        int inputTokens = 0;
        int outputTokens = 0;
        try (EventStream childEvents = child.run(task, new RunOptions(childSignal, List.of()))) {
            // Forwarder loop — THE merge: drain the child's EventStream and put
            // every event into the PARENT queue. The for-each blocks between
            // events, which is fine on a virtual thread.
            for (RunEvent event : childEvents) {
                parentQueue.put(event); // the merge, one line
                switch (event) {
                    case RunEvent.TurnStart ignored -> lastTurnText.setLength(0); // last turn = final answer
                    case RunEvent.TextDelta delta -> lastTurnText.append(delta.text());
                    case RunEvent.Usage usage -> {
                        inputTokens += usage.inputTokens();
                        outputTokens += usage.outputTokens();
                    }
                    default -> { }
                }
            }
        } catch (RuntimeException failure) {
            return "ERROR: [" + childId + "] unexpected failure: " + describe(failure);
        } finally {
            timeout.cancel(false); // child finished: disarm the timeout
        }

        if (timedOut.get()) {
            return "ERROR: [" + childId + "] timeout after " + childTimeoutMs / 1000
                    + " s — cut the subtask smaller.";
        }
        if (parentSignal.isCancelled()) {
            return "ERROR: [" + childId + "] ended by cancellation of the parent run.";
        }
        if (lastTurnText.toString().isBlank()) {
            return "ERROR: [" + childId + "] returned no final text.";
        }
        // Report the usage sum per child: delegation should visibly cost something.
        return "[" + childId + "] result (tokens: " + inputTokens + " in / " + outputTokens + " out):\n"
                + lastTurnText.toString().strip();
    }

    /**
     * Runs one runChild call per request, each on its own virtual thread, and
     * waits until all of them are finished. Since runChild never throws, one
     * failing child does not tear down the others.
     *
     * @param requests one entry per child to spawn
     * @return one result string per request, in request order — failures as "ERROR: " entries
     */
    private List<String> runChildrenInParallel(List<ChildRequest> requests) {
        List<String> results = new ArrayList<>();
        // try-with-resources: ExecutorService.close() waits for the tasks (Java 21).
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<String>> futures = requests.stream()
                    .map(request -> executor.submit(() ->
                            runChild(request.type(), request.task(), request.ownerTask(), request.label())))
                    .toList();
            for (Future<String> future : futures) {
                try {
                    results.add(future.get()); // blocks — fine on a virtual thread
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    results.add("ERROR: interrupted while waiting for a subagent.");
                } catch (ExecutionException failure) {
                    // runChild never throws; reaching this is a programming error —
                    // still surfaced as text so the parent run survives.
                    results.add("ERROR: unexpected subagent failure: " + describe(failure.getCause()));
                }
            }
        }
        return results;
    }

    /** Wall-clock epoch millis — the timestamp base every RunEvent emitter uses. */
    private static long now() {
        return System.currentTimeMillis();
    }

    /**
     * One-line human-readable failure text for ERROR strings and error events.
     *
     * @param failure the caught throwable; null yields "unknown error"
     * @return the message when set, else the throwable's toString()
     */
    private static String describe(Throwable failure) {
        if (failure == null) {
            return "unknown error";
        }
        return failure.getMessage() != null ? failure.getMessage() : failure.toString();
    }

    /**
     * Parses a built-in schema literal — a broken one is a programming error and
     * fails loudly at class-initialization time.
     *
     * @param json the JSON Schema source text
     * @return the parsed schema tree
     */
    private static JsonNode parseSchema(String json) {
        try {
            return JSON.readTree(json);
        } catch (JsonProcessingException invalid) {
            // A broken built-in schema is a programming error — this may crash.
            throw new IllegalStateException("Invalid built-in tool schema: " + invalid.getMessage(), invalid);
        }
    }

    /**
     * One queued child spawn — the unit runChildrenInParallel works through.
     *
     * @param type      explore or worker
     * @param task      the full prompt the child runs on
     * @param ownerTask the requester's assignment, shown in the A2A task message
     * @param label     the spawning dev tool's name, or null for plain spawns
     */
    private record ChildRequest(AgentType type, String task, String ownerTask, String label) {
        /**
         * Plain spawns: what the child runs on IS the assignment, no label.
         *
         * @param type explore or worker
         * @param task doubles as the child's prompt and the visible assignment
         */
        ChildRequest(AgentType type, String task) {
            this(type, task, task, null);
        }
    }

    /**
     * The child's side of the A2A status channel: a permission-free tool every
     * child gets. One call = one visible {@code agent_message} (role status,
     * state working) in the merged stream — progress without waiting for the
     * final result.
     */
    private final class ReportStatusTool implements Tool {
        private static final JsonNode SCHEMA = parseSchema("""
                { "type": "object", "required": ["message"],
                  "properties": {
                    "message": { "type": "string",
                      "description": "One short sentence: what you are working on right now" } } }
                """);

        private final String childId;
        private final MergedEventStream parentQueue;

        /**
         * Binds the tool to one child run.
         *
         * @param childId     the reporting child — the message's sender side
         * @param parentQueue the merged stream the status messages surface on
         */
        private ReportStatusTool(String childId, MergedEventStream parentQueue) {
            this.childId = childId;
            this.parentQueue = parentQueue;
        }

        /** Wire name: {@code report_status}. */
        @Override
        public String name() {
            return "report_status";
        }

        /** Tells the child model to report one short sentence per milestone — non-blocking. */
        @Override
        public String description() {
            return "Reports your current progress to the agent that spawned you. Call this at "
                    + "every milestone with ONE short sentence. It does not pause your work.";
        }

        /** One required string: {@code message}. */
        @Override
        public JsonNode inputSchema() {
            return SCHEMA;
        }

        /** Permission-free — progress reports carry no side effects. */
        @Override
        public boolean needsPermission() {
            return false; // telling the parent what you do is never dangerous
        }

        /** Validates the message and publishes it as a status/working agent_message on the merged stream. */
        @Override
        public String execute(JsonNode input, ToolContext context) {
            String message = input.path("message").asText("");
            if (message.isBlank()) {
                return "ERROR: message must be a non-empty string.";
            }
            parentQueue.put(new RunEvent.AgentMessage(childId, config.parentAgentId(),
                    "status", "working", message.strip(), null, now()));
            return "ok";
        }
    }

    /**
     * One development tool = one role wrapper over a plain worker spawn. The
     * child runs on preamble + task; the A2A task message shows the OWNER task
     * plus this tool's name as the label, so log and UI stay readable.
     */
    private final class DevTool implements Tool {
        private static final JsonNode SCHEMA = parseSchema("""
                { "type": "object", "required": ["task"],
                  "properties": {
                    "task": { "type": "string",
                      "description": "Complete, self-contained assignment" } } }
                """);

        private final RoleCatalog.DevSpec spec;

        /**
         * One instance per catalog entry, created by devTools().
         *
         * @param spec the role recipe — name, description, preamble and skill
         */
        private DevTool(RoleCatalog.DevSpec spec) {
            this.spec = spec;
        }

        /** The dev tool's wire name, straight from its spec. */
        @Override
        public String name() {
            return spec.name();
        }

        /** The spec's description plus the shared worker/skill note. */
        @Override
        public String description() {
            return RoleCatalog.devToolDescription(spec);
        }

        /** One required string: {@code task}. */
        @Override
        public JsonNode inputSchema() {
            return SCHEMA;
        }

        /** Permission-free — the child's real actions pass the gate individually. */
        @Override
        public boolean needsPermission() {
            return false; // the child's real actions pass the permission gate individually
        }

        /** Composes preamble + report_status instruction + task and runs it as ONE labeled worker child. */
        @Override
        public String execute(JsonNode input, ToolContext context) {
            String task = input.path("task").asText("");
            if (task.isBlank()) {
                return "ERROR: task must be a non-empty string.";
            }
            String composed = spec.preamble() + "\n\nReport progress at each milestone via the "
                    + "report_status tool (one short sentence each).\n\nTASK:\n" + task.strip();
            return runChildrenInParallel(List.of(
                    new ChildRequest(AgentType.WORKER, composed, task.strip(), spec.name()))).getFirst();
        }
    }

    /** spawn_agent — starts ONE subagent and waits for its result. */
    private final class SpawnAgentTool implements Tool {
        /** Wire name: {@code spawn_agent}. */
        @Override
        public String name() {
            return "spawn_agent";
        }

        /** The catalog description — the same text the introspection view shows. */
        @Override
        public String description() {
            return RoleCatalog.SPAWN_AGENT_DESC;
        }

        /** Requires {@code type} (explore|worker) and a self-contained {@code task}. */
        @Override
        public JsonNode inputSchema() {
            return SPAWN_AGENT_SCHEMA;
        }

        /** Permission-free — the child's tools ask for permission themselves. */
        @Override
        public boolean needsPermission() {
            return false; // the child's tools ask for permission themselves
        }

        /** Parses the type and runs one child (a batch of one); unknown types come back as "ERROR: ". */
        @Override
        public String execute(JsonNode input, ToolContext context) {
            return AgentType.fromId(input.path("type").asText())
                    .map(type -> runChildrenInParallel(
                            List.of(new ChildRequest(type, input.path("task").asText("")))).getFirst())
                    .orElse("ERROR: unknown agent type \"" + input.path("type").asText() + "\".");
        }
    }

    /** spawn_agents — starts up to MAX_PARALLEL_CHILDREN subagents IN PARALLEL. */
    private final class SpawnAgentsTool implements Tool {
        /** Wire name: {@code spawn_agents}. */
        @Override
        public String name() {
            return "spawn_agents";
        }

        /** The catalog description for the parallel variant. */
        @Override
        public String description() {
            return RoleCatalog.SPAWN_AGENTS_DESC;
        }

        /** Requires an {@code agents} array of {type, task} — 1 to 4 entries. */
        @Override
        public JsonNode inputSchema() {
            return SPAWN_AGENTS_SCHEMA;
        }

        /** Permission-free — the children's tools ask for permission themselves. */
        @Override
        public boolean needsPermission() {
            return false; // the children's tools ask for permission themselves
        }

        /** Validates the batch, runs every child in parallel and joins their results — ERROR only when ALL failed. */
        @Override
        public String execute(JsonNode input, ToolContext context) {
            JsonNode agents = input.path("agents");
            if (!agents.isArray() || agents.isEmpty()) {
                return "ERROR: agents must be a non-empty array.";
            }
            if (agents.size() > MAX_PARALLEL_CHILDREN) {
                return "ERROR: at most " + MAX_PARALLEL_CHILDREN + " parallel subagents.";
            }
            List<ChildRequest> requests = new ArrayList<>();
            for (JsonNode entry : agents) {
                var type = AgentType.fromId(entry.path("type").asText());
                if (type.isEmpty()) {
                    return "ERROR: unknown agent type \"" + entry.path("type").asText() + "\".";
                }
                requests.add(new ChildRequest(type.get(), entry.path("task").asText("")));
            }
            List<String> results = runChildrenInParallel(requests);
            String combined = IntStream.range(0, results.size())
                    .mapToObj(i -> "--- Subagent " + (i + 1) + " ---\n" + results.get(i))
                    .collect(Collectors.joining("\n\n"));
            // Only if ALL children fail is the whole call an error.
            boolean allFailed = results.stream().allMatch(result -> result.startsWith("ERROR:"));
            return allFailed ? "ERROR: all subagents failed.\n" + combined : combined;
        }
    }
}
