package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.messaging.AgentRow;
import dev.spectroscope.core.messaging.MessagingSeat;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 503, criterion 6: every child carries send_message and list_agents
 * beside report_status, its listing shows its parent only (hub and spoke,
 * owner 2026-10-12; a child of any role never addresses another child),
 * and a child's message to {@code parent} reaches the parent's next turn as an
 * attributed block, recorded as sent and received.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ChildMessagingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Tool listDir() {
        return new Tool() {
            public String name() { return "list_dir"; }
            public String description() { return "fake"; }
            public JsonNode inputSchema() { return JSON.createObjectNode(); }
            public boolean needsPermission() { return false; }
            public String execute(JsonNode input, ToolContext context) { return "ok"; }
        };
    }

    private static List<LlmProvider.ProviderEvent> text(String words) {
        return List.of(new LlmProvider.PTextDelta(words), new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static List<LlmProvider.ProviderEvent> tool(String id, String name, JsonNode input) {
        return List.of(new LlmProvider.PToolCall(id, name, input),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static String history(ProviderRequest request) {
        StringBuilder all = new StringBuilder();
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof TextContent t) {
                    all.append(t.text()).append('\n');
                } else if (content instanceof ToolResultContent r) {
                    all.append(r.output()).append('\n');
                }
            }
        }
        return all.toString();
    }

    private static String firstUser(ProviderRequest request) {
        for (ProviderContent content : request.messages().getFirst().content()) {
            if (content instanceof TextContent t) {
                return t.text();
            }
        }
        return "";
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue(latch.await(20, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    private static SubagentManager manager(LlmProvider provider) {
        return new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(listDir()))
                .build(), 30_000);
    }

    private static Agent parent(LlmProvider provider, SubagentManager manager, PeerInbox inbox) {
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .peerInbox(inbox)
                .build());
    }

    private static List<RunEvent> collect(SubagentManager manager, Agent parent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = manager.run(parent, "go", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String idOf(SubagentManager manager, String task) {
        for (Map.Entry<String, String> entry : manager.runningChildren().entrySet()) {
            if (entry.getValue().contains(task)) {
                return entry.getKey();
            }
        }
        throw new AssertionError("no running child with " + task);
    }

    @Test
    void aChildCarriesBothToolsAndListsItsParentOnly() throws Exception {
        CountDownLatch reported = new CountDownLatch(1);
        CountDownLatch listed = new CountDownLatch(1);
        List<ProviderRequest> childA = new CopyOnWriteArrayList<>();
        AtomicReference<String> idB = new AtomicReference<>();
        AtomicReference<SubagentManager> holder = new AtomicReference<>();
        LlmProvider provider = new LlmProvider() {
            final java.util.concurrent.atomic.AtomicInteger parentCalls = new java.util.concurrent.atomic.AtomicInteger();
            final java.util.concurrent.atomic.AtomicInteger bCalls = new java.util.concurrent.atomic.AtomicInteger();

            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return parentCalls.incrementAndGet() == 1
                            ? tool("p1", "spawn_agents", json("{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},"
                                    + "{\"type\":\"explore\",\"task\":\"task B\"}]}"))
                            : text("both done");
                }
                if (firstUser(request).contains("task B")) {
                    if (bCalls.incrementAndGet() == 1) {
                        idB.set(idOf(holder.get(), "task B"));
                        return tool("b1", "report_status", json("{\"message\":\"reading the parser\"}"));
                    }
                    reported.countDown();
                    await(listed);
                    return text("B done");
                }
                childA.add(request);
                if (childA.size() == 1) {
                    await(reported);
                    return tool("a1", "list_agents", JSON.createObjectNode());
                }
                listed.countDown();
                return text("A done");
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        collect(manager, parent(provider, manager, null));

        List<String> tools = childA.getFirst().tools().stream().map(LlmProvider.ToolSpec::name).toList();
        assertTrue(tools.contains("send_message"), tools.toString());
        assertTrue(tools.contains("list_agents"), tools.toString());
        assertTrue(tools.contains("report_status"), tools.toString());
        String listing = history(childA.get(1));
        assertTrue(listing.contains("This agent is explore-"), listing);
        assertTrue(listing.contains("Parent (1):\n  parent ["), listing);
        assertFalse(listing.contains("Siblings"), listing);
        assertFalse(listing.contains(idB.get()), "the other child is not listed: " + listing);
        assertFalse(listing.contains("reading the parser"), "nor its status line: " + listing);
        assertFalse(listing.contains("Peer sessions"), listing);
        assertFalse(listing.contains("Children ("), listing);
        // What the child's two tools tell its model: the parent is its only address.
        LlmProvider.ToolSpec send = childA.getFirst().tools().stream()
                .filter(spec -> spec.name().equals("send_message")).findFirst().orElseThrow();
        assertTrue(send.description().contains("only your parent"), send.description());
        assertTrue(send.inputSchema().path("properties").path("to").path("description").asText()
                .contains("parent"), send.inputSchema().toString());
        assertFalse(send.inputSchema().path("properties").path("to").path("description").asText()
                .contains("or a child"), send.inputSchema().toString());
        LlmProvider.ToolSpec list = childA.getFirst().tools().stream()
                .filter(spec -> spec.name().equals("list_agents")).findFirst().orElseThrow();
        assertTrue(list.description().contains("your parent"), list.description());
    }

    /**
     * Hub and spoke (owner, 2026-10-12), for every role: an explore child and
     * a worker child each address the other by its name, then a session by
     * name. Every call is refused with a result that names the parent as the
     * only address, no message leaves either child, and neither child ever
     * reads the other's text.
     */
    @Test
    void aChildOfEitherRoleThatAddressesASiblingOrASessionIsRefusedAndTheOtherNeverReadsIt() throws Exception {
        CountDownLatch running = new CountDownLatch(2);
        CountDownLatch triedAll = new CountDownLatch(2);
        Map<String, List<ProviderRequest>> byTask = new java.util.concurrent.ConcurrentHashMap<>();
        AtomicReference<SubagentManager> holder = new AtomicReference<>();
        LlmProvider provider = new LlmProvider() {
            final java.util.concurrent.atomic.AtomicInteger parentCalls = new java.util.concurrent.atomic.AtomicInteger();

            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return parentCalls.incrementAndGet() == 1
                            ? tool("p1", "spawn_agents", json("{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},"
                                    + "{\"type\":\"worker\",\"task\":\"task B\"}]}"))
                            : text("both done");
                }
                String own = firstUser(request).contains("task A") ? "task A" : "task B";
                String other = own.equals("task A") ? "task B" : "task A";
                List<ProviderRequest> mine = byTask.computeIfAbsent(own, k -> new CopyOnWriteArrayList<>());
                mine.add(request);
                switch (mine.size()) {
                    case 1 -> {
                        running.countDown();
                        await(running);
                        String to = idOf(holder.get(), other);
                        return tool(own + "-1", "send_message",
                                json("{\"to\":\"" + to + "\",\"message\":\"SIBLING-NOTE from " + own + "\"}"));
                    }
                    case 2 -> {
                        return tool(own + "-2", "send_message",
                                json("{\"to\":\"ForgeDemo-7f\",\"message\":\"SESSION-NOTE from " + own + "\"}"));
                    }
                    case 3 -> {
                        triedAll.countDown();
                        await(triedAll);
                        return tool(own + "-3", "list_dir", JSON.createObjectNode());
                    }
                    default -> {
                        return text(own + " done");
                    }
                }
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        List<RunEvent> events = collect(manager, parent(provider, manager, null));

        for (String task : List.of("task A", "task B")) {
            List<ProviderRequest> requests = byTask.get(task);
            assertEquals(4, requests.size(), task + " ran four turns");
            String toSibling = lastToolResult(requests.get(1));
            assertTrue(toSibling.startsWith("ERROR: Not sent:"), task + ": " + toSibling);
            assertTrue(toSibling.contains("another child agent"), task + ": " + toSibling);
            assertTrue(toSibling.contains("only its parent"), task + ": " + toSibling);
            String toSession = lastToolResult(requests.get(2));
            assertTrue(toSession.startsWith("ERROR: Not sent:"), task + ": " + toSession);
            assertTrue(toSession.contains("only its parent"), task + ": " + toSession);
            String other = task.equals("task A") ? "task B" : "task A";
            assertFalse(history(requests.get(3)).contains("SIBLING-NOTE from " + other),
                    task + " never read the other child's text");
        }
        assertEquals(List.of(), events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                        .map(RunEvent.AgentMessage.class::cast).filter(m -> "peer".equals(m.role()))
                        .filter(m -> m.text().contains("-NOTE from")).toList(),
                "no note left either child");
    }

    /**
     * Hub and spoke, found live on 2026-10-12: a child that names another
     * child which has already finished still hears that the name is another
     * child agent, not merely that it is not its parent.
     */
    @Test
    void aChildThatNamesAFinishedSiblingHearsItIsAnotherChildAgent() throws Exception {
        List<ProviderRequest> childA = new CopyOnWriteArrayList<>();
        AtomicReference<String> idB = new AtomicReference<>();
        AtomicReference<SubagentManager> holder = new AtomicReference<>();
        LlmProvider provider = new LlmProvider() {
            final java.util.concurrent.atomic.AtomicInteger parentCalls = new java.util.concurrent.atomic.AtomicInteger();

            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return parentCalls.incrementAndGet() == 1
                            ? tool("p1", "spawn_agents", json("{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},"
                                    + "{\"type\":\"explore\",\"task\":\"task B\"}]}"))
                            : text("both done");
                }
                if (firstUser(request).contains("task B")) {
                    idB.set(idOf(holder.get(), "task B"));
                    return text("B done");
                }
                childA.add(request);
                if (childA.size() == 1) {
                    long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                    while ((idB.get() == null || holder.get().runningChildren().containsKey(idB.get()))
                            && System.nanoTime() < until) {
                        try {
                            Thread.sleep(10);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            throw new AssertionError(e);
                        }
                    }
                    assertFalse(idB.get() == null || holder.get().runningChildren().containsKey(idB.get()),
                            "premise: B has finished before A writes to it");
                    return tool("a1", "send_message", json("{\"to\":\"" + idB.get() + "\",\"message\":\"late\"}"));
                }
                return text("A done");
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        collect(manager, parent(provider, manager, null));

        String result = lastToolResult(childA.get(1));
        assertTrue(result.startsWith("ERROR: Not sent: " + idB.get() + " is another child agent."), result);
        assertTrue(result.contains("only its parent"), result);
    }

    /**
     * Hub and spoke review, round 1: a child that writes another child's id
     * in another case still hears that the name is another child agent.
     */
    @Test
    void aChildThatNamesASiblingInAnotherCaseHearsItIsAnotherChildAgent() throws Exception {
        String[] written = new String[1];
        String result = siblingRefusal(id -> {
            String upper = id.toUpperCase(java.util.Locale.ROOT);
            assertFalse(upper.equals(id), "premise: the case variant differs from the id");
            written[0] = upper;
            return upper;
        });
        assertTrue(result.startsWith("ERROR: Not sent: " + written[0] + " is another child agent."), result);
    }

    /**
     * Hub and spoke review, round 2: a ref suffix as list_agents prints one, or
     * an invisible character after the id, does not hide that the name is
     * another child agent. The refusal names the right fact, and nothing is sent.
     */
    @Test
    void aChildThatNamesASiblingWithARefSuffixHearsItIsAnotherChildAgent() throws Exception {
        String result = siblingRefusal(id -> id + " [aaaaaa]");
        assertTrue(result.startsWith("ERROR: Not sent:"), result);
        assertTrue(result.contains(" is another child agent."), result);
        assertFalse(result.contains("is not your parent"), "a false fact: " + result);
    }

    @Test
    void aChildThatNamesASiblingWithAZeroWidthSpaceHearsItIsAnotherChildAgent() throws Exception {
        String result = siblingRefusal(id -> id + "\u200B");
        assertTrue(result.startsWith("ERROR: Not sent:"), result);
        assertTrue(result.contains(" is another child agent."), result);
        assertFalse(result.contains("is not your parent"), "a false fact: " + result);
    }

    /**
     * Two explore children run; child A writes to child B under the address
     * {@code write} makes of B's id, and the tool result A reads back is
     * returned.
     */
    private String siblingRefusal(java.util.function.UnaryOperator<String> write) throws Exception {
        List<ProviderRequest> childA = new CopyOnWriteArrayList<>();
        AtomicReference<String> idB = new AtomicReference<>();
        AtomicReference<SubagentManager> holder = new AtomicReference<>();
        LlmProvider provider = new LlmProvider() {
            final java.util.concurrent.atomic.AtomicInteger parentCalls = new java.util.concurrent.atomic.AtomicInteger();

            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return parentCalls.incrementAndGet() == 1
                            ? tool("p1", "spawn_agents", json("{\"agents\":[{\"type\":\"explore\",\"task\":\"task A\"},"
                                    + "{\"type\":\"explore\",\"task\":\"task B\"}]}"))
                            : text("both done");
                }
                if (firstUser(request).contains("task B")) {
                    idB.set(idOf(holder.get(), "task B"));
                    return text("B done");
                }
                childA.add(request);
                if (childA.size() == 1) {
                    long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
                    while (idB.get() == null && System.nanoTime() < until) {
                        try {
                            Thread.sleep(10);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                            throw new AssertionError(e);
                        }
                    }
                    assertFalse(idB.get() == null, "premise: B has started before A writes to it");
                    String to = write.apply(idB.get());
                    String quoted = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.textNode(to).toString();
                    return tool("a1", "send_message", json("{\"to\":" + quoted + ",\"message\":\"hi\"}"));
                }
                return text("A done");
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        collect(manager, parent(provider, manager, null));
        assertTrue(childA.size() >= 2, "positive: child A read the result of its send");
        return lastToolResult(childA.get(1));
    }

    /** The output of the last tool result in a request. */
    private static String lastToolResult(ProviderRequest request) {
        String out = "";
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent r) {
                    out = r.output();
                }
            }
        }
        return out;
    }

    @Test
    void aChildsMessageToParentReachesTheParentsNextTurn() throws Exception {
        List<ProviderRequest> parentRequests = new CopyOnWriteArrayList<>();
        List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();
        PeerInbox parentInbox = new PeerInbox();
        LlmProvider provider = request -> {
            if (!request.system().contains("subagent")) {
                parentRequests.add(request);
                return parentRequests.size() == 1
                        ? tool("p1", "spawn_agent", json("{\"type\":\"explore\",\"task\":\"look\"}"))
                        : text("parent done");
            }
            childRequests.add(request);
            return childRequests.size() == 1
                    ? tool("c1", "send_message", json("{\"to\":\"parent\",\"message\":\"parent, I found it\"}"))
                    : text("child done");
        };
        SubagentManager manager = manager(provider);
        manager.parentInbox(parentInbox);
        List<RunEvent> events = collect(manager, parent(provider, manager, parentInbox));

        String childSaw = history(childRequests.get(1));
        assertTrue(childSaw.contains("Sent \"parent, I found it\" to parent"), childSaw);
        assertTrue(history(parentRequests.get(1)).contains("parent, I found it"));
        List<RunEvent.AgentMessage> peer = events.stream().filter(e -> e instanceof RunEvent.AgentMessage)
                .map(e -> (RunEvent.AgentMessage) e).filter(m -> "peer".equals(m.role())).toList();
        assertEquals(2, peer.size(), peer.toString());
        assertEquals("sent", peer.get(0).state());
        assertEquals("received", peer.get(1).state());
        assertEquals(peer.get(0).label(), peer.get(1).label(), "one msg_id for both records");
        assertEquals("main", peer.get(1).to());
    }

    @Test
    void theParentsSeatReachesARunningChild() throws Exception {
        List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();
        AtomicReference<MessagingSeat.Sent> sent = new AtomicReference<>();
        AtomicReference<List<AgentRow>> seen = new AtomicReference<>();
        AtomicReference<SubagentManager> holder = new AtomicReference<>();
        LlmProvider provider = new LlmProvider() {
            final java.util.concurrent.atomic.AtomicInteger parentCalls = new java.util.concurrent.atomic.AtomicInteger();

            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    return parentCalls.incrementAndGet() == 1
                            ? tool("p1", "spawn_agent", json("{\"type\":\"explore\",\"task\":\"look\"}"))
                            : text("parent done");
                }
                childRequests.add(request);
                if (childRequests.size() == 1) {
                    List<AgentRow> rows = holder.get().childRows();
                    seen.set(rows);
                    sent.set(holder.get().sendFromParent(rows.getFirst(), "child, stop at the first hit",
                            "child, stop"));
                    return tool("c1", "list_dir", JSON.createObjectNode());
                }
                return text("child done");
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        collect(manager, parent(provider, manager, null));
        assertEquals(1, seen.get().size());
        assertEquals(AgentRow.Kind.CHILD, seen.get().getFirst().kind());
        assertEquals("explore", seen.get().getFirst().face());
        assertTrue(sent.get().ok(), String.valueOf(sent.get().error()));
        String childSaw = history(childRequests.get(1));
        assertTrue(childSaw.contains("child, stop at the first hit"), childSaw);
        assertTrue(childSaw.contains("from=\"parent\""), childSaw);
    }

    private static SubagentManager manager(LlmProvider provider, Boolean agentMessaging) {
        return new SubagentManager(SubagentConfig.builder()
                .provider(provider)
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of(listDir()))
                .agentMessaging(agentMessaging)
                .build(), 30_000);
    }

    private static List<String> stepChildTools(Boolean agentMessaging) {
        List<ProviderRequest> requests = new CopyOnWriteArrayList<>();
        LlmProvider provider = request -> {
            requests.add(request);
            return text("step done");
        };
        SubagentManager manager = manager(provider, agentMessaging);
        SubagentManager.StepResult result = manager.runStep(new SubagentManager.StepChild(AgentType.EXPLORE,
                "look at the parser", "look at the parser", "playbook:read", null), event -> { },
                new CancelSignal());
        assertFalse(result.failed(), result.outcome());
        return requests.getFirst().tools().stream().map(LlmProvider.ToolSpec::name).toList();
    }

    @Test
    void aStepChildCarriesNeitherMessagingToolWhenTheKeyIsOff() {
        List<String> tools = stepChildTools(false);
        assertFalse(tools.contains("send_message"), tools.toString());
        assertFalse(tools.contains("list_agents"), tools.toString());
        assertTrue(tools.contains("list_dir"), tools.toString());
        assertTrue(tools.contains("report_status"), tools.toString());
    }

    @Test
    void aStepChildCarriesBothMessagingToolsWhenTheKeyIsOn() {
        for (Boolean on : java.util.Arrays.asList(Boolean.TRUE, null)) {
            List<String> tools = stepChildTools(on);
            assertTrue(tools.contains("send_message"), on + " " + tools);
            assertTrue(tools.contains("list_agents"), on + " " + tools);
            assertTrue(tools.contains("list_dir"), on + " " + tools);
        }
    }

    @Test
    void aParentRunWithTheKeyOffSpawnsAChildWithoutEitherTool() {
        List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();
        LlmProvider provider = request -> {
            if (!request.system().contains("subagent")) {
                return request.messages().size() == 1
                        ? tool("p1", "spawn_agent", json("{\"type\":\"explore\",\"task\":\"look\"}"))
                        : text("parent done");
            }
            childRequests.add(request);
            return text("child done");
        };
        SubagentManager manager = manager(provider, false);
        ToolRegistry registry = new ToolRegistry();
        manager.tools().forEach(registry::register);
        Agent parent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("You are the parent.")
                .registry(registry)
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .agentMessaging(false)
                .build());
        collect(manager, parent);
        List<String> tools = childRequests.getFirst().tools().stream().map(LlmProvider.ToolSpec::name).toList();
        assertFalse(tools.contains("send_message"), tools.toString());
        assertFalse(tools.contains("list_agents"), tools.toString());
        assertTrue(tools.contains("list_dir"), tools.toString());
    }
}
