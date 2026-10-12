package dev.spectroscope.core.peer;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * What other agents sent while a run was working (card 502 criterion 5): the
 * second inbox beside {@link dev.spectroscope.core.steering.SteeringInbox},
 * with the same shape. Open for one run, drained by the loop at the two safe
 * points steering uses, and handed to the model as one
 * {@link AgentMessageBlock} per message. It authorises nothing: the loop puts
 * the block into the history as user content and changes no setting.
 *
 * <p>The host learns two things through hooks: what the loop absorbed (so the
 * sender gets {@code delivered}) and what a closing run did not read (so the
 * host can deliver it again as to an idle session).</p>
 */
public final class PeerInbox {

    /** What became of one submit. */
    public enum Submitted {
        /** In line; the running loop reads it at its next safe point. */
        WAITING,
        /** No run is open; nothing was kept. */
        NO_RUN,
        /** The queue is at its cap; nothing was kept. */
        FULL
    }

    private final ArrayDeque<PeerEnvelope> waiting = new ArrayDeque<>();
    private final ArrayDeque<String> notices = new ArrayDeque<>();
    /** Card 503: what the current run absorbed, and what is about to start the next one. */
    private final List<String> absorbedBodies = new ArrayList<>();
    private final List<String> starting = new ArrayList<>();
    private boolean open;
    private volatile Consumer<List<PeerEnvelope>> absorbedHook = taken -> { };
    private volatile Consumer<List<PeerEnvelope>> unreadHook = unread -> { };
    /** Card 505: further listeners for what the loop absorbed. */
    private final List<Consumer<List<PeerEnvelope>>> listeners = new java.util.concurrent.CopyOnWriteArrayList<>();

    /**
     * Puts one message in line.
     *
     * @param envelope the message
     * @return whether it waits, or why it was not kept
     */
    public synchronized Submitted submit(PeerEnvelope envelope) {
        if (!open) {
            return Submitted.NO_RUN;
        }
        if (waiting.size() >= PeerLimits.QUEUE_CAP) {
            return Submitted.FULL;
        }
        waiting.add(envelope);
        for (Runnable listener : submitListeners) {
            listener.run();
        }
        return Submitted.WAITING;
    }

    /** Card 506: told after every message that went into line; never blocks. */
    private final List<Runnable> submitListeners = new java.util.concurrent.CopyOnWriteArrayList<>();

    /**
     * Card 506: a listener told each time a message went into line, so a
     * workflow's fan-out step that holds no model turn can wake without polling.
     * It runs under the inbox's lock and must only signal.
     *
     * @param listener told after each kept message
     * @return removes the listener again
     */
    public Runnable addSubmitListener(Runnable listener) {
        submitListeners.add(listener);
        return () -> submitListeners.remove(listener);
    }

    /**
     * Card 506: takes the waiting messages a test accepts out of line and
     * leaves every other one waiting, in arrival order.
     *
     * @param which what to take
     * @return the taken messages in arrival order; empty when none
     */
    public synchronized List<PeerEnvelope> take(java.util.function.Predicate<PeerEnvelope> which) {
        List<PeerEnvelope> out = new ArrayList<>();
        java.util.Iterator<PeerEnvelope> it = waiting.iterator();
        while (it.hasNext()) {
            PeerEnvelope envelope = it.next();
            if (which.test(envelope)) {
                out.add(envelope);
                it.remove();
            }
        }
        return out;
    }

    /**
     * A delivery notice for this session's model, about a message it sent.
     * Kept across runs, because the run that sent the message may have ended
     * before the answer came; the next run reads it first.
     *
     * @param text the notice, as {@link PeerNotices#notice} words it
     */
    public synchronized void notice(String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        if (notices.size() >= PeerLimits.QUEUE_CAP) {
            notices.poll();
        }
        notices.add(text);
    }

    /** @return every waiting notice in arrival order; empty when none */
    public synchronized List<String> takeNotices() {
        List<String> out = new ArrayList<>(notices);
        notices.clear();
        return out;
    }

    /**
     * Card 503: the body of a peer message that is about to start a run, so
     * the run counts it as absorbed from its first turn.
     *
     * @param body the message body
     */
    public synchronized void startingMessage(String body) {
        if (body != null) {
            starting.add(body);
        }
    }

