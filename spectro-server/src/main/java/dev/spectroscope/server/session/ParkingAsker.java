package dev.spectroscope.server.session;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent.QuestionAsked;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * The web face's question strategy (card 265): instead of guessing, the agent's
 * own virtual thread PARKS on a future until the browser answers.
 *
 * <p>The {@code question_asked} event goes out in PARALLEL over the event stream
 * (the sender loop drains it); here we only wait for the response carrying the
 * SAME callId. That is the permission gate's shape, one map over — and it is a
 * second map rather than a wider first one because
 * {@code onPermissionResponse} unconditionally does allowlist-rule work, which a
 * question has no business triggering.</p>
 *
 * <p><b>Why parking with no timeout is safe.</b> The parked thread is the
 * Agent's own, so a question nobody ever answers would hang the run forever.
 * Three rules stop that, and the third is the one worth copying carefully:</p>
 * <ol>
 *   <li>An unattended permission mode ({@code auto}, {@code readonly}) answers
 *       before anything parks. Somebody who declared "do not bother me" is not
 *       bothered — and is not answered for, either.</li>
 *   <li>{@link #releaseAllPending()} releases every parked question, driven by
 *       the socket closing, by the run's own {@code finally}, and by
 *       cancellation (the connection registers it on each run's signal).</li>
 *   <li>{@link #ask} RE-CHECKS cancellation AFTER publishing its future to the
 *       map. The window where a stop fires between "is it cancelled?" and "park"
 *       is exactly where a naive implementation deadlocks: the release may run
 *       before the future is in the map, and miss it. The re-check completes it
 *       instead. {@link CompletableFuture#complete} is idempotent, so the
 *       release and the re-check may both fire — the first one wins.</li>
 * </ol>
 *
 * <p><b>Every release is a release, never an answer.</b> The gate's own
 * {@code releasePending} completes its futures with {@code false}, which is a
 * denial and a legitimate verdict; a question has no such verdict. A fabricated
 * answer in a session file cannot be told from a real one afterwards, and the
 * trace is the product — so absence is spelled {@code null}, all the way up to
 * {@code question_answered.cancelled}.</p>
 */
final class ParkingAsker implements Asker {

    /** callId → the parked answer future. Weakly-consistent iteration lets the
     *  socket thread release while a producer thread removes its own settled entry. */
    private final Map<String, CompletableFuture<Answer>> pending = new ConcurrentHashMap<>();

    private final Supplier<String> permissionMode;
    private final Supplier<CancelSignal> runSignal;

    /**
     * @param permissionMode the session's LIVE mode ("ask"/"auto"/"readonly") —
     *                       read per question, because the composer's gear can
     *                       change it while a run is in flight
     * @param runSignal      the current run's cancel signal, or null between runs
     */
    ParkingAsker(Supplier<String> permissionMode, Supplier<CancelSignal> runSignal) {
        this.permissionMode = permissionMode;
        this.runSignal = runSignal;
    }

    @Override
    public Answer ask(QuestionAsked question) {
        if (PermissionModes.unattended(permissionMode.get())) {
            return null; // nobody is listening: unanswered, and nothing parks
        }
        if (cancelled()) {
            // Already cancelled before we even park — publishing a future here
            // would strand this thread behind a release that has already run.
            return null;
        }
        CompletableFuture<Answer> future = new CompletableFuture<>();
        pending.put(question.callId(), future);
        // Re-check AFTER publishing: if a stop fired in the window above, either
        // its release already completed our future, or it ran before our put and
        // missed us — this re-check completes it. Either path unparks; no hang.
        if (cancelled()) {
            future.complete(null);
        }
        try {
            return future.join();
        } finally {
            pending.remove(question.callId(), future);
        }
    }

    /** Whether the run this question belongs to is over. */
    private boolean cancelled() {
        CancelSignal signal = runSignal.get();
        return signal != null && signal.isCancelled();
    }

    /**
     * The browser's answer to one parked question — completes that future so the
     * parked producer thread carries on. Runs on the WebSocket thread and is
     * non-blocking by construction. An unknown callId (already released, or never
     * ours) is a no-op: a late answer must not throw there, or one stale frame
     * would strand the session's whole reader.
     *
     * @param callId the parked question's call id
     * @param answer what the person chose, or null for "they closed it without answering"
     */
    void answer(String callId, Answer answer) {
        CompletableFuture<Answer> future = pending.get(callId);
        if (future != null) {
            future.complete(answer);
        }
    }

    /**
     * Releases every still-parked question so no agent thread stays parked behind
     * an answer that will never come — as CANCELLED, never as an invented reply.
     * Driven by the socket closing, the run's {@code finally}, and cancellation.
     */
    void releaseAllPending() {
        pending.values().forEach(future -> future.complete(null));
    }

    /**
     * How many questions are parked right now — a read for the tests to know a
     * park has landed, and the same seam {@code GateBroker.pending()} offers.
     *
     * @return the count of outstanding questions
     */
    int pending() {
        return pending.size();
    }
}
