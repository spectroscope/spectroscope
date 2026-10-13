package dev.spectroscope.core.messaging;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.PeerClient;
import dev.spectroscope.core.peer.PeerLimits;
import dev.spectroscope.core.peer.PeerNames;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 503, criteria 1, 2, 4 and 5 on the tool's side: the result names the
 * summary, the recipient, the queued state and the msg_id; the transport's
 * errors reach the model as tool errors; an empty message needs
 * notify_when_idle; a child may not subscribe; the description carries the
 * four rules.
 */
class SendMessageToolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static AgentRow session(String name, String id) {
        LiveRecord record = new LiveRecord(4711, "2026-10-11T08:00:00.000Z", 1L, "server", "dev", 1,
                List.of(), "/tmp/a.sock", true, List.of());
        return new AgentRow(AgentRow.Kind.SESSION, name, PeerNames.ref("session", id), id, "server", "idle",
                "/tmp/ForgeDemo", "idle", 1L, true, "uds:/tmp/a.sock", record);
    }

    private static JsonNode input(String to, String message, String summary, Boolean notify) {
        ObjectNode node = JSON.createObjectNode();
        if (to != null) {
            node.put("to", to);
        }
        if (message != null) {
            node.put("message", message);
        }
        if (summary != null) {
            node.put("summary", summary);
        }
        if (notify != null) {
            node.put("notify_when_idle", notify);
        }
        return node;
    }

    private final List<RunEvent> emitted = new ArrayList<>();
    private final CancelSignal run = new CancelSignal();

    private Tool.ToolContext context(CancelSignal signal, String agentId) {
        return new Tool.ToolContext(Path.of("."), signal, agentId, "call-1", emitted::add);
    }

    @Test
    void theResultNamesSummaryRecipientQueuedStateAndMsgId() {
        FakeSeat seat = new FakeSeat();
        AgentRow b = session("ForgeDemo-7f", "s2");
        seat.sessions.add(b);
        String out = new SendMessageTool(seat).execute(
                input("ForgeDemo-7f", "which files did you touch?", null, null), context(run, "main"));
        assertTrue(out.startsWith("Sent \"which files did you touch?\" to ForgeDemo-7f [" + b.ref() + "]"), out);
        assertTrue(out.contains("queued there"), out);
        assertTrue(out.contains("msg_id: msg-1"), out);
        assertEquals(List.of("session:s2:which files did you touch?:which files did you touch?"), seat.sent);
    }

    @Test
    void theSummaryDefaultsToTheFirstLineAndIsCutAt200() {
        FakeSeat seat = new FakeSeat();
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        SendMessageTool tool = new SendMessageTool(seat);
        tool.execute(input("ForgeDemo-7f", "first line\nsecond line", null, null), context(run, "main"));
        assertEquals("session:s2:first line:first line\nsecond line", seat.sent.getFirst());
        String longSummary = "x".repeat(250);
        tool.execute(input("ForgeDemo-7f", "body", longSummary, null), context(run, "main"));
        assertEquals("session:s2:" + "x".repeat(200) + ":body", seat.sent.get(1));
    }

    /**
     * Hub and spoke review, round 1: the summary is cut at SUMMARY_CAP, and
     * the cut never leaves half of a surrogate pair, which the chat would
     * show as a broken character.
     */
    @Test
    void aSummaryCutAtTheCapNeverSplitsASurrogatePair() {
        String face = "\uD83D\uDE00";
        int cap = PeerLimits.SUMMARY_CAP;
        String across = "x".repeat(cap - 1) + face + " tail";
        assertEquals("x".repeat(cap - 1), SendMessageTool.summaryOf(across, "body"),
                "the pair across the cap goes whole");
        assertEquals("x".repeat(cap - 1), SendMessageTool.summaryOf(null, across),
                "the same for the body's first line");
        String endsAtCap = "x".repeat(cap - 2) + face + "y";
        assertEquals("x".repeat(cap - 2) + face, SendMessageTool.summaryOf(endsAtCap, "body"),
                "a pair that ends at the cap is kept whole");
        String umlauts = "\u00e4".repeat(cap + 5);
        assertEquals("\u00e4".repeat(cap), SendMessageTool.summaryOf(umlauts, "body"),
                "a character outside the pairs is cut at the cap itself");
    }

    @Test
    void anEmptyMessageIsRefusedWithoutNotifyWhenIdle() {
        FakeSeat seat = new FakeSeat();
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        String out = new SendMessageTool(seat).execute(input("ForgeDemo-7f", "  ", null, null),
                context(run, "main"));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("notify_when_idle"), out);
        assertTrue(seat.sent.isEmpty());
    }

    @Test
    void anEmptyMessageWithNotifyWhenIdleSubscribesAndSendsNothing() {
        FakeSeat seat = new FakeSeat();
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        String out = new SendMessageTool(seat).execute(input("ForgeDemo-7f", null, null, true),
                context(run, "main"));
        assertFalse(out.startsWith("ERROR"), out);
        assertTrue(out.contains("Subscribed"), out);
        assertTrue(out.contains("Do not poll"), out);
        assertEquals(List.of("s2"), seat.subscribed);
        assertTrue(seat.sent.isEmpty());
    }

    @Test
    void aChildMayNotSubscribeAndHearsWhy() {
        FakeSeat seat = new FakeSeat();
        seat.child = true;
        seat.agentId = "explore-1";
        seat.runAgents.add(AgentRow.inRun(AgentRow.Kind.PARENT, "parent", "main", "main", "working", null));
        String out = new SendMessageTool(seat).execute(input("parent", "done?", null, true),
                context(run, "explore-1"));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("only available to the main agent"), out);
        assertTrue(seat.sent.isEmpty() && seat.subscribed.isEmpty());
    }

    @Test
    void anIdleSubscriptionToAnAgentOfTheRunIsRefused() {
        FakeSeat seat = new FakeSeat();
        seat.runAgents.add(AgentRow.inRun(AgentRow.Kind.CHILD, "explore-1", "explore-1", "explore", "working",
                null));
        String out = new SendMessageTool(seat).execute(input("explore-1", "status?", null, true),
                context(run, "main"));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("sessions on this machine"), out);
        assertTrue(out.contains("NOT delivered"), out);
        assertTrue(seat.sent.isEmpty());
    }

    @Test
    void theTransportErrorsReachTheModelAsToolErrors() {
        for (String text : List.of(PeerClient.gone("ForgeDemo-7f", "IOException"), PeerClient.busy("ForgeDemo-7f"),
                PeerClient.tooLarge(2_000_000))) {
            FakeSeat seat = new FakeSeat();
            seat.sessions.add(session("ForgeDemo-7f", "s2"));
            seat.failSession = text;
            String out = new SendMessageTool(seat).execute(input("ForgeDemo-7f", "hi", null, null),
                    context(new CancelSignal(), "main"));
            assertEquals("ERROR: " + text, out);
        }
        FakeSeat seat = new FakeSeat();
        String out = new SendMessageTool(seat).execute(input("nobody", "hi", null, null), context(run, "main"));
        assertEquals("ERROR: " + PeerClient.unknownName("nobody"), out);
    }

    @Test
    void aNameIsPinnedForTheRunAndARestartedSessionIsRefused() {
        FakeSeat seat = new FakeSeat();
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        SendMessageTool tool = new SendMessageTool(seat);
        tool.execute(input("ForgeDemo-7f", "one", null, null), context(run, "main"));
        seat.sessions.clear();
        AgentRow restarted = session("ForgeDemo-7f", "s9");
        seat.sessions.add(restarted);
        String out = tool.execute(input("ForgeDemo-7f", "two", null, null), context(run, "main"));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("ForgeDemo-7f [" + restarted.ref() + "]"), out);
        assertEquals(1, seat.sent.size());
    }

    @Test
    void aNewRunStartsWithoutPins() {
        FakeSeat seat = new FakeSeat();
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        SendMessageTool tool = new SendMessageTool(seat);
        tool.execute(input("ForgeDemo-7f", "one", null, null), context(run, "main"));
        seat.sessions.clear();
        seat.sessions.add(session("ForgeDemo-7f", "s9"));
        String out = tool.execute(input("ForgeDemo-7f", "two", null, null), context(new CancelSignal(), "main"));
        assertTrue(out.startsWith("Sent"), out);
    }

    @Test
    void aSendInsideTheRunIsRecordedAsAnAgentMessageSent() {
        FakeSeat seat = new FakeSeat();
        seat.runAgents.add(AgentRow.inRun(AgentRow.Kind.CHILD, "explore-1", "explore-1", "explore", "working",
                null));
        String out = new SendMessageTool(seat).execute(input("explore-1", "status?", null, null),
                context(run, "main"));
        assertTrue(out.startsWith("Sent \"status?\" to explore-1"), out);
        assertEquals(List.of("run:explore-1:status?:status?"), seat.sent);
        RunEvent.AgentMessage message = (RunEvent.AgentMessage) emitted.getFirst();
        assertEquals("main", message.from());
        assertEquals("explore-1", message.to());
        assertEquals("peer", message.role());
        assertEquals("sent", message.state());
        assertEquals("status?", message.text());
        assertEquals("msg-1", message.label());
    }

    @Test
    void aSendToAChildSaysTheMessageComesBackWhenTheChildEndsBeforeReadingIt() {
        // Card 594, review M8: the answer the sending model reads.
        FakeSeat seat = new FakeSeat();
        seat.runAgents.add(AgentRow.inRun(AgentRow.Kind.CHILD, "explore-1", "explore-1", "explore", "working",
                null));
        String out = new SendMessageTool(seat).execute(input("explore-1", "status?", null, null),
                context(run, "main"));
        assertTrue(out.startsWith("Sent \"status?\" to explore-1 (in its inbox; it reads it at its next step."), out);
        assertTrue(out.contains("If it ends before it reads it, the message comes back to you as a [Delivery notice]"),
                out);
        String toParent = new SendMessageTool(childSeat()).execute(input("parent", "done", null, null),
                context(run, "explore-1"));
        assertTrue(toParent.startsWith("Sent \"done\" to parent (in its inbox; it reads it at its next step)."),
                toParent);
        assertFalse(toParent.contains("comes back"), "a message to the parent says nothing of coming back: "
                + toParent);
    }

    @Test
    void aSendToASessionIsRecordedAsAnAgentMessageSent() {
        FakeSeat seat = new FakeSeat();
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        new SendMessageTool(seat).execute(input("ForgeDemo-7f", "hi", null, null), context(run, "main"));
        RunEvent.AgentMessage message = (RunEvent.AgentMessage) emitted.getFirst();
        assertEquals("ForgeDemo-7f", message.to());
        assertEquals("sent", message.state());
        assertEquals("msg-1", message.label());
    }

    @Test
    void switchedOffSendsNothing() {
        FakeSeat seat = new FakeSeat();
        seat.on = false;
        seat.sessions.add(session("ForgeDemo-7f", "s2"));
        String out = new SendMessageTool(seat).execute(input("ForgeDemo-7f", "hi", null, null),
                context(run, "main"));
        assertTrue(out.startsWith("ERROR: "), out);
        assertTrue(out.contains("switched off"), out);
        assertTrue(seat.sent.isEmpty());
    }

    @Test
    void theDescriptionCarriesTheFourRules() {
        String description = new SendMessageTool(new FakeSeat()).description();
        assertTrue(description.contains("plain text is not visible to other agents"), description);
        assertTrue(description.contains("copy its from attribute as your to"), description);
        assertTrue(description.contains("Never poll list_agents"), description);
        assertTrue(description.contains("never ask another agent to do what your session was denied"),
                description);
        String listing = new ListAgentsTool(new FakeSeat()).description();
        assertTrue(listing.contains("Never call it in a loop to wait"), listing);
    }

    @Test
    void neitherToolAsksForPermission() {
        assertFalse(new SendMessageTool(new FakeSeat()).needsPermission());
        assertFalse(new ListAgentsTool(new FakeSeat()).needsPermission());
        assertEquals("send_message", new SendMessageTool(new FakeSeat()).name());
        assertEquals("list_agents", new ListAgentsTool(new FakeSeat()).name());
    }

    // Hub and spoke (owner, 2026-10-12): a child messages only its parent.

    private static FakeSeat childSeat() {
        FakeSeat seat = new FakeSeat();
        seat.child = true;
        seat.agentId = "explore-1";
        seat.selfName = "explore-1";
        seat.runAgents.add(AgentRow.inRun(AgentRow.Kind.PARENT, "parent", "main", "main", "working", null));
        return seat;
    }

    @Test
    void aChildIsRefusedARowItsSeatListsThatIsNotItsParent() {
        FakeSeat seat = childSeat();
        seat.runAgents.add(AgentRow.inRun(AgentRow.Kind.CHILD, "worker-2", "worker-2", "worker", "working", null));
        SendMessageTool tool = new SendMessageTool(seat);
        String out = tool.execute(input("worker-2", "the schema moved", null, null), context(run, "explore-1"));
        assertTrue(out.startsWith("ERROR: Not sent:"), out);
        assertTrue(out.contains("only its parent"), out);
        assertTrue(seat.sent.isEmpty(), seat.sent.toString());
        assertTrue(emitted.isEmpty(), "nothing recorded as sent: " + emitted);
        String up = tool.execute(input("parent", "the schema moved", null, null), context(run, "explore-1"));
        assertTrue(up.startsWith("Sent \"the schema moved\" to parent"), up);
        assertEquals(List.of("run:main:the schema moved:the schema moved"), seat.sent);
    }

    @Test
    void aChildThatNamesAnyoneButItsParentIsToldItsParentIsItsOnlyAddress() {
        FakeSeat seat = childSeat();
        String out = new SendMessageTool(seat).execute(input("explore-2", "hi", null, null),
                context(run, "explore-1"));
        assertTrue(out.startsWith("ERROR: Not sent:"), out);
        assertTrue(out.contains("only its parent"), out);
        assertTrue(out.contains("to: parent"), out);
        assertTrue(seat.sent.isEmpty());
    }

    /**
     * Hub and spoke review, round 1: list_agents prints the parent's agent id
     * as its face, so a child may write it as the address. The refusal says
     * which address to use; "main is not your parent" would be false.
     */
    @Test
    void aChildThatWritesItsParentsAgentIdIsToldToWriteParent() {
        for (String to : List.of("main", "MAIN", " main ")) {
            FakeSeat seat = childSeat();
            String out = new SendMessageTool(seat).execute(input(to, "done", null, null),
                    context(run, "explore-1"));
            assertTrue(out.startsWith("ERROR: Not sent: " + to.strip() + " is your parent's agent id."), out);
            assertTrue(out.contains("to: parent"), out);
            assertFalse(out.contains("is not your parent"), "a false fact: " + out);
            assertTrue(seat.sent.isEmpty(), seat.sent.toString());
        }
    }

    /**
     * Hub and spoke review, round 2: the parent's id with a ref suffix, or with
     * an invisible character after it, is still the parent's id.
     */
    @Test
    void aChildThatWritesItsParentsAgentIdWithARefOrAnInvisibleCharacterIsToldToWriteParent() {
        for (String to : List.of("main [abcdef]", "MAIN [abcdef12]", "main\u200B", "\u2060main")) {
            FakeSeat seat = childSeat();
            String out = new SendMessageTool(seat).execute(input(to, "done", null, null),
                    context(run, "explore-1"));
            assertTrue(out.startsWith("ERROR: Not sent:"), out);
            assertTrue(out.contains(" is your parent's agent id."), to + ": " + out);
            assertFalse(out.contains("is not your parent"), "a false fact: " + out);
            assertTrue(seat.sent.isEmpty(), seat.sent.toString());
        }
    }

    /** Hub and spoke review, round 2: the same for another child of the session. */
    @Test
    void aChildThatWritesASiblingWithARefOrAnInvisibleCharacterHearsItIsAnotherChild() {
        for (String to : List.of("worker-1", "worker-1 [aaaaaa]", "WORKER-1 [aaaaaa]", "worker-1\u200B")) {
            FakeSeat seat = childSeat();
            seat.siblings.add("worker-1");
            String out = new SendMessageTool(seat).execute(input(to, "hi", null, null),
                    context(run, "explore-1"));
            assertTrue(out.startsWith("ERROR: Not sent:"), out);
            assertTrue(out.contains(" is another child agent."), to + ": " + out);
            assertFalse(out.contains("is not your parent"), "a false fact: " + out);
            assertTrue(seat.sent.isEmpty(), seat.sent.toString());
        }
    }

    /**
     * Last fix round: "parent" with a stray ref or an invisible character is
     * still the parent; the message goes there instead of a refusal that says
     * "parent is not your parent".
     */
    @Test
    void aChildThatWritesParentWithARefOrAnInvisibleCharacterReachesItsParent() {
        for (String to : List.of("parent [123456]", "Parent [abcdef12]", "pa\u200Brent", "PARENT\u2060")) {
            FakeSeat seat = childSeat();
            emitted.clear();
            String out = new SendMessageTool(seat).execute(input(to, "done", null, null),
                    context(run, "explore-1"));
            assertTrue(out.startsWith("Sent \"done\" to parent"), to + ": " + out);
            assertFalse(out.contains("is not your parent"), "a false fact: " + out);
            assertEquals(List.of("run:main:done:done"), seat.sent, to);
        }
    }

    /**
     * Last fix round 2026-10-12: the ref without brackets, as the agent list
     * reads aloud, is the parent too. A name that is not the parent's keeps
     * its refusal with an unbracketed hex word after it.
     */
    @Test
    void aChildThatWritesParentWithAnUnbracketedRefReachesItsParent() {
        for (String to : List.of("parent 123456", "Parent abcdef12", "PARENT\u200B 123456")) {
            FakeSeat seat = childSeat();
            emitted.clear();
            String out = new SendMessageTool(seat).execute(input(to, "done", null, null),
                    context(run, "explore-1"));
            assertTrue(out.startsWith("Sent \"done\" to parent"), to + ": " + out);
            assertEquals(List.of("run:main:done:done"), seat.sent, to);
        }
        FakeSeat seat = childSeat();
        String out = new SendMessageTool(seat).execute(input("ForgeDemo 123456", "hi", null, null),
                context(run, "explore-1"));
        assertTrue(out.startsWith("ERROR: Not sent: ForgeDemo 123456 is not your parent."), out);
        assertTrue(seat.sent.isEmpty(), seat.sent.toString());
    }

    @Test
    void aChildThatNamesSomeoneElseIsStillToldItIsNotItsParent() {
        FakeSeat seat = childSeat();
        String out = new SendMessageTool(seat).execute(input("ForgeDemo-7f", "hi", null, null),
                context(run, "explore-1"));
        assertTrue(out.startsWith("ERROR: Not sent: ForgeDemo-7f is not your parent."), out);
    }

    // ── card 581: an ended child is named as ended only where its name reaches nobody ──

    private static final String ENDED = "Not sent: explore-1 has ended and reads no more messages.";

    private static FakeSeat seatWithEndedChild() {
        FakeSeat seat = new FakeSeat();
        seat.endedChildren.put("explore-1", ENDED);
        return seat;
    }

    @Test
    void aNameThatReachesNobodyButAnEndedChildIsRefusedAsEnded() {
        String out = new SendMessageTool(seatWithEndedChild()).execute(input("EXPLORE-1", "more?", null, null),
                context(run, "main"));
        assertEquals("ERROR: " + ENDED, out);
    }

    @Test
    void anAmbiguousNameKeepsItsRefusalWhenAnEndedChildSharesIt() {
        FakeSeat seat = seatWithEndedChild();
        seat.sessions.add(session("explore-1", "s1"));
        seat.sessions.add(session("explore-1", "s2"));
        String out = new SendMessageTool(seat).execute(input("explore-1", "more?", null, null), context(run, "main"));
        assertTrue(out.startsWith("ERROR: Not sent: two agents answer to 'explore-1'"), out);
        assertTrue(seat.sent.isEmpty(), seat.sent.toString());
    }

    @Test
    void aWrongRefKeepsItsRefusalWhenAnEndedChildSharesTheName() {
        FakeSeat seat = seatWithEndedChild();
        seat.sessions.add(session("explore-1", "s1"));
        String out = new SendMessageTool(seat).execute(input("explore-1 [abcdef]", "more?", null, null),
                context(run, "main"));
        assertTrue(out.startsWith("ERROR: Not sent: no agent named 'explore-1' has the ref [abcdef]"), out);
    }

    @Test
    void aReboundNameKeepsItsRefusalWhenAnEndedChildSharesIt() {
        FakeSeat seat = seatWithEndedChild();
        seat.sessions.add(session("explore-1", "s1"));
        SendMessageTool tool = new SendMessageTool(seat);
        String first = tool.execute(input("explore-1", "hello", null, null), context(run, "main"));
        assertTrue(first.startsWith("Sent \"hello\" to explore-1"), first);
        seat.sessions.clear();
        seat.sessions.add(session("explore-1", "s9"));
        String out = tool.execute(input("explore-1", "more?", null, null), context(run, "main"));
        assertTrue(out.startsWith("ERROR: Not sent: 'explore-1' now names a different agent"), out);
    }

    @Test
    void aChildsToolsDescribeTheParentAsItsOnlyAddressAndTheMainAgentsDoNot() {
        FakeSeat child = childSeat();
        assertTrue(new SendMessageTool(child).description().contains("only your parent"));
        assertTrue(new ListAgentsTool(child).description().contains("your parent"));
        assertFalse(new SendMessageTool(new FakeSeat()).description().contains("only your parent"));
        assertFalse(new ListAgentsTool(new FakeSeat()).description().contains("your parent"));
    }
}
