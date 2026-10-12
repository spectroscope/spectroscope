package dev.spectroscope.core.subagents;

import dev.spectroscope.core.BackgroundChildren;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.peer.AgentMessageBlock;
import dev.spectroscope.core.peer.PeerEnvelope;
import dev.spectroscope.core.peer.PeerFrames;
import dev.spectroscope.core.peer.PeerInbox;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Card 505: the children one parent run started with {@code spawn_agents}
 * and {@code background: true}.
 *
 * <p>The children run under their own signal, which the parent's signal
 * cancels, so a cancel of the parent reaches every one of them and the run's
 * end can cancel the ones still running without cancelling the parent. A
 * child's status lines and its result go into the parent's inbox as messages;
 * a result is also kept until somebody collects it: the loop when it absorbs
 * the message, {@code wait_agents}, or the join at the parent's
 * {@code end_turn}. Whoever collects first takes it, so the model reads each
 * result once.</p>
 */
final class BackgroundRun implements BackgroundChildren {

    private static final Logger log = LoggerFactory.getLogger(BackgroundRun.class);

    /** How long a run with a goal waits at its end_turn before its first check
     *  in: card 504's governed {@code GOAL_CHECKIN_MINUTES}, in milliseconds. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.MILLISECONDS)
    static final long CHECK_IN_FIRST_MS = dev.spectroscope.core.goal.GoalCheckIn.FIRST_INTERVAL_MS;

    /** The longest wait a model may ask of {@code wait_agents}; a longer one is cut to it. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    static final int WAIT_MAX_SECONDS = 3_600;

    /** How long a run's end waits for the children it cancelled before it ends anyway. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    static final long SETTLE_MS = 30_000L;

    /**
     * Characters of a background child's status line the parent keeps and
     * reads at most (card 505, fix round two); the rest is cut.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    static final int STATUS_LINE_CAP = 500;

    /** The reason a child's signal carries when its parent run ended before it. */
    static final String STOP_PARENT_ENDED = "parent_ended";

    /** One background child. Fields other than the final ones are guarded by the run. */
    private static final class Child {
        final String id;
        final String role;
        final String resultMsgId = PeerFrames.newMsgId();
        final CompletableFuture<String> outcome = new CompletableFuture<>();
        String lastStatus;
        String text;
        boolean failed;
        boolean collected;

        Child(String id, String role) {
            this.id = id;
            this.role = role;
        }
    }

    private final CancelSignal signal = new CancelSignal();
    private final PeerInbox parentInbox;
    private final long checkInMs;
    private final long settleMs;
    private final Map<String, Child> children = new LinkedHashMap<>();

    /**
     * @param parentSignal the parent run's signal; its cancel reaches every child
     * @param parentInbox  the parent's inbox, or null where none is wired
     * @param checkInMs    how long a goal run waits before it checks in
     */
    BackgroundRun(CancelSignal parentSignal, PeerInbox parentInbox, long checkInMs) {
        this(parentSignal, parentInbox, checkInMs, SETTLE_MS);
    }

    /**
     * @param parentSignal the parent run's signal; its cancel reaches every child
     * @param parentInbox  the parent's inbox, or null where none is wired
     * @param checkInMs    how long a goal run waits before it checks in
     * @param settleMs     how long the run's end waits for the children it cancelled
     */
    BackgroundRun(CancelSignal parentSignal, PeerInbox parentInbox, long checkInMs, long settleMs) {
        this.parentInbox = parentInbox;
        this.checkInMs = checkInMs;
        this.settleMs = settleMs;
        parentSignal.onCancel(signal::cancel);
    }

    /** @return how long the run's end waits for the children it cancelled */
    long settleMs() {
        return settleMs;
    }

    /** @return the signal every background child of this run runs under */
    CancelSignal signal() {
        return signal;
    }

    /**
     * @param id   the child's id
     * @param role its role word
     */
    synchronized void add(String id, String role) {
        children.put(id, new Child(id, role));
    }

    /** @param id a child id @return true when it is a background child of this run */
    synchronized boolean holds(String id) {
        return id != null && children.containsKey(id);
    }

    /** @return the ids of this run's background children, in spawn order */
    synchronized List<String> names() {
        return List.copyOf(children.keySet());
    }

    /** @param id a child id @return its role, or null */
    synchronized String role(String id) {
        Child child = children.get(id);
        return child == null ? null : child.role;
    }

    /** @param id a child id @return its last status line, or null */
    synchronized String lastStatus(String id) {
        Child child = children.get(id);
        return child == null ? null : child.lastStatus;
    }

    /** @param id a child id @return true once it has ended */
    synchronized boolean ended(String id) {
        Child child = children.get(id);
        return child != null && child.outcome.isDone();
    }

    /** @param id a child id @return true when it ended with an error */
    synchronized boolean failed(String id) {
        Child child = children.get(id);
        return child != null && child.failed;
    }

    /** @param id a child id @return true once its result reached the model */
    synchronized boolean collected(String id) {
        Child child = children.get(id);
        return child != null && child.collected;
    }

