package dev.spectroscope.core.messaging;

import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.PeerClient;
import dev.spectroscope.core.peer.PeerNames;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 503, criterion 1: how {@code send_message} reads {@code to}. A name
 * from the listing is the address, an exact match wins, an agent of the run
 * wins over a session, a ref picks one of two rows of one name, and a name
 * that once reached one agent and now names another is refused.
 */
class AgentAddressTest {

    private static AgentRow session(String name, String id, String socket) {
        LiveRecord record = new LiveRecord(4711, "2026-10-11T08:00:00.000Z", 1L, "server", "dev", 1,
                List.of(), socket, true, List.of());
        return new AgentRow(AgentRow.Kind.SESSION, name, PeerNames.ref("session", id), id, "server", "idle",
                "/tmp/ForgeDemo", "idle", 1L, true, "uds:" + socket, record);
    }

    private static AgentRow child(String id) {
        return AgentRow.inRun(AgentRow.Kind.CHILD, id, id, "explore", "working", null);
    }

    private static AgentRow parent() {
        return AgentRow.inRun(AgentRow.Kind.PARENT, "parent", "main", "main", "working", null);
    }

    @Test
    void anExactNameReachesItsSession() {
        AgentRow forge = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f", List.of(forge), new AddressPins());
        assertNull(result.refusal());
        assertSame(forge, result.row());
    }

    @Test
    void aNameMatchesAfterNfkcAndLowerCase() {
        AgentRow forge = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentAddress.Result result = AgentAddress.resolve(" forgedemo-7F ", List.of(forge), new AddressPins());
        assertSame(forge, result.row());
    }

    @Test
    void aPrefixIsNotAName() {
        AgentRow forge = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo", List.of(forge), new AddressPins());
        assertNull(result.row());
        assertEquals(PeerClient.unknownName("ForgeDemo"), result.refusal());
    }

    @Test
    void anAgentOfTheRunWinsOverASessionOfTheSameName() {
        AgentRow same = session("explore-1", "s1", "/tmp/a.sock");
        AgentRow child = child("explore-1");
        AgentAddress.Result result = AgentAddress.resolve("explore-1", List.of(same, child), new AddressPins());
        assertSame(child, result.row());
    }

    @Test
    void parentReachesTheParent() {
        AgentRow parent = parent();
        AgentAddress.Result result = AgentAddress.resolve("parent", List.of(child("explore-2"), parent),
                new AddressPins());
        assertSame(parent, result.row());
    }

    @Test
    void twoSessionsOfOneNameAskForARef() {
        AgentRow one = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentRow two = session("ForgeDemo-7f", "s2", "/tmp/b.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f", List.of(one, two), new AddressPins());
        assertNull(result.row());
        contains(result.refusal(), "ForgeDemo-7f [" + one.ref() + "]", "ForgeDemo-7f [" + two.ref() + "]", "two agents");
    }

    @Test
    void aRefPicksOneOfTwo() {
        AgentRow one = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentRow two = session("ForgeDemo-7f", "s2", "/tmp/b.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f [" + two.ref() + "]", List.of(one, two),
                new AddressPins());
        assertSame(two, result.row());
    }

    @Test
    void aRefNoRowCarriesIsRefused() {
        AgentRow one = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f [abcdef]", List.of(one), new AddressPins());
        assertNull(result.row());
        contains(result.refusal(), "abcdef", "list_agents");
    }

    @Test
    void aNameThatNowReachesAnotherSessionIsRefusedAsRebound() {
        AgentRow before = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AddressPins pins = new AddressPins();
        pins.pin("ForgeDemo-7f", before);
        AgentRow after = session("ForgeDemo-7f", "s9", "/tmp/c.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f", List.of(after), pins);
        assertNull(result.row());
        contains(result.refusal(), "ForgeDemo-7f [" + after.ref() + "]", "restarted");
    }

    @Test
    void theSameNameStillReachesThePinnedSession() {
        AgentRow before = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AddressPins pins = new AddressPins();
        pins.pin("ForgeDemo-7f", before);
        AgentAddress.Result result = AgentAddress.resolve("forgedemo-7f", List.of(before), pins);
        assertSame(before, result.row());
    }

    @Test
    void aNameWithTheNewRefReachesTheNewSession() {
        AgentRow before = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AddressPins pins = new AddressPins();
        pins.pin("ForgeDemo-7f", before);
        AgentRow after = session("ForgeDemo-7f", "s9", "/tmp/c.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f [" + after.ref() + "]", List.of(after),
                pins);
        assertSame(after, result.row());
    }

    @Test
    void theFromAttributeOfAMessageReachesItsSession() {
        AgentRow one = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentRow two = session("Other-01", "s2", "/tmp/a.sock");
        AgentAddress.Result result = AgentAddress.resolve("uds:/tmp/a.sock/s2", List.of(one, two),
                new AddressPins());
        assertSame(two, result.row());
    }

    @Test
    void aProcessAddressReachesItsOnlySessionAndAsksWhenItHoldsTwo() {
        AgentRow one = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentRow two = session("Other-01", "s2", "/tmp/a.sock");
        assertSame(one, AgentAddress.resolve("uds:/tmp/a.sock", List.of(one), new AddressPins()).row());
        AgentAddress.Result both = AgentAddress.resolve("uds:/tmp/a.sock", List.of(one, two), new AddressPins());
        assertNull(both.row());
        contains(both.refusal(), "two agents");
    }

    @Test
    void aToOfMoreThanOneLineIsRefused() {
        AgentRow one = session("ForgeDemo-7f", "s1", "/tmp/a.sock");
        AgentAddress.Result result = AgentAddress.resolve("ForgeDemo-7f\nmain", List.of(one), new AddressPins());
        assertNull(result.row());
        contains(result.refusal(), "one line");
    }

    private static void contains(String text, String... parts) {
        for (String part : parts) {
            assertTrue(text != null && text.contains(part), "expected <" + part + "> in <" + text + ">");
        }
    }
}
