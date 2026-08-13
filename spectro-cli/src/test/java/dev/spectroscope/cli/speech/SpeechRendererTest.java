package dev.spectroscope.cli.speech;

import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The voice-output consumer proven WITHOUT any binary: a fake {@link SpeechEngine}
 * captures the sentences the renderer would speak, so the REAL logic under test —
 * sentence segmentation over a flood of {@code text_delta}s, the trailing partial
 * flushed at {@code run_end}, strictly sequential playback order, and abort emptying
 * the queue and stopping the player — is exercised with no piper and no audio player.
 * That is the whole point of the engine seam; it is also why {@code spectro-core} needs
 * zero changes for this feature.
 *
 * <p>The class-wide {@link Timeout} is a gate guard, not a performance budget: a hanging
 * test is worse than a red one, because it blocks every other gate run on the machine
 * rather than just failing. {@code SEPARATE_THREAD} is load-bearing and must not be
 * "simplified" away — the default mode enforces the deadline by INTERRUPTING the test
 * thread, and a thread wedged in {@code idle()} used to swallow that interrupt and spin
 * at 100% CPU forever. Measured on 2026-08-13: with the default mode the build never
 * finished; with {@code SEPARATE_THREAD} it failed in six seconds.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SpeechRendererTest {

    private static final String MAIN = "main";

    /**
     * Attempts at the pump-exit window. The race is hit within the first few hundred on
     * an idle machine, so this is generous; once the bookkeeping is correct every
     * attempt costs microseconds and the whole loop is well under a second.
     */
    private static final int RACE_ATTEMPTS = 4000;

    // --- fakes ---------------------------------------------------------------

    /**
     * Records synthesized and played sentences in order; playback can be gated for the
     * abort test. Modeled on the production engine: {@link #play} starts "playback" and
     * returns a handle at once; {@link Playback#await()} is what blocks. A gated await
     * lets a test freeze the first sentence mid-playback and then abort, exactly as a
     * real long WAV would.
     */
    private static final class FakeEngine implements SpeechEngine {
        final List<String> synthesized = new CopyOnWriteArrayList<>();
        final List<String> played = new CopyOnWriteArrayList<>();
        final AtomicInteger stopsCalled = new AtomicInteger();
        volatile boolean available = true;
        // Optional gate: when set, await() blocks until released (or stopped) — the
        // "long sentence still playing" the abort test needs.
        volatile CountDownLatch playGate;
        volatile CountDownLatch firstPlayStarted;

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public Clip synthesize(String sentence) {
            synthesized.add(sentence);
            return new FakeClip(sentence);
        }

        @Override
        public Playback play(Clip clip) {
            // Playback has begun: record it and hand back a handle immediately, like a
            // started child process. Whether it BLOCKS is decided in await().
            played.add(clip.sentence());
            if (firstPlayStarted != null) {
                firstPlayStarted.countDown();
            }
            return new FakePlayback();
        }

        private final class FakePlayback implements Playback {
            @Override
            public void await() {
                CountDownLatch gate = playGate;
                if (gate != null) {
                    try {
                        gate.await(2, TimeUnit.SECONDS); // "still playing" until released or stopped
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
            }

            @Override
            public void stop() {
                stopsCalled.incrementAndGet();
                CountDownLatch gate = playGate;
                if (gate != null) {
                    gate.countDown(); // destroy() unblocks the player, like killing the process
                }
            }
        }

        private record FakeClip(String sentence) implements Clip {
            @Override
            public void discard() {
                // nothing to clean up
            }
        }
    }

    // --- helpers -------------------------------------------------------------

    private static void delta(SpeechRenderer speech, String text) {
        speech.onEvent(new RunEvent.TextDelta(MAIN, text, 0L));
    }

    private static void runStart(SpeechRenderer speech) {
        speech.onEvent(new RunEvent.RunStart("r1", MAIN, null, "p", "anthropic", null, 0L));
    }

    private static void runEnd(SpeechRenderer speech, String stopReason) {
        speech.onEvent(new RunEvent.RunEnd("r1", stopReason, 0L));
    }

    // --- tests ---------------------------------------------------------------

    @Test
    void multiSentenceDeltaFloodIsCutIntoExactlyThoseSentences() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            // A flood of deltas splitting mid-sentence, mid-word — the buffer reassembles.
            delta(speech, "The first sentence is here. The second ");
            delta(speech, "sentence follows. And a th");
            delta(speech, "ird one ends it.");
            runEnd(speech, "end_turn"); // flushes the trailing partial

            speech.idle();

            assertEquals(
                    List.of(
                            "The first sentence is here.",
                            "The second sentence follows.",
                            "And a third one ends it."),
                    engine.synthesized,
                    "each complete sentence is one synthesis unit; the last is flushed at run_end");
        }
    }

    @Test
    void theFirstSentenceIsSpokenBeforeRunEnd() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            // A complete sentence plus the start of the next — NO run_end yet.
            delta(speech, "This sentence is complete. The next is only just be");

            // Latency is the product goal: the first sentence must synthesize now,
            // not wait for the run to finish.
            waitUntil(() -> engine.synthesized.contains("This sentence is complete."));

            assertEquals(List.of("This sentence is complete."), engine.synthesized,
                    "the first sentence starts as soon as it is complete, before run_end");
        }
    }

    @Test
    void theTrailingPartialWithoutFinalPunctuationIsFlushedAtRunEnd() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            delta(speech, "A sentence with no closing period"); // no '.', no following capital
            assertTrue(engine.synthesized.isEmpty(), "an unterminated sentence is not spoken yet");

            runEnd(speech, "end_turn");
            speech.idle();

            assertEquals(List.of("A sentence with no closing period"), engine.synthesized,
                    "the remaining buffer is spoken once at run_end");
        }
    }

    @Test
    void playbackHappensStrictlyInSentenceOrder() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            delta(speech, "Alpha one. Bravo two. Charlie three. Delta four. Echo five.");
            runEnd(speech, "end_turn");

            speech.idle();

            List<String> expected = List.of(
                    "Alpha one.", "Bravo two.", "Charlie three.", "Delta four.", "Echo five.");
            assertEquals(expected, engine.played,
                    "playback is a single strictly-ordered queue, never out of order");
            // Even though synthesis may run ahead, it does not reorder.
            assertEquals(expected, engine.synthesized);
        }
    }

    @Test
    void abortClearsTheQueueAndStopsThePlayer() throws Exception {
        FakeEngine engine = new FakeEngine();
        CountDownLatch gate = new CountDownLatch(1);
        CountDownLatch firstStarted = new CountDownLatch(1);
        engine.playGate = gate;
        engine.firstPlayStarted = firstStarted;

        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            // Several sentences: the first enters playback (and blocks on the gate),
            // the rest queue up behind it.
            delta(speech, "One two three. Four five six. Seven eight nine. Ten eleven twelve.");
            runEnd(speech, "end_turn");

            // Wait until the first sentence is actually inside play() (blocked on the gate).
            assertTrue(firstStarted.await(2, TimeUnit.SECONDS), "playback must have started");

            // Abort while sentence 1 is 'playing' (await blocked on the gate) and 2..4
            // wait in the queue.
            runEnd(speech, "aborted");

            // The running player was destroyed (which also releases the gate) and the
            // queue was cleared.
            // Waited for, not assumed: the abort travels to the playback thread,
            // so reading the counter the instant runEnd returns is a race the
            // assertion loses under load. It lost it once during the 0.8.0 gate
            // and passed on every isolated re-run, which is the signature. The
            // threshold is unchanged, only the deadline is now explicit.
            waitUntil(() -> engine.stopsCalled.get() >= 1);
            assertTrue(engine.stopsCalled.get() >= 1, "the running player is stopped on abort");

            Thread.sleep(150); // give any (wrongly) surviving queued playback a chance to run

            assertEquals(List.of("One two three."), engine.played,
                    "only the already-started sentence reached playback; 2..4 were dropped, got "
                            + engine.played);
            assertFalse(engine.played.contains("Ten eleven twelve."),
                    "a queued sentence must never speak after abort");
        }
    }

    @Test
    void anAbbreviationDoesNotEndASentence() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            delta(speech, "Use a tool, e.g. the reader, when it helps. Then answer.");
            runEnd(speech, "end_turn");

            speech.idle();

            assertEquals(
                    List.of("Use a tool, e.g. the reader, when it helps.", "Then answer."),
                    engine.synthesized,
                    "the period in 'e.g.' must not split the sentence");
        }
    }

    @Test
    void aCodeBlockIsAnnouncedNotReadAsCharacterNoise() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            delta(speech, "Here is the code. ```python\nsystem('rm -rf /')\n``` That is the example.");
            runEnd(speech, "end_turn");

            speech.idle();

            assertTrue(engine.synthesized.contains("Code block skipped."),
                    "the fenced code is announced, not spelled out: " + engine.synthesized);
            assertTrue(engine.synthesized.stream().noneMatch(s -> s.contains("rm -rf")),
                    "the code content is never spoken: " + engine.synthesized);
            assertTrue(engine.synthesized.stream().noneMatch(s -> s.contains("system(")),
                    "no code characters are spoken: " + engine.synthesized);
            assertTrue(engine.synthesized.stream().anyMatch(s -> s.contains("example")),
                    "the explanatory text after the block is still spoken: " + engine.synthesized);
        }
    }

    @Test
    void markdownFormattingCharactersAreStrippedBeforeSynthesis() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            delta(speech, "This is **very** important and see [the docs](http://x). Done here.");
            runEnd(speech, "end_turn");

            speech.idle();

            assertTrue(engine.synthesized.stream().noneMatch(s -> s.contains("*")),
                    "asterisks are not spoken: " + engine.synthesized);
            assertTrue(engine.synthesized.stream().anyMatch(s -> s.contains("the docs")),
                    "a link keeps only its text: " + engine.synthesized);
            assertTrue(engine.synthesized.stream().noneMatch(s -> s.contains("http")),
                    "the link target is dropped: " + engine.synthesized);
        }
    }

    @Test
    void nothingIsSpokenWhenDisabled() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, false)) { // --speak absent
            runStart(speech);
            delta(speech, "A complete sentence here. And another one.");
            runEnd(speech, "end_turn");
            speech.idle();

            assertTrue(engine.synthesized.isEmpty(), "a disabled renderer never synthesizes");
        }
    }

    @Test
    void speakOnThenOffTogglesSynthesisAndStopsTheQueue() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, false)) {
            speech.setEnabled(true); // /speak on
            runStart(speech);
            delta(speech, "First sentence spoken. Second sentence spoken.");
            speech.idle();
            assertFalse(engine.synthesized.isEmpty(), "after /speak on, sentences are synthesized");

            speech.setEnabled(false); // /speak off clears and silences
            int spokenSoFar = engine.synthesized.size();
            runStart(speech);
            delta(speech, "This must stay silent. Nothing here.");
            speech.idle();
            assertEquals(spokenSoFar, engine.synthesized.size(),
                    "after /speak off nothing new is synthesized");
        }
    }

    @Test
    void anUnavailableEngineDisablesItselfWithAReadableHint() throws Exception {
        FakeEngine engine = new FakeEngine();
        engine.available = false; // piper/voice/player missing
        java.io.PrintStream realErr = System.err;
        java.io.ByteArrayOutputStream captured = new java.io.ByteArrayOutputStream();
        System.setErr(new java.io.PrintStream(captured, true, java.nio.charset.StandardCharsets.UTF_8));
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            delta(speech, "A complete sentence here. And another.");
            runEnd(speech, "end_turn");
            speech.idle();
        } finally {
            System.setErr(realErr);
        }

        assertTrue(engine.synthesized.isEmpty(),
                "with piper/voice/player missing, nothing is synthesized");
        String hint = captured.toString(java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(hint.contains("Voice output disabled"), "a readable hint is printed: " + hint);
        assertTrue(hint.contains("scripts/setup-tts.sh"),
                "the hint points at the setup script: " + hint);
    }

    /**
     * The gate hang, pinned. Each delta below enqueues exactly one sentence; the synthesis
     * pump drains it and then leaves, because its queue is empty. The next delta races that
     * exit. If a pump clears its "running" flag in a SEPARATE lock hold from the decision to
     * leave, an enqueue can slip in between: it sees a flag that is still true, starts no
     * worker, and its sentence is stranded with nobody left to drain it. {@code idle()} then
     * waits forever on a thread that has already died — measured on 2026-08-13, where a
     * {@code :spectro-cli:test} worker sat 13+ minutes in {@code idle()} while its executor
     * held zero live threads. The delay is swept across the window so the interleaving is hit
     * rather than hoped for, and both pumps are watched: synthesis and playback carry the
     * same bookkeeping and so the same hazard.
     */
    @Test
    void aSentenceEnqueuedWhileAPumpIsLeavingIsStillSpoken() throws Exception {
        FakeEngine engine = new FakeEngine();
        try (SpeechRenderer speech = new SpeechRenderer(engine, true)) {
            runStart(speech);
            // Deliberately tight: the next delta must arrive within microseconds of the
            // pump draining the previous one, because that is when the pump is leaving.
            // Any extra work in this loop pushes the enqueue past the window and the
            // race stops being reachable at all.
            for (int attempt = 0; attempt < RACE_ATTEMPTS; attempt++) {
                int before = engine.synthesized.size();
                spinNanos((attempt % 500) * 40L); // sweep 0..20us across the exit window
                delta(speech, "Sentence number " + attempt + " here. The next one begins");
                assertKeepsDraining(engine.synthesized, before, "synthesis", attempt);
            }
            runEnd(speech, "end_turn"); // one last enqueue, straight into the same window

            // Playback carries the same bookkeeping, so it has the same hazard: a clip
            // stranded by a departing playback pump freezes this below synthesis forever.
            assertCatchesUp(engine.played, engine.synthesized, "playback");

            // And the symptom the gate actually suffers.
            assertIdleReturns(speech);
        }
    }

    /**
     * A live pump drains the fake engine in microseconds, so a queue that has not moved
     * within the deadline means the pump is gone while work is still pending — the exact
     * state in which {@code idle()} can never return.
     */
    private static void assertKeepsDraining(List<String> progress, int before, String pump, int attempt) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(500);
        while (System.nanoTime() < deadline) {
            if (progress.size() > before) {
                return;
            }
            Thread.yield();
        }
        throw new AssertionError("attempt " + attempt + ": the " + pump + " queue stopped at "
                + before + " with a sentence still pending — the pump left without handing the"
                + " work on, so idle() would now wait forever on a worker that is gone");
    }

    /** Waits for a trailing queue to reach the one ahead of it — used once the producer has stopped. */
    private static void assertCatchesUp(List<String> trailing, List<String> leading, String pump) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (trailing.size() >= leading.size()) {
                return;
            }
            Thread.yield();
        }
        throw new AssertionError("the " + pump + " queue stalled at " + trailing.size() + " of "
                + leading.size() + " sentences with nothing left to drive it — a departing pump"
                + " left work behind");
    }

    /**
     * {@code idle()} must not outlive its pumps. Waited on a separate daemon thread so a
     * regression fails here in seconds instead of hanging the whole gate, which is exactly
     * what a stranded queue did on 2026-08-13.
     */
    private static void assertIdleReturns(SpeechRenderer speech) throws InterruptedException {
        Thread waiter = new Thread(speech::idle, "idle-waiter");
        waiter.setDaemon(true);
        waiter.start();
        waiter.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(waiter.isAlive(),
                "idle() never returned: it is still waiting on a pump that has already died");
    }

    /** Busy-waits a few microseconds; Thread.sleep is orders of magnitude too coarse for this window. */
    private static void spinNanos(long nanos) {
        long end = System.nanoTime() + nanos;
        while (System.nanoTime() < end) {
            Thread.onSpinWait();
        }
    }

    /** Spins until the condition holds or a short timeout expires — for the pre-run_end assertion. */
    private static void waitUntil(java.util.function.BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(10);
        }
        throw new AssertionError("condition did not become true within the timeout");
    }

}
