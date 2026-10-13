package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.EventStreamProbe;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.wire.LlmWireRecorder;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 557: the stop button ends a run within one second while the provider
 * waits on a backend that does not answer. Each test runs a real agent over a
 * real provider, wrapped for retries exactly as {@code providerFromConfig}
 * wraps it, against a loopback socket that stays silent, presses stop the way
 * the server does (a cancel on a fresh virtual thread) and measures from the
 * cancel to {@code run_end}.
 *
 * <p>Three phases per provider: the connection is never established (an
 * {@code https} dial whose TLS handshake gets no answer), the kernel accepted
 * the connection but the server never calls accept, and the server read the
 * request and sends no headers. After each stop the test counts what the run
 * left behind: the producer thread, every client socket, and any connection
 * dialled after the stop.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class StopReachesAWaitingBackendTest {

    /** Criterion 1 and 2: from the cancel to run_end. */
    private static final long STOP_BUDGET_MS = 1_000;

    /** How long a test waits for run_end before it calls the stop a hang. */
    private static final long GIVE_UP_MS = 4_000;

    private static final Duration ARRIVAL = Duration.ofSeconds(10);
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path temp;

    private final List<AutoCloseable> cleanup = new ArrayList<>();

    @AfterEach
    void tearDown() {
        for (AutoCloseable closeable : cleanup.reversed()) {
            try {
                closeable.close();
            } catch (Exception ignored) {
                // best effort: a red run leaves things waiting
            }
        }
    }

    // ---- fixtures -------------------------------------------------------------

    private SilentBackend backend(SilentBackend.Mode mode) throws IOException {
        SilentBackend backend = new SilentBackend(mode);
        cleanup.add(backend);
        return backend;
    }

    private static LlmProvider openAi(String baseUrl) {
        return new OpenAiCompatProvider(new OpenAiCompatProvider.Options(baseUrl, "local-model", null, "lmstudio"));
    }

    private static LlmProvider ollama(String baseUrl) {
        return new OllamaProvider(new OllamaOptions(baseUrl, "qwen2.5:7b"));
    }

    private static LlmProvider anthropic(String baseUrl) {
        return new AnthropicProvider("claude-opus-4-8", false, "test-key", baseUrl);
    }

    /**
     * The agent a session builds, minus the session: the provider wrapped for
     * retries as {@code SpectroConfig.providerFromConfig} wraps it (two retries).
     *
     * @param provider  the concrete provider
     * @param threshold an explicit compaction threshold, or null to let the
     *                  agent ask the provider for its window first
     * @param wire      a wire recorder, or null
     */
    private Agent agentOn(LlmProvider provider, Integer threshold, LlmWireRecorder wire) {
        return agentOn(provider, threshold, wire, false);
    }

    /** As above, with thinking switched on as the session's setting does. */
    private Agent agentOn(LlmProvider provider, Integer threshold, LlmWireRecorder wire, boolean thinking) {
        AgentOptions.Builder options = AgentOptions.builder()
                .provider(RetryingProvider.wrap(provider, RetryPolicy.from(2)))
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(temp)
                .onPermission(request -> true)
                .compactionThreshold(threshold)
                .thinking(thinking);
        if (wire != null) {
            options.llmWire(wire);
        }
        return new Agent(options.build());
    }

    /** One run, read on its own thread so the test can press stop in the middle. */
    private final class Watched implements AutoCloseable {
        final CancelSignal signal = new CancelSignal();
        final EventStream stream;
        final List<RunEvent> events = new CopyOnWriteArrayList<>();
        final CountDownLatch turnStarted = new CountDownLatch(1);
        final CountDownLatch ended = new CountDownLatch(1);
        volatile long endedAtNanos;
        volatile RunEvent.RunEnd runEnd;
        /** How long the last {@link #stop} waited for run_end before it gave up. */
        volatile long gaveUpAfterMs = GIVE_UP_MS;

        Watched(Agent agent, String prompt) {
            this(agent, prompt, null);
        }

        Watched(Agent agent, String prompt, List<RunEvent.Attachment> attachments) {
            this.stream = agent.run(prompt, new RunOptions(signal, attachments));
            cleanup.add(this);
            Thread reader = new Thread(() -> {
                for (RunEvent event : stream) {
                    events.add(event);
                    if (event instanceof RunEvent.TurnStart) {
                        turnStarted.countDown();
                    }
                    if (event instanceof RunEvent.RunEnd end && runEnd == null) {
                        endedAtNanos = System.nanoTime();
                        runEnd = end;
                        ended.countDown();
                    }
                }
                ended.countDown();
            }, "stop-test-reader");
            reader.setDaemon(true);
            reader.start();
        }

        /**
         * Presses stop as {@code SessionConnection.onAbort} does and measures.
         *
         * @return milliseconds from the cancel to run_end, or -1 when no
         *         run_end came within {@link #GIVE_UP_MS}
         */
        long stop() throws InterruptedException {
            return stop(GIVE_UP_MS);
        }

        /** As {@link #stop()}, waiting up to {@code giveUpMs} for run_end. */
        long stop(long giveUpMs) throws InterruptedException {
            gaveUpAfterMs = giveUpMs;
            long pressed = System.nanoTime();
            Thread.ofVirtual().name("spectro-abort").start(signal::cancel);
            if (!ended.await(giveUpMs, TimeUnit.MILLISECONDS) || runEnd == null) {
                return -1;
            }
            return TimeUnit.NANOSECONDS.toMillis(endedAtNanos - pressed);
        }

        @Override
        public void close() {
            stream.close();
        }
    }

    /**
     * The checks every stopped run must pass: within budget, ended as
     * aborted, no error shown, and the producer thread gone.
     */
    private static void assertStoppedCleanly(Watched run, long millis, String phase) throws InterruptedException {
        assertStoppedCleanly(run, millis, phase, "557");
    }

    /** As above, logged under the card that measures it. */
    private static void assertStoppedCleanly(Watched run, long millis, String phase, String card)
            throws InterruptedException {
        System.out.println("card " + card + " measured: stop " + phase + ": " + millis + " ms to run_end");
        assertTrue(millis >= 0 && millis < STOP_BUDGET_MS,
                "stop " + phase + " took " + (millis < 0 ? "more than " + run.gaveUpAfterMs : millis)
                        + " ms from the cancel to run_end; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals("aborted", run.runEnd.stopReason(), "a stopped run ends as aborted");
        assertTrue(run.events.stream().noneMatch(RunEvent.ErrorEvent.class::isInstance),
                "a stop is not an error, but the run emitted " + run.events.stream()
                        .filter(RunEvent.ErrorEvent.class::isInstance).toList());
        assertTrue(EventStreamProbe.producerGoneWithin(run.stream, Duration.ofSeconds(1)),
                "the thread that produced the stopped run is still alive one second after run_end");
    }

    /** Waits until an accepted connection has sent something that satisfies {@code ready}. */
    private static SilentBackend.Peer awaitPeer(SilentBackend backend, Function<String, Boolean> ready)
            throws InterruptedException {
        SilentBackend.Peer peer = backend.awaitConnection(ARRIVAL);
        assertNotNull(peer, "the run never reached the backend");
        long deadline = System.nanoTime() + ARRIVAL.toNanos();
        while (!ready.apply(peer.head()) && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        assertTrue(ready.apply(peer.head()), "the backend never saw what it waits for: " + peer.head());
        return peer;
    }

    private static boolean tlsHello(String head) {
        return !head.isEmpty() && head.charAt(0) == 0x16; // a TLS handshake record
    }

    private static boolean httpRequest(String head) {
        return head.startsWith("POST ") || head.startsWith("GET ");
    }

    /**
     * Phase one: the connection is never established. The test waits for the
     * ClientHello, so the dial is provably under way, then stops.
     */
    private void stopDuringConnect(Function<String, LlmProvider> provider) throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        Agent agent = agentOn(provider.apply(backend.url("https")), 100_000, null);
        Watched run = new Watched(agent, "hello");
        awaitPeer(backend, StopReachesAWaitingBackendTest::tlsHello);
        Thread.sleep(100);
        int dialled = backend.connections();

        long millis = run.stop();

        assertStoppedCleanly(run, millis, "during a connect that never completes");
        Thread.sleep(400); // a retry would dial within the first backoff
        assertEquals(dialled, backend.connections(), "a connection was dialled after the stop");
        assertEquals(0, backend.openAfter(Duration.ofSeconds(1)),
                "the stopped run left its socket open");
    }

    /** Phase two: the kernel accepted, the server never does. */
    private void stopWhileNeverAccepted(Function<String, LlmProvider> provider) throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.NEVER_ACCEPTING);
        Agent agent = agentOn(provider.apply(backend.url("http")), 100_000, null);
        Watched run = new Watched(agent, "hello");
        assertTrue(backend.awaitQueued(ARRIVAL), "the run never dialled the backend");
        Thread.sleep(100);

        long millis = run.stop();

        assertStoppedCleanly(run, millis, "while the server never accepts");
        Thread.sleep(400);
        SilentBackend.Queue queue = backend.drainQueued(Duration.ofSeconds(1));
        assertEquals(1, queue.connections(),
                "the run dials exactly once: before the stop, and never after it");
        assertEquals(1, queue.closedByClient(), "the stopped run left its socket open");
    }

    /** Phase three: the server read the request and sends no headers. */
    private void stopWhileWaitingForHeaders(Function<String, LlmProvider> provider) throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        Agent agent = agentOn(provider.apply(backend.url("http")), 100_000, null);
        Watched run = new Watched(agent, "hello");
        awaitPeer(backend, StopReachesAWaitingBackendTest::httpRequest);
        Thread.sleep(100);

        long millis = run.stop();

        assertStoppedCleanly(run, millis, "while the server sends no headers");
        Thread.sleep(400);
        assertEquals(1, backend.connections(), "a connection was dialled after the stop");
        assertEquals(0, backend.openAfter(Duration.ofSeconds(1)),
                "the stopped run left its socket open");

        // Criterion 6: the session takes the next prompt at once.
        long asked = System.nanoTime();
        Watched next = new Watched(agent, "again");
        SilentBackend.Peer second = backend.awaitConnection(Duration.ofSeconds(1));
        assertNotNull(second, "the next prompt did not reach the backend within one second of the stop");
        long reached = TimeUnit.NANOSECONDS.toMillis(second.acceptedAtNanos - asked);
        assertTrue(reached < STOP_BUDGET_MS, "the next prompt took " + reached + " ms to reach the backend");
        awaitRequest(second);
        assertStoppedCleanly(next, next.stop(), "of the next prompt");
    }

    /** Waits until a connection has sent its request line, then gives the client a moment to block. */
    private static void awaitRequest(SilentBackend.Peer peer) throws InterruptedException {
        long deadline = System.nanoTime() + ARRIVAL.toNanos();
        while (!httpRequest(peer.head()) && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        Thread.sleep(100);
    }

    // ---- OpenAI-compatible (LM Studio, llama.cpp, spectro-local) -------------

    @Test
    void openAiCompatStopsDuringAConnectThatNeverCompletes() throws Exception {
        stopDuringConnect(StopReachesAWaitingBackendTest::openAi);
    }

    @Test
    void openAiCompatStopsWhileTheServerNeverAccepts() throws Exception {
        stopWhileNeverAccepted(StopReachesAWaitingBackendTest::openAi);
    }

    @Test
    void openAiCompatStopsWhileTheServerSendsNoHeaders() throws Exception {
        stopWhileWaitingForHeaders(StopReachesAWaitingBackendTest::openAi);
    }

    // ---- Ollama ---------------------------------------------------------------

    @Test
    void ollamaStopsDuringAConnectThatNeverCompletes() throws Exception {
        stopDuringConnect(StopReachesAWaitingBackendTest::ollama);
    }

    @Test
    void ollamaStopsWhileTheServerNeverAccepts() throws Exception {
        stopWhileNeverAccepted(StopReachesAWaitingBackendTest::ollama);
    }

    @Test
    void ollamaStopsWhileTheServerSendsNoHeaders() throws Exception {
        stopWhileWaitingForHeaders(StopReachesAWaitingBackendTest::ollama);
    }

    // ---- Anthropic ------------------------------------------------------------

    @Test
    void anthropicStopsDuringAConnectThatNeverCompletes() throws Exception {
        stopDuringConnect(StopReachesAWaitingBackendTest::anthropic);
    }

    @Test
    void anthropicStopsWhileTheServerNeverAccepts() throws Exception {
        stopWhileNeverAccepted(StopReachesAWaitingBackendTest::anthropic);
    }

    @Test
    void anthropicStopsWhileTheServerSendsNoHeaders() throws Exception {
        stopWhileWaitingForHeaders(StopReachesAWaitingBackendTest::anthropic);
    }

    // ---- before the chat post -------------------------------------------------

    /**
     * Without an explicit threshold the agent asks the backend for its window
     * before the first request. That question has a two second deadline of
     * its own; a stop during it must not wait for the deadline.
     */
    @Test
    void aStopDuringTheWindowQuestionDoesNotWaitForItsDeadline() throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        Agent agent = agentOn(openAi(backend.url("http")), null, null);
        Watched run = new Watched(agent, "hello");
        SilentBackend.Peer probe = awaitPeer(backend, StopReachesAWaitingBackendTest::httpRequest);
        assertTrue(probe.head().startsWith("GET "), "the first request is the window question: " + probe.head());
        Thread.sleep(100);

        long millis = run.stop();

        assertStoppedCleanly(run, millis, "during the window question");
        Thread.sleep(400);
        assertEquals(1, backend.connections(), "the chat request went out after the stop");
    }

    /**
     * A stop pressed before the provider opens its stream sends nothing: no
     * connection, and no request on the wire record. The retry wrapper is
     * left out, so the provider's own check is the only one in play. The
     * wire record is the part that does not depend on timing: without the
     * check, an HTTP client cancelled at once may still never reach the
     * socket, but the request line is written either way.
     */
    private void aCancelledRequestDialsNothing(Function<String, LlmProvider> provider) throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        RecordingWireTap tap = new RecordingWireTap();
        ProviderRequest request = new ProviderRequest("test",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("hello")))),
                List.of(), 100, ProviderRequest.Reasoning.DEFAULT, null, signal, tap);
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        LlmProvider stopped = provider.apply(backend.url("http"));
        Thread reader = Thread.ofVirtual().start(() -> stopped.stream(request).forEach(events::add));
        reader.join(Duration.ofSeconds(2));
        Thread.sleep(200);
        assertEquals(0, backend.connections(),
                "a request whose stop was already pressed dialled the backend anyway");
        assertEquals(List.of(), tap.requests, "a request whose stop was already pressed went on the wire record");
        assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), events);
    }

    @Test
    void openAiCompatDialsNothingOnceStopped() throws Exception {
        aCancelledRequestDialsNothing(StopReachesAWaitingBackendTest::openAi);
    }

    @Test
    void ollamaDialsNothingOnceStopped() throws Exception {
        aCancelledRequestDialsNothing(StopReachesAWaitingBackendTest::ollama);
    }

    @Test
    void anthropicDialsNothingOnceStopped() throws Exception {
        aCancelledRequestDialsNothing(StopReachesAWaitingBackendTest::anthropic);
    }

    // ---- the wire record ------------------------------------------------------

    /**
     * The stop reaches the waiting thread through an interrupt. The record
     * of the exchange is written after the stop, to a file, so it shows
     * whether that interrupt was cleared first: a file channel written on an
     * interrupted thread closes and the line is lost. And it shows that the
     * exchange is recorded as aborted, not as failed.
     */
    private void theWireRecordSaysAborted(Function<String, LlmProvider> provider, String name) throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        Path file = temp.resolve(name + ".llm.jsonl");
        Agent agent = agentOn(provider.apply(backend.url("http")), 100_000, new LlmWireRecorder(file, 1_000_000));
        Watched run = new Watched(agent, "hello");
        awaitPeer(backend, StopReachesAWaitingBackendTest::httpRequest);
        Thread.sleep(100);

        assertStoppedCleanly(run, run.stop(), "with a wire record (" + name + ")");

        List<JsonNode> lines = new ArrayList<>();
        for (String line : Files.readAllLines(file)) {
            lines.add(JSON.readTree(line));
        }
        List<String> types = lines.stream().map(l -> l.path("type").asText()).toList();
        assertEquals(List.of("llm_request", "llm_response"), types, "the record of the stopped exchange");
        assertTrue(lines.get(1).path("aborted").asBoolean(), "the response line says aborted: " + lines.get(1));
        assertTrue(lines.get(1).path("error").isMissingNode() || lines.get(1).path("error").isNull(),
                "a stopped exchange is not a failed one: " + lines.get(1));
    }

    @Test
    void theWireRecordClosesTheStoppedExchangeAsAborted() throws Exception {
        theWireRecordSaysAborted(StopReachesAWaitingBackendTest::openAi, "openai");
    }

    @Test
    void ollamasWireRecordClosesTheStoppedExchangeAsAborted() throws Exception {
        theWireRecordSaysAborted(StopReachesAWaitingBackendTest::ollama, "ollama");
    }

    @Test
    void anthropicsWireRecordClosesTheStoppedExchangeAsAborted() throws Exception {
        theWireRecordSaysAborted(StopReachesAWaitingBackendTest::anthropic, "anthropic");
    }

    // ---- an image in the history ----------------------------------------------

    /** One tiny PNG, saved where the agent reads attachments from. */
    private static List<RunEvent.Attachment> anImage() {
        byte[] png = java.util.Base64.getDecoder().decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
        SessionStore.StoredBlob blob = SessionStore.saveBlob(
                "card557-" + java.util.UUID.randomUUID().toString().substring(0, 8), png, "image/png");
        return List.of(new RunEvent.Attachment("image", "image/png", blob.blobPath(), blob.sha256()));
    }

    /**
     * With an image in the history the agent asks the provider whether the
     * model can see before it sends (card 252). Ollama answers that from
     * {@code /api/show}, on a client without a deadline; a stop must reach
     * that wait too.
     */
    @Test
    void ollamaStopsWhileTheVisionQuestionWaits() throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        Agent agent = agentOn(ollama(backend.url("http")), 100_000, null);
        Watched run = new Watched(agent, "what is on it?", anImage());
        SilentBackend.Peer show = awaitPeer(backend, StopReachesAWaitingBackendTest::httpRequest);
        assertTrue(show.head().startsWith("POST /api/show"), "the first request is the vision question: "
                + show.head());
        Thread.sleep(100);

        assertStoppedCleanly(run, run.stop(), "while the vision question waits (ollama)");
        Thread.sleep(400);
        assertEquals(1, backend.connections(), "the chat request went out after the stop");
        assertEquals(0, backend.openAfter(Duration.ofSeconds(1)), "the stopped run left its socket open");
    }

    // ---- the first request of a session (live check 0.15.3, fix 2) -------------

    /**
     * With thinking on, Ollama's first chat request of a provider asks
     * {@code /api/show} whether the model can think (card 447), once per
     * session, on the capability client with its two second deadlines. In the
     * live check the first Stop after run_start of a fresh session took 1823
     * to 1848 ms, a thread dump showed the run in that question, and later
     * Stops took 10 to 45 ms. The question must end on a Stop like the chat
     * request does.
     *
     * @param scheme {@code http} for a server that reads the question and
     *               never answers, {@code https} for a connect that never
     *               completes (the handshake is never answered)
     */
    private void stopWhileTheThinkingQuestionWaits(String scheme) throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        Agent agent = agentOn(ollama(backend.url(scheme)), 100_000, null, true);
        Watched run = new Watched(agent, "hello");
        SilentBackend.Peer first = awaitPeer(backend, "https".equals(scheme)
                ? StopReachesAWaitingBackendTest::tlsHello : StopReachesAWaitingBackendTest::httpRequest);
        if ("http".equals(scheme)) {
            assertTrue(first.head().startsWith("POST /api/show"), "the first request is the thinking question: "
                    + first.head());
        }
        Thread.sleep(100);

        assertStoppedCleanly(run, run.stop(), "while the thinking question waits (ollama, " + scheme + ")");
        Thread.sleep(400);
        assertEquals(1, backend.connections(), "the chat request went out after the stop");
        assertEquals(0, backend.openAfter(Duration.ofSeconds(1)), "the stopped run left its socket open");
    }

    @Test
    void ollamaStopsWhileTheThinkingQuestionGetsNoAnswer() throws Exception {
        stopWhileTheThinkingQuestionWaits("http");
    }

    @Test
    void ollamaStopsWhileTheThinkingQuestionCannotConnect() throws Exception {
        stopWhileTheThinkingQuestionWaits("https");
    }

    @Test
    void ollamaWithThinkingOnDialsNothingOnceStopped() throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        CancelSignal signal = new CancelSignal();
        signal.cancel();
        ProviderRequest request = new ProviderRequest("test",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("hello")))),
                List.of(), 100, ProviderRequest.Reasoning.ON, null, signal, null);
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        LlmProvider stopped = ollama(backend.url("http"));
        Thread reader = Thread.ofVirtual().start(() -> stopped.stream(request).forEach(events::add));
        reader.join(Duration.ofSeconds(3));
        Thread.sleep(200);
        assertEquals(0, backend.connections(),
                "a request whose stop was already pressed asked the thinking question anyway");
        assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), events);
    }

    // ---- Copilot --------------------------------------------------------------

    private FakeCopilotRuntime copilotRuntime() throws IOException {
        FakeCopilotRuntime runtime = new FakeCopilotRuntime();
        cleanup.add(runtime);
        return runtime;
    }

    private CopilotProvider copilot(FakeCopilotRuntime runtime) {
        CopilotProvider provider = new CopilotProvider(
                new CopilotProvider.Options("claude-sonnet-5", null, null, false), "Mac OS X", runtime.cliUrl());
        cleanup.add(provider::close);
        return provider;
    }

    private static ProviderMessage userSays(String text) {
        return new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(text)));
    }

    private static ProviderMessage assistantSays(String text) {
        return new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent(text)));
    }

    private static ProviderRequest copilotAsk(List<ProviderMessage> history, List<ToolSpec> tools, String effort,
                                              CancelSignal signal) {
        return new ProviderRequest("test", history, tools, 1_000, ProviderRequest.Reasoning.DEFAULT, effort,
                signal, null);
    }

    /** A runtime turn that answers {@code text} and ends. */
    private static java.util.function.Consumer<FakeCopilotRuntime.Turn> answers(String text) {
        return turn -> {
            turn.message(text, List.of());
            turn.idle();
        };
    }

    /** Waits up to one second for the runtime to see {@code count} requests of {@code method}. */
    private static boolean sawWithinASecond(FakeCopilotRuntime runtime, String method, int count)
            throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        while (runtime.requests(method).size() < count && System.nanoTime() < deadline) {
            Thread.sleep(5);
        }
        return runtime.requests(method).size() >= count;
    }

    /**
     * Stops a Copilot run while the runtime holds back the answer to
     * {@code method}, and checks the stopped run and the next prompt.
     *
     * @param threshold null lets the agent ask for the window first (the
     *                  model list, which starts the runtime); a number skips
     *                  that question, so the wait happens inside the stream
     * @param nextAsks  what the next prompt asks the runtime first
     */
    private void copilotStopsWhileTheRuntimeHolds(FakeCopilotRuntime runtime, String method, Integer threshold,
                                                  String nextAsks) throws Exception {
        CopilotProvider provider = copilot(runtime);
        Agent agent = agentOn(provider, threshold, null);
        Watched run = new Watched(agent, "hello");
        runtime.await(method, ARRIVAL);
        Thread.sleep(100);

        long millis = run.stop();

        assertStoppedCleanly(run, millis, "while the Copilot runtime holds " + method);
        Thread.sleep(300);
        assertEquals(1, runtime.requests(method).size(), "the stopped run asked the runtime again: " + method);
        if (!"session.send".equals(method)) {
            assertTrue(runtime.requests("session.send").isEmpty(), "the prompt was sent after the stop");
        } else {
            // The prompt went out half way; the runtime session it went to is closed.
            assertTrue(sawWithinASecond(runtime, "session.detach", 1),
                    "the runtime session of the stopped send is still open one second after run_end");
        }
        if ("connect".equals(method)) {
            // The connection the stopped start opened belongs to the stopped run.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
            while (runtime.clientsGone() == 0 && System.nanoTime() < deadline) {
                Thread.sleep(5);
            }
            assertEquals(1, runtime.clientsGone(),
                    "the stopped runtime start still holds its connection one second after run_end");
        }

        // Criterion 6: the next prompt reaches the runtime at once.
        int before = runtime.requests().size();
        long asked = System.nanoTime();
        Watched next = new Watched(agent, "again");
        while (runtime.requests().size() == before
                && System.nanoTime() - asked < TimeUnit.SECONDS.toNanos(1)) {
            Thread.sleep(5);
        }
        assertTrue(runtime.requests().size() > before,
                "the next prompt did not reach the runtime within one second of the stop");
        assertEquals(nextAsks, runtime.requests().get(before).path("method").asText(),
                "the next prompt asks the runtime again, it does not reuse what the stop cut short");
        Thread.sleep(100);
        assertStoppedCleanly(next, next.stop(), "of the next Copilot prompt");
    }

    @Test
    void copilotStopsDuringTheRuntimeStart() throws Exception {
        copilotStopsWhileTheRuntimeHolds(copilotRuntime().hold("connect"), "connect", null, "connect");
    }

    @Test
    void copilotStopsDuringTheModelListWait() throws Exception {
        copilotStopsWhileTheRuntimeHolds(copilotRuntime().hold("models.list"), "models.list", null, "models.list");
    }

    @Test
    void copilotStopsDuringTheRuntimeStartInsideTheStream() throws Exception {
        copilotStopsWhileTheRuntimeHolds(copilotRuntime().hold("connect"), "connect", 100_000, "connect");
    }

    @Test
    void copilotStopsWhileTheRuntimeHoldsTheSend() throws Exception {
        copilotStopsWhileTheRuntimeHolds(copilotRuntime().hold("session.send"), "session.send", 100_000,
                "session.create");
    }

    /**
     * Setting the tools and switching the effort happen on a conversation
     * the first turn opened, before the next prompt is sent. The provider is
     * driven directly: the agent sends neither a changed tool list nor a
     * changed effort into a running session on its own.
     */
    private void copilotTurnStopsWhileTheRuntimeHolds(String method, List<ToolSpec> tools, String effort)
            throws Exception {
        FakeCopilotRuntime runtime = copilotRuntime();
        CopilotProvider provider = copilot(runtime);
        runtime.onSend(answers("hello"));
        List<ProviderEvent> first = new ArrayList<>();
        provider.stream(copilotAsk(List.of(userSays("hi")), List.of(), null, new CancelSignal()))
                .forEach(first::add);
        assertEquals(new PStop(PStop.StopReason.END_TURN), first.getLast(), "the first turn ends normally");
        runtime.hold(method);
        // A runtime that holds one request holds the next one too: closing the
        // dropped session must not sit on the stopped turn.
        runtime.hold("session.detach");

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        long[] doneAt = new long[1];
        Thread.ofVirtual().start(() -> {
            try {
                provider.stream(copilotAsk(List.of(userSays("hi"), assistantSays("hello"), userSays("again")),
                        tools, effort, signal)).forEach(events::add);
            } finally {
                doneAt[0] = System.nanoTime();
                done.countDown();
            }
        });
        runtime.await(method, ARRIVAL);
        Thread.sleep(100);

        long pressed = System.nanoTime();
        Thread.ofVirtual().name("spectro-abort").start(signal::cancel);
        long millis = done.await(GIVE_UP_MS, TimeUnit.MILLISECONDS)
                ? TimeUnit.NANOSECONDS.toMillis(doneAt[0] - pressed) : -1;

        System.out.println("card 557 measured: stop while the Copilot runtime holds " + method + ": " + millis
                + " ms to the end of the turn");
        assertTrue(millis >= 0 && millis < STOP_BUDGET_MS, "stop while the Copilot runtime holds " + method
                + " took " + (millis < 0 ? "more than " + GIVE_UP_MS : millis)
                + " ms from the cancel to the end of the turn; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), events, "a stopped turn ends as aborted");
        assertEquals(1, runtime.requests("session.send").size(), "the second prompt was sent after the stop");
        assertTrue(sawWithinASecond(runtime, "session.detach", 1),
                "the runtime session the stop cut short is still open one second later");
    }

    @Test
    void copilotStopsWhileTheRuntimeHoldsSettingTheTools() throws Exception {
        copilotTurnStopsWhileTheRuntimeHolds("session.tools.set", List.of(new ToolSpec("read_file", "Reads a file.",
                JSON.valueToTree(java.util.Map.of("type", "object")))), null);
    }

    @Test
    void copilotStopsWhileTheRuntimeHoldsTheEffortSwitch() throws Exception {
        copilotTurnStopsWhileTheRuntimeHolds("session.model.switchTo", List.of(), "high");
    }

    /**
     * A stop that lands after the turn found its conversation but before
     * anything was sent leaves that conversation free for the next prompt.
     * The test holds the provider's monitor, so the turn waits inside the
     * matching, presses stop there, and lets go.
     */
    @Test
    void aStopAfterTheConversationWasFoundLeavesItFree() throws Exception {
        FakeCopilotRuntime runtime = copilotRuntime();
        CopilotProvider provider = copilot(runtime);
        runtime.onSend(answers("hello"));
        provider.stream(copilotAsk(List.of(userSays("hi")), List.of(), null, new CancelSignal()))
                .forEach(event -> { });
        List<ProviderMessage> again = List.of(userSays("hi"), assistantSays("hello"), userSays("again"));

        CancelSignal signal = new CancelSignal();
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        Thread turn;
        synchronized (provider) {
            turn = new Thread(() -> provider.stream(copilotAsk(again, List.of(), null, signal))
                    .forEach(events::add), "copilot-turn");
            turn.start();
            long deadline = System.nanoTime() + ARRIVAL.toNanos();
            while (!(turn.getState() == Thread.State.BLOCKED && insidePlan(turn))
                    && System.nanoTime() < deadline) {
                Thread.sleep(1);
            }
            assertTrue(insidePlan(turn), "the turn never reached the matching");
            signal.cancel();
        }
        turn.join(Duration.ofSeconds(5));
        assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), events, "a stopped turn ends as aborted");

        runtime.onSend(answers("again to you"));
        List<ProviderEvent> next = new ArrayList<>();
        provider.stream(copilotAsk(again, List.of(), null, new CancelSignal())).forEach(next::add);
        assertEquals(new PStop(PStop.StopReason.END_TURN), next.getLast(), "the next prompt is answered");
        assertEquals(1, runtime.requests("session.create").size(),
                "the next prompt opened a second runtime session: the stop left the first one marked busy");
    }

    private static boolean insidePlan(Thread thread) {
        for (StackTraceElement frame : thread.getStackTrace()) {
            if (frame.getClassName().equals(CopilotProvider.class.getName()) && frame.getMethodName().equals("plan")) {
                return true;
            }
        }
        return false;
    }

    /**
     * A stop that lands while the window question waits for the model list
     * leaves a run with an image in its history. That run asks nothing more:
     * the vision question would ask for the model list again.
     */
    @Test
    void aStoppedRunWithAnImageAsksTheRuntimeNothingMore() throws Exception {
        FakeCopilotRuntime runtime = copilotRuntime().hold("models.list");
        Agent agent = agentOn(copilot(runtime), null, null);
        Watched run = new Watched(agent, "what is on it?", anImage());
        runtime.await("models.list", ARRIVAL);
        Thread.sleep(100);

        assertStoppedCleanly(run, run.stop(), "during the window question with an image (copilot)");
        Thread.sleep(300);
        assertEquals(1, runtime.requests("models.list").size(), "the stopped run asked for the model list again");
    }

    /**
     * Ollama checks the model's sight itself before it posts an image, for
     * the faces that drive it without the agent's fence. That check waits on
     * {@code /api/show} as well.
     */
    @Test
    void ollamaStopsWhileItsOwnVisionCheckWaits() throws Exception {
        SilentBackend backend = backend(SilentBackend.Mode.ACCEPTING);
        LlmProvider provider = ollama(backend.url("http"));
        CancelSignal signal = new CancelSignal();
        ProviderRequest request = new ProviderRequest("test", List.of(new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new TextContent("what is on it?"), new LlmProvider.ImageContent("image/png",
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")))),
                List.of(), 100, signal);
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        long[] doneAt = new long[1];
        Thread.ofVirtual().start(() -> {
            try {
                provider.stream(request).forEach(events::add);
            } finally {
                doneAt[0] = System.nanoTime();
                done.countDown();
            }
        });
        SilentBackend.Peer show = awaitPeer(backend, StopReachesAWaitingBackendTest::httpRequest);
        assertTrue(show.head().startsWith("POST /api/show"), "the first request is the vision check: " + show.head());
        Thread.sleep(100);

        long pressed = System.nanoTime();
        Thread.ofVirtual().name("spectro-abort").start(signal::cancel);
        long millis = done.await(GIVE_UP_MS, TimeUnit.MILLISECONDS)
                ? TimeUnit.NANOSECONDS.toMillis(doneAt[0] - pressed) : -1;

        System.out.println("card 557 measured: stop while ollama's own vision check waits: " + millis
                + " ms to the end of the stream");
        assertTrue(millis >= 0 && millis < STOP_BUDGET_MS, "stop while ollama's own vision check waits took "
                + (millis < 0 ? "more than " + GIVE_UP_MS : millis) + " ms; the budget is " + STOP_BUDGET_MS + " ms");
        assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), events, "a stopped stream ends as aborted");
        Thread.sleep(400);
        assertEquals(1, backend.connections(), "the chat request went out after the stop");
    }

    /**
     * With an image in the history the agent asks Copilot whether the model
     * can see, and Copilot answers from its model list. A stop must reach
     * that wait.
     */
    @Test
    void copilotStopsWhileTheVisionQuestionWaitsForTheModelList() throws Exception {
        FakeCopilotRuntime runtime = copilotRuntime().hold("models.list");
        Agent agent = agentOn(copilot(runtime), 100_000, null);
        Watched run = new Watched(agent, "what is on it?", anImage());
        runtime.await("models.list", ARRIVAL);
        Thread.sleep(100);

        assertStoppedCleanly(run, run.stop(), "while the vision question waits (copilot)");
        Thread.sleep(300);
        assertEquals(1, runtime.requests("models.list").size(), "the stopped run asked for the model list again");
        assertTrue(runtime.requests("session.create").isEmpty(), "a runtime session was opened after the stop");
    }

    // ---- card 583: a runtime that ignores the stop's own questions ------------

    /** Longer than the provider's old abort wait (5 s), so a red run prints the time it took. */
    private static final long GIVE_UP_ABORT_MS = 8_000;

    /** A turn that streams one delta and then goes quiet, as a model that thinks. */
    private static java.util.function.Consumer<FakeCopilotRuntime.Turn> startsAndGoesQuiet() {
        return turn -> turn.delta("partial");
    }

    /**
     * Criterion 6 of card 557 for a prompt that ends on its own: it reaches the
     * runtime within one second of the stop and is answered.
     */
    private void theNextCopilotPromptIsAnsweredAtOnce(Agent agent, FakeCopilotRuntime runtime, String nextAsks)
            throws InterruptedException {
        int before = runtime.requests().size();
        long asked = System.nanoTime();
        Watched next = new Watched(agent, "again");
        while (runtime.requests().size() == before
                && System.nanoTime() - asked < TimeUnit.SECONDS.toNanos(1)) {
            Thread.sleep(5);
        }
        assertTrue(runtime.requests().size() > before,
                "the next prompt did not reach the runtime within one second of the stop");
        assertEquals(nextAsks, runtime.requests().get(before).path("method").asText(),
                "what the next prompt asks the runtime first");
        assertTrue(next.ended.await(ARRIVAL.toMillis(), TimeUnit.MILLISECONDS) && next.runEnd != null,
                "the next prompt never ended");
        assertEquals("end_turn", next.runEnd.stopReason(), "the next prompt is answered");
        assertTrue(next.events.stream().noneMatch(RunEvent.ErrorEvent.class::isInstance),
                "the next prompt failed: " + next.events);
    }

    /**
     * Card 583: the runtime never answers {@code session.abort} and never goes
     * idle. Before, the stop waited out the provider's whole abort settle
     * (5,007 ms measured by the 0.15.3 review). The run ends at once; the
     * runtime session the abort never settled is closed in the background,
     * and the next prompt does not wait for that.
     */
    @Test
    void copilotStopsWhenTheRuntimeIgnoresTheAbort() throws Exception {
        FakeCopilotRuntime runtime = copilotRuntime().hold("session.abort");
        runtime.onSend(startsAndGoesQuiet());
        runtime.onSend(answers("again"));
        Agent agent = agentOn(copilot(runtime), 100_000, null);
        Watched run = new Watched(agent, "hello");
        String stopped = runtime.await("session.send", ARRIVAL).path("sessionId").asText();
        Thread.sleep(100);

        long millis = run.stop(GIVE_UP_ABORT_MS);

        assertStoppedCleanly(run, millis, "while the Copilot runtime ignores session.abort", "583");
        assertEquals(1, runtime.requests("session.abort").size(), "the stopped run asked for the abort again");
        theNextCopilotPromptIsAnsweredAtOnce(agent, runtime, "session.create");
        assertEquals(1, runtime.requests("session.send").stream()
                        .filter(send -> stopped.equals(send.path("sessionId").asText())).count(),
                "a prompt went to the runtime session whose abort never settled");

        // Nothing of the stopped run stays: its runtime session is closed once the
        // provider's abort settle (5 s) has run out, and the settle with it.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(7);
        while (runtime.requests("session.detach").stream()
                .noneMatch(detach -> stopped.equals(detach.path("sessionId").asText()))
                && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertTrue(runtime.requests("session.detach").stream()
                        .anyMatch(detach -> stopped.equals(detach.path("sessionId").asText())),
                "the runtime session whose abort never settled is still open 7 s after the stop");
    }

    /**
     * Card 583: the turn has gone quiet, the provider pings the runtime to
     * tell a thinking model from a dead runtime, and the runtime never answers
     * the ping. Before, the stop waited for the ping's own timeout (1,923 ms
     * measured by the 0.15.3 review).
     */
    @Test
    void copilotStopsWhileTheRuntimeIgnoresThePing() throws Exception {
        FakeCopilotRuntime runtime = copilotRuntime().hold("ping");
        runtime.onSend(startsAndGoesQuiet());
        runtime.onSend(answers("again"));
        Agent agent = agentOn(copilot(runtime), 100_000, null);
        Watched run = new Watched(agent, "hello");
        runtime.await("ping", ARRIVAL);
        String stopped = runtime.requests("session.send").getFirst().path("sessionId").asText();
        Thread.sleep(100);

        long millis = run.stop();

        assertStoppedCleanly(run, millis, "while the Copilot runtime ignores the ping", "583");
        assertEquals(1, runtime.requests("session.abort").size(), "the stop asks the runtime to abort once");
        // The runtime answered the abort at once, so its session takes the next prompt.
        theNextCopilotPromptIsAnsweredAtOnce(agent, runtime, "session.send");
        assertEquals(stopped, runtime.requests("session.send").getLast().path("sessionId").asText(),
                "the next prompt did not go to the runtime session the abort settled");
    }
}
