package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ask-mode parking broker (block 4). A needsPermission tool PARKS the
 * agent's producer virtual thread until an operator answers over the hub
 * ({@code ctl{gate}}), or the run is cancelled ({@code ctl{stop}}). The whole
 * test class runs under a hard timeout: a regression that reintroduces the
 * deadlock fails as a TIMEOUT here, never as a frozen suite.
 *
 * <p>The correctness point the card flags: the naive "register deny-on-cancel,
 * then park" has a race — a stop that fires between the cancel check and the
 * park would leave a future nothing ever completes. {@link #aCancelBeforeAnyGateDeniesImmediatelyInsteadOfHanging}
 * pins it.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class GateBrokerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest ask(String callId) {
        return new PermissionRequest("node-x", callId, "write_file",
                JSON.createObjectNode().put("path", "x.txt"), 0L);
    }

    /** Parks decide() on a virtual thread; returns the future of its verdict. */
    private static CompletableFuture<Boolean> startPark(GateBroker broker, String callId) {
        CompletableFuture<Boolean> verdict = new CompletableFuture<>();
        Thread.ofVirtual().start(() -> verdict.complete(broker.decide(ask(callId))));
        return verdict;
    }

    /** Blocks until exactly {@code n} gates are parked (or the window elapses). */
    private static void awaitPending(GateBroker broker, int n) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (broker.pending() < n && System.nanoTime() < deadline) {
            Thread.sleep(2);
        }
        assertEquals(n, broker.pending(), n + " gate(s) parked, awaiting an answer");
    }

    @Test
    void aCancelBeforeAnyGateDeniesImmediatelyInsteadOfHanging() {
        // THE deadlock: the operator stops the run, THEN a tool asks. A naive
        // broker that only registered deny-on-cancel once would park a future
        // the deny-listener already ran past — a permanent hang. The up-front
        // and after-park cancel checks deny it instead.
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        cancel.cancel();

        assertFalse(broker.decide(ask("late")),
                "a gate requested after cancel is denied at once, never parked forever");
    }

    @Test
    void anAllowAnswerUnparksTheGateTrue() throws Exception {
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        CompletableFuture<Boolean> verdict = startPark(broker, "call-1");
        awaitPending(broker, 1);

        broker.answer("call-1", true);

        assertTrue(verdict.get(5, TimeUnit.SECONDS), "allow runs the tool");
        assertEquals(0, broker.pending(), "the answered gate leaves the pending set");
    }

    @Test
    void aDenyAnswerUnparksTheGateFalse() throws Exception {
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        CompletableFuture<Boolean> verdict = startPark(broker, "call-1");
        awaitPending(broker, 1);

        broker.answer("call-1", false);

        assertFalse(verdict.get(5, TimeUnit.SECONDS), "deny refuses the tool");
    }

    @Test
    void aStopWhileParkedDeniesTheGate() throws Exception {
        // Gotcha (c): ctl{stop} arrives while a gate is parked. Cancel denies
        // every pending future so the producer thread unparks; the run then
        // ends "aborted" upstream.
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        CompletableFuture<Boolean> verdict = startPark(broker, "call-1");
        awaitPending(broker, 1);

        cancel.cancel();

        assertFalse(verdict.get(5, TimeUnit.SECONDS), "a stop denies the parked gate");
    }

    @Test
    void twoParkedGatesAreAnsweredIndependentlyByCallId() throws Exception {
        // The broker keys by callId, never a single slot: an answer reaches
        // exactly its gate. (A node has no subagents today, but the design must
        // not assume one gate at a time — the card's ConcurrentHashMap mandate.)
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        CompletableFuture<Boolean> a = startPark(broker, "call-a");
        CompletableFuture<Boolean> b = startPark(broker, "call-b");
        awaitPending(broker, 2);

        broker.answer("call-a", true);
        broker.answer("call-b", false);

        assertTrue(a.get(5, TimeUnit.SECONDS), "call-a got its own verdict");
        assertFalse(b.get(5, TimeUnit.SECONDS), "call-b got its own verdict");
    }

    @Test
    void answeringAnUnknownCallIdIsANoOp() {
        // A late answer for a gate already resolved (or never ours) must not throw:
        // the reader thread runs this and a throw there strands the event stream.
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        assertDoesNotThrow(() -> broker.answer("never-parked", true));
    }

    @Test
    void denyAllPendingReleasesOrphansOnClose() throws Exception {
        // On node close/abort, still-parked futures are denied so no producer
        // thread outlives the node.
        CancelSignal cancel = new CancelSignal();
        GateBroker broker = new GateBroker(cancel);
        CompletableFuture<Boolean> verdict = startPark(broker, "call-1");
        awaitPending(broker, 1);

        broker.denyAllPending();

        assertFalse(verdict.get(5, TimeUnit.SECONDS), "an orphaned gate is denied on close");
    }
}
