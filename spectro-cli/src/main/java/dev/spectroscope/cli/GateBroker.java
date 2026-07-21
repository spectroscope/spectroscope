package dev.spectroscope.cli;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The "ask" permission policy for a fleet node (block 4). Instead of a fixed
 * yes/no, a needsPermission tool PARKS: the agent's producer virtual thread
 * blocks in {@link #decide} until an operator answers over the hub
 * ({@code ctl{gate}} → {@link #answer}), or the run is cancelled
 * ({@code ctl{stop}}, a max-turns brake, or the normal EventStream teardown →
 * the wired {@link CancelSignal}).
 *
 * <p><b>Why the parking is safe.</b> The parked thread is the Agent's own
 * producer thread ({@code Agent.runGuarded}), so a gate that never resolves
 * would hang the run forever. Two rules keep that from happening:</p>
 * <ol>
 *   <li>Cancellation denies EVERY pending future — registered once on the
 *       signal in the constructor.</li>
 *   <li>{@link #decide} RE-CHECKS cancellation AFTER publishing its future to
 *       the map. The window where a stop fires between "is it cancelled?" and
 *       "park" is exactly where a naive broker deadlocks: the deny-listener may
 *       run before the future is in the map (and miss it). The recheck completes
 *       it instead. {@link CompletableFuture#complete} is idempotent, so the
 *       listener and the recheck may both fire — the first {@code false} wins.</li>
 * </ol>
 *
 * <p>Keyed by {@code callId} in a {@link ConcurrentHashMap}, never a single
 * slot: {@link #answer} and {@link #denyAllPending} run on the ProcessBus reader
 * thread and are non-blocking by construction (they only {@code complete}
 * futures).</p>
 */
final class GateBroker implements PermissionBroker {

    /** callId → the parked verdict future. Weakly-consistent iteration lets the
     *  reader thread deny while a producer thread removes its own settled entry. */
    private final ConcurrentHashMap<String, CompletableFuture<Boolean>> pending =
            new ConcurrentHashMap<>();
    private final CancelSignal cancel;

    /**
     * @param cancel the run's cancel signal — a stop, a turn brake or the
     *               EventStream teardown fires it, and every parked gate is
     *               then denied so no producer thread stays blocked
     */
    GateBroker(CancelSignal cancel) {
        this.cancel = cancel;
        // Deny every parked gate the moment the run is cancelled. onCancel fires
        // the listener immediately if the signal is already cancelled, so a
        // broker built after a cancel is born denying.
        cancel.onCancel(this::denyAllPending);
    }

    @Override
    public boolean decide(PermissionRequest request) {
        // Already cancelled before we even park? Deny now — the deny-listener has
        // already run, and publishing a future here would strand this thread.
        if (cancel.isCancelled()) {
            return false;
        }
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        pending.put(request.callId(), future);
        // Re-check AFTER publishing: if a stop fired in the window above, either
        // its listener already completed our future, or it ran before our put and
        // missed us — this recheck completes it. Either path unparks; no hang.
        if (cancel.isCancelled()) {
            future.complete(false);
        }
        try {
            return future.join();
        } finally {
            pending.remove(request.callId(), future);
        }
    }

    /**
     * The hub's answer to one parked gate — completes that future so the parked
     * producer thread runs (allow) or refuses (deny) the tool. Runs on the
     * ProcessBus reader thread: non-blocking. An unknown callId (already
     * resolved, or never ours) is a no-op — a late answer must not throw there,
     * or one bad verdict would strand the node's whole event stream.
     *
     * @param callId the parked request's call id
     * @param allow  the operator's verdict
     */
    void answer(String callId, boolean allow) {
        CompletableFuture<Boolean> future = pending.get(callId);
        if (future != null) {
            future.complete(allow);
        }
    }

    /**
     * Denies every still-parked gate so no agent thread stays blocked behind an
     * answer that will never come. Three callers drive it: cancellation (via the
     * wired signal — a stop or a turn brake), a HUB DISCONNECT (the node wires
     * this to {@code bus.onDisconnect} — a gate the departed hub can never answer
     * must not wedge the run), and the node's defensive {@code finally}.
     */
    void denyAllPending() {
        pending.values().forEach(future -> future.complete(false));
    }

    /**
     * How many gates are currently parked, awaiting an operator answer. A read
     * for a node to report ("N gates awaiting a decision") and the seam tests
     * poll to know a park has landed.
     *
     * @return the count of outstanding gates
     */
    int pending() {
        return pending.size();
    }
}
