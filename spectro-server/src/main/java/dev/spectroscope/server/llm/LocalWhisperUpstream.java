package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Comparator;
import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Live text on the local route (card 527): whisper-cli over the open window,
 * every chunk step.
 *
 * <p>whisper-cli is a one shot process, so there is no stream to read. This
 * upstream holds the audio of the open window in memory and, every
 * {@link Settings#chunkMs()}, writes all of it to a wav and runs whisper over
 * it. The answer is the window's text so far and goes up as a replacing
 * partial. A window closes when a run's text ends a sentence and the window
 * ends in a pause, or when it reaches {@link Settings#windowMs()}; its text then
 * goes up as a window final and the next window starts empty. On commit the
 * window runs once more and its text is the final.</p>
 *
 * <p>It speaks the socket the handler already speaks: it reads the hosted
 * frames ({@code session.update}, {@code input_audio_buffer.append},
 * {@code input_audio_buffer.commit}) and answers with
 * {@code session.updated} and the three {@code spectro.local.*} frames of
 * {@link LiveSttProtocol}.</p>
 *
 * <p>Three rules from the card's non-functional criteria. A run never happens
 * on the thread that delivers the audio: appends keep arriving while whisper
 * runs. A step that comes while a run is in flight is skipped and counted, never
 * queued, so a slow machine shows words later and does not fall behind without
 * bound. The temp folder of a window is deleted when the window closes and when
 * the session closes.</p>
 */
public final class LocalWhisperUpstream implements LiveSttUpstream {

    /**
     * One transcription of one wav, the seam that keeps whisper out of tests.
     */
    @FunctionalInterface
    public interface WindowRunner {
        /**
         * Transcribe a 16 kHz mono wav.
         *
         * @param wav the window's audio
         * @param language the {@code sttLanguage} setting
         * @return the text, empty for silence
         * @throws IOException when whisper failed
         * @throws InterruptedException when the run was interrupted
         */
        Optional<String> transcribe(Path wav, String language) throws IOException, InterruptedException;

        /**
         * Card 528: whether the next warm up loads the model, so the browser
         * shows the loading card. whisper-cli loads it in every process, so
         * the default is yes.
         *
         * @return true when the warm up loads the model
         */
        default boolean loadsModel() {
            return true;
        }

        /**
         * Card 527 criterion 8, card 528 criterion 2: get the model ready
         * before ready is said. The default runs whisper once over the silent
         * clip, which is what loads the model for whisper-cli.
         *
         * @param silentWav one second of silence
         * @param language the {@code sttLanguage} setting
         * @throws IOException when whisper failed
         * @throws InterruptedException when the warm up was interrupted
         */
        default void warmUp(Path silentWav, String language) throws IOException, InterruptedException {
            transcribe(silentWav, language);
        }

        /**
         * The program that runs whisper, named on the handshake and the record.
         *
         * @return {@code whisper-cli} unless the runner says otherwise
         */
        default String engine() {
            return "whisper-cli";
        }
    }

    /**
     * What one session runs with, read when it opens.
     *
     * @param language the dictation language
     * @param chunkMs the step between two runs
     * @param windowMs the longest window
     * @param pauseMs how much quiet at the end counts as a pause
     * @param silenceRms the loudness under which audio counts as quiet, as a
     *                   share of full scale
     */
    public record Settings(String language, long chunkMs, long windowMs, long pauseMs, double silenceRms) {}

    private static final ObjectMapper JSON = new ObjectMapper();
    /** 16 kHz, 16 bit, mono. */
    private static final int BYTES_PER_MS = LiveSttProtocol.LOCAL_RATE * 2 / 1000;
    /** A run's text ends a sentence: a stop, a question or an exclamation mark,
     *  maybe followed by a closing quote or bracket. */
    private static final Pattern SENTENCE_END = Pattern.compile("[.!?…][\"')\\]”]*$");

    /** The runs of every session. Daemon threads, so a server stops without
     *  waiting for a whisper process nobody is listening to. */
    private static final ExecutorService RUNS = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "stt-local-run");
        t.setDaemon(true);
        return t;
    });

    /** The steps of every session: one thread, and it only submits runs. */
    private static final ScheduledExecutorService TICKS = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "stt-local-step");
        t.setDaemon(true);
        return t;
    });

    private final Supplier<Settings> settings;
    /** Read when a session opens (card 528): the runner follows {@code sttRunner}. */
    private final Supplier<WindowRunner> runners;
    private final Executor runs;
    private final ScheduledExecutorService ticks;
    private final Path tempParent;

    /**
     * Production: shared daemon pools, the system temp folder.
     *
     * @param settings read when a session opens
     * @param runner one whisper run
     */
    public LocalWhisperUpstream(Supplier<Settings> settings, WindowRunner runner) {
        this(settings, runner, RUNS, TICKS, null);
    }

    /**
     * Seam for tests.
     *
     * @param settings read when a session opens
     * @param runner one whisper run
     * @param runs where runs execute
     * @param ticks the step clock; null means the test ticks by hand
     * @param tempParent where window folders go; null means the system temp folder
     */
    LocalWhisperUpstream(Supplier<Settings> settings, WindowRunner runner, Executor runs,
            ScheduledExecutorService ticks, Path tempParent) {
        this(settings, runs, ticks, tempParent, () -> runner);
    }

    private LocalWhisperUpstream(Supplier<Settings> settings, Executor runs, ScheduledExecutorService ticks,
            Path tempParent, Supplier<WindowRunner> runners) {
        this.settings = settings;
        this.runners = runners;
        this.runs = runs;
        this.ticks = ticks;
        this.tempParent = tempParent;
    }

    /**
     * Production (card 528): the runner is read when a session opens, so a
     * saved {@code sttRunner} reaches the next press.
     *
     * @param settings read when a session opens
     * @param runners the runner for the session that opens
     * @return the upstream on the shared daemon pools and the system temp folder
     */
    public static LocalWhisperUpstream perSession(Supplier<Settings> settings, Supplier<WindowRunner> runners) {
        return new LocalWhisperUpstream(settings, RUNS, TICKS, null, runners);
    }

    /**
     * Seam for tests: {@link #perSession(Supplier, Supplier)} with its pools.
     *
     * @param settings read when a session opens
     * @param runners the runner for the session that opens
     * @param runs where runs execute
     * @param ticks the step clock; null means the test ticks by hand
     * @param tempParent where window folders go
     * @return the upstream
     */
    static LocalWhisperUpstream perSession(Supplier<Settings> settings, Supplier<WindowRunner> runners,
            Executor runs, ScheduledExecutorService ticks, Path tempParent) {
        return new LocalWhisperUpstream(settings, runs, ticks, tempParent, runners);
    }

    @Override
    public Link open(Listener listener) {
        Session session = new Session(listener, settings.get(), runners.get());
        if (ticks != null) {
            long step = Math.max(1, session.set.chunkMs());
            session.future = ticks.scheduleAtFixedRate(session::tick, step, step, TimeUnit.MILLISECONDS);
        }
        return session;
    }

    /** One open recording. */
    final class Session implements Link {
        private final Listener listener;
        final Settings set;
        /** What runs whisper for this session, fixed when it opened. */
        private final WindowRunner runner;
        /** The audio of the open window, PCM16 little endian. */
        private final ByteArrayOutputStream window = new ByteArrayOutputStream();
        /** Frames leave in the order the runs finished. */
        private final Object emitting = new Object();
        /** How much of the window the last run covered; a step with nothing new is not worth a run. */
        private int covered;
        private Path windowDir;
        private int chunk;
        private int skipped;
        private boolean running;
        /** The warm up run is inside whisper; a close leaves its folder to it. */
        private boolean warming;
        private boolean finalPending;
        private boolean committed;
        private boolean closed;
        private ScheduledFuture<?> future;

        Session(Listener listener, Settings set, WindowRunner runner) {
            this.listener = listener;
            this.set = set;
            this.runner = runner;
        }

        @Override
        public void send(String frame) {
            JsonNode read;
            try {
                read = JSON.readTree(frame);
            } catch (IOException unreadable) {
                return;
            }
            switch (read.path("type").asText("")) {
                case "session.update" -> warmUp();
                case "input_audio_buffer.append" -> append(read.path("audio").asText(""));
                case "input_audio_buffer.commit" -> commit();
                default -> {
                    // Nothing else is part of this conversation.
                }
            }
        }

        /**
         * Card 527 criterion 8: before it says ready, the session runs whisper
         * once over one second of silence on the run pool. That run brings the
         * model file into memory, so the first chunk of the recording is not
         * also the model's first load, and nobody speaks into a window that
         * cannot be heard yet. Its wall time rides on the ready frame.
         *
         * <p>Card 528: the runner decides what the warm up is. whisper-cli
         * loads the model in that run; a resident whisper-server starts on the
         * first press and is only probed on later ones. When the warm up loads
         * the model, a loading frame goes up first, so the browser shows the
         * loading card only then.</p>
         */
        private void warmUp() {
            runs.execute(() -> {
                synchronized (emitting) {
                    String frame = warmUpOutcome();
                    if (frame != null) {
                        listener.onFrame(frame);
                    }
                }
            });
        }

        private String warmUpOutcome() {
            Path dir;
            synchronized (this) {
                if (closed) {
                    return null;
                }
                dir = windowDir();
                warming = true;
            }
            Path runDir = dir.resolve("warm-up");
            long started = System.nanoTime();
            boolean loads = runner.loadsModel();
            if (loads) {
                listener.onFrame(LiveSttProtocol.localLoading(runner.engine()));
            }
            String failure = null;
            try {
                Files.createDirectories(runDir);
                Path wav = runDir.resolve("silence.wav");
                Files.write(wav, wav(new byte[LiveSttProtocol.LOCAL_RATE * 2]));
                runner.warmUp(wav, set.language());
            } catch (IOException failed) {
                failure = failed.getMessage() == null ? runner.engine() + " failed" : failed.getMessage();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                failure = "the speech model did not load";
            } finally {
                deleteRecursively(runDir);
            }
            long took = (System.nanoTime() - started) / 1_000_000;
            synchronized (this) {
                warming = false;
                // A close during the warm up left the folder to this point (see
                // close()). Without audio yet the folder is not needed either.
                if (closed || window.size() == 0) {
                    deleteWindowDir();
                }
                if (closed) {
                    return null;
                }
            }
            if (failure != null) {
                return error(failure);
            }
            ObjectNode ready = JSON.createObjectNode();
            ready.put("type", "session.updated");
            ready.put("warmupMs", took);
            ready.put("loaded", loads);
            return ready.toString();
        }

        private synchronized void append(String base64) {
            if (closed || committed || base64.isEmpty()) {
                return;
            }
            byte[] pcm;
            try {
                pcm = Base64.getDecoder().decode(base64);
            } catch (IllegalArgumentException notBase64) {
                return;
            }
            window.write(pcm, 0, pcm.length);
        }

        private synchronized void commit() {
            if (closed || committed) {
                return;
            }
            committed = true;
            cancelSteps();
            if (running) {
                finalPending = true;
            } else {
                start(true);
            }
        }

        /** One step: a run over the whole window, unless one is still in flight. */
        synchronized void tick() {
            if (closed || committed) {
                return;
            }
            int size = window.size();
            if (size == 0 || size == covered) {
                return;
            }
            if (quiet(window.toByteArray(), 0)) {
                // Nothing said yet in this window. whisper answers silence with a
                // word of its own ("you"), so silence never goes to whisper.
                return;
            }
            if (running) {
                skipped++;
                return;
            }
            start(false);
        }

        private void start(boolean last) {
            running = true;
            byte[] pcm = window.toByteArray();
            covered = pcm.length;
            int number = ++chunk;
            runs.execute(() -> run(pcm, number, last));
        }

        private void run(byte[] pcm, int number, boolean last) {
            synchronized (emitting) {
                String frame = outcome(pcm, number, last);
                if (frame != null) {
                    listener.onFrame(frame);
                }
            }
        }

        /** The run itself, then what it means; null when nobody is listening. */
        private String outcome(byte[] pcm, int number, boolean last) {
            Path dir;
            synchronized (this) {
                if (closed) {
                    running = false;
                    deleteWindowDir();
                    return null;
                }
                // A quiet window has nothing to transcribe; see tick().
                dir = pcm.length == 0 || quiet(pcm, 0) ? null : windowDir();
            }
            String text = "";
            long took = 0;
            String failure = null;
            if (dir != null) {
                Path runDir = dir.resolve("run-" + number);
                long started = System.nanoTime();
                try {
                    Files.createDirectories(runDir);
                    Path wav = runDir.resolve("recording.wav");
                    Files.write(wav, wav(pcm));
                    text = runner.transcribe(wav, set.language()).orElse("");
                } catch (IOException failed) {
                    failure = failed.getMessage() == null ? runner.engine() + " failed" : failed.getMessage();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    failure = "transcription interrupted";
                } finally {
                    took = (System.nanoTime() - started) / 1_000_000;
                    deleteRecursively(runDir);
                }
            }
            synchronized (this) {
                running = false;
                if (closed) {
                    deleteWindowDir();
                    return null;
                }
                long audioMs = pcm.length / BYTES_PER_MS;
                if (failure != null) {
                    return error(failure);
                }
                String frame;
                if (last) {
                    deleteWindowDir();
                    frame = LiveSttProtocol.localResult(LiveSttProtocol.LOCAL_FINAL, text, number, took,
                            audioMs, skipped);
                } else if (closes(pcm, text)) {
                    byte[] all = window.toByteArray();
                    window.reset();
                    window.write(all, pcm.length, all.length - pcm.length);
                    covered = 0;
                    deleteWindowDir();
                    frame = LiveSttProtocol.localResult(LiveSttProtocol.LOCAL_WINDOW, text, number, took,
                            audioMs, skipped);
                } else {
                    frame = LiveSttProtocol.localResult(LiveSttProtocol.LOCAL_PARTIAL, text, number, took,
                            audioMs, skipped);
                }
                if (finalPending && !last) {
                    finalPending = false;
                    start(true);
                }
                return frame;
            }
        }

        /** Whether this run ends its window. */
        private boolean closes(byte[] pcm, String text) {
            if (pcm.length >= set.windowMs() * BYTES_PER_MS) {
                return true;
            }
            return SENTENCE_END.matcher(text.strip()).find() && quietAtEnd(pcm);
        }

        /** Whether the last {@code pauseMs} of the window are quiet. */
        private boolean quietAtEnd(byte[] pcm) {
            int tail = (int) (set.pauseMs() * BYTES_PER_MS);
            if (tail <= 0 || pcm.length < tail) {
                return false;
            }
            return quiet(pcm, pcm.length - tail);
        }

        /**
         * Whether the samples from {@code from} to the end are quiet: no 100 ms
         * block in them is louder than the silence level. Block by block, so a
         * short word in a long quiet stretch still counts as speech.
         */
        private boolean quiet(byte[] pcm, int from) {
            int length = (pcm.length - from) & ~1;
            ByteBuffer samples = ByteBuffer.wrap(pcm, from, length).order(ByteOrder.LITTLE_ENDIAN);
            int block = LiveSttProtocol.LOCAL_RATE / 10;
            int n = length / 2;
            for (int start = 0; start < n; start += block) {
                int count = Math.min(block, n - start);
                double sum = 0;
                for (int i = 0; i < count; i++) {
                    double s = samples.getShort() / 32768.0;
                    sum += s * s;
                }
                if (Math.sqrt(sum / count) >= set.silenceRms()) {
                    return false;
                }
            }
            return true;
        }

        private Path windowDir() {
            if (windowDir == null) {
                try {
                    windowDir = tempParent == null
                            ? Files.createTempDirectory("spectroscope-live-")
                            : Files.createTempDirectory(tempParent, "spectroscope-live-");
                } catch (IOException noTemp) {
                    throw new IllegalStateException("no temp folder for the live window", noTemp);
                }
            }
            return windowDir;
        }

        private void deleteWindowDir() {
            if (windowDir != null) {
                deleteRecursively(windowDir);
                windowDir = null;
            }
        }

        private void cancelSteps() {
            if (future != null) {
                future.cancel(false);
            }
        }

        @Override
        public synchronized void close() {
            if (closed) {
                return;
            }
            closed = true;
            cancelSteps();
            window.reset();
            // A run or the warm up inside whisper deletes the folder when it
            // ends; deleting it now would pull the wav from under whisper.
            if (!running && !warming) {
                deleteWindowDir();
            }
        }
    }

    /** An error frame in the shape the protocol reads as one. */
    private static String error(String message) {
        ObjectNode frame = JSON.createObjectNode();
        frame.put("type", "error");
        frame.putObject("error").put("message", message);
        return frame.toString();
    }

    /**
     * A 16 kHz mono PCM16 wav around the given samples.
     *
     * @param pcm the samples, little endian
     * @return the file's bytes
     */
    static byte[] wav(byte[] pcm) {
        ByteBuffer out = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        out.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        out.putInt(36 + pcm.length);
        out.put("WAVE".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        out.put("fmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        out.putInt(16);
        out.putShort((short) 1);
        out.putShort((short) 1);
        out.putInt(LiveSttProtocol.LOCAL_RATE);
        out.putInt(LiveSttProtocol.LOCAL_RATE * 2);
        out.putShort((short) 2);
        out.putShort((short) 16);
        out.put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII));
        out.putInt(pcm.length);
        out.put(pcm);
        return out.array();
    }

    private static void deleteRecursively(Path dir) {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        try (Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best effort
                }
            });
        } catch (IOException ignored) {
            // best effort
        }
    }
}
