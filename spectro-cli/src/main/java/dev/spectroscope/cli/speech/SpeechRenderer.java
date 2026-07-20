package dev.spectroscope.cli.speech;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.RunEnd;
import dev.spectroscope.core.events.RunEvent.RunStart;
import dev.spectroscope.core.events.RunEvent.TextDelta;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Voice output as an EVENT CONSUMER: hangs off the same {@code RunEvent} stream as
 * the CLI renderer, exactly like the JSONL store and the graph view. The core knows
 * nothing about it — {@code spectro-core} stays unchanged, zero lines (the acceptance
 * criterion of this stage). It buffers {@code text_delta}s up to a sentence boundary,
 * synthesizes finished sentences and plays them back through a bounded queue while the
 * rest of the answer is still streaming; {@code run_end}/abort clears the queue and
 * stops playback.
 *
 * <p>Synthesis and playback are decoupled: piper produces a sentence faster than a
 * human can hear it, so synthesis may run a few sentences ahead of playback
 * ({@link #MAX_PREPARED}), and playback stays strictly in order. Both run on virtual
 * threads with blocking child processes — but the process boundary lives entirely
 * behind {@link SpeechEngine}, so this class (the real logic: segmentation, the queue,
 * abort clearing it) is tested with a fake engine and NO binary.</p>
 */
public final class SpeechRenderer implements AutoCloseable {

    /** Synthesis may run at most this many sentences ahead of playback. */
    private static final int MAX_PREPARED = 3;
    private static final String FENCE = "```";
    // Sentence boundary: punctuation, whitespace, capital letter — a deliberately simple heuristic.
    private static final Pattern SENTENCE_BOUNDARY = Pattern.compile("(?<=[.!?])\\s+(?=[A-Z])");
    // Abbreviations whose period is NOT a sentence end — masked before the split.
    private static final List<String> ABBREVIATIONS = List.of("e.g.", "i.e.", "Dr.", "Mr.", "Mrs.", "etc.");
    private static final char MASK = 0x01; // control character, never appears in model text

    private final SpeechEngine engine;
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    // State guarded by `lock`: buffer, code-block flag, the two queues and the running playback.
    private final Object lock = new Object();
    private boolean enabled;
    private final StringBuilder buffer = new StringBuilder();
    private boolean inCodeBlock = false;
    private final Deque<String> sentences = new ArrayDeque<>();         // waiting for synthesis
    private final Deque<SpeechEngine.Clip> clipQueue = new ArrayDeque<>(); // synthesized, waiting for playback
    private boolean synthRunning = false;
    private boolean playRunning = false;
    private SpeechEngine.Playback playback = null; // handle of the running playback (for stop())
    private boolean stopped = false;
    private Boolean available = null; // engine availability, checked once

    /**
     * Production: piper + the OS audio player. voice = config {@code tts.voice}; enabled = --speak or config.
     *
     * @param voice   the piper voice model name, resolved under ~/.spectro/models
     * @param enabled whether speaking starts on — the --speak flag or {@code tts.enabled}
     */
    public SpeechRenderer(String voice, boolean enabled) {
        this(new PiperSpeechEngine(voice), enabled);
    }

    /**
     * Seam for tests: inject a fake engine that records the spoken sentences.
     *
     * @param engine  the synthesis/playback boundary — a fake keeps tests binary-free
     * @param enabled whether the renderer starts consuming events at all
     */
    public SpeechRenderer(SpeechEngine engine, boolean enabled) {
        this.engine = engine;
        this.enabled = enabled;
    }

    /**
     * /speak on|off — off also stops the running playback immediately.
     *
     * @param on the new state; switching on clears a previous abort so speech resumes
     */
    public void setEnabled(boolean on) {
        synchronized (lock) {
            this.enabled = on;
            if (on) {
                this.stopped = false;
            }
        }
        if (!on) {
            stop();
        }
    }

    /**
     * The only touch point with the harness: public RunEvents.
     *
     * @param event the next stream event — only run_start, text_delta and run_end
     *              matter to this consumer; everything else is ignored
     */
    public void onEvent(RunEvent event) {
        synchronized (lock) {
            if (!enabled || !ensureAvailable()) {
                return;
            }
        }
        switch (event) {
            case RunStart start -> {
                synchronized (lock) {
                    stopped = false;
                    buffer.setLength(0);
                    inCodeBlock = false;
                }
            }
            case TextDelta delta -> {
                synchronized (lock) {
                    buffer.append(delta.text());
                    drain(); // the first sentence starts as soon as it is COMPLETE — not at run_end
                }
            }
            case RunEnd end -> {
                // Abort (Ctrl+C): no ghost sentences; otherwise speak the remaining buffer.
                if ("aborted".equals(end.stopReason())) {
                    stop();
                } else {
                    synchronized (lock) {
                        flushRest();
                    }
                }
            }
            default -> {
                // Every other event is none of this consumer's business.
            }
        }
    }

    /** Abort: clear buffer and queues, destroy the running playback. */
    public void stop() {
        List<SpeechEngine.Clip> orphaned;
        SpeechEngine.Playback running;
        synchronized (lock) {
            stopped = true;
            buffer.setLength(0);
            inCodeBlock = false;
            sentences.clear();
            orphaned = new ArrayList<>(clipQueue);
            clipQueue.clear();
            running = playback;
            playback = null;
        }
        if (running != null) {
            running.stop();
        }
        for (SpeechEngine.Clip clip : orphaned) {
            clip.discard();
        }
    }

    /**
     * Headless (spectroscope run): blocks until synthesis AND playback are finished. The caller
     * waits on this before exiting, so the JVM does not cut the playback off.
     */
    public void idle() {
        while (true) {
            synchronized (lock) {
                boolean pending = !sentences.isEmpty() || !clipQueue.isEmpty() || synthRunning || playRunning;
                if (stopped || !pending) {
                    return;
                }
            }
            sleep(20);
        }
    }

    /** Final teardown: stop everything, then release the synth/playback virtual threads. */
    @Override
    public void close() {
        stop();
        workers.shutdownNow();
    }

    // --- internals -----------------------------------------------------------------------------

    /**
     * Availability of the engine, checked once. Caller holds {@code lock}.
     *
     * @return true when speaking can proceed; false disables the renderer for good
     *         (with a one-time setup hint on stderr)
     */
    private boolean ensureAvailable() {
        if (available == null) {
            available = engine.isAvailable();
            if (!available) {
                System.err.println("\nVoice output disabled: piper, voice or audio player missing"
                        + " — run bash scripts/setup-tts.sh.");
            }
        }
        if (!available) {
            enabled = false;
        }
        return available;
    }

    /** Consume code fences ({@code ```}) from the buffer, then cut off finished sentences. Caller holds {@code lock}. */
    private void drain() {
        int idx;
        while ((idx = buffer.indexOf(FENCE)) != -1) {
            if (!inCodeBlock) {
                String before = buffer.substring(0, idx);
                buffer.delete(0, idx + FENCE.length());
                flushText(before);                    // speak the text before the fence in full
                enqueue("Code block skipped.");        // an announcement instead of character noise
                inCodeBlock = true;
            } else {
                buffer.delete(0, idx + FENCE.length());
                inCodeBlock = false;
            }
        }
        if (inCodeBlock) {
            // Speak nothing; keep 2 characters in case ``` arrives split across two deltas.
            if (buffer.length() > 2) {
                buffer.delete(0, buffer.length() - 2);
            }
            return;
        }
        String[] parts = SENTENCE_BOUNDARY.split(protectAbbr(buffer.toString()), -1);
        if (parts.length <= 1) {
            return; // no complete sentence yet
        }
        String tail = restoreAbbr(parts[parts.length - 1]); // the last part stays in the buffer
        for (int i = 0; i < parts.length - 1; i++) {
            enqueue(restoreAbbr(parts[i]));
        }
        buffer.setLength(0);
        buffer.append(tail);
    }

    /** Speak the remaining buffer at a normal run end (the last sentence has no following capital). Caller holds {@code lock}. */
    private void flushRest() {
        drain();
        if (!inCodeBlock) {
            flushText(buffer.toString());
        }
        buffer.setLength(0);
    }

    /**
     * Splits {@code text} into sentences and enqueues every part — the flush paths
     * (fence boundary, run end) use it where nothing may stay behind. Caller holds {@code lock}.
     *
     * @param text the remaining text to speak in full, abbreviations still unprotected
     */
    private void flushText(String text) {
        for (String part : SENTENCE_BOUNDARY.split(protectAbbr(text), -1)) {
            enqueue(restoreAbbr(part));
        }
    }

    /**
     * Queues one sentence for synthesis — markdown stripped first, empty fragments
     * dropped, and the synthesis worker started lazily on the first entry.
     * Caller holds {@code lock}.
     *
     * @param raw the sentence as cut from the stream, formatting characters still in
     */
    private void enqueue(String raw) {
        if (stopped) {
            return;
        }
        String sentence = stripMarkdown(raw);
        if (sentence.length() < 2) {
            return; // do not synthesize empty fragments
        }
        sentences.addLast(sentence);
        if (!synthRunning) {
            synthRunning = true;
            workers.submit(this::pumpSynthesis);
        }
    }

    /** Synthesis loop: sequential, runs at most MAX_PREPARED sentences ahead of playback. */
    private void pumpSynthesis() {
        try {
            while (true) {
                String sentence;
                synchronized (lock) {
                    if (stopped || sentences.isEmpty()) {
                        return;
                    }
                    if (clipQueue.size() >= MAX_PREPARED) {
                        sentence = null; // MAX_PREPARED reached: let playback catch up, wait below
                    } else {
                        sentence = sentences.pollFirst();
                    }
                }
                if (sentence == null) {
                    sleep(20); // wait outside the lock, then re-check
                    continue;
                }
                SpeechEngine.Clip clip;
                try {
                    clip = engine.synthesize(sentence); // synthesize OUTSIDE the lock — a blocking child process
                } catch (Exception synthFailure) {
                    continue; // synthesis error: skip the sentence — the text is in the terminal
                }
                synchronized (lock) {
                    if (stopped) {
                        clip.discard();
                        return;
                    }
                    clipQueue.addLast(clip);
                    if (!playRunning) {
                        playRunning = true;
                        workers.submit(this::pumpPlayback);
                    }
                }
            }
        } finally {
            synchronized (lock) {
                synthRunning = false;
            }
        }
    }

    /** Playback loop: strictly in order, one playback per sentence. */
    private void pumpPlayback() {
        try {
            while (true) {
                SpeechEngine.Clip clip;
                synchronized (lock) {
                    if (stopped || clipQueue.isEmpty()) {
                        return;
                    }
                    clip = clipQueue.pollFirst();
                }
                play(clip); // blocking playback, OUTSIDE the lock
                clip.discard();
            }
        } finally {
            synchronized (lock) {
                playRunning = false;
            }
        }
    }

    /**
     * Play one clip; the playback handle is kept for stop().
     *
     * @param clip the synthesized sentence to play — skipped silently on player failure
     *             (its text is already in the terminal)
     */
    private void play(SpeechEngine.Clip clip) {
        SpeechEngine.Playback started;
        try {
            started = engine.play(clip);
        } catch (Exception playFailure) {
            return; // playback error: skip; the text is in the terminal
        }
        synchronized (lock) {
            if (stopped) {
                // Aborted between poll and start: do not begin a ghost sentence.
                started.stop();
                return;
            }
            this.playback = started;
        }
        started.await();
        synchronized (lock) {
            this.playback = null;
        }
    }

    // --- text hygiene --------------------------------------------------------------------------

    /**
     * Masks the periods of known abbreviations with a control character so the
     * sentence splitter does not cut at "e.g." or "Dr.".
     *
     * @param text the text about to be split at sentence boundaries
     * @return the same text with abbreviation periods masked
     */
    private static String protectAbbr(String text) {
        String result = text;
        for (String abbr : ABBREVIATIONS) {
            result = result.replace(abbr, abbr.replace('.', MASK));
        }
        return result;
    }

    /**
     * Undoes {@link #protectAbbr} after the split, so spoken sentences read naturally.
     *
     * @param text one split part, possibly carrying mask characters
     * @return the part with real periods restored
     */
    private static String restoreAbbr(String text) {
        return text.replace(MASK, '.');
    }

    /**
     * Markdown hygiene: piper normalizes numbers/punctuation itself, but formatting
     * characters would be read aloud ("asterisk asterisk important").
     *
     * @param text the raw sentence, possibly with links, emphasis or table bars
     * @return the speakable text — link labels kept, formatting characters gone
     */
    private static String stripMarkdown(String text) {
        return text
                .replaceAll("\\[([^\\]]*)\\]\\([^)]*\\)", "$1") // links: only the link text
                .replaceAll("[*_`#>|]", " ")                    // asterisks, backticks, hashes, table bars
                .replaceAll("\\s+", " ")
                .trim();
    }

    // --- small helpers -------------------------------------------------------------------------

    /**
     * Interruptible pause for the polling loops — an interrupt re-flags the thread
     * instead of vanishing.
     *
     * @param millis how long to back off between queue checks
     */
    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
