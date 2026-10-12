package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 502 criterion 7: the five guards at the inbox, each on its own, with
 * the numbers read from {@link PeerLimits} and the five drop texts pinned.
 */
class IngressGuardTest {

    private static final String OWN_HOP = "aaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String OTHER_HOP = "bbbbbbbbbbbbbbbbbbbbbbbb";

    private final AtomicLong clock = new AtomicLong(1_000_000L);
    private final IngressGuard guard = new IngressGuard(clock::get);

    private Optional<DropReason> admit(String sender, String text) {
        return guard.admit(sender, text, List.of(), OWN_HOP, 0);
    }

    @Test
    void aFirstMessageIsAdmitted() {
        assertEquals(Optional.empty(), admit("pid:1", "hello"));
    }

    @Test
    void theBucketHoldsThirtyAndTheThirtyFirstIsRateLimited() {
        for (int i = 0; i < PeerLimits.BUCKET_CAPACITY; i++) {
            assertEquals(Optional.empty(), admit("pid:1", "message " + i), "message " + i);
        }
        assertEquals(Optional.of(DropReason.RATE_LIMITED), admit("pid:1", "one more"));
    }

    @Test
    void theBucketRefillsHalfATokenPerSecond() {
        for (int i = 0; i < PeerLimits.BUCKET_CAPACITY; i++) {
            admit("pid:1", "message " + i);
        }
        clock.addAndGet(1_999);
        assertEquals(Optional.of(DropReason.RATE_LIMITED), admit("pid:1", "too early"));
        clock.addAndGet(2);
        assertEquals(Optional.empty(), admit("pid:1", "after two seconds"));
    }

    @Test
    void theBucketIsPerSender() {
        for (int i = 0; i < PeerLimits.BUCKET_CAPACITY; i++) {
            admit("pid:1", "message " + i);
        }
        assertEquals(Optional.empty(), admit("pid:2", "another sender"));
    }

    @Test
    void anIdenticalMessageWithinThirtySecondsIsADuplicate() {
        admit("pid:1", "same words");
        clock.addAndGet(PeerLimits.DUPLICATE_WINDOW_MS - 1);
        assertEquals(Optional.of(DropReason.DUPLICATE), admit("pid:1", "same words"));
    }

    @Test
    void theSameWordsAfterTheWindowPass() {
        admit("pid:1", "same words");
        clock.addAndGet(PeerLimits.DUPLICATE_WINDOW_MS);
        assertEquals(Optional.empty(), admit("pid:1", "same words"));
    }

    @Test
    void aMessageThatPassedThroughThisSessionTenTimesIsALoop() {
        List<String> chain = new ArrayList<>(Collections.nCopies(PeerLimits.SELF_HOP_LIMIT, OWN_HOP));
        assertEquals(Optional.of(DropReason.LOOP), guard.admit("pid:1", "x", chain, OWN_HOP, 0));
        chain.removeLast();
        assertEquals(Optional.empty(), guard.admit("pid:1", "x", chain, OWN_HOP, 0));
    }

    @Test
    void aChainLongerThanTwentyEightIsARunaway() {
        List<String> chain = new ArrayList<>(Collections.nCopies(PeerLimits.CHAIN_LENGTH + 1, OTHER_HOP));
        assertEquals(Optional.of(DropReason.RUNAWAY), guard.admit("pid:1", "x", chain, OWN_HOP, 0));
        chain.removeLast();
        assertEquals(Optional.empty(), guard.admit("pid:1", "x", chain, OWN_HOP, 0));
    }

    @Test
    void aFullQueueDropsTheMessage() {
        assertEquals(Optional.of(DropReason.QUEUE_FULL),
                guard.admit("pid:1", "x", List.of(), OWN_HOP, PeerLimits.QUEUE_CAP));
        assertEquals(Optional.empty(),
                guard.admit("pid:1", "x", List.of(), OWN_HOP, PeerLimits.QUEUE_CAP - 1));
    }

    @Test
    void aDroppedMessageSpendsNoToken() {
        for (int i = 0; i < 100; i++) {
            guard.admit("pid:1", "x", List.of(), OWN_HOP, PeerLimits.QUEUE_CAP);
        }
        assertEquals(Optional.empty(), admit("pid:1", "still has its tokens"));
    }

    @Test
    void theFiveDropTextsAreTheHouseWording() {
        assertEquals("the sender exceeded this session's message rate limit", DropReason.RATE_LIMITED.text());
        assertEquals("identical to the previous message from this sender", DropReason.DUPLICATE.text());
        assertEquals("this message has already passed through this session", DropReason.LOOP.text());
        assertEquals("the relay chain of this message is too long", DropReason.RUNAWAY.text());
        assertEquals("this session has too many undelivered messages queued", DropReason.QUEUE_FULL.text());
    }

    @Test
    void theNumbersAreTheCardsNumbers() {
        assertEquals(30, PeerLimits.BUCKET_CAPACITY);
        assertEquals(0.5, PeerLimits.REFILL_PER_SECOND);
        assertEquals(30_000L, PeerLimits.DUPLICATE_WINDOW_MS);
        assertEquals(10, PeerLimits.SELF_HOP_LIMIT);
        assertEquals(28, PeerLimits.CHAIN_LENGTH);
        assertEquals(64, PeerLimits.QUEUE_CAP);
        assertTrue(DropReason.values().length == 5);
    }

    @Test
    void aFloodOfNewSendersCannotEvictAnActiveSendersBucket() {
        for (int i = 0; i < PeerLimits.BUCKET_CAPACITY; i++) {
            admit("pid:1/real", "message " + i);
        }
        for (int i = 0; i < PeerLimits.TRACKED_SENDERS * 2; i++) {
            admit("pid:" + (100 + i) + "/flood", "flood " + i);
        }
        assertEquals(Optional.of(DropReason.RATE_LIMITED), admit("pid:1/real", "still drained"),
                "the drained bucket was kept, not replaced by a fresh one");
    }

    @Test
    void aNewSenderIsDroppedWhileEveryTrackedSenderIsActive() {
        for (int i = 0; i < PeerLimits.TRACKED_SENDERS; i++) {
            assertEquals(Optional.empty(), admit("pid:" + i + "/s", "first " + i));
        }
        assertEquals(Optional.of(DropReason.RATE_LIMITED), admit("pid:9999/new", "one too many"));
    }

    @Test
    void aSettledSenderMakesRoomForANewOne() {
        for (int i = 0; i < PeerLimits.TRACKED_SENDERS; i++) {
            admit("pid:" + i + "/s", "first " + i);
        }
        clock.addAndGet(PeerLimits.DUPLICATE_WINDOW_MS + 2_000);
        assertEquals(Optional.empty(), admit("pid:9999/new", "after the others settled"));
    }
}
