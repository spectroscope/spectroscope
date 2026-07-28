package dev.spectroscope.cli;

/**
 * The one monitor object of the trigger loop (card 72): capacity ONE, because
 * one node is one agent identity is one lane — concurrent runs would
 * interleave two runs on one (sender, epoch) stream and turn the machine-room
 * lane into a lie. While a fire is already queued, the insert semantics are
 * per KIND: fs merges (a union of directory statements loses nothing), http
 * is refused (a payload is a distinct datum — the 429 makes the caller the
 * retry authority), timer is refused (the cron overlap-skip precedent).
 */
final class FireSlot {

    enum Disposition { ACCEPTED, COALESCED, REFUSED }

    private Fire held;
    private boolean stopped;

    /**
     * Offers a fire from any source thread.
     *
     * @param fire the incoming fire
     * @return what happened to it — the http source answers its caller from this
     */
    synchronized Disposition offer(Fire fire) {
        if (stopped) {
            return Disposition.REFUSED;
        }
        if (held == null) {
            held = fire;
            notifyAll();
            return Disposition.ACCEPTED;
        }
        if ("fs".equals(fire.kind()) && "fs".equals(held.kind())) {
            held = held.coalesceWith(fire);
            return Disposition.COALESCED;
        }
        return Disposition.REFUSED;
    }

    /**
     * Blocks the trigger loop until a fire (or the stop) arrives.
     *
     * @return the next fire, or null once stopped — the loop's exit signal
     * @throws InterruptedException on thread interrupt while parked
     */
    synchronized Fire take() throws InterruptedException {
        while (held == null && !stopped) {
            wait();
        }
        if (stopped) {
            return null; // a queued fire is discarded — nothing may run after a stop
        }
        Fire fire = held;
        held = null;
        return fire;
    }

    /** Wakes a parked {@link #take} with null and refuses everything after. */
    synchronized void stop() {
        stopped = true;
        held = null;
        notifyAll();
    }
}
