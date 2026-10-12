package dev.spectroscope.core.subagents;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.peer.AgentMessageBlock;
import dev.spectroscope.core.peer.PeerEnvelope;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
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
 * Card 502 criterion 10: a child's run opens its own peer inbox in the child
 * builder. Hub and spoke (owner, 2026-10-12): a child's address space is its
 * parent only; a message from one child to another is refused by the run.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ChildPeerInboxTest {

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

    private static PeerEnvelope note(String text) {
        return PeerEnvelope.builder().msgId(java.util.UUID.randomUUID().toString()).fromName("sender")
                .fromMode("prompting").text(text).build();
    }

    private record Run(SubagentManager manager, List<RunEvent> events) {
    }

    /** Hub and spoke (owner, 2026-10-12). Two explore children; task A
     *  addresses B from inside its first turn while B runs, B waits for that
     *  before it ends its first turn with a tool call. The run refuses it and
     *  B never reads it. */
    @Test
    void aChildsMessageToASiblingIsRefusedAndNeverReachesIt() throws Exception {
        CountDownLatch bothRunning = new CountDownLatch(2);
        CountDownLatch sent = new CountDownLatch(1);
        AtomicReference<SubagentManager.InRunDelivery> outcome = new AtomicReference<>();
        List<ProviderRequest> childBRequests = new CopyOnWriteArrayList<>();
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
                String task = firstUser(request);
                if (task.contains("task B")) {
                    childBRequests.add(request);
                    if (childBRequests.size() == 1) {
                        bothRunning.countDown();
                        await(sent);
                        return tool("b1", "list_dir", JSON.createObjectNode());
                    }
                    return text("B read it");
                }
                bothRunning.countDown();
                await(bothRunning);
                SubagentManager manager = holder.get();
                String a = idOf(manager, "task A");
                String b = idOf(manager, "task B");
                outcome.set(manager.deliverInRun(a, b, note("B, the schema moved to v2")));
                sent.countDown();
                return text("A done");
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        collect(manager, parent(provider, manager, null));

        assertEquals(SubagentManager.InRunDelivery.NOT_PARENT, outcome.get());
        assertEquals(2, childBRequests.size(), "B ran a second turn");
        assertFalse(history(childBRequests.get(1)).contains("B, the schema moved to v2"),
                "a sibling's text never reaches the other child");
        assertFalse(history(childBRequests.get(1)).contains(AgentMessageBlock.TRAILER),
                "no message block at all reached B");
        assertTrue(manager.runningChildren().isEmpty(), "every inbox left with its child");
    }

    /** Hub and spoke (owner, 2026-10-12): a running child's seat lists its
     *  parent and nobody else, tells another child of the run from any other
     *  name, and refuses a session. */
    @Test
    void aChildsSeatListsItsParentOnlyAndKnowsAnotherChildOfTheRunByName() throws Exception {
        CountDownLatch bothRunning = new CountDownLatch(2);
        CountDownLatch looked = new CountDownLatch(1);
        AtomicReference<List<dev.spectroscope.core.messaging.AgentRow>> rows = new AtomicReference<>();
        AtomicReference<List<Boolean>> siblings = new AtomicReference<>();
        AtomicReference<String> toSession = new AtomicReference<>();
        AtomicReference<dev.spectroscope.core.messaging.MessagingSeat.Sent> toSibling = new AtomicReference<>();
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
                bothRunning.countDown();
                await(bothRunning);
                if (firstUser(request).contains("task A")) {
                    SubagentManager manager = holder.get();
                    String a = idOf(manager, "task A");
                    String b = idOf(manager, "task B");
                    dev.spectroscope.core.messaging.MessagingSeat seat = manager.childSeat(a);
                    rows.set(seat.runAgents());
                    siblings.set(List.of(seat.sibling(b), seat.sibling(a), seat.sibling("parent"),
                            seat.sibling("ForgeDemo-7f")));
                    toSession.set(seat.sendToSession(dev.spectroscope.core.messaging.AgentRow.inRun(
                            dev.spectroscope.core.messaging.AgentRow.Kind.PARENT, "ForgeDemo-7f", "s2", "server",
                            "idle", null), "hi", "hi").error());
                    toSibling.set(seat.sendInRun(dev.spectroscope.core.messaging.AgentRow.inRun(
                            dev.spectroscope.core.messaging.AgentRow.Kind.CHILD, b, b, "worker", "working", null),
                            "SEAT-NOTE", "SEAT-NOTE"));
                    looked.countDown();
                } else {
                    await(looked);
                }
                return text("done");
            }
        };
        SubagentManager manager = manager(provider);
        holder.set(manager);
        collect(manager, parent(provider, manager, null));

        assertEquals(1, rows.get().size(), rows.get().toString());
        assertEquals(dev.spectroscope.core.messaging.AgentRow.Kind.PARENT, rows.get().getFirst().kind());
        assertEquals("parent", rows.get().getFirst().name());
        assertEquals(List.of(true, false, false, false), siblings.get(),
                "another child of the run, itself, the parent, a session");
        assertTrue(toSession.get().contains("only its parent"), toSession.get());
        assertFalse(toSibling.get().ok(), "the run refuses a row of another child handed to the seat");
        assertTrue(toSibling.get().error().contains("another child agent"), toSibling.get().error());
        assertTrue(toSibling.get().error().contains("only its parent"), toSibling.get().error());
    }

    @Test
    void theParentReachesARunningChildAndAChildReachesItsParent() throws Exception {
        CountDownLatch childReady = new CountDownLatch(1);
        CountDownLatch delivered = new CountDownLatch(1);
        AtomicReference<SubagentManager.InRunDelivery> down = new AtomicReference<>();
        AtomicReference<SubagentManager.InRunDelivery> up = new AtomicReference<>();
        AtomicReference<SubagentManager.InRunDelivery> stranger = new AtomicReference<>();
        AtomicReference<SubagentManager.InRunDelivery> self = new AtomicReference<>();
        List<ProviderRequest> childRequests = new CopyOnWriteArrayList<>();
        List<ProviderRequest> parentRequests = new CopyOnWriteArrayList<>();
        AtomicReference<SubagentManager> holder = new AtomicReference<>();
        PeerInbox parentInbox = new PeerInbox();
        LlmProvider provider = new LlmProvider() {
            @Override
            public Iterable<ProviderEvent> stream(ProviderRequest request) {
                if (!request.system().contains("subagent")) {
                    parentRequests.add(request);
                    return parentRequests.size() == 1
                            ? tool("p1", "spawn_agent", json("{\"type\":\"explore\",\"task\":\"look\"}"))
                            : text("parent done");
                }
                childRequests.add(request);
                if (childRequests.size() == 1) {
                    SubagentManager manager = holder.get();
                    String child = manager.runningChildren().keySet().iterator().next();
                    down.set(manager.deliverInRun("main", child, note("child, stop at the first hit")));
                    up.set(manager.deliverInRun(child, "parent", note("parent, I found it")));
                    stranger.set(manager.deliverInRun("ForgeDemo-7f", child, note("a peer session")));
                    self.set(manager.deliverInRun(child, child, note("a note to myself")));
                    return tool("c1", "list_dir", JSON.createObjectNode());
                }
                return text("child done");
            }
        };
        SubagentManager manager = manager(provider);
        manager.parentInbox(parentInbox);
        holder.set(manager);
        collect(manager, parent(provider, manager, parentInbox));

        assertEquals(SubagentManager.InRunDelivery.QUEUED, down.get());
        assertEquals(SubagentManager.InRunDelivery.QUEUED, up.get());
        assertEquals(SubagentManager.InRunDelivery.UNKNOWN, stranger.get(),
                "a name outside the run cannot reach a running child");
        assertTrue(!history(childRequests.get(1)).contains("a peer session"));
        assertEquals(SubagentManager.InRunDelivery.UNKNOWN, self.get(), "a child is not its own recipient");
        assertTrue(!history(childRequests.get(1)).contains("a note to myself"));
        assertTrue(history(childRequests.get(1)).contains("child, stop at the first hit"));
        assertTrue(history(parentRequests.get(1)).contains("parent, I found it"));
    }

    @Test
    void aNameOutsideTheRunIsNotInTheAddressSpace() {
        LlmProvider idle = request -> text("x");
        SubagentManager manager = manager(idle);
        assertEquals(SubagentManager.InRunDelivery.UNKNOWN, manager.deliverInRun("main", "explore-9", note("x")));
        assertEquals(SubagentManager.InRunDelivery.UNKNOWN,
                manager.deliverInRun("ForgeDemo-7f", "main", note("a peer session is not a member")));
        assertTrue(!manager.isChild("ForgeDemo-7f"));
        assertEquals(SubagentManager.InRunDelivery.UNKNOWN, manager.deliverInRun("main", "parent", note("self")),
                "the parent is not its own recipient");
    }

    private static String idOf(SubagentManager manager, String task) {
        for (Map.Entry<String, String> entry : manager.runningChildren().entrySet()) {
            if (entry.getValue().contains(task)) {
                return entry.getKey();
            }
        }
        throw new AssertionError("no running child with " + task + ": " + manager.runningChildren());
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue(latch.await(20, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }

    private static JsonNode json(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
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
}
