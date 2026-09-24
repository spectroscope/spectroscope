package dev.spectroscope.core.subagents;

import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.events.RunEvent;

import java.util.Iterator;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * The shared-queue merge: ONE BlockingQueue, many producers
 * (the parent pump plus one forwarder thread per child), exactly ONE
 * consumer (the CLI's for-each). Intended for a single consumer — do not
 * hand the iterator to several threads.
 */
final class MergedEventStream implements EventStream {

    /**
     * Poison pill: a BlockingQueue cannot hold null, so end-of-stream is a
     * dedicated sentinel instance, recognized by REFERENCE identity (==).
     * It is never handed to the consumer and never serialized.
     */
    static final RunEvent END_OF_STREAM = new RunEvent.RunEnd("__end__", "__end__", 0L);

    /** Unbounded on purpose: producers must never block behind a slow renderer. */
    private final BlockingQueue<RunEvent> queue = new LinkedBlockingQueue<>();

    /**
     * Card 395: the most bytes the text of one merged delta may take once it is
     * written as JSON (UTF-8, with the escapes JSON needs). The session file
     * writes each line through {@code Files.write}, which hands the bytes over
     * in chunks of 8,192, and a second writer landing between two chunks tears
     * the line (card 406; measured on 2026-09-24 with a 12,000-character merged
     * line). This budget leaves 512 bytes for the rest of the line, so a merge
     * never builds a line of that size. A single delta that is larger already
     * is handed out as it came.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    static final int MAX_MERGED_TEXT_BYTES = 7_680;

    /** What cancel()/close() should do — the manager passes parentSignal::cancel. */
    private final Runnable onCancel;

    private volatile boolean ended = false;

    /**
     * One instance per merged run, created by SubagentManager.run.
     *
     * @param onCancel invoked by cancel()/close() — the parent signal's cancel,
     *                 so closing the merged stream tears down the whole tree
     */
    MergedEventStream(Runnable onCancel) {
        this.onCancel = onCancel;
    }

    /**
     * Producer side: the parent pump and the child forwarders put events here.
     * Events arriving after end() are dropped — by the time the parent run
     * ends, every child has already finished (see SubagentManager.run), so
     * nothing of value can be lost.
     *
     * @param event the next parent or child event, enqueued in arrival order
     */
    void put(RunEvent event) {
        if (ended) {
            return;
        }
        try {
            queue.put(event);
        } catch (InterruptedException interrupted) {
            // The producer virtual thread is being torn down: stop producing.
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Ends the stream. The consumer first drains everything still buffered
     * (the queue is FIFO), then sees the sentinel and stops. Idempotent.
     */
    void end() {
        if (ended) {
            return;
        }
        ended = true;
        queue.add(END_OF_STREAM); // add(): unbounded queue, never blocks
    }

    /** Runs the injected cancel hook — cancelling the merge cancels the parent signal, which cascades to every child. */
    @Override
    public void cancel() {
        onCancel.run();
    }

    /** Idempotent; also cancels — the EventStream contract. */
    @Override
    public void close() {
        cancel();
    }

    /** @param event any event
     *  @return true for a thinking or text delta, the two kinds a merge joins */
    private static boolean isDelta(RunEvent event) {
        return event instanceof RunEvent.ThinkingDelta || event instanceof RunEvent.TextDelta;
    }

    /** @param delta a thinking or text delta
     *  @return the agent that streamed it */
    private static String deltaAgent(RunEvent delta) {
        return delta instanceof RunEvent.ThinkingDelta thinking
                ? thinking.agentId()
                : ((RunEvent.TextDelta) delta).agentId();
    }

    /**
     * Card 395: how many bytes {@code text} takes in a session line, which
     * {@code SessionStore.append} builds with Jackson's
     * {@code writeValueAsString} and writes as UTF-8. Quotes, backslashes and
     * the five short control escapes take two bytes, every other control
     * character six (a backslash, a u and four hex digits). Each half of a
     * surrogate pair counts two, since the pair is four bytes in UTF-8.
     * {@code MergedEventStreamTest} holds this against that same path for
     * every char and for a pair.
     *
     * @param text the text to measure
     * @return an upper bound for its JSON-escaped UTF-8 size
     */
    static int jsonBytes(CharSequence text) {
        int bytes = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '"' || c == '\\') {
                bytes += 2;
            } else if (c < 0x20) {
                bytes += (c == '\n' || c == '\r' || c == '\t' || c == '\b' || c == '\f') ? 2 : 6;
            } else if (c < 0x80) {
                bytes += 1;
            } else if (c < 0x800) {
                bytes += 2;
            } else if (Character.isSurrogate(c)) {
                bytes += 2;
            } else {
                bytes += 3;
            }
        }
        return bytes;
    }

    /** @param delta a thinking or text delta
     *  @return the piece of text it carries */
    private static String deltaText(RunEvent delta) {
        return delta instanceof RunEvent.ThinkingDelta thinking
                ? thinking.text()
                : ((RunEvent.TextDelta) delta).text();
    }

    /** The single consumer's view: a blocking iterator that drains the queue, merges queued deltas
     *  (card 395) and stops at the sentinel. */
    @Override
    public Iterator<RunEvent> iterator() {
        return new Iterator<>() {
            private RunEvent lookahead; // hasNext() parks the taken event here
            private boolean done = false;

            /** Blocks on the queue until an event or the sentinel arrives; parks the taken event for next(). */
            @Override
            public boolean hasNext() {
                if (done) {
                    return false;
                }
                if (lookahead != null) {
                    return true;
                }
                try {
                    RunEvent taken = queue.take(); // blocks — fine on a virtual thread
                    if (taken == END_OF_STREAM) {
                        done = true;
                        return false;
                    }
                    lookahead = coalesce(taken);
                    return true;
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    done = true;
                    return false;
                }
            }

            /**
             * Card 395: a thinking or text delta takes along the deltas of the
             * same kind and the same agent that are queued behind it, without
             * waiting for more. Other agents' deltas in between stay in the
             * queue, in their order, so children streaming at the same time
             * still merge (review of 2026-09-24). The merge stops at the first
             * event that is not a delta, at the same agent's delta of the other
             * kind, at the end of the queue and before the piece that would take
             * the text past {@link #MAX_MERGED_TEXT_BYTES}. So each agent's own
             * events keep their order, and no event carries two agents' text;
             * what changes is the order of deltas between agents. The joined
             * text keeps the order of the pieces and the merged delta keeps the
             * first piece's timestamp. An empty queue merges nothing, so a
             * stream the consumer keeps up with is handed out exactly as it was
             * put.
             *
             * <p>Removing through the queue's iterator is safe here because
             * this iterator is the only consumer; producers only append.</p>
             *
             * @param first the event just taken from the queue
             * @return {@code first} itself, or one delta carrying its text and its agent's text behind it
             */
            private RunEvent coalesce(RunEvent first) {
                if (!isDelta(first)) {
                    return first;
                }
                String agentId = deltaAgent(first);
                StringBuilder text = new StringBuilder(deltaText(first));
                int bytes = jsonBytes(text);
                boolean merged = false;
                Iterator<RunEvent> behind = queue.iterator();
                while (behind.hasNext()) {
                    RunEvent next = behind.next();
                    // The end-of-stream sentinel is a RunEnd, so it stops the merge here too.
                    if (!isDelta(next)) {
                        break;
                    }
                    if (!Objects.equals(agentId, deltaAgent(next))) {
                        continue; // another agent's delta stays where it is
                    }
                    if (next.getClass() != first.getClass()) {
                        break; // this agent's other kind: nothing of its own may pass it
                    }
                    int more = jsonBytes(deltaText(next));
                    if (bytes + more > MAX_MERGED_TEXT_BYTES) {
                        break;
                    }
                    behind.remove();
                    text.append(deltaText(next));
                    bytes += more;
                    merged = true;
                }
                if (!merged) {
                    return first;
                }
                return first instanceof RunEvent.ThinkingDelta thinking
                        ? new RunEvent.ThinkingDelta(agentId, text.toString(), thinking.ts())
                        : new RunEvent.TextDelta(agentId, text.toString(), first.ts());
            }

            /** Hands out the event parked by hasNext(). */
            @Override
            public RunEvent next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                RunEvent event = lookahead;
                lookahead = null;
                return event;
            }
        };
    }
}
