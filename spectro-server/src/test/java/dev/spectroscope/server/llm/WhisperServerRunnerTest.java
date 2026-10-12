package dev.spectroscope.server.llm;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 528 criterion 1: a resident whisper-server behind the runner interface
 * of card 527. No whisper-server runs here: the process is a fake child, the
 * HTTP leg is a fake (and once a real loopback endpoint the test serves), and
 * the clock moves only when the test or the runner's own sleep moves it.
 */
class WhisperServerRunnerTest {

    @TempDir
    Path temp;

    private static final Path BINARY = Path.of("/opt/homebrew/bin/whisper-server");
    private static final long START_TIMEOUT_MS = 20_000L;
    private static final long IDLE_MS = 30L * 60L * 1000L;

    /** A child process that is alive until it is stopped or told to die. */
    private static final class FakeChild implements WhisperServerRunner.Child {
        volatile boolean alive = true;
        int stops;

        @Override
        public boolean isAlive() {
            return alive;
        }

        @Override
        public void stop() {
            stops++;
            alive = false;
        }
    }

    /** Records every start; a child can be made to die on start. */
    private static final class FakeLauncher implements WhisperServerRunner.Launcher {
        final List<List<String>> argvs = new ArrayList<>();
        final List<Path> logs = new ArrayList<>();
        final List<FakeChild> children = new ArrayList<>();
        boolean dieOnStart;

        @Override
        public WhisperServerRunner.Child start(List<String> argv, Path log) {
            argvs.add(List.copyOf(argv));
            logs.add(log);
            FakeChild child = new FakeChild();
            if (dieOnStart) {
                child.alive = false;
            }
            children.add(child);
            return child;
        }

        FakeChild last() {
            return children.get(children.size() - 1);
        }
    }

    /** What happens inside a request; it may throw the way the HTTP leg throws. */
    @FunctionalInterface
    private interface Step {
        void run() throws IOException;
    }

    /** The HTTP leg: refuses health a number of times, then answers 200. */
    private static final class FakeHttp implements WhisperServerRunner.Http {
        final FakeLauncher launcher;
        int refuseHealth;
        int healthCalls;
        final List<byte[]> bodies = new ArrayList<>();
        final List<String> languages = new ArrayList<>();
        final List<Integer> ports = new ArrayList<>();
        final List<Long> timeouts = new ArrayList<>();
        String answer = "{\"text\":\" hello there\\n\"}";
        int status = 200;
        Step duringInference = () -> { };

        FakeHttp(FakeLauncher launcher) {
            this.launcher = launcher;
        }

        @Override
        public int health(int port) throws IOException {
            healthCalls++;
            if (launcher.children.isEmpty() || !launcher.last().isAlive()) {
                throw new IOException("Connection refused");
            }
            if (refuseHealth > 0) {
                refuseHealth--;
                throw new IOException("Connection refused");
            }
            return 200;
        }

        @Override
        public WhisperServerRunner.Answer inference(int port, byte[] wav, String language, long timeoutMs)
                throws IOException {
            if (launcher.children.isEmpty() || !launcher.last().isAlive()) {
                throw new IOException("Connection refused");
            }
            timeouts.add(timeoutMs);
            ports.add(port);
            bodies.add(wav);
            languages.add(language);
            duringInference.run();
            return new WhisperServerRunner.Answer(status, answer);
        }
    }

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final AtomicReference<Path> model = new AtomicReference<>(Path.of("/models/ggml-small.bin"));

    private WhisperServerRunner runner(FakeLauncher launcher, FakeHttp http) {
        return new WhisperServerRunner(BINARY, model::get, launcher, http, () -> 51234,
                now::get, ms -> now.addAndGet(ms), temp, START_TIMEOUT_MS, IDLE_MS);
    }

    private Path silence() throws IOException {
        Path wav = temp.resolve("silence.wav");
        Files.write(wav, LocalWhisperUpstream.wav(new byte[32_000]));
        return wav;
    }

    private Path speech() throws IOException {
        Path wav = temp.resolve("chunk.wav");
        Files.write(wav, LocalWhisperUpstream.wav(new byte[6_400]));
        return wav;
    }