    /**
     * A status line of a background child: kept for the listings and sent to
     * the parent's inbox as a message.
     *
     * @param id   the child
     * @param line the line
     */
    synchronized void status(String id, String line) {
        Child child = children.get(id);
        if (child == null) {
            return;
        }
        String kept = capped(line);
        child.lastStatus = oneLine(kept);
        String msgId = PeerFrames.newMsgId();
        statusIds.add(msgId);
        submit(msgId, id, "status", "Status of " + id + ": " + kept);
    }

    /** @return the msg ids of the status lines this run put into the parent's inbox (card 506 fix round 1) */
    synchronized java.util.Set<String> statusIds() {
        return java.util.Set.copyOf(statusIds);
    }

    /**
     * A background child ended. Its result goes into the parent's inbox before
     * anybody waiting on it wakes, so a waiter that collects it can take the
     * message back out of line.
     *
     * @param id      the child
     * @param outcome its result line and answer, or an ERROR: string
     */
    void finished(String id, String outcome) {
        Child child;
        synchronized (this) {
            child = children.get(id);
            if (child == null) {
                return;
            }
            child.text = outcome;
            child.failed = outcome.startsWith("ERROR:");
            if (!child.collected && parentInbox != null) {
                parentInbox.submit(resultMessage(child));
            }
        }
        child.outcome.complete(outcome);
        for (Runnable listener : endListeners) {
            listener.run();
        }
    }

    /** Card 506: told after each child ended. */
    private final List<Runnable> endListeners = new java.util.concurrent.CopyOnWriteArrayList<>();

    /**
     * Card 506: a listener told after each child ended, so a workflow's
     * fan-out step wakes when its last child ends even if the full inbox
     * dropped the result message.
     *
     * @param listener told after each end; must only signal
     */
    void addEndListener(Runnable listener) {
        endListeners.add(listener);
    }

    /** Card 506 fix round 1: the status lines this run submitted, by msg id. */
    private final java.util.Set<String> statusIds = new java.util.HashSet<>();

    /**
     * The parent's loop took these messages in; a result among them is collected.
     *
     * @param taken the messages
     */
    synchronized void absorbed(List<PeerEnvelope> taken) {
        for (PeerEnvelope envelope : taken) {
            for (Child child : children.values()) {
                if (child.resultMsgId.equals(envelope.msgId())) {
                    child.collected = true;
                }
            }
        }
    }

    private void submit(String msgId, String from, String summary, String text) {
        if (parentInbox == null) {
            return;
        }
        parentInbox.submit(message(msgId, from, summary, text));
    }

    private static PeerEnvelope message(String msgId, String from, String summary, String text) {
        return PeerEnvelope.builder().msgId(msgId).from(from).fromName(from).priority("next")
                .summary(summary).text(text).build();
    }

    /** One ended child's result as the message it reaches the parent in; the caller holds the lock. */
    private static PeerEnvelope resultMessage(Child child) {
        return message(child.resultMsgId, child.id, "result",
                "Result of " + child.id + " (" + verdict(child) + "):\n" + child.text);
    }

    /**
     * A child's status line as the listings and the check in show it: on one
     * line, and unable to open or close a message tag.
     */
    static String oneLine(String line) {
        if (line == null) {
            return null;
        }
        return AgentMessageBlock.scrub(line).replaceAll("[\\r\\n\\u0085\\u2028\\u2029]+", " ").strip();
    }

    /**
     * A status line cut to {@link #STATUS_LINE_CAP} characters, so a child
     * cannot fill its parent's context through its status lines.
     *
     * @param line the line, or null
     * @return the line, cut with a note when it was longer
     */
    static String capped(String line) {
        if (line == null || line.length() <= STATUS_LINE_CAP) {
            return line;
        }
        // Card 504, hub and spoke fix round: never half of a surrogate pair.
        int end = Character.isHighSurrogate(line.charAt(STATUS_LINE_CAP - 1)) ? STATUS_LINE_CAP - 1 : STATUS_LINE_CAP;
        return line.substring(0, end) + " [cut at " + STATUS_LINE_CAP + " characters]";
    }

    private static String verdict(Child child) {
        return child.failed ? "failed" : "completed";
    }

    /** Collects one ended child's result; the caller holds the lock. */
    private String collect(Child child) {
        child.collected = true;
        if (parentInbox != null) {
            parentInbox.withdraw(child.resultMsgId);
        }
        return "--- " + child.id + " (" + verdict(child) + ") ---\n" + child.text;
    }

