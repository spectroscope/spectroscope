package dev.spectroscope.server.session;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 265, criterion 4: the four independent releases of a parked question,
 * and <b>no path may ever invent an answer.</b>
 *
 * <p>The web face parks the agent's own virtual thread on a person with no
 * timeout, exactly as the permission gate does. That is only survivable because
 * other things always release it, and the ordering of one of them is subtle
 * enough that the concept says to copy {@code GateBroker.java:58-78} verbatim
 * rather than re-derive it: {@code ask} re-checks cancellation AFTER publishing
 * its future, because a cancel that fires in the window between "is it
 * cancelled?" and "park" may have run its listener before the future was in the
 * map and missed it.</p>
 *
 * <p>{@code SEPARATE_THREAD} is deliberate and is the house rule for a timeout
 * over a blocking wait: {@code CompletableFuture.join()} is not interruptible,
 * so the default thread mode's interrupt would leave a broken build hanging
 * forever instead of going red.</p>
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ParkingAskerTest {

    private static RunEvent.QuestionAsked question(String callId) {
        return new RunEvent.QuestionAsked("main", callId, List.of(
                new RunEvent.AskedQuestion("Which store?", null, false,
                        List.of(new RunEvent.QuestionOption("Postgres", null)))), 1L);
    }

    /** Parks the asker on a virtual thread and hands back what it eventually returned. */
    private static AtomicReference<Asker.Answer> parkOn(ParkingAsker asker, String callId,
                                                        CountDownLatch parked, CountDownLatch done) {
        AtomicReference<Asker.Answer> out = new AtomicReference<>();
        Thread.ofVirtual().start(() -> {
            parked.countDown();
            out.set(asker.ask(question(callId)));
            done.countDown();
        });
        return out;
    }

    private static void awaitPark(ParkingAsker asker) {
        long deadline = System.currentTimeMillis() + 5_000;
        while (asker.pending() == 0 && System.currentTimeMillis() < deadline) {
            Thread.onSpinWait();
        }
    }

    @Test
    void anAnswerFromTheBrowserUnparksTheRun() throws Exception {
        CancelSignal run = new CancelSignal();
        ParkingAsker asker = new ParkingAsker(() -> "ask", () -> run);
        CountDownLatch parked = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Asker.Answer> answer = parkOn(asker, "c1", parked, done);
        parked.await();
        awaitPark(asker);
        assertThat(asker.pending()).as("the run really is parked").isEqualTo(1);

        asker.answer("c1", new Asker.Answer(List.of("Postgres")));

        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(answer.get()).isNotNull();
        assertThat(answer.get().answers()).containsExactly("Postgres");
        assertThat(asker.pending()).as("a settled question leaves the map").isZero();
    }

    @Test
    void aClosedSocketReleasesEveryParkedQuestionAsCancelledAndNeverAsDenied() throws Exception {
        // The gate's releasePending() completes its futures with FALSE, which is a
        // denial and a legitimate verdict. A question has no such verdict: the
        // only honest release is "nobody answered".
        CancelSignal run = new CancelSignal();
        ParkingAsker asker = new ParkingAsker(() -> "ask", () -> run);
        CountDownLatch parked = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Asker.Answer> answer = parkOn(asker, "c1", parked, done);
        parked.await();
        awaitPark(asker);

        asker.releaseAllPending();

        assertThat(done.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(answer.get()).as("null is the whole contract for 'nobody answered'").isNull();
    }

    @Test
    void aRunCancelledBeforeTheParkNeverReachesAPerson() {
        CancelSignal run = new CancelSignal();
        run.cancel();
        ParkingAsker asker = new ParkingAsker(() -> "ask", () -> run);
        assertThat(asker.ask(question("c1"))).isNull();
        assertThat(asker.pending()).as("nothing was ever published").isZero();
    }

    @Test
    void aCancelFiredInTheWindowBetweenPublishAndJoinStillUnparks() {
        // The GateBroker.java:66-73 case, staged deterministically. The signal is
        // cancelled on its SECOND reading — i.e. after the future is in the map
        // and before the join — and no cancel listener is registered here on
        // purpose, so the re-check is the only thing that can unpark. Without it
        // this call never returns, which is what the class timeout turns red.
        CancelSignal run = new CancelSignal();
        AtomicInteger reads = new AtomicInteger();
        Supplier<CancelSignal> staged = () -> {
            if (reads.incrementAndGet() == 2) {
                run.cancel();
            }
            return run;
        };
        ParkingAsker asker = new ParkingAsker(() -> "ask", staged);

        assertThat(asker.ask(question("c1"))).isNull();
        assertThat(asker.pending()).isZero();
    }

    @Test
    void anUnattendedModeAnswersUnansweredWithoutParkingAtAll() {
        // A person who set "auto" or "readonly" declared "do not bother me". A
        // question is a bother, so it must not park — and must not be answered
        // on their behalf either.
        CancelSignal run = new CancelSignal();
        for (String mode : List.of("auto", "readonly")) {
            ParkingAsker asker = new ParkingAsker(() -> mode, () -> run);
            assertThat(asker.ask(question("c1"))).as("mode %s", mode).isNull();
            assertThat(asker.pending()).as("mode %s parked nothing", mode).isZero();
        }
    }

    @Test
    void aLateOrUnknownAnswerIsANoOp() {
        // A late frame must not throw on the socket thread: one bad answer there
        // would strand the whole session's reader.
        ParkingAsker asker = new ParkingAsker(() -> "ask", () -> new CancelSignal());
        asker.answer("never-parked", new Asker.Answer(List.of("Postgres")));
        asker.releaseAllPending();
        assertThat(asker.pending()).isZero();
    }
}