    /**
     * Card 503: a message that was to start a run and did not.
     *
     * @param body the message body
     */
    public synchronized void forgetStarting(String body) {
        starting.remove(body);
    }

    /**
     * Card 503: the bodies of the peer messages the current run absorbed, the
     * one that started it first. The auto modes read them before they approve
     * a gated call ({@link PeerRelayRule}).
     *
     * @return the bodies, oldest first
     */
    public synchronized List<String> absorbedThisRun() {
        return List.copyOf(absorbedBodies);
    }

    /** A run starts reading. */
    public synchronized void open() {
        open = true;
        absorbedBodies.clear();
        absorbedBodies.addAll(starting);
        starting.clear();
    }

    /** @return whether a run is reading */
    public synchronized boolean isOpen() {
        return open;
    }

    /**
     * The run is over: stop taking messages and hand back what nobody read.
     *
     * @return the unread messages in arrival order, possibly empty
     */
    public List<PeerEnvelope> close() {
        List<PeerEnvelope> unread;
        synchronized (this) {
            open = false;
            unread = drain();
        }
        if (!unread.isEmpty()) {
            unreadHook.accept(unread);
        }
        return unread;
    }

    /** @return whether anything is in line */
    public synchronized boolean waiting() {
        return !waiting.isEmpty();
    }

    /** @return how many messages are in line */
    public synchronized int size() {
        return waiting.size();
    }

    /** @return every waiting message in arrival order; empty when none */
    public synchronized List<PeerEnvelope> take() {
        return drain();
    }

    /**
     * Card 505: one more listener for what the loop absorbed, beside the
     * host's hook. It is told synchronously, on the loop's thread.
     *
     * @param listener told what the loop absorbed
     */
    public void addAbsorbedListener(Consumer<List<PeerEnvelope>> listener) {
        if (listener != null) {
            listeners.add(listener);
        }
    }

    /**
     * Card 505, fix round two: a message body that reached the model another
     * way than through this inbox, as a tool result, counts as absorbed for
     * {@link PeerRelayRule}. The host's hook and the listeners are not told.
     *
     * @param body the body
     */
    public synchronized void collected(String body) {
        if (body != null) {
            absorbedBodies.add(body);
        }
    }

    /** @return how many listeners {@link #addAbsorbedListener} holds (card 505, fix round two) */
    public int absorbedListeners() {
        return listeners.size();
    }

    /**
     * Card 505: takes one waiting message out of line, because it reached the
     * model another way.
     *
     * @param msgId the message's id
     * @return true when a waiting message with that id was removed
     */
    public synchronized boolean withdraw(String msgId) {
        if (msgId == null) {
            return false;
        }
        return waiting.removeIf(envelope -> msgId.equals(envelope.msgId()));
    }

    /** @param hook told what the loop absorbed */
    public void onAbsorbed(Consumer<List<PeerEnvelope>> hook) {
        absorbedHook = hook == null ? taken -> { } : hook;
    }

    /** @param hook told what a closing run did not read */
    public void onUnread(Consumer<List<PeerEnvelope>> hook) {
        unreadHook = hook == null ? unread -> { } : hook;
    }

    /**
     * The loop put these into the history.
     *
     * @param taken what {@link #take()} returned
     */
    public void absorbed(List<PeerEnvelope> taken) {
        if (taken != null && !taken.isEmpty()) {
            synchronized (this) {
                for (PeerEnvelope envelope : taken) {
                    if (envelope.text() != null) {
                        absorbedBodies.add(envelope.text());
                    }
                }
            }
            List<PeerEnvelope> copy = List.copyOf(taken);
            absorbedHook.accept(copy);
            for (Consumer<List<PeerEnvelope>> listener : listeners) {
                listener.accept(copy);
            }
        }
    }

    /**
     * The text the model reads for a batch of messages.
     *
     * @param taken   the messages
     * @param working true while the run is working
     * @return one block per message, separated by a blank line
     */
    public static String attributed(List<PeerEnvelope> taken, boolean working) {
        List<String> blocks = new ArrayList<>(taken.size());
        for (PeerEnvelope envelope : taken) {
            blocks.add(AgentMessageBlock.render(envelope, working));
        }
        return String.join("\n\n", blocks);
    }

    private List<PeerEnvelope> drain() {
        List<PeerEnvelope> out = new ArrayList<>(waiting);
        waiting.clear();
        return out;
    }
}
