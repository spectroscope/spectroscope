package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 502 criterion 5: the second inbox beside steering. */
class PeerInboxTest {

    private static PeerEnvelope message(String text) {
        return AgentMessageBlockTest.envelope(text).withMsgId(java.util.UUID.randomUUID().toString());
    }

    @Test
    void aClosedInboxRefusesAndKeepsNothing() {
        PeerInbox inbox = new PeerInbox();
        assertEquals(PeerInbox.Submitted.NO_RUN, inbox.submit(message("x")));
        inbox.open();
        assertEquals(List.of(), inbox.take());
    }

    @Test
    void anOpenInboxQueuesInArrivalOrderAndTakingDrains() {
        PeerInbox inbox = new PeerInbox();
        inbox.open();
        assertEquals(PeerInbox.Submitted.WAITING, inbox.submit(message("first")));
        assertEquals(PeerInbox.Submitted.WAITING, inbox.submit(message("second")));
        assertTrue(inbox.waiting());
        List<PeerEnvelope> taken = inbox.take();
        assertEquals(List.of("first", "second"), taken.stream().map(PeerEnvelope::text).toList());
        assertFalse(inbox.waiting());
        assertEquals(List.of(), inbox.take());
    }

    @Test
    void theQueueHoldsSixtyFourAndTheNextIsFull() {
        PeerInbox inbox = new PeerInbox();
        inbox.open();
        for (int i = 0; i < PeerLimits.QUEUE_CAP; i++) {
            assertEquals(PeerInbox.Submitted.WAITING, inbox.submit(message("m" + i)));
        }
        assertEquals(PeerInbox.Submitted.FULL, inbox.submit(message("one too many")));
        assertEquals(PeerLimits.QUEUE_CAP, inbox.size());
    }

    @Test
    void closingHandsBackWhatTheRunDidNotRead() {
        PeerInbox inbox = new PeerInbox();
        List<PeerEnvelope> handedBack = new ArrayList<>();
        inbox.onUnread(handedBack::addAll);
        inbox.open();
        inbox.submit(message("unread"));
        List<PeerEnvelope> unread = inbox.close();
        assertEquals(List.of("unread"), unread.stream().map(PeerEnvelope::text).toList());
        assertEquals(unread, handedBack);
        assertEquals(PeerInbox.Submitted.NO_RUN, inbox.submit(message("late")));
    }

    @Test
    void absorbingTellsTheHost() {
        PeerInbox inbox = new PeerInbox();
        List<PeerEnvelope> absorbed = new ArrayList<>();
        inbox.onAbsorbed(absorbed::addAll);
        inbox.open();
        inbox.submit(message("read me"));
        List<PeerEnvelope> taken = inbox.take();
        inbox.absorbed(taken);
        assertEquals(taken, absorbed);
    }

    @Test
    void theAttributedTextIsOneBlockPerMessage() {
        String text = PeerInbox.attributed(List.of(message("a"), message("b")), true);
        assertEquals(2, text.split("<agent-message ", -1).length - 1);
        assertEquals(2, text.split("\n</agent-message>\n", -1).length - 1);
    }

    @Test
    void aNoticeWaitsEvenWhileNoRunIsOpen() {
        PeerInbox inbox = new PeerInbox();
        inbox.notice("[Delivery notice] one");
        inbox.open();
        inbox.close();
        assertEquals(List.of("[Delivery notice] one"), inbox.takeNotices());
        assertEquals(List.of(), inbox.takeNotices());
    }
    // Card 505: the background run listens on the parent's inbox beside the host.

    @Test
    void anAbsorbedListenerHearsWhatTheLoopTookOnTheLoopsOwnThread() {
        PeerInbox inbox = new PeerInbox();
        List<PeerEnvelope> heard = new ArrayList<>();
        List<Thread> on = new ArrayList<>();
        inbox.addAbsorbedListener(taken -> {
            heard.addAll(taken);
            on.add(Thread.currentThread());
        });
        inbox.open();
        inbox.submit(message("result"));
        List<PeerEnvelope> taken = inbox.take();
        inbox.absorbed(taken);
        assertEquals(taken, heard);
        assertEquals(List.of(Thread.currentThread()), on, "synchronously, before absorbed returns");
    }

    @Test
    void theHostsHookAndEveryListenerAllHearOneAbsorption() {
        PeerInbox inbox = new PeerInbox();
        List<PeerEnvelope> hook = new ArrayList<>();
        List<PeerEnvelope> first = new ArrayList<>();
        List<PeerEnvelope> second = new ArrayList<>();
        inbox.onAbsorbed(hook::addAll);
        inbox.addAbsorbedListener(first::addAll);
        inbox.addAbsorbedListener(second::addAll);
        inbox.open();
        inbox.submit(message("one"));
        List<PeerEnvelope> taken = inbox.take();
        inbox.absorbed(taken);
        assertEquals(taken, hook);
        assertEquals(taken, first);
        assertEquals(taken, second);
    }

    @Test
    void aWithdrawnMessageIsNeverTakenAndAnUnknownIdWithdrawsNothing() {
        PeerInbox inbox = new PeerInbox();
        inbox.open();
        PeerEnvelope gone = message("collected elsewhere");
        PeerEnvelope stays = message("still to read");
        inbox.submit(gone);
        inbox.submit(stays);
        assertTrue(inbox.withdraw(gone.msgId()));
        assertFalse(inbox.withdraw(gone.msgId()), "a second withdraw finds nothing");
        assertFalse(inbox.withdraw("no-such-id"));
        assertFalse(inbox.withdraw(null));
        assertEquals(List.of("still to read"), inbox.take().stream().map(PeerEnvelope::text).toList());
    }
}
