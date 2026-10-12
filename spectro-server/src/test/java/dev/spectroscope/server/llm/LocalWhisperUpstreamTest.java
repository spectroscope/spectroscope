package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SttStreaming;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Card 527 criterion 1 and the non-functional criteria: the local upstream
 * holds the open window, runs whisper over all of it every step, answers a
 * replacing partial, closes a window with a window final, answers the final on
 * commit, never runs on the caller's thread, skips an overlapping run, and
 * leaves no temp folder behind.
 *
 * <p>No whisper anywhere: the runner is a fake that reads the wav it was given
 * and answers from a script, the steps are ticked by hand, and the run
 * executor is a queue the test drains.</p>
 */
class LocalWhisperUpstreamTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Where the window folders of a test go, so none is left in the system temp folder. */
    @TempDir
    Path tempRoot;
    private static final int RATE = 16_000;

    /** What a run was asked to transcribe, and what it answers. */
    private static final class FakeRunner implements LocalWhisperUpstream.WindowRunner {
        final List<Integer> pcmBytes = new CopyOnWriteArrayList<>();
        final List<Path> wavs = new CopyOnWriteArrayList<>();
        final List<String> threads = new CopyOnWriteArrayList<>();
        final Deque<String> answers = new ArrayDeque<>();
        String language;
        boolean fail;

        @Override
        public Optional<String> transcribe(Path wav, String language) throws IOException {
            this.language = language;
            threads.add(Thread.currentThread().getName());
            wavs.add(wav);
            pcmBytes.add((int) Files.size(wav) - 44);
            if (fail) {
                throw new IOException("whisper-cli exited 1");
            }
            String next = answers.isEmpty() ? "" : answers.removeFirst();
            return next.isEmpty() ? Optional.empty() : Optional.of(next);
        }
    }

    /** A run executor the test drains by hand. */
    private static final class Queue implements Executor {
        final Deque<Runnable> waiting = new ArrayDeque<>();

        @Override
        public void execute(Runnable command) {
            waiting.add(command);
        }

        void runNext() {
            waiting.removeFirst().run();
        }
    }

    /** Everything the upstream told the handler. */
    private static final class Heard implements LiveSttUpstream.Listener {
        final List<String> frames = new CopyOnWriteArrayList<>();

        @Override
        public void onFrame(String raw) {
            frames.add(raw);
        }

        @Override
        public void onClosed(String reason) {
            frames.add("{\"type\":\"closed\"}");
        }

        List<JsonNode> parsed() {
            List<JsonNode> out = new ArrayList<>();
            for (String raw : frames) {
                try {
                    out.add(JSON.readTree(raw));
                } catch (IOException broken) {
                    throw new IllegalStateException(raw, broken);
                }
            }
            return out;
        }

        JsonNode last() {
            List<JsonNode> all = parsed();
            return all.get(all.size() - 1);
        }
    }

    private LocalWhisperUpstream.Settings settings(long windowMs) {
        return new LocalWhisperUpstream.Settings("en", 2000, windowMs, 600, 0.02);
    }

    /** PCM16 at 16 kHz: a loud tone, standing in for speech. */
    private static byte[] loud(double seconds) {
        int n = (int) (seconds * RATE);
        ByteBuffer out = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < n; i++) {
            out.putShort((short) (Math.sin(i * 2 * Math.PI * 220 / RATE) * 12_000));
        }
        return out.array();
    }

    /** PCM16 at 16 kHz: nothing at all. */
    private static byte[] quiet(double seconds) {
        return new byte[(int) (seconds * RATE) * 2];
    }

    private static String append(byte[] pcm) {
        return LiveSttProtocol.append(Base64.getEncoder().encodeToString(pcm));
    }

    private static long filesUnder(Path dir) throws IOException {
        try (Stream<Path> all = Files.walk(dir)) {
            return all.filter(p -> !p.equals(dir)).count();
        }
    }

    @Test
    void theHandshakeIsAnsweredAsReadyOnlyAfterAWarmUpRunOfWhisper() throws Exception {
        // Card 527 criterion 8: the model is loaded before the recording starts,
        // so no word is spoken before the first chunk can be heard.
        FakeRunner runner = new FakeRunner();
        Queue runs = new Queue();
        Heard heard = new Heard();
        LiveSttUpstream.Link link = new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot)
                .open(heard);

        link.send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        assertTrue(heard.frames.isEmpty(), "no ready before the warm up ran");
        assertEquals(1, runs.waiting.size(), "the warm up runs on the run pool, not the socket thread");
        runs.runNext();

        assertEquals(List.of(32_000), runner.pcmBytes, "one second of silence brings the model in");
        assertEquals("session.updated", heard.last().path("type").asText());
        assertTrue(heard.last().has("warmupMs"), "the warm up's wall time rides on the ready");
        assertEquals(0, filesUnder(tempRoot), "the warm up clip is deleted");
    }

    /** Card 528: a runner whose model is resident; its warm up is a probe. */
    private static final class ResidentRunner implements LocalWhisperUpstream.WindowRunner {
        boolean loaded;
        long probeMs;
        final List<Integer> probes = new CopyOnWriteArrayList<>();
        final List<Integer> transcribed = new CopyOnWriteArrayList<>();

        @Override
        public Optional<String> transcribe(Path wav, String language) throws IOException {
            transcribed.add((int) Files.size(wav) - 44);
            return Optional.of("hello");
        }

        @Override
        public boolean loadsModel() {
            return !loaded;
        }

        @Override
        public void warmUp(Path silentWav, String language) throws IOException {
            probes.add((int) Files.size(silentWav) - 44);
            if (probeMs > 0) {
                try {
                    Thread.sleep(probeMs);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            loaded = true;
        }

        @Override
        public String engine() {
            return "whisper-server";
        }
    }

    @Test
    void aWarmUpThatLoadsTheModelSaysLoadingBeforeReady() throws Exception {
        // Card 528 criterion 2: the loading card shows while the model loads.
        ResidentRunner runner = new ResidentRunner();
        Queue runs = new Queue();
        Heard heard = new Heard();
        LiveSttUpstream.Link link = LocalWhisperUpstream.perSession(() -> settings(30_000), () -> runner, runs,
                null, tempRoot).open(heard);

        link.send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        runs.runNext();

        List<JsonNode> frames = heard.parsed();
        assertEquals(2, frames.size(), heard.frames.toString());
        assertEquals(LiveSttProtocol.LOCAL_LOADING, frames.get(0).path("type").asText());
        assertEquals("whisper-server", frames.get(0).path("engine").asText());
        assertEquals("session.updated", frames.get(1).path("type").asText());
        assertTrue(frames.get(1).path("loaded").asBoolean(), "the ready says the model was loaded");
        assertEquals(List.of(32_000), runner.probes, "the warm up is the runner's own, over one second of silence");
        assertTrue(runner.transcribed.isEmpty(), "no chunk run for the warm up");
        assertEquals(0, filesUnder(tempRoot), "the warm up clip is deleted");
    }

    @Test
    void aWarmUpAgainstAModelAlreadyLoadedSaysReadyAndNeverLoading() throws Exception {
        // Card 528 criterion 2: a second press never shows the loading card,
        // and warmupMs is the probe's time.
        ResidentRunner runner = new ResidentRunner();
        runner.loaded = true;
        Queue runs = new Queue();
        Heard heard = new Heard();
        LiveSttUpstream.Link link = LocalWhisperUpstream.perSession(() -> settings(30_000), () -> runner, runs,
                null, tempRoot).open(heard);

        link.send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        runs.runNext();

        List<JsonNode> frames = heard.parsed();
        assertEquals(1, frames.size(), heard.frames.toString());
        assertEquals("session.updated", frames.get(0).path("type").asText());
        assertFalse(frames.get(0).path("loaded").asBoolean());
        assertTrue(frames.get(0).has("warmupMs"), "the probe's wall time rides on the ready");
        assertEquals(List.of(32_000), runner.probes, "the probe ran");
    }

    @Test
    void warmupMsIsTheWallTimeOfTheProbe() throws Exception {
        // Fix round 1, finding 5: the value, not only its presence.
        ResidentRunner runner = new ResidentRunner();
        runner.loaded = true;
        runner.probeMs = 250;
        Queue runs = new Queue();
        Heard heard = new Heard();
        LiveSttUpstream.Link link = LocalWhisperUpstream.perSession(() -> settings(30_000), () -> runner, runs,
                null, tempRoot).open(heard);

        link.send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        runs.runNext();

        long warmupMs = heard.parsed().get(0).path("warmupMs").asLong(-1);
        assertTrue(warmupMs >= 250, "at least the probe's 250 ms: " + warmupMs);
        assertTrue(warmupMs < SttStreaming.STT_WARMUP_TIMEOUT_MS, "and below the warm-up bound: " + warmupMs);
    }

    @Test
    void eachSessionTakesTheRunnerTheSupplierNamesWhenItOpens() throws Exception {
        ResidentRunner first = new ResidentRunner();
        ResidentRunner second = new ResidentRunner();
        Deque<LocalWhisperUpstream.WindowRunner> handed = new ArrayDeque<>(List.of(first, second));
        Queue runs = new Queue();
        LocalWhisperUpstream upstream = LocalWhisperUpstream.perSession(() -> settings(30_000),
                handed::removeFirst, runs, null, tempRoot);

        upstream.open(new Heard()).send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        upstream.open(new Heard()).send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        runs.runNext();
        runs.runNext();

        assertEquals(1, first.probes.size());
        assertEquals(1, second.probes.size());
    }

    @Test
    void aFailedWarmUpArrivesAsAnErrorAndNeverAsReady() {
        FakeRunner runner = new FakeRunner();
        runner.fail = true;
        Queue runs = new Queue();
        Heard heard = new Heard();
        LiveSttUpstream.Link link = new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot)
                .open(heard);

        link.send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        runs.runNext();

        assertEquals(LiveSttProtocol.Kind.ERROR, LiveSttProtocol.read(heard.last()).kind());
        assertFalse(heard.frames.stream().anyMatch(f -> f.contains("session.updated")));
    }

    @Test
    void aSessionClosedDuringItsWarmUpNeverAnswersReady() {
        FakeRunner runner = new FakeRunner();
        Queue runs = new Queue();
        Heard heard = new Heard();
        LiveSttUpstream.Link link = new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot)
                .open(heard);

        link.send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        link.close();
        runs.runNext();

        assertTrue(heard.frames.isEmpty());
    }

    @Test
    void aStepRunsWhisperOverTheWholeOpenWindowAndAnswersAReplacingPartial() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        runner.answers.add("hello there");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();
        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();

        assertEquals(List.of(32_000, 64_000), runner.pcmBytes,
                "each run covers the WHOLE window so far, not only the newest step");
        assertEquals("en", runner.language);
        JsonNode last = heard.last();
        assertEquals(LiveSttProtocol.LOCAL_PARTIAL, last.path("type").asText());
        assertEquals("hello there", last.path("text").asText());
        assertEquals(2, last.path("chunk").asInt());
        assertEquals(2000, last.path("audioMs").asLong());
        assertTrue(last.has("durationMs"), "every run carries its own wall time");
    }

    @Test
    void aStepWithNoNewAudioRunsNothing() {
        FakeRunner runner = new FakeRunner();
        Queue runs = new Queue();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(new Heard());

        session.tick();
        assertTrue(runs.waiting.isEmpty(), "an empty window is not worth a whisper run");
        session.send(append(loud(0.5)));
        session.tick();
        runs.runNext();
        session.tick();
        assertTrue(runs.waiting.isEmpty(), "the same audio twice gives the same answer");
    }

    @Test
    void aRunThatWouldOverlapTheNextStepIsSkippedAndCountedNeverQueued() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("one");
        runner.answers.add("two");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.0)));
        session.tick();
        session.send(append(loud(1.0)));
        session.tick();
        session.send(append(loud(1.0)));
        session.tick();

        assertEquals(1, runs.waiting.size(), "a run still in flight is never joined by a second");
        runs.runNext();
        assertEquals(2, heard.last().path("skipped").asInt(), "both overlapping steps are counted");
        session.tick();
        runs.runNext();
        assertEquals(List.of(32_000, 96_000), runner.pcmBytes,
                "the next run after the skip covers everything that arrived meanwhile");
    }

    @Test
    void runsNeverHappenOnTheThreadThatDeliversTheAudio() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        ExecutorService pool = Executors.newSingleThreadExecutor(r -> new Thread(r, "stt-run-test"));
        try {
            CountDownLatch partial = new CountDownLatch(1);
            LiveSttUpstream.Listener listener = new LiveSttUpstream.Listener() {
                @Override
                public void onFrame(String raw) {
                    if (raw.contains(LiveSttProtocol.LOCAL_PARTIAL)) {
                        partial.countDown();
                    }
                }

                @Override
                public void onClosed(String reason) {
                }
            };
            LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                    new LocalWhisperUpstream(() -> settings(30_000), runner, pool, null, tempRoot).open(listener);
            session.send(append(loud(1.0)));
            session.tick();
            assertTrue(partial.await(5, TimeUnit.SECONDS));
            assertEquals(List.of("stt-run-test"), runner.threads);
            assertNotEquals(Thread.currentThread().getName(), runner.threads.get(0));
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void theRealScheduleTicksEveryStepOnItsOwnThread() throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        CountDownLatch partial = new CountDownLatch(1);
        LiveSttUpstream.Listener listener = new LiveSttUpstream.Listener() {
            @Override
            public void onFrame(String raw) {
                if (raw.contains(LiveSttProtocol.LOCAL_PARTIAL)) {
                    partial.countDown();
                }
            }

            @Override
            public void onClosed(String reason) {
            }
        };
        LocalWhisperUpstream upstream = new LocalWhisperUpstream(
                () -> new LocalWhisperUpstream.Settings("en", 50, 30_000, 600, 0.02), runner);
        LiveSttUpstream.Link link = upstream.open(listener);
        try {
            link.send(append(loud(0.5)));
            assertTrue(partial.await(5, TimeUnit.SECONDS), "no step ran within five seconds");
        } finally {
            link.close();
        }
    }

    @Test
    void commitRunsTheWindowOnceMoreAndAnswersTheFinal() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        runner.answers.add("Hello there.");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();
        session.send(append(loud(0.5)));
        session.send(LiveSttProtocol.commit());
        runs.runNext();

        JsonNode last = heard.last();
        assertEquals(LiveSttProtocol.LOCAL_FINAL, last.path("type").asText());
        assertEquals("Hello there.", last.path("text").asText());
        assertEquals(List.of(32_000, 48_000), runner.pcmBytes, "the final covers the tail too");
        session.tick();
        assertTrue(runs.waiting.isEmpty(), "nothing runs after the final");
    }

    @Test
    void aCommitWhileARunIsInFlightWaitsForItAndThenAnswersTheFinal() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        runner.answers.add("Hello there.");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.0)));
        session.tick();
        session.send(append(loud(0.5)));
        session.send(LiveSttProtocol.commit());
        assertEquals(1, runs.waiting.size(), "the final waits for the run in flight");
        runs.runNext();
        assertEquals(1, runs.waiting.size(), "and starts the moment it ends");
        runs.runNext();

        assertEquals(LiveSttProtocol.LOCAL_FINAL, heard.last().path("type").asText());
        assertEquals("Hello there.", heard.last().path("text").asText());
    }

    @Test
    void aCommitOnAnEmptyWindowAnswersAnEmptyFinalWithoutRunningWhisper() {
        FakeRunner runner = new FakeRunner();
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(LiveSttProtocol.commit());
        runs.runNext();

        assertEquals(LiveSttProtocol.LOCAL_FINAL, heard.last().path("type").asText());
        assertEquals("", heard.last().path("text").asText());
        assertTrue(runner.pcmBytes.isEmpty());
    }

    @Test
    void aSentenceEndFollowedByAPauseClosesTheWindowAndTheNextStartsEmpty(@TempDir Path temp)
            throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("Hello there.");
        runner.answers.add("next");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, temp).open(heard);

        session.send(append(loud(1.0)));
        session.send(append(quiet(0.7)));
        session.tick();
        runs.runNext();

        assertEquals(LiveSttProtocol.LOCAL_WINDOW, heard.last().path("type").asText());
        assertEquals("Hello there.", heard.last().path("text").asText());
        assertEquals(0, filesUnder(temp), "the window's temp folder goes with the window");

        session.send(append(loud(0.5)));
        session.tick();
        runs.runNext();
        assertEquals(16_000, runner.pcmBytes.get(1), "the new window holds only the new audio");
        assertEquals(LiveSttProtocol.LOCAL_PARTIAL, heard.last().path("type").asText());
    }

    @Test
    void aSentenceEndWithoutAPauseKeepsTheWindowOpen() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("Hello there.");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.7)));
        session.tick();
        runs.runNext();

        assertEquals(LiveSttProtocol.LOCAL_PARTIAL, heard.last().path("type").asText(),
                "whisper ends every cut with a full stop; only a pause makes it a sentence end");
    }

    @Test
    void aPauseWithoutASentenceEndKeepsTheWindowOpen() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("and then");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.0)));
        session.send(append(quiet(0.7)));
        session.tick();
        runs.runNext();

        assertEquals(LiveSttProtocol.LOCAL_PARTIAL, heard.last().path("type").asText());
    }

    @Test
    void theWindowClosesAtItsCap() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("a long run of words");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(1_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.2)));
        session.tick();
        runs.runNext();

        assertEquals(LiveSttProtocol.LOCAL_WINDOW, heard.last().path("type").asText());
    }

    @Test
    void closingDeletesTheWindowFolderAndSilencesARunStillInFlight(@TempDir Path temp) throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        runner.answers.add("late");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, temp).open(heard);
        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();
        assertTrue(filesUnder(temp) > 0, "premise: the open window has its folder");

        session.send(append(loud(1.0)));
        session.tick();
        session.close();
        int before = heard.frames.size();
        runs.runNext();

        assertEquals(0, filesUnder(temp), "a killed socket leaves no audio on disk");
        assertEquals(before, heard.frames.size(), "nobody is listening any more");
    }

    @Test
    void closingBetweenRunsDeletesTheWindowFolder(@TempDir Path temp) throws Exception {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("hello");
        Queue runs = new Queue();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, temp).open(new Heard());
        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();
        assertTrue(filesUnder(temp) > 0, "premise: the open window has its folder");

        session.close();

        assertEquals(0, filesUnder(temp), "a killed socket leaves no audio on disk");
    }

    /**
     * Runs one call on its own thread, the way the socket thread delivers a
     * frame, and fails when it has not returned within two seconds.
     */
    private static void returnsWhileWhisperRuns(ExecutorService socket, String what, Runnable call)
            throws Exception {
        Future<?> done = socket.submit(call);
        try {
            done.get(2, TimeUnit.SECONDS);
        } catch (TimeoutException blocked) {
            fail(what + " waited for the whisper run in flight");
        }
    }

    @Test
    void appendsStepsAndCloseNeverWaitForAWhisperRunInFlight() throws Exception {
        // Fix round 3: the non-functional criterion that a run never blocks the
        // audio. Every other test here delivers frames between runs; this one
        // holds a run inside whisper and delivers them meanwhile.
        CountDownLatch inWhisper = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        LocalWhisperUpstream.WindowRunner held = (wav, language) -> {
            inWhisper.countDown();
            if (!release.await(10, TimeUnit.SECONDS)) {
                throw new IOException("the test never released the run");
            }
            return Optional.of("hello");
        };
        ExecutorService pool = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "stt-run-test");
            t.setDaemon(true);
            return t;
        });
        ExecutorService socket = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "socket-test");
            t.setDaemon(true);
            return t;
        });
        Heard heard = new Heard();
        try {
            LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                    new LocalWhisperUpstream(() -> settings(30_000), held, pool, null, tempRoot).open(heard);
            session.send(append(loud(1.0)));
            session.tick();
            assertTrue(inWhisper.await(5, TimeUnit.SECONDS), "premise: a run is inside whisper");

            returnsWhileWhisperRuns(socket, "an append", () -> session.send(append(loud(1.0))));
            returnsWhileWhisperRuns(socket, "a step", session::tick);
            returnsWhileWhisperRuns(socket, "a close", session::close);
        } finally {
            release.countDown();
            pool.shutdown();
            socket.shutdown();
        }
        assertTrue(pool.awaitTermination(5, TimeUnit.SECONDS), "the held run ended once released");
        assertTrue(heard.frames.isEmpty(), "the session was closed before the run ended");
        assertEquals(0, filesUnder(tempRoot), "a socket closed during the run leaves no folder");
    }

    @Test
    void aSocketClosedWhileWhisperRunsLeavesNoFolderAndNoFrame() throws Exception {
        // Fix round 3: the close lands while whisper is executing, after the run
        // has checked for a close and before it reads its answer.
        AtomicReference<LiveSttUpstream.Link> link = new AtomicReference<>();
        AtomicLong filesDuringRun = new AtomicLong(-1);
        AtomicReference<Boolean> wavAfterClose = new AtomicReference<>();
        LocalWhisperUpstream.WindowRunner closing = (wav, language) -> {
            filesDuringRun.set(filesUnder(tempRoot));
            link.get().close();
            wavAfterClose.set(Files.exists(wav));
            return Optional.of("hello");
        };
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), closing, runs, null, tempRoot).open(heard);
        link.set(session);

        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();

        assertTrue(filesDuringRun.get() > 0, "premise: the window folder existed while whisper ran");
        assertEquals(Boolean.TRUE, wavAfterClose.get(), "the close never deletes the wav whisper is reading");
        assertEquals(0, filesUnder(tempRoot), "a socket killed during the run leaves no audio on disk");
        assertTrue(heard.frames.isEmpty(), "nobody is listening any more");
    }

    @Test
    void aSocketClosedDuringTheWarmUpRunLeavesNoFolderAndNoReady() throws Exception {
        // The warm up used to let the close delete its folder at once, under a
        // running whisper; a close between the folder's creation and the clip's
        // write then left an empty folder behind. The folder now goes when the
        // warm up ends, as it does after a run.
        AtomicReference<LiveSttUpstream.Link> link = new AtomicReference<>();
        AtomicLong filesDuringRun = new AtomicLong(-1);
        AtomicReference<Boolean> wavAfterClose = new AtomicReference<>();
        LocalWhisperUpstream.WindowRunner closing = (wav, language) -> {
            filesDuringRun.set(filesUnder(tempRoot));
            link.get().close();
            wavAfterClose.set(Files.exists(wav));
            return Optional.empty();
        };
        Queue runs = new Queue();
        Heard heard = new Heard();
        link.set(new LocalWhisperUpstream(() -> settings(30_000), closing, runs, null, tempRoot).open(heard));

        link.get().send(LiveSttProtocol.localSessionUpdate("ggml-small.bin", "en", 2000));
        runs.runNext();

        assertTrue(filesDuringRun.get() > 0, "premise: the warm up clip existed while whisper ran");
        assertEquals(Boolean.TRUE, wavAfterClose.get(), "the close never deletes the clip whisper is reading");
        assertEquals(0, filesUnder(tempRoot), "a socket killed during the warm up leaves no folder");
        // Card 528: the loading frame left before the close; nothing after it.
        assertEquals(List.of(LiveSttProtocol.localLoading("whisper-cli")), heard.frames,
                "no ready for a session nobody holds");
    }

    @Test
    void aQuietWindowNeverReachesWhisper() {
        // Found in the live check: after the last sentence closed its window,
        // the new window held 1.5 s of silence, and whisper answered "you", its
        // usual word for nothing at all. It landed at the end of the message.
        FakeRunner runner = new FakeRunner();
        runner.answers.add("you");
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(quiet(1.5)));
        session.tick();
        assertTrue(runs.waiting.isEmpty(), "a step over silence runs nothing");
        session.send(LiveSttProtocol.commit());
        runs.runNext();

        assertTrue(runner.pcmBytes.isEmpty(), "whisper never heard the silence");
        assertEquals(LiveSttProtocol.LOCAL_FINAL, heard.last().path("type").asText());
        assertEquals("", heard.last().path("text").asText());
    }

    @Test
    void aShortWordInALongQuietWindowStillGoesToWhisper() {
        FakeRunner runner = new FakeRunner();
        runner.answers.add("yes");
        Queue runs = new Queue();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(new Heard());

        session.send(append(quiet(5.0)));
        session.send(append(loud(0.2)));
        session.send(append(quiet(5.0)));
        session.tick();

        assertEquals(1, runs.waiting.size(), "0.2 s of speech in 10 s is still speech");
    }

    @Test
    void aFailingRunArrivesAsAnErrorAndNeverAsText() {
        FakeRunner runner = new FakeRunner();
        runner.fail = true;
        Queue runs = new Queue();
        Heard heard = new Heard();
        LocalWhisperUpstream.Session session = (LocalWhisperUpstream.Session)
                new LocalWhisperUpstream(() -> settings(30_000), runner, runs, null, tempRoot).open(heard);

        session.send(append(loud(1.0)));
        session.tick();
        runs.runNext();

        LiveSttProtocol.Incoming read = LiveSttProtocol.read(heard.last());
        assertEquals(LiveSttProtocol.Kind.ERROR, read.kind());
        assertTrue(read.text().contains("whisper-cli exited 1"), read.text());
        assertFalse(heard.frames.stream().anyMatch(f -> f.contains(LiveSttProtocol.LOCAL_PARTIAL)));
    }
}
