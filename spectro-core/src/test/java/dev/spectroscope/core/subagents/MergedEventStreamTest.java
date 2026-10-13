package dev.spectroscope.core.subagents;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The shared-queue merge: buffered values, a blocked consumer, end(), drop-after-end,
 *  and card 395's coalescing of queued deltas. */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class MergedEventStreamTest {

    /** Card 395, criterion 2: a stop must reach the client within this. */
    private static final long STOP_BOUND_MS = 2_000;

    /** Card 395: the slowest drain rate measured in the field, at 60,000 events and up
     *  (kanban/evidence/review-2026-09-24/05-stop-and-self-kill.md, Root Cause). */
    private static final double FIELD_FRAMES_PER_SECOND = 17.0;

    /** How many drain steps fit in the stop bound at the field rate: 34. */
    private static final int STEPS_IN_THE_STOP_BOUND =
            (int) (STOP_BOUND_MS / 1000.0 * FIELD_FRAMES_PER_SECOND);

    private static RunEvent delta(String agentId, String text) {
        return new RunEvent.TextDelta(agentId, text, 1L);
    }

    private static List<RunEvent> drain(MergedEventStream stream) {
        List<RunEvent> got = new ArrayList<>();
        for (RunEvent event : stream) {
            got.add(event);
        }
        return got;
    }

    private static String textOf(RunEvent event) {
        return switch (event) {
            case RunEvent.TextDelta text -> text.text();
            case RunEvent.ThinkingDelta thinking -> thinking.text();
            default -> throw new AssertionError("not a delta: " + event);
        };
    }

    @Test
    void buffersEarlyEventsAndWakesABlockedConsumer() throws InterruptedException {
        // Card 395 replaced this test's old assertion (["one","two","three"]):
        // two deltas buffered before the consumer arrives may now reach it as
        // ONE event. The claim of the test is unchanged and still asserted in
        // full: every buffered value arrives, in order, and a consumer that is
        // already blocked in take() is woken by a later put.
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.put(delta("demo", "one"));   // no consumer yet -> buffered
        stream.put(delta("demo", "two"));
        CountDownLatch consumerTookTheBuffer = new CountDownLatch(1);
        AtomicBoolean thirdWasLate = new AtomicBoolean(false);
        Thread.ofVirtual().start(() -> {
            try {
                consumerTookTheBuffer.await();
                Thread.sleep(50);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            thirdWasLate.set(true);
            stream.put(delta("demo", "three")); // consumer already blocked in take() -> wakes it
            stream.end();
        });

        StringBuilder texts = new StringBuilder();
        List<Boolean> lateWhenSeen = new ArrayList<>();
        for (RunEvent event : stream) {
            texts.append(textOf(event));
            lateWhenSeen.add(thirdWasLate.get());
            consumerTookTheBuffer.countDown();
        }
        assertEquals("onetwothree", texts.toString(), "every buffered value, in order");
        assertTrue(lateWhenSeen.getLast(), "the last event is the late put, which woke the"
                + " consumer blocked in take(): " + lateWhenSeen);
        assertTrue(lateWhenSeen.subList(0, lateWhenSeen.size() - 1).stream().noneMatch(b -> b),
                "the buffered values arrive before the late put: " + lateWhenSeen);
    }

    @Test
    void eventsAfterEndAreDropped() {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.put(delta("demo", "kept"));
        stream.end();
        stream.put(delta("demo", "dropped"));
        stream.end(); // idempotent

        List<RunEvent> events = new ArrayList<>();
        stream.forEach(events::add);
        assertEquals(1, events.size());
    }

    @Test
    void closeDelegatesToTheCancelHook() {
        AtomicBoolean cancelled = new AtomicBoolean(false);
        MergedEventStream stream = new MergedEventStream(() -> cancelled.set(true));
        stream.close();
        assertTrue(cancelled.get(), "close() must cancel the run (EventStream contract)");
        stream.end(); // let a hypothetical consumer finish
    }

    @Test
    void aBackloggedDeltaFloodReachesTheConsumerAsFewEventsAndLosesNoText() {
        // Card 395, criterion 4, positive half. 10,000 thinking deltas and the
        // stop's run_end are queued before the consumer takes the first one,
        // which is the backlog a GLM stream built in the field.
        MergedEventStream stream = new MergedEventStream(() -> { });
        StringBuilder sent = new StringBuilder();
        for (int i = 0; i < 10_000; i++) {
            String piece = "t" + i + " ";
            sent.append(piece);
            stream.put(new RunEvent.ThinkingDelta("main", piece, i));
        }
        stream.put(new RunEvent.RunEnd("r1", "aborted", 10_001L));
        stream.end();

        List<RunEvent> got = drain(stream);
        StringBuilder received = new StringBuilder();
        got.stream().filter(RunEvent.ThinkingDelta.class::isInstance)
                .forEach(event -> received.append(textOf(event)));

        System.out.println("card 395 flood: 10,000 queued deltas and run_end took " + got.size()
                + " drain steps");
        assertTrue(got.size() <= STEPS_IN_THE_STOP_BOUND,
                "10,000 queued deltas cost " + got.size() + " drain steps; at the field rate of "
                        + FIELD_FRAMES_PER_SECOND + " steps/s the stop bound of " + STOP_BOUND_MS
                        + " ms allows " + STEPS_IN_THE_STOP_BOUND);
        assertEquals(sent.toString(), received.toString(), "every piece of text, in order");
        assertInstanceOf(RunEvent.RunEnd.class, got.getLast(), "run_end is present and last");
        assertEquals(0L, got.getFirst() instanceof RunEvent.ThinkingDelta first ? first.ts() : -1L,
                "a merged delta keeps the timestamp of its first piece");
    }

    @Test
    void noMergedDeltaMakesASessionLineLongerThanOneWriteChunk() throws Exception {
        // SessionStore.append writes a line through Files.write, which hands the
        // bytes to the file in chunks of 8,192. A longer line can be torn by a
        // second writer landing between two chunks, and the reader then drops
        // both halves: measured on 2026-09-24 with a 12,000-character merged
        // thinking line (kanban/evidence/395/loop/torn-merged-line-2026-09-24.txt).
        // So every merged delta has to serialize, as the session file writes it,
        // to at most 8,192 bytes including the newline, whatever the text holds:
        // multi-byte UTF-8, a surrogate pair, quotes, backslashes, control
        // characters that JSON escapes to six bytes.
        MergedEventStream stream = new MergedEventStream(() -> { });
        StringBuilder sent = new StringBuilder();
        int pieces = 3_000;
        for (int i = 0; i < pieces; i++) {
            String piece = String.format("%05d|", i) + "\u00e4\u20ac\ud83d\ude00\"\\\u0001\n";
            sent.append(piece);
            stream.put(new RunEvent.ThinkingDelta("main", piece, i));
        }
        stream.end();

        List<RunEvent> got = drain(stream);
        StringBuilder received = new StringBuilder();
        got.forEach(event -> received.append(textOf(event)));
        com.fasterxml.jackson.databind.ObjectMapper json = new com.fasterxml.jackson.databind.ObjectMapper();
        int longest = 0;
        for (RunEvent event : got) {
            int bytes = (json.writeValueAsString(event) + "\n")
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            longest = Math.max(longest, bytes);
        }

        assertEquals(sent.toString(), received.toString(), "every piece, in order");
        assertTrue(longest <= 8_192, "the longest merged session line is " + longest + " bytes");
        assertTrue(got.size() < pieces / 10, "positive control: the pieces did merge, into "
                + got.size() + " deltas");
    }

    @Test
    void theByteCountIsNeverBelowWhatJacksonWritesForAnyChar() throws Exception {
        // The budget above only holds if jsonBytes never under-counts what the
        // session file really writes: SessionStore.append serializes with
        // writeValueAsString and writes the string as UTF-8. Checked on that
        // same path for every char, and for a whole surrogate pair.
        com.fasterxml.jackson.databind.ObjectMapper json = new com.fasterxml.jackson.databind.ObjectMapper();
        List<String> under = new ArrayList<>();
        for (int c = 0; c <= 0xFFFF; c++) {
            String one = String.valueOf((char) c);
            int written = json.writeValueAsString(one).getBytes(java.nio.charset.StandardCharsets.UTF_8).length - 2;
            if (MergedEventStream.jsonBytes(one) < written) {
                under.add(String.format("U+%04X counted %d, written %d", c,
                        MergedEventStream.jsonBytes(one), written));
            }
        }
        String pair = "\ud83d\ude00";
        int pairWritten = json.writeValueAsString(pair).getBytes(java.nio.charset.StandardCharsets.UTF_8).length - 2;
        assertTrue(MergedEventStream.jsonBytes(pair) >= pairWritten,
                "a surrogate pair is written as " + pairWritten + " bytes, counted "
                        + MergedEventStream.jsonBytes(pair));
        assertTrue(under.isEmpty(), "under-counted: " + under.stream().limit(10).toList());
        assertEquals(1, MergedEventStream.jsonBytes("a"), "positive control: plain ASCII counts one byte");
    }

    private static List<String> shapeOf(List<RunEvent> events) {
        return events.stream()
                .map(event -> switch (event) {
                    case RunEvent.ThinkingDelta t -> "thinking:" + t.agentId() + ":" + t.text();
                    case RunEvent.TextDelta t -> "text:" + t.agentId() + ":" + t.text();
                    case RunEvent.TurnStart t -> "turn_start:" + t.agentId();
                    default -> event.getClass().getSimpleName();
                })
                .toList();
    }

    @Test
    void aDeltaTakesItsOwnAgentsPiecesPastOtherAgentsDeltasButNeverPastAnotherEventOrItsOwnOtherKind() {
        // Card 395, criterion 4, negative half, with its positive control in
        // the same queue. Review finding of 2026-09-24: children thinking at
        // the same time interleave their deltas, so a merge that stops at the
        // first delta of another agent merges almost nothing. A delta now
        // takes its own agent's same-kind pieces from behind other agents'
        // deltas. It stops at any event that is not a delta, at its own agent's
        // delta of the other kind, and never puts two agents' text into one event.
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.put(new RunEvent.ThinkingDelta("main", "a", 1));
        stream.put(new RunEvent.ThinkingDelta("explore-1", "b", 2));   // another agent: stays
        stream.put(new RunEvent.ThinkingDelta("main", "c", 3));        // joins "a" past "b"
        stream.put(new RunEvent.TextDelta("explore-1", "d", 4));       // another agent and kind: stays
        stream.put(new RunEvent.ThinkingDelta("main", "e", 5));        // joins "ac" past "d"
        stream.put(new RunEvent.TextDelta("main", "f", 6));            // main's other kind: main's merge ends
        stream.put(new RunEvent.ThinkingDelta("main", "g", 7));        // stays behind "f"
        stream.put(new RunEvent.ThinkingDelta("explore-1", "h", 8));
        stream.put(new RunEvent.TurnStart("explore-1", 2, 9));         // not a delta: nothing crosses it
        stream.put(new RunEvent.ThinkingDelta("explore-1", "i", 10));
        stream.put(new RunEvent.ThinkingDelta("main", "j", 11));       // same as "g", but past the turn_start
        stream.end();

        assertEquals(List.of(
                        "thinking:main:ace",
                        "thinking:explore-1:b",
                        "text:explore-1:d",
                        "text:main:f",
                        "thinking:main:g",
                        "thinking:explore-1:h",
                        "turn_start:explore-1",
                        "thinking:explore-1:i",
                        "thinking:main:j"),
                shapeOf(drain(stream)),
                "a delta merges its own agent's same-kind pieces past other agents' deltas; it"
                        + " stops at a non-delta event and at its own agent's other kind");
    }

    @Test
    void aPieceThatDoesNotFitEndsTheMergeAndNothingOfThatAgentBehindItJumpsAhead() {
        // The byte budget ends a merge. A smaller piece of the same agent
        // queued behind the one that did not fit must not be taken first,
        // or that agent's text changes order.
        MergedEventStream stream = new MergedEventStream(() -> { });
        String big = "x".repeat(MergedEventStream.MAX_MERGED_TEXT_BYTES - 100);
        String tooBig = "y".repeat(200);
        stream.put(new RunEvent.ThinkingDelta("main", big, 1));
        stream.put(new RunEvent.ThinkingDelta("explore-1", "o", 2));
        stream.put(new RunEvent.ThinkingDelta("main", tooBig, 3));     // does not fit behind "big"
        stream.put(new RunEvent.ThinkingDelta("main", "z", 4));        // would fit, and stays behind tooBig
        stream.end();

        assertEquals(List.of(
                        "thinking:main:" + big,
                        "thinking:explore-1:o",
                        "thinking:main:" + tooBig + "z"),
                shapeOf(drain(stream)),
                "the merge ends at the piece that does not fit; the agent's order holds");
    }

    @Test
    void fourChildrenThinkingAtOnceReachTheConsumerAsFewEventsEachInItsOwnOrder() {
        // Review finding of 2026-09-24: spawn_agents runs up to four children at
        // once and all of them feed this queue. A probe of the merge as it stood
        // counted 430 drain steps ahead of run_end with two agents at 75 lines/s
        // each, where one agent at 150 lines/s left 2. Here the children's
        // deltas are queued strictly in turn, the worst interleaving there is,
        // before the consumer takes the first one.
        int agents = SubagentManager.MAX_PARALLEL_CHILDREN;
        int perAgent = 2_500;
        MergedEventStream stream = new MergedEventStream(() -> { });
        List<StringBuilder> sent = new ArrayList<>();
        for (int a = 0; a < agents; a++) {
            sent.add(new StringBuilder());
        }
        for (int i = 0; i < perAgent; i++) {
            for (int a = 0; a < agents; a++) {
                String piece = (char) ('a' + a) + String.format("%04d|", i);
                sent.get(a).append(piece);
                stream.put(new RunEvent.ThinkingDelta("explore-" + (a + 1), piece, (long) i * agents + a));
            }
        }
        stream.put(new RunEvent.RunEnd("r1", "aborted", Long.MAX_VALUE));
        stream.end();

        List<RunEvent> got = drain(stream);
        List<StringBuilder> received = new ArrayList<>();
        for (int a = 0; a < agents; a++) {
            received.add(new StringBuilder());
        }
        long lastTs = Long.MIN_VALUE;
        boolean tsInOrder = true;
        for (RunEvent event : got) {
            if (event instanceof RunEvent.ThinkingDelta delta) {
                int a = Integer.parseInt(delta.agentId().substring("explore-".length())) - 1;
                received.get(a).append(delta.text());
                tsInOrder &= delta.ts() >= lastTs;
                lastTs = delta.ts();
            }
        }

        System.out.println("card 395 interleaved flood: " + agents + " agents x " + perAgent
                + " queued deltas and run_end took " + got.size() + " drain steps");
        assertTrue(got.size() <= STEPS_IN_THE_STOP_BOUND,
                agents + " interleaved agents with " + perAgent + " queued deltas each cost "
                        + got.size() + " drain steps; the stop bound of " + STOP_BOUND_MS
                        + " ms at the field rate allows " + STEPS_IN_THE_STOP_BOUND);
        for (int a = 0; a < agents; a++) {
            assertEquals(sent.get(a).toString(), received.get(a).toString(),
                    "explore-" + (a + 1) + " gets every piece of its own text, in order, and no other");
        }
        assertInstanceOf(RunEvent.RunEnd.class, got.getLast(), "run_end is present and last");
        assertTrue(tsInOrder, "the merged deltas leave the queue in the order of their first piece");
    }
    /** Card 505, non-functional: four background children write into the
     *  one merged stream at once; the one consumer reads all 1,000 of their
     *  events, each producer's in its own order. */
    @Test
    void oneThousandEventsFromFourProducersReachTheOneConsumer() throws Exception {
        MergedEventStream merged = new MergedEventStream(() -> { });
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> producers = new ArrayList<>();
        for (int p = 0; p < 4; p++) {
            String child = "worker-" + (p + 1);
            producers.add(Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                for (int i = 0; i < 250; i++) {
                    merged.put(new RunEvent.AgentMessage(child, "main", "status", "working", child + "#" + i,
                            null, i));
                }
            }));
        }
        List<RunEvent> got = new ArrayList<>();
        Thread consumer = Thread.ofVirtual().start(() -> merged.forEach(got::add));
        go.countDown();
        for (Thread producer : producers) {
            producer.join();
        }
        merged.end();
        consumer.join(5_000);
        assertEquals(1_000, got.size(), "no event lost");
        for (int p = 1; p <= 4; p++) {
            String child = "worker-" + p;
            List<String> own = got.stream().map(e -> ((RunEvent.AgentMessage) e))
                    .filter(m -> m.from().equals(child)).map(RunEvent.AgentMessage::text).toList();
            assertEquals(250, own.size(), child);
            for (int i = 0; i < 250; i++) {
                assertEquals(child + "#" + i, own.get(i), "each producer keeps its order");
            }
        }
    }

    // ── in-run peer messages: received never before sent ──────────────────

    private static RunEvent peer(String msgId, String state) {
        return new RunEvent.AgentMessage("main", "explore-2", "peer", state, "status?", msgId, 1L);
    }

    private static String describe(RunEvent event) {
        return event instanceof RunEvent.AgentMessage m ? m.label() + ":" + m.state() : textOf(event);
    }

    private static void awaitTrue(String what, java.util.function.BooleanSupplier condition)
            throws InterruptedException {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!condition.getAsBoolean()) {
            assertTrue(System.nanoTime() < until, "timed out waiting for " + what);
            Thread.sleep(5);
        }
    }

    @Test
    void aReceivedRecordOfAnAnnouncedMessageWaitsForItsSentRecordAndNobodyElseWaits()
            throws InterruptedException {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.expectSent("m1");
        Thread receiver = Thread.ofVirtual().start(() -> stream.put(peer("m1", "received")));
        awaitTrue("the receiver's put to return or be held",
                () -> !receiver.isAlive() || stream.heldForTests() == 1);
        stream.put(delta("explore-1", "meanwhile"));
        stream.put(peer("m1", "sent"));
        receiver.join(5_000);
        assertEquals(0, stream.heldForTests());
        stream.end();
        assertEquals(List.of("meanwhile", "m1:sent", "m1:received"),
                drain(stream).stream().map(MergedEventStreamTest::describe).toList());
    }

    @Test
    void aReceivedRecordWhoseSentRecordPassedFirstGoesAtOnce() {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.expectSent("m2");
        stream.put(peer("m2", "sent"));
        stream.put(peer("m2", "received"));
        stream.end();
        assertEquals(List.of("m2:sent", "m2:received"),
                drain(stream).stream().map(MergedEventStreamTest::describe).toList());
    }

    @Test
    void aReceivedRecordNobodyAnnouncedGoesAtOnce() {
        // The operator's reply and a peer session's message: no sent record of them is on this stream.
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.put(peer("m3", "received"));
        stream.end();
        assertEquals(List.of("m3:received"), drain(stream).stream().map(MergedEventStreamTest::describe).toList());
    }

    @Test
    void aDeliveryThatFailedTakesItsAnnouncementBack() {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.expectSent("m4");
        stream.forgetSent("m4");
        stream.put(peer("m4", "received"));
        stream.end();
        assertEquals(List.of("m4:received"), drain(stream).stream().map(MergedEventStreamTest::describe).toList());
    }

    @Test
    void theEndOfTheStreamLetsAHeldRecordGoWithoutWritingIt() throws InterruptedException {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.expectSent("m5");
        Thread receiver = Thread.ofVirtual().start(() -> stream.put(peer("m5", "received")));
        awaitTrue("the receiver's put to return or be held",
                () -> !receiver.isAlive() || stream.heldForTests() == 1);
        stream.end();
        receiver.join(5_000);
        assertTrue(!receiver.isAlive(), "the end released the receiver");
        assertEquals(List.of(), drain(stream).stream().map(MergedEventStreamTest::describe).toList(),
                "a record that waited past the end is dropped like any record after the end");
    }

    /** Runs {@code put} on its own thread, as a forwarder does. */
    private static Thread receiving(MergedEventStream stream, String msgId) {
        return Thread.ofVirtual().start(() -> stream.put(peer(msgId, "received")));
    }

    @Test
    void aHeldRecordGoesIntoTheQueueOnceTheBoundHasPassed() {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.expectSent("m6");
        long started = System.nanoTime();
        stream.put(peer("m6", "received"));
        long waitedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertTrue(waitedMs >= MergedEventStream.SENT_RECORD_WAIT_MS, "waited " + waitedMs + " ms");
        assertTrue(waitedMs < 2 * MergedEventStream.SENT_RECORD_WAIT_MS, "waited " + waitedMs + " ms");
        assertEquals(0, stream.heldForTests());
        stream.end();
        assertEquals(List.of("m6:received"), drain(stream).stream().map(MergedEventStreamTest::describe).toList());
    }

    @Test
    void theOrderDefectIsLoggedOncePerStream() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(MergedEventStream.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> records =
                new ch.qos.logback.core.read.ListAppender<>();
        records.start();
        logger.addAppender(records);
        try {
            MergedEventStream stream = new MergedEventStream(() -> { }, 50);
            stream.expectSent("m7");
            stream.expectSent("m8");
            stream.put(peer("m7", "received"));
            stream.put(peer("m8", "received"));
            stream.end();
            assertEquals(List.of("m7:received", "m8:received"),
                    drain(stream).stream().map(MergedEventStreamTest::describe).toList());
            List<String> warnings = records.list.stream()
                    .filter(e -> e.getLevel() == ch.qos.logback.classic.Level.WARN)
                    .map(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage).toList();
            assertEquals(1, warnings.size(), warnings.toString());
            assertTrue(warnings.getFirst().contains("m7"), warnings.getFirst());
        } finally {
            logger.detachAppender(records);
        }
    }

    @Test
    void cancelLetsEveryHeldRecordGoAtOnceAndLaterOnesDoNotWait() throws InterruptedException {
        AtomicBoolean cancelled = new AtomicBoolean();
        MergedEventStream stream = new MergedEventStream(() -> cancelled.set(true));
        stream.expectSent("c1");
        stream.expectSent("c2");
        Thread first = receiving(stream, "c1");
        Thread second = receiving(stream, "c2");
        awaitTrue("both records held", () -> stream.heldForTests() == 2);
        stream.cancel();
        java.time.Duration underTheBound = java.time.Duration.ofMillis(MergedEventStream.SENT_RECORD_WAIT_MS / 2);
        first.join(underTheBound);
        second.join(underTheBound);
        assertTrue(!first.isAlive() && !second.isAlive(), "cancel let both go before the bound did");
        assertTrue(cancelled.get(), "cancel still runs the stream's cancel hook");
        stream.expectSent("c3");
        long started = System.nanoTime();
        stream.put(peer("c3", "received"));
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < underTheBound.toMillis(),
                "a record of a message announced after the cancel does not wait");
        stream.end();
        List<String> got = drain(stream).stream().map(MergedEventStreamTest::describe).toList();
        assertEquals(3, got.size(), got.toString());
        assertTrue(got.containsAll(List.of("c1:received", "c2:received", "c3:received")), got.toString());
    }

    @Test
    void closeLetsAHeldRecordGoAtOnce() throws InterruptedException {
        MergedEventStream stream = new MergedEventStream(() -> { });
        stream.expectSent("c4");
        Thread receiver = receiving(stream, "c4");
        awaitTrue("the record held", () -> stream.heldForTests() == 1);
        stream.close();
        receiver.join(java.time.Duration.ofMillis(MergedEventStream.SENT_RECORD_WAIT_MS / 2));
        assertTrue(!receiver.isAlive(), "close let it go before the bound did");
        stream.end();
        assertEquals(List.of("c4:received"), drain(stream).stream().map(MergedEventStreamTest::describe).toList());
    }
}
