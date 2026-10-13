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
import dev.spectroscope.core.provider.LlmProvider;
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
import java.util.function.Consumer;
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
    /** Card 505: the same schemas with the {@code background} field, by batch width. */
    private static final Map<Integer, JsonNode> SPAWN_AGENTS_BACKGROUND_SCHEMAS =
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

    /** Card 505: the schema with {@code background}, offered only where a
     *  background fan-out can run. */
    private static JsonNode spawnAgentsBackgroundSchema(int width) {
        return SPAWN_AGENTS_BACKGROUND_SCHEMAS.computeIfAbsent(width, w -> parseSchema("""
                { "type": "object", "required": ["agents"],
                  "properties": {
                    "agents": { "type": "array", "minItems": 1, "maxItems": %d,
                      "items": { "type": "object", "required": ["type", "task"],
                        "properties": {
                          "type": { "type": "string", "enum": ["explore", "worker"] },
                          "task": { "type": "string" } } } },
                    "background": { "type": "boolean",
                      "description": "true: return at once with the children's names; collect their results with wait_agents" } } }
                """.formatted(w)));
    }

    /** Card 505: what the spawn_agents description adds where background is offered. */
    public static final String BACKGROUND_SENTENCE = " With background true the call returns at once with the children's"
            + " names while they run on the same slots: their status lines and results reach you as messages,"
            + " send_message asks one of them how far it is, list_agents shows them, and wait_agents collects"
            + " their results. If your turn ends while they still run, the run waits for them.";

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

    /** Card 502: what became of one message inside a run. */
    public enum InRunDelivery {
        /** In the recipient's inbox; read at its next safe point. */
        QUEUED,
        /** The recipient is in the run but takes no message now. */
        REFUSED,
        /** The recipient's queue is at its cap. */
        FULL,
        /** The name is not the parent or a running child of this run. */
        UNKNOWN,
        /**
         * A child named another child. Hub and spoke (owner, 2026-10-12): a
         * child messages only its parent, where the person watching sees it.
         */
        NOT_PARENT
    }

    /** Card 502: the inbox of every running child, by child id. */
    private final java.util.concurrent.ConcurrentHashMap<String, dev.spectroscope.core.peer.PeerInbox> childInboxes =
            new java.util.concurrent.ConcurrentHashMap<>();
    /** Card 502: the task of every running child, by child id, in spawn order. */
    private final Map<String, String> childTasks = java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<>());
    /** Card 502: the parent's own inbox, set by the face that hosts it; null when none. */
    private volatile dev.spectroscope.core.peer.PeerInbox parentInbox;
    /**
     * Card 506 fix round 1: the msg ids a child of this run put into the
     * parent's inbox through {@link #deliverInRun}, until the parent took them.
     * An envelope's {@code from} is the sender's claim; this set is what the
     * run itself submitted.
     */
    private final java.util.Set<String> inRunToParent = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /** @return how many in-run messages to the parent are still marked as the run's own (tests) */
    int inRunToParentPending() {
        return inRunToParent.size();
    }

    /**
     * Card 502: delivers one message inside this run. The address space is the
     * run: the parent reaches its running children, a child reaches its parent
     * ({@code parent} or the parent's id) and nobody else. Hub and spoke
     * (owner, 2026-10-12): a child that names another child is refused with
     * {@link InRunDelivery#NOT_PARENT}, so what one child says to another
     * passes through the parent, where the person watching the run sees it. A
     * peer session is outside the run, in both directions.
     *
     * @param from    the sending agent's id
     * @param to      the receiving agent's id, or {@code parent}
     * @param message the message
     * @return what became of it
     */
    public InRunDelivery deliverInRun(String from, String to, dev.spectroscope.core.peer.PeerEnvelope message) {
        String parentId = config.parentAgentId();
        boolean fromParent = parentId != null && parentId.equals(from);
        boolean fromChild = from != null && childInboxes.containsKey(from);
        if (!fromParent && !fromChild) {
            return InRunDelivery.UNKNOWN;
        }
        dev.spectroscope.core.peer.PeerInbox target;
        if ("parent".equals(to) || (parentId != null && parentId.equals(to))) {
            if (!fromChild) {
                return InRunDelivery.UNKNOWN;
            }
            target = parentInbox;
        } else {
            if (to == null || to.equals(from)) {
                return InRunDelivery.UNKNOWN;
            }
            if (fromChild) {
                return InRunDelivery.NOT_PARENT;
            }
            target = childInboxes.get(to);
            if (target == null) {
                return InRunDelivery.UNKNOWN;
            }
        }
        if (target == null) {
            return InRunDelivery.REFUSED;
        }
        boolean toParent = target == parentInbox && message.msgId() != null;
        if (toParent) {
            inRunToParent.add(message.msgId());
        }
        InRunDelivery delivery = switch (target.submit(message)) {
            case WAITING -> InRunDelivery.QUEUED;
            case FULL -> InRunDelivery.FULL;
            case NO_RUN -> InRunDelivery.REFUSED;
        };
        if (toParent && delivery != InRunDelivery.QUEUED) {
            inRunToParent.remove(message.msgId());
        }
        return delivery;
    }

    /** Card 502: the running children with their tasks, in spawn order.
     *  @return child id to task, a snapshot */
    public Map<String, String> runningChildren() {
        synchronized (childTasks) {
            return Map.copyOf(new java.util.LinkedHashMap<>(childTasks));
        }
    }

    /** Card 502: whether a name is a running child of this run, which a peer
     *  session may never address.
     *  @param name the name
     *  @return true for a running child */
    public boolean isChild(String name) {
        return name != null && childInboxes.containsKey(name);
    }

    /**
     * Card 503: the {@code agentMessaging} setting a child spawned now starts
     * from: the one the parent run read at its start while a run is in flight,
     * else the session's value.
     *
     * @return false when messaging is off; null for the shipped on
     */
    public Boolean childAgentMessaging() {
        Agent parent = currentParent;
        if (parent != null) {
            return parent.agentMessagingThisRun();
        }
        return config.agentMessaging();
    }

    /** Card 503: the role of every running child, by child id. */
    private final java.util.concurrent.ConcurrentHashMap<String, String> childRoles =
            new java.util.concurrent.ConcurrentHashMap<>();
    /** Card 503: the last report_status line of every running child, by child id. */
    private final java.util.concurrent.ConcurrentHashMap<String, String> childStatus =
            new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * Card 503: the running children as the parent's {@code list_agents} shows
     * them, in spawn order, with role and last status line.
     *
     * @return one row per running child
     */
    public List<dev.spectroscope.core.messaging.AgentRow> childRows() {
        List<dev.spectroscope.core.messaging.AgentRow> rows = new ArrayList<>();
        // Card 505: the background children first, in spawn order, whatever
        // their state: waiting for a slot, working, or ended with the result
        // collected or not.
        BackgroundRun run = background;
        java.util.Set<String> listed = new java.util.HashSet<>();
        if (run != null) {
            for (String id : run.names()) {
                listed.add(id);
                rows.add(dev.spectroscope.core.messaging.AgentRow.inRun(
                        dev.spectroscope.core.messaging.AgentRow.Kind.CHILD, id, id, run.role(id),
                        backgroundStatus(run, id), run.lastStatus(id)));
            }
        }
        for (String id : runningChildren().keySet()) {
            if (listed.contains(id)) {
                continue;
            }
            rows.add(dev.spectroscope.core.messaging.AgentRow.inRun(
                    dev.spectroscope.core.messaging.AgentRow.Kind.CHILD, id, id,
                    childRoles.getOrDefault(id, "agent"), "working", childStatus.get(id)));
        }
        return rows;
    }

    /** Card 505: the status word of a background child in a listing. */
    private String backgroundStatus(BackgroundRun run, String id) {
        if (run.ended(id)) {
            String verdict = run.failed(id) ? "failed" : "finished";
            return run.collected(id) ? verdict : verdict + " in the background, result not collected";
        }
        return childTasks.containsKey(id) ? "working in the background" : "waiting for a slot";
    }

    /**
     * Card 503: the parent's message to one of its running children, or the
     * operator's reply to one, which reaches the child as from {@code parent}.
     *
     * @param row     the child
     * @param text    the body
     * @param summary the preview line
     * @return what happened
     */
    public dev.spectroscope.core.messaging.MessagingSeat.Sent sendFromParent(
            dev.spectroscope.core.messaging.AgentRow row, String text, String summary) {
        return inRun(config.parentAgentId(), "parent", config.parentAgentId(), row.id(), text, summary);
    }

    /**
     * Card 503: the operator's message to a running child, from the page. It
     * reaches the child from {@code parent}, named {@code operator}.
     *
     * @param childId the child
     * @param text    the body
     * @param unused  reserved
     * @return what happened
     */
    public dev.spectroscope.core.messaging.MessagingSeat.Sent sendFromOperator(String childId, String text,
                                                                               String unused) {
        String summary = text == null ? "" : text.strip().lines().findFirst().orElse("");
        return inRun(config.parentAgentId(), "parent", "operator", childId, text, summary);
    }

    /**
     * Card 503: a running child's inbox, which the auto modes read before
     * they approve one of its gated calls.
     *
     * @param childId the child
     * @return its inbox, or null when it is not running
     */
    public dev.spectroscope.core.peer.PeerInbox inboxOf(String childId) {
        return childId == null ? null : childInboxes.get(childId);
    }

    /** Card 503: one message inside the run, as the messaging tools send it. */
    private dev.spectroscope.core.messaging.MessagingSeat.Sent inRun(String from, String replyAddress,
                                                                      String fromName, String to, String text,
                                                                      String summary) {
        String msgId = dev.spectroscope.core.peer.PeerFrames.newMsgId();
        dev.spectroscope.core.peer.PeerEnvelope envelope = dev.spectroscope.core.peer.PeerEnvelope.builder()
                .msgId(msgId).from(replyAddress).fromName(fromName).priority("next").text(text)
                .summary(summary).build();
        return switch (deliverInRun(from, to, envelope)) {
            case QUEUED -> dev.spectroscope.core.messaging.MessagingSeat.Sent.ok(msgId);
            case FULL -> dev.spectroscope.core.messaging.MessagingSeat.Sent.failed("Not sent: " + to + " has too"
                    + " many undelivered messages queued; fold this into one later message.");
            case REFUSED -> dev.spectroscope.core.messaging.MessagingSeat.Sent.failed("Not sent: " + to + " takes"
                    + " no message right now; it may have just finished. Call list_agents to see who is running.");
            case UNKNOWN -> dev.spectroscope.core.messaging.MessagingSeat.Sent.failed(unknownInRun(to));
            case NOT_PARENT -> dev.spectroscope.core.messaging.MessagingSeat.Sent.failed(
                    dev.spectroscope.core.messaging.SendMessageTool.childRefusal(to, isSibling(from, to)
                            ? dev.spectroscope.core.messaging.SendMessageTool.ChildMiss.SIBLING
                            : dev.spectroscope.core.messaging.SendMessageTool.ChildMiss.OTHER));
        };
    }

    /** Card 505: why a name of this run takes no message, in words a model can act on. */
    private String unknownInRun(String to) {
        BackgroundRun run = background;
        if (run != null && run.holds(to)) {
            return run.ended(to)
                    ? "Not sent: " + to + " has ended; collect its result with wait_agents."
                    : "Not sent: " + to + " is waiting for a free slot and reads no message yet; send it again"
                    + " once list_agents shows it working.";
        }
        return dev.spectroscope.core.peer.PeerClient.unknownName(to);
    }

    /** Visible for tests: the seat a running child's messaging tools sit on.
     *  @param childId the child @return its seat */
    dev.spectroscope.core.messaging.MessagingSeat childSeat(String childId) {
        return new ChildSeat(childId);
    }

    /**
     * Hub and spoke: every child id this manager started, kept after the child
     * ends, so a child that names a finished one hears that it named another
     * child agent. It only picks the words of a refusal.
     */
    private final java.util.Set<String> startedChildIds = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * Hub and spoke: whether {@code name} is a child of this manager other
     * than {@code self}. Matched as names are matched (review round 1): in
     * any case, so {@code EXPLORE-2} is the child {@code explore-2}.
     */
    private boolean isSibling(String self, String name) {
        if (name == null || dev.spectroscope.core.peer.PeerNames.same(name, self)) {
            return false;
        }
        if (startedChildIds.stream().anyMatch(id -> dev.spectroscope.core.peer.PeerNames.same(id, name))) {
            return true;
        }
        BackgroundRun run = background;
        return run != null && run.names().stream().anyMatch(id -> dev.spectroscope.core.peer.PeerNames.same(id, name));
    }

    /**
     * Card 503: the seat a child's two messaging tools sit on. Hub and spoke
     * (owner, 2026-10-12): its address space is its parent, never another
     * child and never a session.
     */
    private final class ChildSeat implements dev.spectroscope.core.messaging.MessagingSeat {
        private final String childId;

        private ChildSeat(String childId) {
            this.childId = childId;
        }

        @Override
        public String selfName() {
            return childId;
        }

        @Override
        public String selfRef() {
            return dev.spectroscope.core.peer.PeerNames.ref("agent", childId);
        }

        @Override
        public boolean child() {
            return true;
        }

        @Override
        public String agentId() {
            return childId;
        }

        @Override
        public boolean on() {
            return !Boolean.FALSE.equals(childAgentMessaging());
        }

        @Override
        public List<dev.spectroscope.core.messaging.AgentRow> sessions() {
            return List.of();
        }

        @Override
        public List<dev.spectroscope.core.messaging.AgentRow> runAgents() {
            return List.of(dev.spectroscope.core.messaging.AgentRow.inRun(
                    dev.spectroscope.core.messaging.AgentRow.Kind.PARENT, "parent", config.parentAgentId(),
                    "main", "working", null));
        }

        @Override
        public boolean sibling(String name) {
            return isSibling(childId, name);
        }

        @Override
        public Sent sendToSession(dev.spectroscope.core.messaging.AgentRow row, String text, String summary) {
            return Sent.failed(dev.spectroscope.core.messaging.SendMessageTool.childRefusal(row.name(),
                    dev.spectroscope.core.messaging.SendMessageTool.ChildMiss.OTHER));
        }

        @Override
        public Sent sendInRun(dev.spectroscope.core.messaging.AgentRow row, String text, String summary) {
            String to = row.kind() == dev.spectroscope.core.messaging.AgentRow.Kind.PARENT ? "parent" : row.id();
            return inRun(childId, childId, childId, to, text, summary);
        }

        @Override
        public Sent notifyWhenIdle(dev.spectroscope.core.messaging.AgentRow row) {
            return Sent.failed("notify_when_idle is only available to the main agent of a session.");
        }
    }

    /** Card 502: the parent's inbox, so a child's message to {@code parent} lands.
     *  @param inbox the inbox the parent agent drains; null for none */
    public void parentInbox(dev.spectroscope.core.peer.PeerInbox inbox) {
        this.parentInbox = inbox;
        // Card 505: a result the parent's loop took in is collected. One
        // listener per inbox, forwarding to the run in flight.
        if (inbox != null && listenedInbox != inbox) {
            listenedInbox = inbox;
            inbox.addAbsorbedListener(taken -> {
                for (dev.spectroscope.core.peer.PeerEnvelope envelope : taken) {
                    inRunToParent.remove(envelope.msgId());
                }
                BackgroundRun run = background;
                if (run != null) {
                    run.absorbed(taken);
                }
            });
        }
    }

    /** Card 505: the inbox this manager listens on, so it listens once. */
    private volatile dev.spectroscope.core.peer.PeerInbox listenedInbox;
    /** Card 505: the background children of the run in flight, null between runs. */
    private volatile BackgroundRun background;
    /** Card 505: how long a goal run waits before it checks in. */
    private volatile long checkInMs = BackgroundRun.CHECK_IN_FIRST_MS;

    /**
     * Card 505: whether {@code spawn_agents} offers {@code background}. It
     * needs the parent's inbox, where the children's lines and results land,
     * and agent messaging on for the run, since wait_agents and the children's
     * messages belong to that family.
     *
     * @return true where a background fan-out can run
     */
    boolean backgroundOffered() {
        if (parentInbox == null) {
            return false;
        }
        Agent parent = currentParent;
        if (parent == null && Boolean.FALSE.equals(config.agentMessaging())) {
            return false;
        }
        return !childToolGroupsOff().contains(dev.spectroscope.core.ToolGroup.MESSAGING);
    }

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
     * Card 505: the tools only the parent of a background fan-out holds.
     *
     * @return wait_agents, ready to register after the messaging tools
     */
    public List<Tool> backgroundTools() {
        return List.of(new WaitAgentsTool());
    }

    /** Test seam: how long a run with a goal waits before it checks in.
     *  @param ms the interval */
    void checkInMs(long ms) {
        this.checkInMs = ms;
    }

    /** Test seam: the background children of the run in flight, one
     *  {@code id=state[:last status]} per child, joined by semicolons.
     *  @return the snapshot, empty when none */
    String backgroundSnapshotForTests() {
        BackgroundRun run = background;
        return run == null ? "" : run.snapshot(childTasks::containsKey);
    }

    /**
     * The text a role child runs on: the role's preamble, the report_status
     * instruction and the task. The static role tools and a playbook step
     * with role {@code agent:<name>} (card 485) both compose through here.
     *
     * @param preamble the role text
     * @param task     the task, stripped before it is appended
     * @return the composed text
     */
    public static String roleTask(String preamble, String task) {
        return preamble + "\n\nReport progress at each milestone via the "
                + "report_status tool (one short sentence each).\n\nTASK:\n" + task.strip();
    }

    /**
     * Card 558: one named agent of the session, from its workspace's
     * {@code .claude/agents} or {@code .spectro/agents} or from the picked
     * playbook's {@code agents/}, read in place.
     *
     * @param name        the effective name the model calls it by
     * @param description one line
     * @param type        the child type: explore, worker or research
     * @param preamble    the agent file's body
     */
    public record NamedAgent(String name, String description, String type, String preamble) {
    }

    /** Card 558: the wire name of the tool that starts a named agent. */
    public static final String NAMED_AGENT_TOOL = "spawn_named_agent";

    /**
     * Card 558: the PARENT tool that starts one of the session's named agents
     * (workspace or picked playbook), the way a role tool starts its role: the agent file's preamble
     * and the task composed by {@link #roleTask}, run as ONE labelled child of
     * the file's type. Offered only while the session has an agent; the list is
     * read at every call, so a pick reaches the next run. Children never get it,
     * so depth stays one.
     *
     * @param agents the session's agents now, read at every call
     * @return the tool
     */
    public Tool namedAgentTool(java.util.function.Supplier<List<NamedAgent>> agents) {
        return new NamedAgentTool(agents);
    }

    /** {@code spawn_named_agent}: one child as one of the session's named agents. */
    private final class NamedAgentTool implements Tool {

        private final java.util.function.Supplier<List<NamedAgent>> agents;

        private NamedAgentTool(java.util.function.Supplier<List<NamedAgent>> agents) {
            this.agents = agents;
        }

        private List<NamedAgent> now() {
            List<NamedAgent> list = agents.get();
            return list == null ? List.of() : list;
        }

        @Override
        public String name() {
            return NAMED_AGENT_TOOL;
        }

        /** A second call starts a new child, like the other spawn verbs. */
        @Override
        public boolean resultRepeatable() {
            return false;
        }

        /** Names every agent the session has now, with its type. */
        @Override
        public String description() {
            StringBuilder out = new StringBuilder("Starts one of this session's named agents as a subagent and "
                    + "waits for its result. The agent brings its own instructions; give it a complete, "
                    + "self-contained task. Agents:");
            for (NamedAgent a : now()) {
                out.append("\n- ").append(a.name()).append(" (").append(a.type()).append("): ")
                        .append(a.description());
            }
            return out.toString();
        }

        @Override
        public JsonNode inputSchema() {
            return NAMED_AGENT_SCHEMA;
        }

        /** Permission-free, like the role tools: the child's own calls pass the gate. */
        @Override
        public boolean needsPermission() {
            return false;
        }

        /** Offered while the session has an agent. */
        @Override
        public boolean offeredIn(java.nio.file.Path cwd) {
            return !now().isEmpty();
        }

        @Override
        public String execute(JsonNode input, ToolContext context) {
            List<NamedAgent> list = now();
            String name = input.path("agent").asText("");
            NamedAgent agent = list.stream().filter(a -> a.name().equals(name)).findFirst().orElse(null);
            if (agent == null) {
                return "ERROR: no agent named \"" + name + "\" in this session. Agents: "
                        + (list.isEmpty() ? "none" : list.stream().map(NamedAgent::name)
                        .collect(Collectors.joining(", "))) + ".";
            }
            String task = input.path("task").asText("");
            if (task.isBlank()) {
                return "ERROR: task must be a non-empty string.";
            }
            AgentType type = AgentType.fromId(agent.type()).orElse(null);
            if (type == null) {
                return "ERROR: agent " + agent.name() + " names an unknown type: " + agent.type() + ".";
            }
            return runChildrenInParallel(List.of(new ChildRequest(type, roleTask(agent.preamble(), task),
                    task.strip(), agent.name()))).getFirst();
        }
    }

    private static final JsonNode NAMED_AGENT_SCHEMA = parseSchema("""
            { "type": "object", "required": ["agent", "task"],
              "properties": {
                "agent": { "type": "string", "description": "An agent name exactly as the description lists it" },
                "task": { "type": "string", "description": "Complete, self-contained assignment" } } }
            """);

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

    /** How many helpers of this chat are in the slot queue now, for tests.
     *  @return the tickets not yet admitted or dropped */
    int slotsQueued() {
        return slots.queued();
    }

    /**
     * Card 492: the {@code careParagraph} setting a child spawned now starts
     * from. While a parent run is in flight it is the setting that run read at
     * its start, so a change between runs reaches parent and children
     * together; otherwise the session's value.
     *
     * @return the setting, or null for the shipped off
     */
    public String childCareParagraph() {
        Agent parent = currentParent;
        if (parent != null) {
            return parent.careSettingThisRun();
        }
        return config.careParagraph();
    }

    /**
     * Card 493: the read share a child spawned now starts from. While a
     * parent run is in flight it is the share that run read at its start, so
     * a child reads and describes {@code read_file} as its parent's run does;
     * otherwise the session's value.
     *
     * @return the share in per cent, or null for the shipped one
     */
    public Integer childReadSharePercent() {
        Agent parent = currentParent;
        if (parent != null) {
            return parent.readSharePercentThisRun();
        }
        return config.readSharePercent();
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
        // Card 505: the children this run may start in the background. Handed
        // to the parent before its run starts, so the loop meets them at its exits.
        BackgroundRun backgroundRun = new BackgroundRun(parentSignal, parentInbox, checkInMs);
        background = backgroundRun;
        parent.backgroundChildren(backgroundRun);

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
                background = null;
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
     * @param out         where report_status publishes its status events
     * @return the child's registry: policy-filtered belt plus report_status, never the spawn tools
     */
    private ToolRegistry registryFor(AgentType type, String childId, Consumer<RunEvent> out) {
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
        registry.register(new ReportStatusTool(childId, out));
        // Card 503: and message its parent, and list it. Hub and spoke (owner,
        // 2026-10-12): never another child, never a session.
        ChildSeat seat = new ChildSeat(childId);
        registry.register(new dev.spectroscope.core.messaging.SendMessageTool(seat));
        registry.register(new dev.spectroscope.core.messaging.ListAgentsTool(seat));
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

        String outcome = executeChild(type, task, childId, parentQueue::put, parentSignal, ticket, null);
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
     * @param out          where its events are forwarded: the shared queue, or a step's sink
     * @param parentSignal the parent's cancel; it also ends a wait for a slot
     * @param ticket       the child's place in the slot queue
     * @param stepProvider a playbook step's own provider (card 482), or null for this manager's
     * @return the child's memo or an "ERROR: " string; never throws
     */
    private String executeChild(AgentType type, String task, String childId,
                                Consumer<RunEvent> out, CancelSignal parentSignal,
                                SessionSlots.Ticket ticket, LlmProvider stepProvider) {
        SessionCount count = liveCount();
        if (slots.mustWait(ticket, count)) {
            out.accept(new RunEvent.AgentMessage(childId, config.parentAgentId(),
                    "status", "submitted", count.waitingText(), null, now()));
        }
        parentSignal.onCancel(slots::wake);
        if (!slots.acquire(ticket, this::liveCount, parentSignal)) {
            return "ERROR: [" + childId + "] " + endedBy(parentSignal) + " while it waited for a free slot.";
        }
        try {
            return runAdmittedChild(type, task, childId, out, parentSignal, stepProvider);
        } finally {
            slots.release();
        }
    }

    /**
     * Builds and runs one child that holds a slot; returns its memo or an
     * "ERROR: " string; never throws.
     *
     * @param type         profile deciding system prompt and tool registry
     * @param task         the prompt the child runs on
     * @param childId      the child's agentId, already drawn from the counter
     * @param out          where its events are forwarded: the shared queue, or a step's sink
     * @param parentSignal the parent's cancel; cancelling it cascades into the child's own signal
     * @param stepProvider a playbook step's own provider (card 482), or null for this manager's
     */
    private String runAdmittedChild(AgentType type, String task, String childId,
                                    Consumer<RunEvent> out, CancelSignal parentSignal,
                                    LlmProvider stepProvider) {
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
        long graceMs = firstTokenGraceMs(); // card 490: the one reader of the grace
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
        LlmProvider provider = stepProvider != null ? stepProvider : config.provider();
        // Card 482: a threshold and a window the operator typed describe the chat
        // model; a step child on another provider derives both from its own.
        boolean chatModel = provider == config.provider();
        // Card 502: the child's own inbox, opened by its loop for its run. It is
        // registered before the run starts so the parent can reach it from turn one.
        dev.spectroscope.core.peer.PeerInbox inbox = new dev.spectroscope.core.peer.PeerInbox();
        inbox.open();
        childRoles.put(childId, type.id()); // card 503: the role a listing shows
        childInboxes.put(childId, inbox);
        startedChildIds.add(childId); // hub and spoke: the refusal's words
        // A subagent is simply another Agent instance from our own core.
        Agent child = new Agent(AgentOptions.builder()
                .provider(provider)                   // the model lives in the provider
                .systemPrompt(RoleCatalog.SYSTEM_PROMPTS.get(type))
                .registry(registryFor(type, childId, out)) // + report_status; NEVER the spawn tools
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
                .compactionThreshold(chatModel ? config.compactionThreshold() : null)
                // Card 390: the window the operator set for the session, the
                // SAME holder the parent reads, so a change reaches a working
                // child from its next turn as it reaches the parent.
                .sessionWindow(chatModel ? config.sessionWindow() : null)
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
                // Card 492: the care paragraph of the parent run that spawns
                // this child. A child carries no spawn tool, so its paragraph
                // leaves the sentence about subagents out.
                .careParagraph(childCareParagraph())
                // Card 493: the read share of the parent run that spawns this
                // child, so the child's read_file says and checks the same.
                .readSharePercent(childReadSharePercent())
                .peerInbox(inbox)                     // card 502: its own, never the parent's
                .agentMessaging(childAgentMessaging()) // card 503: the parent run's switch
                .build());

        StringBuilder lastTurnText = new StringBuilder();
        long inputTokens = 0;
        long outputTokens = 0;
        childTasks.put(childId, task);
        try (EventStream childEvents = child.run(task, new RunOptions(childSignal, List.of()))) {
            // Forwarder loop — THE merge: drain the child's EventStream and put
            // every event into the PARENT queue. The for-each blocks between
            // events, which is fine on a virtual thread.
            for (RunEvent event : childEvents) {
                out.accept(event); // the merge, one line
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
            childInboxes.remove(childId); // card 502: the address leaves with the child
            childTasks.remove(childId);
            childRoles.remove(childId);   // card 503
            childStatus.remove(childId);
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
            return "ERROR: [" + childId + "] " + endedBy(parentSignal) + ".";
        }
        if (lastTurnText.toString().isBlank()) {
            return "ERROR: [" + childId + "] returned no final text.";
        }
        // Report the usage sum per child: delegation should visibly cost something.
        return "[" + childId + "] result (tokens: " + inputTokens + " in / " + outputTokens + " out):\n"
                + lastTurnText.toString().strip();
    }

    /**
     * Card 505: what ended a child from above: a cancel of the parent run, or
     * the parent run ending while a background child still ran.
     *
     * @param parentSignal the signal the child ran under
     * @return the words for the child's error line
     */
    private static String endedBy(CancelSignal parentSignal) {
        return BackgroundRun.STOP_PARENT_ENDED.equals(parentSignal.reason())
                ? "ended because its parent run ended before it finished"
                : "ended by cancellation of the parent run";
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
     * Card 482: one playbook step run as a child with no parent run in flight.
     *
     * @param type      the child profile
     * @param task      the full prompt the child runs on
     * @param ownerTask the assignment the A2A task message shows
     * @param label     the step marker, "playbook:" and the step id
     * @param provider  the step's own provider, or null for this manager's
     */
    public record StepChild(AgentType type, String task, String ownerTask, String label, LlmProvider provider) {
    }

    /**
     * What a step child came back with.
     *
     * @param childId the child's agent id, or null when the request was refused before a child existed
     * @param outcome the text executeChild returns: the result line and the answer, or an ERROR: string
     */
    public record StepResult(String childId, String outcome) {
        /** @return true when the outcome is an ERROR: string */
        public boolean failed() {
            return outcome.startsWith("ERROR:");
        }

        /** @return the child's final text, without the result line; empty on failure */
        public String answer() {
            if (failed()) {
                return "";
            }
            int newline = outcome.indexOf('\n');
            return newline < 0 ? "" : outcome.substring(newline + 1);
        }
    }

    /**
     * Card 482: runs one child for a playbook step. Unlike the spawn tools it
     * needs no parent run: the events go to {@code out} and the cancel comes
     * from the step's own signal. The child takes a slot of this chat's pool
     * like any helper (card 490).
     *
     * @param request what to run and on which provider
     * @param out     where every event of the envelope and the child goes
     * @param signal  the step's signal; cancelling it ends the child
     * @return the child id and its outcome; never throws
     */
    public StepResult runStep(StepChild request, Consumer<RunEvent> out, CancelSignal signal) {
        if (request.task() == null || request.task().isBlank()) {
            return new StepResult(null, "ERROR: task must be a non-empty string.");
        }
        String childId = nextChildId(request.type());
        SessionSlots.Ticket ticket = slots.enqueue();
        try {
            out.accept(new RunEvent.AgentSpawn(childId, config.parentAgentId(), request.task(), now()));
            out.accept(new RunEvent.AgentMessage(config.parentAgentId(), childId,
                    "task", "submitted", request.ownerTask(), request.label(), now()));
            String outcome = executeChild(request.type(), request.task(), childId, out, signal,
                    ticket, request.provider());
            out.accept(new RunEvent.AgentMessage(childId, config.parentAgentId(), "result",
                    outcome.startsWith("ERROR:") ? "failed" : "completed", outcome, request.label(), now()));
            return new StepResult(childId, outcome);
        } finally {
            slots.forget(ticket); // a child refused before its slot holds no place
        }
    }

    /** Card 506: the agent id the children's parent has, which a workflow's records name as the receiver.
     *  @return the parent agent's id */
    public String parentAgentId() {
        return config.parentAgentId();
    }

    /**
     * Card 506: one child of a workflow's fan-out step.
     *
     * @param role explore or worker
     * @param task the task
     */
    public record Spawn(String role, String task) {
    }

    /**
     * Card 506: a workflow's fan-out step while no model turn is open. The
     * step is the orchestrator: it starts its children through the real
     * {@code spawn_agents} with {@code background: true}, takes their status
     * lines and their messages to {@code parent} out of the session's inbox
     * and records each as a message the run received, and collects their
     * results through the real {@code wait_agents}. While it is open the
     * manager holds a background run and a merged stream as a parent run
     * would, so {@code list_agents} lists the children and a child reaches
     * its parent, never another child (hub and spoke, owner 2026-10-12).
     * Messages from other sessions stay in line
     * for the next model turn.
     */
    public final class Orchestration implements AutoCloseable {
        private final CancelSignal signal;
        private final BackgroundRun run;
        private final MergedEventStream merged;
        private final Thread pump;
        private final boolean openedInbox;
        private final java.util.concurrent.BlockingQueue<Boolean> wake = new java.util.concurrent.LinkedBlockingQueue<>();
        private final Runnable unhookSubmit;
        private final Runnable unhookCancel;
        private boolean closed;

        private Orchestration(java.util.function.Consumer<RunEvent> out, CancelSignal signal) {
            this.signal = signal;
            this.merged = new MergedEventStream(signal::cancel);
            this.run = new BackgroundRun(signal, parentInbox, checkInMs);
            dev.spectroscope.core.peer.PeerInbox inbox = parentInbox;
            this.openedInbox = inbox != null && !inbox.isOpen();
            if (openedInbox) {
                inbox.open();
            }
            this.unhookSubmit = inbox == null ? () -> { } : inbox.addSubmitListener(() -> wake.offer(Boolean.TRUE));
            run.addEndListener(() -> wake.offer(Boolean.TRUE));
            this.unhookCancel = signal.onCancel(() -> wake.offer(Boolean.TRUE));
            this.pump = Thread.ofVirtual().name("spectroscope-workflow-pump").start(() -> {
                for (RunEvent event : merged) {
                    out.accept(event);
                }
            });
        }

        /**
         * Starts the children through {@code spawn_agents} with {@code background: true}.
         *
         * @param children the children, in order
         * @return what the tool answered
         */
        public String spawn(List<Spawn> children) {
            com.fasterxml.jackson.databind.node.ObjectNode input = JSON.createObjectNode();
            com.fasterxml.jackson.databind.node.ArrayNode agents = input.putArray("agents");
            for (Spawn child : children) {
                agents.addObject().put("type", child.role()).put("task", child.task());
            }
            input.put("background", true);
            return new SpawnAgentsTool().execute(input, context());
        }

        /** @return the ids of the children this step started, in spawn order */
        public List<String> children() {
            return run.names();
        }

        /**
         * Blocks without polling until every child has ended or the step's
         * signal is cancelled. Each status line and each message a child sent
         * to {@code parent} is taken out of the inbox meanwhile and recorded as
         * an {@code agent_message} the run received; results stay for
         * {@link #collect()}.
         */
        public void awaitChildren() {
            while (true) {
                takeChildMessages();
                if (signal.isCancelled() || run.runningCount() == 0) {
                    takeChildMessages();
                    return;
                }
                try {
                    wake.take();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }

        private void takeChildMessages() {
            dev.spectroscope.core.peer.PeerInbox inbox = parentInbox;
            if (inbox == null) {
                return;
            }
            // A snapshot first: the run submits to the inbox under its own lock.
            java.util.Set<String> statuses = run.statusIds();
            // Only what the run itself submitted: a status line of a child, or a
            // child's send_message to parent. A peer may claim a child's name, and
            // a result stays for wait_agents: neither id is in these two sets.
            List<dev.spectroscope.core.peer.PeerEnvelope> taken =
                    inbox.take(e -> e.msgId() != null
                            && (statuses.contains(e.msgId()) || inRunToParent.contains(e.msgId())));
            if (taken.isEmpty()) {
                return;
            }
            for (dev.spectroscope.core.peer.PeerEnvelope message : taken) {
                merged.put(new RunEvent.AgentMessage(message.fromName() != null ? message.fromName() : message.from(),
                        config.parentAgentId(), "peer", "received", message.text(), message.msgId(), now()));
            }
            inbox.absorbed(taken);
        }

        /** @return what {@code wait_agents} answers for every child of this step */
        public String collect() {
            return new WaitAgentsTool().execute(JSON.createObjectNode(), context());
        }

        /**
         * @param event an event of the step, written to the same stream as the children's
         */
        public void emit(RunEvent event) {
            merged.put(event);
        }

        private Tool.ToolContext context() {
            return new Tool.ToolContext(config.cwd(), signal, config.parentAgentId(), "workflow-" + now(),
                    merged::put, attachment -> { }, change -> { }, ms -> { }, false);
        }

        /** Settles what still runs, ends the stream and gives the manager back. */
        @Override
        public void close() {
            synchronized (SubagentManager.this) {
                if (closed) {
                    return;
                }
                closed = true;
            }
            try {
                run.settle();
            } finally {
                takeChildMessages();
                merged.end();
                try {
                    pump.join();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                unhookSubmit.run();
                unhookCancel.run();
                dev.spectroscope.core.peer.PeerInbox inbox = parentInbox;
                if (openedInbox && inbox != null) {
                    inbox.close();
                }
                synchronized (SubagentManager.this) {
                    background = null;
                    currentStream = null;
                    currentParentSignal = null;
                }
            }
        }
    }

    /**
     * Card 506: opens a workflow's fan-out step. One at a time, and never
     * while a parent run is in flight.
     *
     * @param out    where every event of the step and its children goes, in order
     * @param signal the step's signal; its cancel reaches every child
     * @return the open step; close it to settle the children and end the stream
     * @throws IllegalStateException when a run or another step holds the manager
     */
    public synchronized Orchestration orchestrate(java.util.function.Consumer<RunEvent> out, CancelSignal signal) {
        if (currentStream != null) {
            throw new IllegalStateException("SubagentManager.orchestrate: a run is already active (one at a time).");
        }
        Orchestration o = new Orchestration(out, signal);
        currentStream = o.merged;
        currentParentSignal = signal;
        background = o.run;
        return o;
    }

    /**
     * Card 505: starts the children of one {@code spawn_agents} call in the
     * background and returns at once. Each child takes a slot of the chat's
     * pool like a blocking one, runs under the background run's signal, and
     * on its way out records its result on the stream and hands it to the run.
     *
     * @param requests the children, in the order asked
     * @return the names, or an ERROR: string when nothing was started
     */
    private String startInBackground(List<ChildRequest> requests) {
        if (!backgroundOffered()) {
            return "ERROR: background is not available in this session (agent messaging is off or nothing"
                    + " here can receive the children's messages); call spawn_agents without background.";
        }
        BackgroundRun run = background;
        MergedEventStream queue = currentStream;
        if (run == null || queue == null) {
            return "ERROR: spawn_agents only works inside SubagentManager.run.";
        }
        for (ChildRequest request : requests) {
            if (request.task() == null || request.task().isBlank()) {
                return "ERROR: task must be a non-empty string.";
            }
        }
        // Tickets in request order on this thread, as for a blocking batch.
        List<SessionSlots.Ticket> tickets = requests.stream().map(request -> slots.enqueue()).toList();
        List<String> started = new ArrayList<>();
        for (int i = 0; i < requests.size(); i++) {
            ChildRequest request = requests.get(i);
            SessionSlots.Ticket ticket = tickets.get(i);
            String childId = nextChildId(request.type());
            run.add(childId, request.type().id());
            queue.put(new RunEvent.AgentSpawn(childId, config.parentAgentId(), request.task(), now()));
            queue.put(new RunEvent.AgentMessage(config.parentAgentId(), childId,
                    "task", "submitted", request.ownerTask(), request.label(), now()));
            Thread.ofVirtual().name("spectroscope-background-" + childId).start(() -> {
                String outcome;
                try {
                    outcome = executeChild(request.type(), request.task(), childId, queue::put, run.signal(),
                            ticket, null);
                } catch (RuntimeException failure) {
                    outcome = "ERROR: [" + childId + "] unexpected failure: " + describe(failure);
                } finally {
                    slots.forget(ticket);
                }
                queue.put(new RunEvent.AgentMessage(childId, config.parentAgentId(), "result",
                        outcome.startsWith("ERROR:") ? "failed" : "completed", outcome, request.label(), now()));
                run.finished(childId, outcome);
            });
            started.add(childId + " (" + request.type().id() + ")");
        }
        SessionCount count = liveCount();
        return "Started " + started.size() + " children in the background: " + String.join(", ", started)
                + ". They run on this chat's slots" + (count.sessions() == null ? "" : ", at most "
                + count.helpersAtOnce() + " at once") + "; their status lines and results reach you as"
                + " messages at your next step. Ask one how far it is with send_message, list them with"
                + " list_agents, and collect their results with wait_agents. If your turn ends while they"
                + " still run, the run waits for them.";
    }

    /**
     * {@code wait_agents} (card 505): the join of a background fan-out. Only
     * the parent holds it; no child registry gets it, so depth stays one.
     */
    private final class WaitAgentsTool implements Tool {

        /** Wire name: {@code wait_agents}. */
        @Override
        public String name() {
            return "wait_agents";
        }

        /** A collected result is not handed over a second time (card 467).
         *  @return false */
        @Override
        public boolean resultRepeatable() {
            return false;
        }

        /** Names the children of the run in flight. */
        @Override
        public String description() {
            BackgroundRun run = background;
            List<String> names = run == null ? List.of() : run.names();
            return "Waits for children you started with spawn_agents and background true, and returns their"
                    + " results and the last status line of each one still running. It blocks without polling"
                    + " until they have ended or the timeout has passed. "
                    + (names.isEmpty() ? "No child of this run was started in the background yet."
                    : "Children of this run: " + String.join(", ", names) + ".");
        }

        @Override
        public JsonNode inputSchema() {
            return WAIT_AGENTS_SCHEMA;
        }

        /** Permission-free: it reads what the children already did. */
        @Override
        public boolean needsPermission() {
            return false;
        }

        @Override
        public String execute(JsonNode input, ToolContext context) {
            BackgroundRun run = background;
            List<String> known = run == null ? List.of() : run.names();
            if (known.isEmpty()) {
                return "ERROR: no child of this run was started in the background; spawn_agents with background"
                        + " true starts some.";
            }
            List<String> ids = new ArrayList<>();
            JsonNode asked = input.path("ids");
            if (!asked.isMissingNode() && !asked.isNull()) {
                if (!asked.isArray()) {
                    return "ERROR: ids must be an array of child names.";
                }
                for (JsonNode id : asked) {
                    String name = id.asText("");
                    if (!known.contains(name)) {
                        return "ERROR: no background child named \"" + name + "\" in this run. Children of"
                                + " this run: " + String.join(", ", known) + ".";
                    }
                    if (!ids.contains(name)) {
                        ids.add(name);
                    }
                }
            }
            if (ids.isEmpty()) {
                ids.addAll(known);
            }
            Long timeoutMs = waitAgentsTimeoutMs(input.path("timeoutSeconds"));
            if (timeoutMs == null) {
                return "ERROR: timeoutSeconds must be a number of seconds.";
            }
            return run.waitFor(ids, timeoutMs, context.signal());
        }
    }

    /**
     * The wait {@code wait_agents} asks of the run.
     *
     * @param timeout the {@code timeoutSeconds} field
     * @return -1 when it is left out or null (no limit), otherwise the seconds
     *         asked cut to 0 to {@link BackgroundRun#WAIT_MAX_SECONDS}, in
     *         milliseconds; null when it is not a number
     */
    static Long waitAgentsTimeoutMs(JsonNode timeout) {
        if (timeout == null || timeout.isMissingNode() || timeout.isNull()) {
            return -1L;
        }
        if (!timeout.isNumber()) {
            return null;
        }
        long seconds = Math.max(0, Math.min(BackgroundRun.WAIT_MAX_SECONDS, timeout.asLong()));
        return seconds * 1000L;
    }

    private static final JsonNode WAIT_AGENTS_SCHEMA = parseSchema("""
            { "type": "object",
              "properties": {
                "ids": { "type": "array", "items": { "type": "string" },
                  "description": "Child names from spawn_agents; every background child of this run when left out" },
                "timeoutSeconds": { "type": "integer", "minimum": 0, "maximum": %d,
                  "description": "Return after at most this many seconds; 0 returns at once with the status lines. Left out, it waits until they have ended." } } }
            """.formatted(BackgroundRun.WAIT_MAX_SECONDS));

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
        private final Consumer<RunEvent> parentQueue;

        /**
         * Binds the tool to one child run.
         *
         * @param childId     the reporting child — the message's sender side
         * @param parentQueue the merged stream the status messages surface on
         */
        private ReportStatusTool(String childId, Consumer<RunEvent> parentQueue) {
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
            String line = BackgroundRun.capped(message.strip()); // card 505, fix round two
            childStatus.put(childId, line); // card 503: the line list_agents shows
            parentQueue.accept(new RunEvent.AgentMessage(childId, config.parentAgentId(),
                    "status", "working", line, null, now()));
            // Card 505: a background child's line also reaches the parent's
            // inbox, since the parent is not blocked waiting for it.
            BackgroundRun run = background;
            if (run != null && run.holds(childId)) {
                run.status(childId, line);
            }
            return line.equals(message.strip()) ? "ok"
                    : "ok, cut to its first " + BackgroundRun.STATUS_LINE_CAP + " characters";
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
            String composed = roleTask(spec.preamble(), task);
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

    /** spawn_agents: starts up to the chat's batch width of subagents; the
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
            String base = RoleCatalog.spawnAgentsDescription(describedCount());
            return backgroundOffered() ? base + BACKGROUND_SENTENCE : base;
        }

        /** Requires an {@code agents} array of {type, task}, 1 to the batch width;
         *  card 505 adds {@code background} where it is offered. */
        @Override
        public JsonNode inputSchema() {
            int width = describedCount().batchWidth();
            return backgroundOffered() ? spawnAgentsBackgroundSchema(width) : spawnAgentsSchema(width);
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
            if (input.path("background").asBoolean(false)) {
                return startInBackground(requests);
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
