package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.governing.Governs;
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
import java.util.concurrent.atomic.AtomicReference;
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

    /**
     * How many children one {@code spawn_agents} call may start at once.
     *
     * <p>Unchanged by card 270, deliberately: nobody has measured whether the
     * house test backend serves four concurrent completions usefully, and
     * {@code konzept/ORCHESTRATION.md} §7 leaves the width an open owner call
     * until someone does. It moves when a number says so, with the number.</p>
     *
     * <p>Card 490 left it where it is and made it the width of a chat with no
     * session count. A chat with a count reads {@link SessionCount}: its batch
     * width never drops below this constant, and how many of a batch run at
     * once is the chat's count minus the main agent.</p>
     */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.COUNT)
    public static final int MAX_PARALLEL_CHILDREN = 4;

    /** The line between an out-of-budget error and the text the child had
     *  written before the cut (card 371). The parent reads the error first and
     *  the unfinished text after it. What survives the cut is the LAST turn and
     *  nothing before it: {@code lastTurnText} is cleared at every
     *  {@code TurnStart}, so a child cut in its eighth turn hands back that
     *  turn and the seven earlier ones are gone. */
    public static final String PARTIAL_OUTPUT_MARKER =
            "--- what the child had written before the cut, unfinished ---";

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final JsonNode SPAWN_AGENT_SCHEMA = parseSchema("""
            { "type": "object", "required": ["type", "task"],
              "properties": {
                "type": { "type": "string", "enum": ["explore", "worker"] },
                "task": { "type": "string", "description": "Complete, self-contained assignment" } } }
            """);

    /** The {@code spawn_agents} schemas by batch width (card 490). The width
     *  comes from {@link SessionCount#batchWidth()}, so the schema, the
     *  description and the width check cannot disagree; a chat with no count
     *  gets width {@link #MAX_PARALLEL_CHILDREN}, which is the v0.14.4 schema. */
    private static final Map<Integer, JsonNode> SPAWN_AGENTS_SCHEMAS =
            new java.util.concurrent.ConcurrentHashMap<>();

    private static JsonNode spawnAgentsSchema(int width) {
        return SPAWN_AGENTS_SCHEMAS.computeIfAbsent(width, w -> parseSchema("""
                { "type": "object", "required": ["agents"],
                  "properties": {
                    "agents": { "type": "array", "minItems": 1, "maxItems": %d,
                      "items": { "type": "object", "required": ["type", "task"],
                        "properties": {
                          "type": { "type": "string", "enum": ["explore", "worker"] },
                          "task": { "type": "string" } } } } } }
                """.formatted(w)));
    }

    private final SubagentConfig config;
    private final ChildBudget budget;

    /** Card 490: the chat's slot pool. One per manager, because a manager is
     *  built once per chat; nothing outside the chat is counted. */
    private final SessionSlots slots = new SessionSlots();

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
    /** Card 466: the parent whose run is in flight, null between runs. */
    private volatile Agent currentParent;

    /**
     * Production entry: the per-child budget the config carries, which is
     * {@link ChildBudget#derivedFrom} over this session's measured exchanges
     * unless the face named an override (card 270).
     *
     * @param config the parent-session wiring every child is built from
     */
    public SubagentManager(SubagentConfig config) {
        this.config = config;
        this.budget = config.budget();
    }

    /**
     * Visible for tests: an explicit run budget, which wins over any
     * measurement. The queue grace is still derived from it (see
     * {@link ChildBudget#firstTokenGraceMs()}), because the point of card 270 is
     * that the two clocks are different clocks — an override sets the price, not
     * the shape.
     *
     * @param config      the parent-session wiring every child is built from
     * @param runBudgetMs per-child budget in milliseconds, counted from the
     *                    child's first token
     */
    SubagentManager(SubagentConfig config, long runBudgetMs) {
        this.config = config;
        this.budget = ChildBudget.fixed(runBudgetMs);
    }

    /** The per-child budget this manager prices with — the derivation is
     *  re-read on every spawn, so a session whose backend gets slower pays more
     *  for its next child rather than for the one it already lost.
     *  @return the live budget */
    public ChildBudget budget() {
        return budget;
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
     * The role tools for the PARENT registry — thin wrappers over a child
     * spawn: the four dev roles run as workers (specialization is prompt +
     * skill), the research role (card 205) as the research profile with the
     * gated web grant. Children never receive these either.
     *
     * @return build_plan, write_spec, develop, test and research, ready to register
     */
    public List<Tool> devTools() {
        return RoleCatalog.DEV_SPECS.stream().map(spec -> (Tool) new DevTool(spec)).toList();
    }

    /**
     * Card 466: the tool groups a child spawned now would leave out. While a
     * parent run is in flight that is the set the parent read when its run
     * started, so a change in the gear during the run cannot reach a child
     * before it reaches the parent. Between runs it is the configured reader,
     * which the next run reads at its start.
     *
     * @return the switched-off groups, empty when none are or none is wired
     */
    public java.util.Set<dev.spectroscope.core.ToolGroup> childToolGroupsOff() {
        Agent parent = currentParent;
        if (parent != null) {
            return parent.toolGroupsOffThisRun();
        }
        java.util.function.Supplier<java.util.Set<dev.spectroscope.core.ToolGroup>> reader =
                config.toolGroupsOff();
        java.util.Set<dev.spectroscope.core.ToolGroup> off = reader == null ? null : reader.get();
        return off == null ? java.util.Set.of() : java.util.Set.copyOf(off);
    }

    /**
     * Card 490: the session count the spawn tools describe and check against.
     * While a parent run is in flight it is the count that run read when it
     * started, so the descriptions do not move inside a run. Between runs it
     * is the count the config carries.
     *
     * @return the count for descriptions, the schema and the width check
     */
    SessionCount describedCount() {
        Agent parent = currentParent;
        return SessionCount.of(parent != null ? parent.sessionsPerChatThisRun() : config.sessionsPerChat());
    }

    /**
     * Card 490: the session count the slot pool admits by, read live. While a
     * parent run is in flight it is the parent agent's count as it stands now,
     * so a change reaches the next helper that asks for a slot. The parent
     * governs: a parent built without a count runs its helpers with no limit,
     * whatever the config carries.
     *
     * @return the count for the pool and the first-token grace
     */
    SessionCount liveCount() {
        Agent parent = currentParent;
        return SessionCount.of(parent != null ? parent.sessionsPerChat() : config.sessionsPerChat());
    }

    /** The first-token grace a helper admitted now would get (card 490).
     *  @return milliseconds */
    long firstTokenGraceMs() {
        return budget.firstTokenGraceMs(liveCount());
    }

    /** How many helpers of this chat hold a slot now, for tests.
     *  @return the slots in use */
    int slotsInUse() {
        return slots.running();
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
        currentParent = parent;

        // Parent pump: ONE forwarder virtual thread drains the parent's own
        // EventStream into the shared queue. The children add themselves as
        // further producers from inside the spawn tools (runChild).
        Thread.ofVirtual().name("spectroscope-parent-pump").start(() -> {
            try (EventStream parentEvents = parent.run(prompt,
                    new RunOptions(parentSignal, attachments, options.promptForModel()))) {
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
                currentParent = null;
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
     * Permission profile by construction, from the role's own declared policy
     * ({@link RoleCatalog#beltPolicy}): a worker carries the belt whole, explore
     * only its read keep-list, research the read set plus the session's web
     * grant (card 205).
     *
     * <p><b>Card 270 changed what the belt IS, not what a role does to it.</b>
     * The faces now hand children the same supplier step the parent's own belt
     * comes from — so the browser family, the launch family and every MCP server
     * the operator configured arrive here, and a worker child holds them. Before
     * this card the belt was hand-listed as {@code StandardTools.all()} plus
     * {@code use_skill} in two faces, and the families registered one line later
     * reached the parent only; a {@code test} child advertised verification and
     * held no way to open a page.</p>
     *
     * <p>What did not change, and must not: a role WIDENS nothing. Every tool
     * here is one of the parent's own instances, so a child's call passes the
     * same permission broker, the same allowlist and the same card-199 tiers as
     * the parent's — the belt grants reach, never approval. A face that hands
     * over no web tools (headless, fleet) builds research children without web
     * reach, which is the unattended-lanes decision of card 205.</p>
     *
     * <p><b>The owner's answer, 2026-08-18.</b> Five of the newly reachable tools
     * are constructed with {@code gated=false}: {@code browser_read_page},
     * {@code browser_find}, {@code browser_read_console}, {@code launch_list}
     * and {@code launch_logs}. A child holds the parent's OWN instances, so a
     * child reads the operator's attached page and console with no prompt at
     * all. The owner was asked that exact question and accepted it ungated: a
     * child reads the screen exactly as the parent already does.</p>
     *
     * <p>No line numbers here on purpose — they drift, and this list does not
     * need them: {@code BrowserToolsTest} and {@code LaunchToolsTest} assert
     * {@code needsPermission()} false for exactly these five and true for the
     * other seven, so the claim is pinned rather than cited. Recorded in this
     * file rather than only in the card, because this is where a reader lands
     * when they ask what a child may do.</p>
     *
     * <p><b>What else the same widening handed over</b>, since the owner was
     * asked about the screen and not about the rest: a worker child now also
     * carries {@code generate_image}, the three web tools — so it has network
     * egress it did not have before this card — and every MCP server the
     * operator configured. All gated per call, all newly reachable.</p>
     *
     * @param type        the child profile whose policy decides the filter
     * @param childId     stamped into the child's report_status messages
     * @param parentQueue where report_status publishes its status events
     * @return the child's registry: policy-filtered belt plus report_status, never the spawn tools
     */
    private ToolRegistry registryFor(AgentType type, String childId, MergedEventStream parentQueue) {
        RoleCatalog.BeltPolicy policy = RoleCatalog.beltPolicy(type);
        ToolRegistry registry = new ToolRegistry();
        config.baseTools().stream()
                .filter(tool -> policy.holds(tool.name()))
                .forEach(registry::register);
        // The role's explicit grant out of the session's own instances — the
        // card-205 web trio, in the card's order. Registering a name the belt
        // already carried is a no-op replacement with the SAME instance.
        Set<String> granted = Set.copyOf(policy.grant());
        config.webTools().stream()
                .filter(tool -> granted.contains(tool.name()))
                .forEach(registry::register);
        // Every child (all types) may report progress — the A2A status channel.
        registry.register(new ReportStatusTool(childId, parentQueue));
        return registry;
    }

    /**
     * Builds one child agent, runs it, forwards its events, returns its final
     * text. Runs on a virtual thread of the spawn executor — that thread IS
     * the forwarder. Never throws: failures return as a String prefixed
     * "ERROR: " (tool convention), which the agent loop turns into a
     * tool_result with isError = true. Wraps executeChild in the A2A
     * envelope — spawn edge, task message, then the result message on every path.
     *
     * @param type      the child profile — dev tools always pass worker
     * @param task      the full prompt the child runs on (dev tools compose a role preamble)
     * @param ownerTask the assignment as given by the requester — what the A2A task message shows
     * @param label     the dev tool that spawned this child, or null for plain spawns
     * @param ticket    the child's place in the chat's slot queue (card 490)
     * @return the outcome forwarded to the requester — final text or an "ERROR: " string
     */
    private String runChild(AgentType type, String task, String ownerTask, String label,
                            SessionSlots.Ticket ticket) {
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

        String outcome = executeChild(type, task, childId, parentQueue, parentSignal, ticket);
        boolean failed = outcome.startsWith("ERROR:");
        parentQueue.put(new RunEvent.AgentMessage(childId, config.parentAgentId(),
                "result", failed ? "failed" : "completed", outcome, label, now()));
        return outcome;
    }

    /**
     * Takes a slot of the chat for one child, runs it, and gives the slot
     * back (card 490). A child that finds no free slot is shown as waiting, an
     * {@code agent_message} with role {@code status} and the A2A state
     * {@code submitted}, and waits behind the children asked for before it.
     *
     * <p>This is the seam a helper passes on its way to the model: everything
     * between the slot and the release is {@link #runAdmittedChild}.</p>
     *
     * @param type         profile deciding system prompt and tool registry
     * @param task         the prompt the child runs on
     * @param childId      the child's agentId, already drawn from the counter
     * @param parentQueue  the shared queue its events are forwarded into
     * @param parentSignal the parent's cancel; it also ends a wait for a slot
     * @param ticket       the child's place in the slot queue
     * @return the child's memo or an "ERROR: " string; never throws
     */
    private String executeChild(AgentType type, String task, String childId,
                                MergedEventStream parentQueue, CancelSignal parentSignal,
                                SessionSlots.Ticket ticket) {
        SessionCount count = liveCount();
        if (slots.mustWait(ticket, count)) {
            parentQueue.put(new RunEvent.AgentMessage(childId, config.parentAgentId(),
                    "status", "submitted", count.waitingText(), null, now()));
        }
        parentSignal.onCancel(slots::wake);
        if (!slots.acquire(ticket, this::liveCount, parentSignal)) {
            return "ERROR: [" + childId + "] ended by cancellation of the parent run while it"
                    + " waited for a free slot.";
        }
        try {
            return runAdmittedChild(type, task, childId, parentQueue, parentSignal);
        } finally {
            slots.release();
        }
    }

    /**
     * Builds and runs one child that holds a slot; returns its memo or an
     * "ERROR: " string — never throws.
     *
     * @param type         profile deciding system prompt and tool registry
     * @param task         the prompt the child runs on
     * @param childId      the child's agentId, already drawn from the counter
     * @param parentQueue  the shared queue its events are forwarded into
     * @param parentSignal the parent's cancel — cancelling it cascades into the child's own signal
     */
    private String runAdmittedChild(AgentType type, String task, String childId,
                                    MergedEventStream parentQueue, CancelSignal parentSignal) {
        // Cascading cancel + TWO per-child clocks: the child gets its OWN signal.
        // The parent's signal cancels it (Ctrl+C ends the whole tree; onCancel
        // fires immediately if the parent is already cancelled — no race at
        // spawn time), and the scheduled tasks turn the SAME signal into the
        // budget. Never a Thread.sleep race, never Future.get(timeout).
        //
        // Card 270, the shape that replaces the single literal:
        //   * the QUEUE GRACE is armed here, once the child holds a slot of its
        //     chat (card 490), and only asks whether this backend ever started
        //     on this child. Up to a chat's helpers-at-once are at the backend
        //     together, so on one loaded local model the later ones wait for
        //     real; the allowance follows the chat's count.
        //   * the RUN BUDGET is armed on the child's FIRST TOKEN and asks whether
        //     it is still getting anywhere. One clock could not tell those apart,
        //     and on the owner's backend (median exchange 92.2 s) the literal
        //     120 s was shorter than 7 of 15 measured exchanges.
        //
        // The named stop reason travels on the signal, so the child's own
        // run_end says WHICH clock ran out instead of reading as a plain abort.
        // The dedicated flag still matters: closing the child's EventStream
        // (try-with-resources below) also cancels the child signal per the
        // stage-3 contract, so the signal state alone cannot distinguish
        // "finished normally" from "out of budget".
        long graceMs = budget.firstTokenGraceMs(liveCount());
        long runBudgetMs = budget.runBudgetMs();
        // Card 394: the third brake, and not a clock. It is read against the
        // running usage sum in the forwarder loop below and cuts through the
        // same child signal the two clocks use.
        long tokenBudget = config.subagentBudgetTokens();
        String writtenBeforeTheTokenCut = "";
        CancelSignal childSignal = new CancelSignal();
        parentSignal.onCancel(childSignal::cancel);
        AtomicReference<String> stoppedBy = new AtomicReference<>();
        ScheduledFuture<?> graceTimer = timeoutScheduler.schedule(() -> {
            if (stoppedBy.compareAndSet(null, ChildBudget.STOP_NO_FIRST_TOKEN)) {
                childSignal.cancel(ChildBudget.STOP_NO_FIRST_TOKEN);
            }
        }, graceMs, TimeUnit.MILLISECONDS);
        AtomicReference<ScheduledFuture<?>> budgetTimer = new AtomicReference<>();
        AtomicBoolean spoke = new AtomicBoolean(false);

        java.util.Set<dev.spectroscope.core.ToolGroup> childOff = childToolGroupsOff();
        // A subagent is simply another Agent instance from our own core.
        Agent child = new Agent(AgentOptions.builder()
                .provider(config.provider())          // the model lives in the provider
                .systemPrompt(RoleCatalog.SYSTEM_PROMPTS.get(type))
                .registry(registryFor(type, childId, parentQueue)) // + report_status; NEVER the spawn tools
                .onPermission(config.onPermission())  // same broker; request.agentId() names the asker
                .hooks(config.hooks())                // same guard — delegation must not bypass a blocking hook
                .llmWire(config.llmWire())            // same wire record; the child binds its own agentId
                .latency(budget.latency())            // a child's exchanges price the NEXT child (card 270)
                .cwd(config.cwd())
                .agentId(childId)
                .parentId(config.parentAgentId())     // the tree edge — the graph tab draws exactly this
                // AC 3 of card 263 governs the TREE, not just its root: an
                // operator who typed a threshold means it for the children too,
                // and null still lets them derive it from the shared provider.
                .compactionThreshold(config.compactionThreshold())
                // Card 390: the window the operator set for the session, the
                // SAME holder the parent reads, so a change reaches a working
                // child from its next turn as it reaches the parent.
                .sessionWindow(config.sessionWindow())
                // Card 466: the groups of the parent run that spawns this
                // child, fixed now. Applied by the child's own loop to the
                // registry registryFor built, so it narrows after the role
                // policy and after the role's grant and never widens.
                .toolGroupsOff(() -> childOff)
                // Card 364, and the same argument card 263 makes one line up: a
                // ceiling the operator typed governs the TREE. Until this card
                // `.maxTurns(` had one caller in the whole repository and
                // `.maxTokens(` had none, so a child ran on Agent's own two
                // constants no matter what the settings page said. `thinking`
                // joins them because a child's events are merged into the very
                // stream the operator turned reasoning on to watch.
                .maxTurns(config.maxTurns())
                .maxTokens(config.maxTokens())
                // Null-safe on purpose: the seam is nullable ("the parent said
                // nothing") while the builder's setter is a primitive. Agent
                // reads this as `Boolean.TRUE.equals(...) ? ON : DEFAULT`, so
                // false and unset are the SAME state there and nothing is lost
                // by folding one into the other here. Passing the Boolean
                // straight through threw an unboxing NPE on every unconfigured
                // spawn, which arrived as "ERROR: unexpected subagent failure"
                // in the parent's tool result.
                .thinking(Boolean.TRUE.equals(config.thinking()))
                // Card 467: the session's elision switch governs the tree. A
                // child's history grows with its own reads, and a switch that
                // stopped at the root would leave the busiest readers unruled.
                .toolResultElision(config.toolResultElision())
                // Card 490: the child belongs to the chat whose count it ran
                // under. It holds no spawn tools, so the number limits nothing
                // in the child; it is carried so the tree reads one count.
                .sessionsPerChat(liveCount().sessions())
                .build());

        StringBuilder lastTurnText = new StringBuilder();
        long inputTokens = 0;
        long outputTokens = 0;
        try (EventStream childEvents = child.run(task, new RunOptions(childSignal, List.of()))) {
            // Forwarder loop — THE merge: drain the child's EventStream and put
            // every event into the PARENT queue. The for-each blocks between
            // events, which is fine on a virtual thread.
            for (RunEvent event : childEvents) {
                parentQueue.put(event); // the merge, one line
                if (isFirstTokenKind(event) && spoke.compareAndSet(false, true)
                        && stoppedBy.get() == null) {
                    // The child is producing: the queue is behind it, the budget
                    // starts now. If the grace timer wins this instant anyway, its
                    // CAS already stands and the finally below disarms whatever
                    // was armed here — the boundary is a boundary, not a leak.
                    graceTimer.cancel(false);
                    budgetTimer.set(timeoutScheduler.schedule(() -> {
                        if (stoppedBy.compareAndSet(null, ChildBudget.STOP_BUDGET_EXHAUSTED)) {
                            childSignal.cancel(ChildBudget.STOP_BUDGET_EXHAUSTED);
                        }
                    }, runBudgetMs, TimeUnit.MILLISECONDS));
                }
                switch (event) {
                    case RunEvent.TurnStart ignored -> {
                        // Card 394: a child whose spend has passed its budget is
                        // cut as it starts another exchange. The check reads the
                        // running sum below, and it sits on the turn start rather
                        // than on the usage event for two reasons: a child whose
                        // passing exchange was its last keeps its answer, and the
                        // words of that exchange are still in the buffer to hand
                        // back. A child the parent already cancelled is left to
                        // that cancel, so its result keeps saying who stopped it.
                        if (inputTokens + outputTokens > tokenBudget && !childSignal.isCancelled()
                                && stoppedBy.compareAndSet(null,
                                        ChildBudget.STOP_TOKEN_BUDGET_EXHAUSTED)) {
                            writtenBeforeTheTokenCut = lastTurnText.toString();
                            childSignal.cancel(ChildBudget.STOP_TOKEN_BUDGET_EXHAUSTED);
                        }
                        lastTurnText.setLength(0); // last turn = final answer
                    }
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
            graceTimer.cancel(false); // child finished: disarm both clocks
            ScheduledFuture<?> armed = budgetTimer.get();
            if (armed != null) {
                armed.cancel(false);
            }
        }

        // Both messages name the clock AND its derivation: a requester told only
        // "timeout" learns nothing it can act on, and the old sentence could even
        // print "timeout after 0 s" for a sub-second test budget.
        if (ChildBudget.STOP_BUDGET_EXHAUSTED.equals(stoppedBy.get())) {
            String error = "ERROR: [" + childId + "] out of budget: " + runBudgetMs / 1000
                    + " s of work since its first token (" + budget.derivation()
                    + "). Raise subagentBudgetSeconds in the settings, or cut the subtask smaller.";
            // Card 371: the buffer above was accumulated for the "finished normally"
            // path only, and a cut threw it away. A 2,400-line plan was lost that way
            // on 2026-09-16. Hand it back, marked as unfinished.
            //
            return withWhatItHadWritten(error, lastTurnText.toString());
        }
        if (ChildBudget.STOP_TOKEN_BUDGET_EXHAUSTED.equals(stoppedBy.get())) {
            // Card 394: the spend named with its budget and its key, and the
            // words of the exchange that passed the budget handed back the way
            // card 371 hands back a child that ran out of time.
            return withWhatItHadWritten("ERROR: [" + childId + "] out of tokens: "
                    + (inputTokens + outputTokens) + " spent (" + inputTokens + " in / "
                    + outputTokens + " out), past its budget of " + tokenBudget
                    + " (subagentBudgetTokens). Raise subagentBudgetTokens in the settings,"
                    + " or cut the subtask smaller.", writtenBeforeTheTokenCut);
        }
        if (ChildBudget.STOP_NO_FIRST_TOKEN.equals(stoppedBy.get())) {
            return "ERROR: [" + childId + "] never produced a token within " + graceMs / 1000
                    + " s of being started (" + budget.derivation()
                    + ") — the backend did not begin on this child.";
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
     * A cut child's error, followed by what its last turn had written (card 371).
     *
     * <p>Blank, not empty, and stripped on the way out: the same two calls the
     * normal-answer path makes. A model that opens its answer with a newline and
     * is cut there has a buffer that is non-empty and holds nothing a reader can
     * use, and isEmpty() printed the marker over it.</p>
     *
     * @param error   the "ERROR: " sentence that names the cut
     * @param written the text the child had written, possibly blank
     * @return the error alone when nothing was written, else error, marker and text
     */
    private static String withWhatItHadWritten(String error, String written) {
        if (written.isBlank()) {
            return error;
        }
        return error + "\n" + PARTIAL_OUTPUT_MARKER + "\n" + written.strip();
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
        // Card 490: the tickets are drawn HERE, on the caller's thread and in
        // request order, so the slot queue starts the children in the order the
        // parent asked for them and not in the order their threads wake up.
        List<SessionSlots.Ticket> tickets = requests.stream().map(request -> slots.enqueue()).toList();
        // try-with-resources: ExecutorService.close() waits for the tasks (Java 21).
        try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<String>> futures = IntStream.range(0, requests.size())
                    .mapToObj(i -> {
                        ChildRequest request = requests.get(i);
                        SessionSlots.Ticket ticket = tickets.get(i);
                        return executor.submit(() -> {
                            try {
                                return runChild(request.type(), request.task(), request.ownerTask(),
                                        request.label(), ticket);
                            } finally {
                                slots.forget(ticket); // a child refused before its slot holds no place
                            }
                        });
                    })
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

    /**
     * Whether this event means the backend has started producing for the child —
     * the moment the run budget's clock starts (card 270, criterion 1).
     *
     * <p>{@code turn_start} deliberately does not count: the agent loop emits it
     * BEFORE the provider call, so counting it would put the clock back where the
     * literal had it. A tool-calling model may produce no text at all, so a
     * {@code tool_call} counts; a turn that produced only usage still means the
     * backend answered, so that counts too.</p>
     *
     * @param event one forwarded child event
     * @return true for the kinds that prove the child is out of the queue
     */
    private static boolean isFirstTokenKind(RunEvent event) {
        return event instanceof RunEvent.TextDelta
                || event instanceof RunEvent.ThinkingDelta
                || event instanceof RunEvent.ToolCall
                || event instanceof RunEvent.Usage;
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

        /** A second call starts a new child; the first report cannot be fetched
         *  again (card 467).
         *  @return false */
        @Override
        public boolean resultRepeatable() {
            return false;
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

        /** Composes preamble + report_status instruction + task and runs it as ONE labeled child of the spec's type. */
        @Override
        public String execute(JsonNode input, ToolContext context) {
            String task = input.path("task").asText("");
            if (task.isBlank()) {
                return "ERROR: task must be a non-empty string.";
            }
            String composed = spec.preamble() + "\n\nReport progress at each milestone via the "
                    + "report_status tool (one short sentence each).\n\nTASK:\n" + task.strip();
            return runChildrenInParallel(List.of(
                    new ChildRequest(spec.type(), composed, task.strip(), spec.name()))).getFirst();
        }
    }

    /** spawn_agent — starts ONE subagent and waits for its result. */
    private final class SpawnAgentTool implements Tool {
        /** Wire name: {@code spawn_agent}. */
        @Override
        public String name() {
            return "spawn_agent";
        }

        /** A second call starts a new child; the first report cannot be fetched
         *  again (card 467).
         *  @return false */
        @Override
        public boolean resultRepeatable() {
            return false;
        }

        /** The catalog description — the same text the introspection view shows. */
        @Override
        public String description() {
            return RoleCatalog.spawnAgentDescription(describedCount());
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

        /** Parses the type and runs one child (a batch of one); unknown types come
         *  back as "ERROR: " — and so does the role-only research type (card 205),
         *  which is selected as the research tool, never through this enum. */
        @Override
        public String execute(JsonNode input, ToolContext context) {
            return AgentType.fromId(input.path("type").asText())
                    .filter(AgentType::spawnable)
                    .map(type -> runChildrenInParallel(
                            List.of(new ChildRequest(type, input.path("task").asText("")))).getFirst())
                    .orElse("ERROR: unknown agent type \"" + input.path("type").asText() + "\".");
        }
    }

    /** spawn_agents — starts up to the chat's batch width of subagents; the
     *  chat's slot pool decides how many of them run at once (card 490). */
    private final class SpawnAgentsTool implements Tool {
        /** Wire name: {@code spawn_agents}. */
        @Override
        public String name() {
            return "spawn_agents";
        }

        /** A second call starts a new child; the first report cannot be fetched
         *  again (card 467).
         *  @return false */
        @Override
        public boolean resultRepeatable() {
            return false;
        }

        /** The catalog description for the parallel variant, naming the chat's count. */
        @Override
        public String description() {
            return RoleCatalog.spawnAgentsDescription(describedCount());
        }

        /** Requires an {@code agents} array of {type, task}, 1 to the batch width. */
        @Override
        public JsonNode inputSchema() {
            return spawnAgentsSchema(describedCount().batchWidth());
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
            int width = describedCount().batchWidth();
            if (agents.size() > width) {
                return "ERROR: at most " + width + " parallel subagents.";
            }
            List<ChildRequest> requests = new ArrayList<>();
            for (JsonNode entry : agents) {
                // Role-only types (research, card 205) are refused like unknown
                // strings — the batch spawn advertises explore|worker and grants
                // exactly that.
                var type = AgentType.fromId(entry.path("type").asText()).filter(AgentType::spawnable);
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
