package dev.spectroscope.core.steering;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 380: the holder itself, away from the loop.
 *
 * <p>Two rules carry the feature and both are pinned here rather than through an
 * agent: a sentence is handed out exactly once, so it cannot buy two turns, and
 * several sentences come back as one text in arrival order.</p>
 */
class SteeringInboxTest {

    /** An inbox with a run in flight, which is the only state that takes a
     *  sentence since the fix round of 2026-09-24. */
    private static SteeringInbox openInbox() {
        SteeringInbox inbox = new SteeringInbox();
        inbox.open();
        return inbox;
    }

    @Test
    void oneSentenceIsHandedOutExactlyOnce() {
        SteeringInbox inbox = openInbox();
        assertEquals(SteeringInbox.Submitted.WAITING, inbox.submit("use the cached list, not the API"));
        assertTrue(inbox.waiting());

        assertEquals("use the cached list, not the API", inbox.take());
        assertFalse(inbox.waiting(), "taken means gone");
        assertNull(inbox.take(), "a second take finds nothing");
    }

    @Test
    void severalSentencesComeBackAsOneTextInArrivalOrder() {
        SteeringInbox inbox = openInbox();
        inbox.submit("first");
        inbox.submit("second");
        inbox.submit("third");

        assertEquals("first\nsecond\nthird", inbox.take(),
                "whole string, not three containments: order is the assertion");
    }

    @Test
    void blankIsDroppedAtTheEdgeAndARealSentenceOnTheSamePathIsNot() {
        // Paired on purpose: the negative alone is green on a holder that drops
        // everything, which is exactly the defect this pairing rules out.
        SteeringInbox inbox = openInbox();

        assertEquals(SteeringInbox.Submitted.BLANK, inbox.submit(""), "empty is refused");
        assertEquals(SteeringInbox.Submitted.BLANK, inbox.submit("   \n\t "), "whitespace is refused");
        assertEquals(SteeringInbox.Submitted.BLANK, inbox.submit(null), "null is refused");
        assertFalse(inbox.waiting());
        assertNull(inbox.take());

        assertEquals(SteeringInbox.Submitted.WAITING, inbox.submit("something real"),
                "and the same path accepts a sentence");
        assertEquals("something real", inbox.take());
    }

    // ── fix round 2026-09-24: the inbox lives exactly as long as a run ────

    @Test
    void withNoRunInFlightASentenceIsRefusedAndNothingWaits() {
        // The defect of 2026-09-21 in its smallest form: a sentence that
        // arrived between runs waited, and the next run read it as if it had
        // been typed into that run. With no run there is nobody to read it,
        // so the inbox says so and holds nothing.
        SteeringInbox inbox = new SteeringInbox();

        assertEquals(SteeringInbox.Submitted.NO_RUN, inbox.submit("typed after the run ended"));
        assertFalse(inbox.waiting(), "nothing is left for the next run to fold in");
        assertNull(inbox.take());

        // The positive twin on the same holder: once a run opens it, the same
        // call is accepted. Without it the refusal is green on a holder that
        // refuses everything.
        inbox.open();
        assertEquals(SteeringInbox.Submitted.WAITING, inbox.submit("typed during the run"));
        assertEquals("typed during the run", inbox.take());
    }

    @Test
    void closingHandsBackEverythingUnreadAndRefusesWhatComesAfter() {
        SteeringInbox inbox = openInbox();
        inbox.submit("one");
        inbox.submit("two");

        assertEquals("one\ntwo", inbox.close(),
                "what the run did not read comes back whole, in arrival order");
        assertFalse(inbox.waiting(), "and nothing stays behind");
        assertEquals(SteeringInbox.Submitted.NO_RUN, inbox.submit("three"),
                "a sentence after the close is refused, never kept for the next run");
        assertNull(inbox.close(), "a second close finds nothing");
    }

    @Test
    void aReopenedInboxStartsEmpty() {
        SteeringInbox inbox = openInbox();
        inbox.submit("for run one");
        assertEquals("for run one", inbox.close());

        inbox.open();
        assertNull(inbox.take(), "run two starts with nothing from run one");
        assertEquals(SteeringInbox.Submitted.WAITING, inbox.submit("for run two"));
        assertEquals("for run two", inbox.take());
    }

    @Test
    void aSubmitFromAnotherThreadIsSeenByTheTaker() throws Exception {
        // The real shape: written from the socket thread, polled by the agent's
        // own virtual thread. Nothing blocks on anybody.
        SteeringInbox inbox = openInbox();
        CountDownLatch submitted = new CountDownLatch(20);

        List<Thread> writers = IntStream.range(0, 20)
                .mapToObj(i -> Thread.ofVirtual().start(() -> {
                    inbox.submit("line " + i);
                    submitted.countDown();
                }))
                .toList();
        assertTrue(submitted.await(10, TimeUnit.SECONDS), "every writer finished");
        for (Thread writer : writers) {
            writer.join();
        }

        String taken = inbox.take();
        assertEquals(20, taken.split("\n").length, "nothing was lost: " + taken);
        assertNull(inbox.take());
    }

    @Test
    void theAttributionNamesThePersonAndQuotesThem() {
        // Criterion 4 lives here: the model must be able to tell a person from a
        // tool. The raw sentence never travels as bare content.
        String attributed = SteeringInbox.attributed("make the accent amber");

        assertTrue(attributed.contains("\"make the accent amber\""),
                "quoted, the way ProgressGuard already hands a person's words over: " + attributed);
        assertFalse(attributed.equals("make the accent amber"),
                "and never bare");
        assertTrue(attributed.startsWith("The person watching this run"), attributed);
    }
}