    /**
     * {@code wait_agents}: waits for the named children and reports on each.
     *
     * @param ids       the children, every one of this run when empty
     * @param timeoutMs at most this long; negative waits until they have ended, zero not at all
     * @param callSignal the calling run's signal
     * @return one section per child, in the order asked
     */
    String waitFor(List<String> ids, long timeoutMs, CancelSignal callSignal) {
        List<CompletableFuture<String>> futures = new ArrayList<>();
        synchronized (this) {
            for (String id : ids) {
                futures.add(children.get(id).outcome);
            }
        }
        await(futures, timeoutMs, callSignal);
        List<String> sections = new ArrayList<>();
        synchronized (this) {
            for (String id : ids) {
                Child child = children.get(id);
                if (!child.outcome.isDone()) {
                    String status = child.lastStatus == null ? "no status line yet" : "last status: " + child.lastStatus;
                    sections.add("--- " + id + " (still running) ---\n" + status);
                } else if (child.collected) {
                    sections.add("--- " + id + " (" + verdict(child) + ") ---\n"
                            + "Its result reached you earlier as a message.");
                } else {
                    sections.add(collect(child));
                    // Fix round two: a result wait_agents hands over counts as
                    // taken in, as it does on the inbox and the end_turn paths,
                    // so the relay rule of the auto modes reads it either way.
                    if (parentInbox != null) {
                        parentInbox.collected(resultMessage(child).text());
                    }
                }
            }
        }
        return String.join("\n\n", sections);
    }

    @Override
    public synchronized boolean pending() {
        for (Child child : children.values()) {
            if (!child.outcome.isDone() || !child.collected) {
                return true;
            }
        }
        return false;
    }

    @Override
    public List<PeerEnvelope> join(CancelSignal runSignal, long waitMs) {
        List<CompletableFuture<String>> running = new ArrayList<>();
        synchronized (this) {
            for (Child child : children.values()) {
                if (!child.outcome.isDone()) {
                    running.add(child.outcome);
                }
            }
        }
        boolean all = await(running, waitMs <= 0 ? -1 : waitMs, runSignal);
        if (!all || (runSignal != null && runSignal.isCancelled())) {
            return null;
        }
        List<PeerEnvelope> results = new ArrayList<>();
        synchronized (this) {
            for (Child child : children.values()) {
                if (child.outcome.isDone() && !child.collected) {
                    collect(child);
                    results.add(resultMessage(child));
                }
            }
        }
        return results;
    }

    @Override
    public synchronized String runningLines() {
        StringBuilder out = new StringBuilder();
        for (Child child : children.values()) {
            if (!child.outcome.isDone()) {
                out.append("  ").append(child.id).append(" · ").append(child.role).append(" · still running · ")
                        .append(child.lastStatus == null ? "no status line yet" : child.lastStatus).append('\n');
            }
        }
        return out.toString();
    }

    @Override
    public synchronized int runningCount() {
        int running = 0;
        for (Child child : children.values()) {
            if (!child.outcome.isDone()) {
                running++;
            }
        }
        return running;
    }

    @Override
    public long checkInMs() {
        return checkInMs;
    }

    @Override
    public void settle() {
        List<CompletableFuture<String>> running = new ArrayList<>();
        synchronized (this) {
            for (Child child : children.values()) {
                if (!child.outcome.isDone()) {
                    running.add(child.outcome);
                }
            }
        }
        if (running.isEmpty()) {
            return;
        }
        signal.cancel(STOP_PARENT_ENDED);
        if (!await(running, settleMs, null)) {
            log.warn("{} background children had not ended {} ms after their parent run ended",
                    running.stream().filter(f -> !f.isDone()).count(), settleMs);
        }
    }

    /** Test seam: one {@code id=state[:last status]} per child, joined by semicolons. */
    synchronized String snapshot(java.util.function.Predicate<String> working) {
        List<String> out = new ArrayList<>();
        for (Child child : children.values()) {
            String state = child.outcome.isDone() ? (child.failed ? "failed" : "finished")
                    : working.test(child.id) ? "working" : "waiting";
            out.add(child.id + "=" + state + (child.lastStatus == null ? "" : ":" + child.lastStatus));
        }
        return String.join(";", out);
    }

    /**
     * Waits without polling until every future is done, the signal is
     * cancelled or the time has passed.
     *
     * @param futures   the futures
     * @param timeoutMs at most this long; negative waits without a limit, zero does not wait
     * @param stopOn    a signal whose cancel ends the wait, or null
     * @return true when every future is done
     */
    private static boolean await(List<CompletableFuture<String>> futures, long timeoutMs, CancelSignal stopOn) {
        if (futures.isEmpty()) {
            return true;
        }
        CompletableFuture<Void> all = CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new));
        if (timeoutMs == 0) {
            return all.isDone();
        }
        CompletableFuture<Object> stop = new CompletableFuture<>();
        Runnable release = stopOn == null ? () -> { } : stopOn.onCancel(() -> stop.complete(null));
        try {
            CompletableFuture<Object> either = CompletableFuture.anyOf(all, stop);
            if (timeoutMs < 0) {
                either.get();
            } else {
                either.get(timeoutMs, TimeUnit.MILLISECONDS);
            }
        } catch (TimeoutException late) {
            // the caller reads what is done
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException impossible) {
            // the futures complete normally; nothing to report
        } finally {
            release.run();
        }
        return all.isDone();
    }
}
