package dev.spectroscope.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntConsumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 502 criterion 5: the loop drains the peer inbox at the two safe points
 * steering uses, and hands the model one attribution block per message.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class AgentPeerInboxTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String BODY = "the build on main is red, check the javadoc";

    private static final class AlwaysWorks implements Tool {
        @Override public String name() {
            return "always_works";
        }

        @Override public String description() {
            return "does one small thing";
        }

        @Override public JsonNode inputSchema() {
            return JSON.createObjectNode().put("type", "object");
        }

        @Override public boolean needsPermission() {
            return false;
        }

        @Override public String execute(JsonNode input, ToolContext context) {
            return "done";
        }
    }

    private static List<LlmProvider.ProviderEvent> toolTurn(String callId) {
        return List.of(new LlmProvider.PToolCall(callId, "always_works", JSON.createObjectNode()),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
    }

    private static List<LlmProvider.ProviderEvent> answerTurn() {
        return List.of(new LlmProvider.PTextDelta("All set."),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    private static final class Recording implements LlmProvider {
        private final List<List<ProviderEvent>> script;
        private final IntConsumer duringTurn;
        final List<ProviderRequest> requests = new ArrayList<>();
        private final AtomicInteger next = new AtomicInteger();

        Recording(IntConsumer duringTurn, List<List<ProviderEvent>> script) {
            this.duringTurn = duringTurn;
            this.script = script;
        }

        @Override public String modelName() {
            return "fake-model-1";
        }

        @Override public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            int turn = next.incrementAndGet();
            duringTurn.accept(turn);
            return turn <= script.size() ? script.get(turn - 1) : answerTurn();
        }
    }

    private static PeerEnvelope message() {
        return PeerEnvelope.builder().msgId("0b6c6d8e-8a4d-4f0e-9b55-2b1f4a0c2d11")
                .from("uds:/tmp/spectro/4711.sock").fromSession("20261011-090000-abcdef12")
                .fromName("ForgeDemo-7f").fromMode("prompting").text(BODY).build();
    }

    private static Agent agent(LlmProvider provider, PeerInbox inbox, Integer maxTurns) {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new AlwaysWorks());
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .maxTurns(maxTurns)
                .peerInbox(inbox)
                .build());
    }

    private static List<RunEvent> run(Agent agent) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("do it", new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events;
    }

    private static String wholeHistory(ProviderRequest request) {
        StringBuilder all = new StringBuilder();
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof TextContent text) {
                    all.append(text.text()).append('\n');
                }
            }
        }
        return all.toString();
    }

    private static List<RunEvent.AgentMessage> peerLines(List<RunEvent> events) {
        return events.stream().filter(RunEvent.AgentMessage.class::isInstance)
                .map(RunEvent.AgentMessage.class::cast)
                .filter(m -> "peer".equals(m.role())).toList();
    }

    @Test
    void aMessageThatArrivesDuringTurnTwoIsReadAtTheStartOfTurnThree() {
        PeerInbox inbox = new PeerInbox();
        Recording provider = new Recording(turn -> {
            if (turn == 2) {
                inbox.submit(message());
            }
        }, List.of(toolTurn("c1"), toolTurn("c2"), answerTurn()));

        List<RunEvent> events = run(agent(provider, inbox, null));

        assertEquals(3, provider.requests.size());
        String turnThree = wholeHistory(provider.requests.get(2));
        assertTrue(turnThree.contains(AgentMessageBlock.render(message(), true)),
                "turn three reads the whole attribution block");
        assertFalse(wholeHistory(provider.requests.get(1)).contains(BODY));
        List<RunEvent.AgentMessage> peer = peerLines(events);
        assertEquals(1, peer.size());
        assertEquals("received", peer.getFirst().state());
        assertEquals("ForgeDemo-7f", peer.getFirst().from());
        assertEquals(BODY, peer.getFirst().text());
        assertEquals("0b6c6d8e-8a4d-4f0e-9b55-2b1f4a0c2d11", peer.getFirst().label(),
                "the label of a peer line carries the msg_id");
    }

    @Test
    void aMessageThatArrivesDuringTheLastTurnContinuesTheRunAtTheEndTurnExit() {
        PeerInbox inbox = new PeerInbox();
        Recording provider = new Recording(turn -> {
            if (turn == 1) {
                inbox.submit(message());
            }
        }, List.of(answerTurn(), answerTurn()));

        run(agent(provider, inbox, null));

        assertEquals(2, provider.requests.size(), "the end_turn exit read the message and went on");
        assertTrue(wholeHistory(provider.requests.get(1)).contains(AgentMessageBlock.TRAILER));
    }

    @Test
    void theHostLearnsWhatTheLoopAbsorbed() {
        PeerInbox inbox = new PeerInbox();
        List<PeerEnvelope> absorbed = new ArrayList<>();
        inbox.onAbsorbed(absorbed::addAll);
        Recording provider = new Recording(turn -> {
            if (turn == 1) {
                inbox.submit(message());
            }
        }, List.of(toolTurn("c1"), answerTurn()));

        run(agent(provider, inbox, null));

        assertEquals(List.of(message()), absorbed);
    }

    @Test
    void aMessageTheRunNeverReadIsHandedBackAndTheInboxCloses() {
        PeerInbox inbox = new PeerInbox();
        List<PeerEnvelope> unread = new ArrayList<>();
        inbox.onUnread(unread::addAll);
        Recording provider = new Recording(turn -> inbox.submit(message()), List.of(answerTurn()));

        List<RunEvent> events = run(agent(provider, inbox, 1));

        assertEquals(1, provider.requests.size(), "at the cap the message cannot buy a turn");
        assertEquals(List.of(message()), unread);
        assertFalse(inbox.isOpen());
        assertEquals(PeerInbox.Submitted.NO_RUN, inbox.submit(message()));
        assertTrue(peerLines(events).isEmpty(), "nothing was recorded as received");
    }

    @Test
    void theInboxIsOpenWhileTheRunWorks() {
        PeerInbox inbox = new PeerInbox();
        List<Boolean> openDuringTurn = new ArrayList<>();
        Recording provider = new Recording(turn -> openDuringTurn.add(inbox.isOpen()), List.of(answerTurn()));

        run(agent(provider, inbox, null));

        assertEquals(List.of(true), openDuringTurn);
        assertFalse(inbox.isOpen());
    }

    @Test
    void aDeliveryNoticeIsReadAtTheNextSafePointAsItIs() {
        PeerInbox inbox = new PeerInbox();
        inbox.notice("[Delivery notice] Your message to ForgeDemo-7f was dropped.");
        Recording provider = new Recording(turn -> { }, List.of(toolTurn("c1"), answerTurn()));

        run(agent(provider, inbox, null));

        assertTrue(wholeHistory(provider.requests.get(0)).contains("[Delivery notice] Your message to ForgeDemo-7f"),
                "a notice that waited before the run is read in its first turn");
        assertTrue(inbox.takeNotices().isEmpty(), "taken means gone");
    }
    // Card 504, hub and spoke review round 1: the guide says the goal's check
    // does not run at a turn end while a message from another agent waits.
    // This pins that exit with a goal stated, as AgentSteeringTest pins it for
    // a typed sentence (GoalCheckGuideDriftTest ties the sentence to it).

    /** A goal check that is met at once and counts its runs. */
    private static final class CountingCheck implements dev.spectroscope.core.goal.GoalCheck {
        final AtomicInteger runs = new AtomicInteger();

        @Override public dev.spectroscope.core.goal.GoalVerdict run(dev.spectroscope.core.goal.RunGoal goal,
                                                                   Context context) {
            runs.incrementAndGet();
            return new dev.spectroscope.core.goal.GoalVerdict(dev.spectroscope.core.goal.GoalVerdict.Outcome.MET,
                    "node --test", 0, "ok 4", 12, null, null, "met: the check exited 0");
        }
    }

    @Test
    @GuideExit("goal-check.waiting-message")
    void aWaitingAgentMessageKeepsARunWithAStatedGoalAliveAndTheCheckRunsOnceAtTheLastExit() {
        PeerInbox inbox = new PeerInbox();
        CountingCheck check = new CountingCheck();
        dev.spectroscope.core.goal.SessionGoal goal = new dev.spectroscope.core.goal.SessionGoal(check);
        goal.state(new dev.spectroscope.core.goal.RunGoal("The auth tests pass.", "node --test"));
        Recording provider = new Recording(turn -> {
            if (turn == 1) {
                inbox.submit(message());
            }
        }, List.of(answerTurn(), answerTurn()));
        ToolRegistry registry = new ToolRegistry();
        registry.register(new AlwaysWorks());
        Agent agent = new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("test")
                .registry(registry)
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .peerInbox(inbox)
                .goal(goal)
                .build());

        List<RunEvent> events = run(agent);

        assertEquals(2, provider.requests.size(),
                "turn 1 answered with a goal stated; the waiting message buys turn 2");
        assertTrue(wholeHistory(provider.requests.get(1)).contains(AgentMessageBlock.TRAILER),
                "the request for turn 2 carries the message");
        assertEquals(1, check.runs.get(),
                "the check ran once, at the exit that ended the run, not at the one the message kept open");
        assertEquals(1, events.stream().filter(RunEvent.GoalCheck.class::isInstance).count(),
                "one verdict on the stream");
    }
}