    @Test
    void theServerBindsTheLoopbackOnlyOnThePortSpectroPickedWithTheModelAndLanguage() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));

        runner.warmUp(silence(), "de");

        List<String> argv = launcher.argvs.get(0);
        assertEquals(BINARY.toString(), argv.get(0));
        assertEquals("127.0.0.1", argv.get(argv.indexOf("--host") + 1), "the bind address: " + argv);
        assertEquals("51234", argv.get(argv.indexOf("--port") + 1));
        assertEquals("/models/ggml-small.bin", argv.get(argv.indexOf("-m") + 1));
        assertEquals("de", argv.get(argv.indexOf("-l") + 1));
        assertFalse(argv.contains("0.0.0.0") || argv.contains("::"), "never every interface: " + argv);
        assertFalse(argv.contains("--convert"), "no ffmpeg and no temp audio file on the server side");
    }

    @Test
    void readinessWaitsForHealthThenProbesWithTheSilentClip() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        http.refuseHealth = 3;
        WhisperServerRunner runner = runner(launcher, http);
        Path silence = silence();

        assertTrue(runner.loadsModel(), "nothing runs yet, so a warm up loads the model");
        runner.warmUp(silence, "en");

        assertEquals(4, http.healthCalls, "polled until health answered 200");
        assertEquals(1, http.bodies.size(), "one probe after health");
        assertArrayEquals(Files.readAllBytes(silence), http.bodies.get(0), "the probe is the silent clip");
        assertFalse(runner.loadsModel(), "up after the probe");
        assertEquals(1, launcher.argvs.size());
    }

    @Test
    void readinessIsBoundedAndAServerThatNeverAnswersIsStopped() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        http.refuseHealth = Integer.MAX_VALUE;
        WhisperServerRunner runner = runner(launcher, http);
        long started = now.get();

        IOException failed = assertThrows(IOException.class, () -> runner.warmUp(silence(), "en"));

        assertTrue(failed.getMessage().contains("whisper-server did not start"), failed.getMessage());
        assertTrue(now.get() - started >= START_TIMEOUT_MS, "waited the whole bound");
        assertTrue(now.get() - started < START_TIMEOUT_MS + 1_000, "and not much longer");
        assertEquals(1, launcher.last().stops, "the child that never answered is stopped");
        assertTrue(runner.loadsModel());
        assertEquals(0, http.bodies.size(), "no probe without health");
    }

    @Test
    void aChildThatDiesWhileStartingIsReportedWithoutWaitingTheBound() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        launcher.dieOnStart = true;
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));
        long started = now.get();

        IOException failed = assertThrows(IOException.class, () -> runner.warmUp(silence(), "en"));

        assertTrue(failed.getMessage().contains("whisper-server"), failed.getMessage());
        assertTrue(now.get() - started < 1_000, "a dead child is not waited for: " + (now.get() - started));
    }

    @Test
    void eachChunkIsPostedToTheResidentServerAndItsTextParsed() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        Path chunk = speech();

        Optional<String> text = runner.transcribe(chunk, "de");

        assertEquals(Optional.of("hello there"), text);
        assertArrayEquals(Files.readAllBytes(chunk), http.bodies.get(1));
        assertEquals("de", http.languages.get(1), "the language travels per request");
        assertEquals(51234, http.ports.get(1));
        assertEquals(1, launcher.argvs.size(), "the chunk did not start another server");
    }

    @Test
    void markersAndSilenceAnswerNoText() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");

        http.answer = "{\"text\":\" [BLANK_AUDIO]\\n\"}";
        assertEquals(Optional.empty(), runner.transcribe(speech(), "en"));
        http.answer = "{\"text\":\"\"}";
        assertEquals(Optional.empty(), runner.transcribe(speech(), "en"));
        http.answer = "{\"text\":\" one\\n two\\n\"}";
        assertEquals(Optional.of("one two"), runner.transcribe(speech(), "en"));
    }

    @Test
    void anAnswerThatIsNotTwoHundredIsAnError() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        http.status = 400;
        http.answer = "Invalid request";

        IOException failed = assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));
        assertTrue(failed.getMessage().contains("400"), failed.getMessage());
    }

    @Test
    void aSecondPressFindsTheServerUpAndStartsNoOther() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");

        assertFalse(runner.loadsModel(), "the second press loads nothing");
        runner.warmUp(silence(), "en");

        assertEquals(1, launcher.argvs.size(), "one process for both presses");
        assertEquals(2, http.bodies.size(), "the second warm up is the probe alone");
    }

    @Test
    void theServerStopsAfterTheIdleTimeAndNotBefore() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));
        runner.warmUp(silence(), "en");
        runner.transcribe(speech(), "en");

        now.addAndGet(IDLE_MS - 1);
        runner.reapIfIdle();
        assertTrue(launcher.last().isAlive(), "one millisecond before the idle time it still runs");
        assertFalse(runner.loadsModel());

        now.addAndGet(1);
        runner.reapIfIdle();
        assertFalse(launcher.last().isAlive(), "at the idle time it stops");
        assertEquals(1, launcher.last().stops);
        assertTrue(runner.loadsModel(), "the next press loads the model again");
        assertFalse(runner.status().up());
    }

    @Test
    void aRequestInFlightKeepsTheServerUpPastTheIdleTime() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        http.duringInference = () -> {
            now.addAndGet(IDLE_MS + 5);
            runner.reapIfIdle();
        };

        runner.transcribe(speech(), "en");

        assertTrue(launcher.last().isAlive(), "a request in flight is not idle");
        runner.reapIfIdle();
        assertTrue(launcher.last().isAlive(), "the idle time counts from the end of the last request");
    }

    @Test
    void stopEndsTheServerForShutdown() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));
        runner.warmUp(silence(), "en");
        assertTrue(runner.status().up());

        runner.stop();

        assertEquals(1, launcher.last().stops);
        assertFalse(launcher.last().isAlive());
        assertFalse(runner.status().up());
        assertEquals(null, runner.status().port(), "no port once it is down");
    }

    @Test
    void aCrashAnswersTheChunkWithAnErrorAndTheNextPressRestartsIt() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        launcher.last().alive = false;

        IOException failed = assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));
        assertTrue(failed.getMessage().contains("whisper-server"), failed.getMessage());
        assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));
        assertEquals(1, launcher.argvs.size(), "a chunk never restarts the server");

        assertTrue(runner.loadsModel(), "the next press loads the model");
        runner.warmUp(silence(), "en");
        assertEquals(2, launcher.argvs.size(), "the next press restarted it");
        assertEquals(Optional.of("hello there"), runner.transcribe(speech(), "en"));
    }

    @Test
    void aServerThatDiesDuringAChunkFailsItAsStoppedAndTheNextPressStartsANewOne() throws Exception {
        // Fix round 1, finding 1: alive at the check before the request, dead
        // when the request fails.
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        http.duringInference = () -> {
            launcher.last().alive = false;
            throw new IOException("Connection reset");
        };

        IOException failed = assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));

        assertTrue(failed.getMessage().startsWith("whisper-server stopped: Connection reset"), failed.getMessage());
        assertTrue(runner.loadsModel(), "the dead server is forgotten");
        assertFalse(runner.status().up());
        http.duringInference = () -> { };
        runner.warmUp(silence(), "en");
        assertEquals(2, launcher.argvs.size(), "the next press started a new process");
        assertEquals(Optional.of("hello there"), runner.transcribe(speech(), "en"));
    }

    @Test
    void aServerThatDiesDuringTheProbeFailsThePressAndTheNextPressStartsANewOne() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        http.duringInference = () -> {
            launcher.last().alive = false;
            throw new IOException("Connection reset");
        };

        IOException failed = assertThrows(IOException.class, () -> runner.warmUp(silence(), "en"));

        assertTrue(failed.getMessage().startsWith("whisper-server stopped: Connection reset"), failed.getMessage());
        assertEquals(1, launcher.argvs.size(), "the failed press did not restart it");
        http.duringInference = () -> { };
        assertTrue(runner.loadsModel());
        runner.warmUp(silence(), "en");
        assertEquals(2, launcher.argvs.size(), "the next press started a new process");
    }

    @Test
    void aServerThatStopsAnsweringIsStoppedSoTheNextChunkFailsAtOnceAndTheNextPressRestartsIt() throws Exception {
        // Fix round 1, finding 2: alive but no answer (hung, or its port gone).
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        FakeChild hung = launcher.last();
        http.duringInference = () -> {
            throw new IOException("request timed out");
        };

        IOException failed = assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));

        assertTrue(failed.getMessage().contains("did not answer"), failed.getMessage());
        assertEquals(1, hung.stops, "the hung process is stopped");
        assertFalse(hung.isAlive());
        int asked = http.bodies.size();
        assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));
        assertEquals(asked, http.bodies.size(), "the next chunk fails without a request");
        http.duringInference = () -> { };
        assertTrue(runner.loadsModel());
        runner.warmUp(silence(), "en");
        assertEquals(2, launcher.argvs.size(), "the next press started a new process");
        assertEquals(Optional.of("hello there"), runner.transcribe(speech(), "en"));
    }

    @Test
    void aProbeThatFailsOnALiveServerStopsItAndTheNextPressStartsANewOne() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        FakeChild first = launcher.last();
        http.status = 500;

        IOException failed = assertThrows(IOException.class, () -> runner.warmUp(silence(), "en"));

        assertTrue(failed.getMessage().contains("500"), failed.getMessage());
        assertEquals(1, first.stops, "a server that fails its probe is stopped");
        http.status = 200;
        assertTrue(runner.loadsModel(), "the next press loads the model");
        runner.warmUp(silence(), "en");
        assertEquals(2, launcher.argvs.size());
    }

    @Test
    void aBadRequestAnswerToAChunkKeepsTheServer() throws Exception {
        // A 400 says the request was bad, not the server.
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        http.status = 400;
        http.answer = "Invalid request";

        assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));

        assertEquals(0, launcher.last().stops, "the server keeps running");
        http.status = 200;
        http.answer = "{\"text\":\" hello there\\n\"}";
        assertEquals(Optional.of("hello there"), runner.transcribe(speech(), "en"));
        assertEquals(1, launcher.argvs.size());
    }

    @Test
    void anInterruptedRequestNeverStopsTheServer() throws Exception {
        // A session that closes interrupts its request; the server is fine.
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        http.duringInference = () -> {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while whisper-server answered");
        };

        try {
            assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));
        } finally {
            Thread.interrupted();
        }

        assertEquals(0, launcher.last().stops, "the server keeps running");
        assertTrue(launcher.last().isAlive());
        assertFalse(runner.loadsModel());
    }

    @Test
    void aRestartThatFailsIsTriedOncePerPress() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);
        runner.warmUp(silence(), "en");
        launcher.last().alive = false;
        launcher.dieOnStart = true;

        assertThrows(IOException.class, () -> runner.warmUp(silence(), "en"));
        assertEquals(2, launcher.argvs.size(), "one restart in this press, not a loop");
        assertThrows(IOException.class, () -> runner.transcribe(speech(), "en"));
        assertEquals(2, launcher.argvs.size(), "and none from a chunk");

        assertThrows(IOException.class, () -> runner.warmUp(silence(), "en"));
        assertEquals(3, launcher.argvs.size(), "the next press tries once more");
    }

    @Test
    void anotherModelRestartsTheServer() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));
        runner.warmUp(silence(), "en");
        FakeChild first = launcher.last();

        model.set(Path.of("/models/ggml-medium.bin"));
        assertTrue(runner.loadsModel(), "a different model has to load");
        runner.warmUp(silence(), "en");

        assertFalse(first.isAlive(), "the old server stopped");
        assertEquals("/models/ggml-medium.bin",
                launcher.argvs.get(1).get(launcher.argvs.get(1).indexOf("-m") + 1));
    }

    @Test
    void theLogGoesToAFileUnderTheTempFolder() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));
        runner.warmUp(silence(), "en");

        Path log = launcher.logs.get(0);
        assertTrue(log.startsWith(temp), "the log is under the temp folder: " + log);
        assertEquals("whisper-server.log", log.getFileName().toString());
    }

    @Test
    void theStatusNamesThePortAndWhetherTheServerIsUp() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        WhisperServerRunner runner = runner(launcher, new FakeHttp(launcher));
        assertFalse(runner.status().up());
        assertEquals(null, runner.status().port());

        runner.warmUp(silence(), "en");

        assertTrue(runner.status().up());
        assertEquals(51234, runner.status().port());
        launcher.last().alive = false;
        assertFalse(runner.status().up(), "a dead child is not up");
    }

    @Test
    void theRealHttpLegPostsTheWavAsTheFileFieldToTheLoopbackAndReadsTheText() throws Exception {
        // A fake whisper-server endpoint on the loopback: it keeps what it was
        // sent and answers the way whisper-server 1.9.1 answers.
        HttpServer fake = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        AtomicReference<byte[]> body = new AtomicReference<>();
        AtomicReference<String> type = new AtomicReference<>();
        fake.createContext("/health", exchange -> {
            byte[] ok = "{\"status\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, ok.length);
            exchange.getResponseBody().write(ok);
            exchange.close();
        });
        fake.createContext("/inference", exchange -> {
            type.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            body.set(exchange.getRequestBody().readAllBytes());
            byte[] out = "{\"text\":\" Good morning.\\n\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
        });
        fake.start();
        try {
            WhisperServerRunner.Http http = WhisperServerRunner.loopbackHttp();
            int port = fake.getAddress().getPort();
            byte[] wav = LocalWhisperUpstream.wav(new byte[]{1, 2, 3, 4});

            assertEquals(200, http.health(port));
            WhisperServerRunner.Answer answer = http.inference(port, wav, "de", 5_000L);

            assertEquals(200, answer.status());
            assertEquals("Good morning.", WhisperServerRunner.textOf(answer.body()).orElseThrow());
            assertTrue(type.get().startsWith("multipart/form-data; boundary="), type.get());
            String sent = new String(body.get(), StandardCharsets.ISO_8859_1);
            assertTrue(sent.contains("name=\"file\"; filename=\"chunk.wav\""), sent);
            assertTrue(sent.contains("name=\"language\"\r\n\r\nde\r\n"), sent);
            assertTrue(sent.contains("name=\"response_format\"\r\n\r\njson\r\n"), sent);
            assertTrue(sent.contains(new String(wav, StandardCharsets.ISO_8859_1)), "the wav bytes travel as sent");
        } finally {
            fake.stop(0);
        }
    }

    /** A runner whose first sleep between two health polls waits for the test. */
    private WhisperServerRunner heldAtFirstPoll(FakeLauncher launcher, FakeHttp http, CountDownLatch waiting,
            CountDownLatch go) {
        AtomicInteger sleeps = new AtomicInteger();
        return new WhisperServerRunner(BINARY, model::get, launcher, http, () -> 51234, now::get, ms -> {
            if (sleeps.getAndIncrement() == 0) {
                waiting.countDown();
                go.await();
            }
            now.addAndGet(ms);
        }, temp, START_TIMEOUT_MS, IDLE_MS);
    }

    private static void press(WhisperServerRunner runner, Path silence) {
        try {
            runner.warmUp(silence, "en");
        } catch (IOException | InterruptedException failed) {
            throw new CompletionException(failed);
        }
    }

    @Test
    void stopReturnsWhileAStartWaitsForHealthAndEndsThatStart() throws Exception {
        // Fix round 1, finding 3: the desktop shell kills the JVM 5 s after
        // SIGTERM, and a start may wait 20 s for the model to load. stop() must
        // not wait behind it, or the quit leaves the whisper-server running.
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        http.refuseHealth = Integer.MAX_VALUE;
        CountDownLatch waiting = new CountDownLatch(1);
        CountDownLatch go = new CountDownLatch(1);
        WhisperServerRunner runner = heldAtFirstPoll(launcher, http, waiting, go);
        Path silence = silence();
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<?> starting = pool.submit(() -> press(runner, silence));
            assertTrue(waiting.await(5, TimeUnit.SECONDS), "the start polls health");

            assertFalse(CompletableFuture.supplyAsync(runner::status).get(2, TimeUnit.SECONDS).up(),
                    "the status answers during a start");
            assertTrue(CompletableFuture.supplyAsync(runner::loadsModel).get(2, TimeUnit.SECONDS));
            CompletableFuture.runAsync(runner::stop).get(2, TimeUnit.SECONDS);
            assertEquals(1, launcher.last().stops, "stop ended the starting process");

            go.countDown();
            ExecutionException failed = assertThrows(ExecutionException.class,
                    () -> starting.get(5, TimeUnit.SECONDS));
            assertTrue(failed.getCause().getMessage().contains("whisper-server stopped"),
                    failed.getCause().getMessage());
            assertEquals(1, launcher.argvs.size(), "the stopped start did not start another");
            assertEquals(1, launcher.last().stops, "and the child was stopped once");
            assertFalse(runner.status().up());
        } finally {
            go.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void aSecondPressDuringAStartWaitsForTheSameServerInsteadOfStartingAnother() throws Exception {
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        http.refuseHealth = 1;
        CountDownLatch waiting = new CountDownLatch(1);
        CountDownLatch go = new CountDownLatch(1);
        WhisperServerRunner runner = heldAtFirstPoll(launcher, http, waiting, go);
        Path silence = silence();
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<?> first = pool.submit(() -> press(runner, silence));
            assertTrue(waiting.await(5, TimeUnit.SECONDS), "the first press polls health");

            CompletableFuture.runAsync(() -> press(runner, silence)).get(2, TimeUnit.SECONDS);
            assertEquals(1, launcher.argvs.size(), "the second press used the starting server");

            go.countDown();
            first.get(5, TimeUnit.SECONDS);
            assertEquals(1, launcher.argvs.size(), "one process for both presses");
            assertEquals(2, http.bodies.size(), "each press sent its probe");
            assertFalse(runner.loadsModel());
            assertTrue(launcher.last().isAlive());
        } finally {
            go.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void theProbeWaitsAtMostTheStartBoundAndAChunkTheRequestBound() throws Exception {
        // Fix round 1: the browser gives a warm up 20 s, so a probe that waits
        // 60 s on a hung server answers nobody.
        FakeLauncher launcher = new FakeLauncher();
        FakeHttp http = new FakeHttp(launcher);
        WhisperServerRunner runner = runner(launcher, http);

        runner.warmUp(silence(), "en");
        runner.transcribe(speech(), "en");

        assertEquals(List.of(START_TIMEOUT_MS, WhisperServerRunner.REQUEST_TIMEOUT_MS), http.timeouts);
        assertEquals(60_000L, WhisperServerRunner.REQUEST_TIMEOUT_MS);
    }

    @Test
    void theProductionLauncherWritesStdoutAndStderrIntoTheLogAndRunsInItsFolder() throws Exception {
        // Fix round 1, finding 6: the fake launcher replaces this redirect in
        // every other case, so a real process proves it here.
        Path dir = temp.resolve("logs");
        Files.createDirectories(dir);
        Path log = dir.resolve("whisper-server.log");
        WhisperServerRunner.Child child = WhisperServerRunner.launch(
                List.of("/bin/sh", "-c", "echo to-stdout; echo to-stderr 1>&2; pwd -P"), log);
        long until = System.currentTimeMillis() + 10_000;
        while (child.isAlive() && System.currentTimeMillis() < until) {
            Thread.sleep(20);
        }
        assertFalse(child.isAlive(), "the shell ended");

        List<String> lines = Files.readAllLines(log);
        assertTrue(lines.contains("to-stdout"), lines.toString());
        assertTrue(lines.contains("to-stderr"), lines.toString());
        assertTrue(lines.contains(dir.toRealPath().toString()), "the working folder is the log's: " + lines);
    }

    @Test
    void theProductionChildStopsItsProcess() throws Exception {
        WhisperServerRunner.Child child = WhisperServerRunner.launch(
                List.of("/bin/sleep", "30"), temp.resolve("whisper-server.log"));
        assertTrue(child.isAlive());

        child.stop();

        assertFalse(child.isAlive(), "stop() returns once the process is gone");
    }

    @Test
    void theProductionPortIsAFreeLoopbackPort() throws Exception {
        int port = WhisperServerRunner.freeLoopbackPort();
        assertTrue(port > 1024 && port < 65536, "port " + port);
        try (java.net.ServerSocket again = new java.net.ServerSocket(port, 1, InetAddress.getLoopbackAddress())) {
            assertEquals(port, again.getLocalPort(), "the port was free on the loopback");
        }
    }
}
