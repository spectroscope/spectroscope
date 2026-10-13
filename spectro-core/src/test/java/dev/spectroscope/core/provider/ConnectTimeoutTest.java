package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 557, criterion 8: a connect timeout of ten seconds as a safety net
 * under the stop button. Without a stop, a dial whose connection is never set
 * up ends after the timeout instead of the operating system's (75 s on macOS
 * for a black-holed address, measured 2026-10-12), and the run ends with an
 * error that names the host. The timeout bounds the connection setup only: a
 * stream that is connected and stays silent is not cut by it.
 *
 * <p>The OpenAI-compatible and Ollama providers dial through the JDK client,
 * whose connect timeout covers the TLS handshake as well, so a loopback socket
 * that accepts and never answers the handshake is a dial that is never set up,
 * the same on every operating system. The Anthropic SDK dials through OkHttp,
 * whose connect timeout covers the TCP connect only; its dial goes to a loopback
 * socket whose listen queue is full, so the kernel drops the SYN. How long a
 * kernel keeps such a loopback dial before it gives up itself differs (7.8 s on
 * macOS, measured 2026-10-12, which is below the timeout), so that test skips
 * where the kernel is faster, and a second test reads the timeout off the SDK
 * client instead.</p>
 */
@Timeout(value = 90, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ConnectTimeoutTest {

    /** The owner's value (card 557, 2026-10-12), written here so a change to the constant fails a test. */
    private static final long TIMEOUT_MS = 10_000;

    /** "About ten seconds": the clock of a connect timeout is not exact, the budget below says how much. */
    private static final long LOWEST_MS = TIMEOUT_MS - 500;
    private static final long HIGHEST_MS = TIMEOUT_MS + 2_500;

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path temp;

    private final List<AutoCloseable> cleanup = new ArrayList<>();
    private final ExecutorService dialers = Executors.newVirtualThreadPerTaskExecutor();

    @AfterEach
    void tearDown() {
        dialers.shutdownNow();
        for (AutoCloseable closeable : cleanup.reversed()) {
            try {
                closeable.close();
            } catch (Exception ignored) {
                // best effort
            }
        }
    }

    /** A host whose TLS handshake never answers: a dial the JDK client never finishes setting up. */
    private String handshakeNeverAnswered() throws IOException {
        SilentBackend backend = new SilentBackend(SilentBackend.Mode.ACCEPTING);
        cleanup.add(backend);
        return backend.url("https");
    }

    /** A host whose kernel drops the SYN: a TCP connect that is never answered. */
    private String synDropped() throws IOException {
        SilentBackend backend = new SilentBackend(SilentBackend.Mode.FULL_QUEUE);
        cleanup.add(backend);
        assumeTrue(backend.dropsNewConnections(),
                "this kernel answers a dial to a full listen queue, so it cannot model an unreachable host");
        return backend.url("http");
    }

    private static LlmProvider openAi(String url) {
        return new OpenAiCompatProvider(new OpenAiCompatProvider.Options(url, "local-model", null, "lmstudio"));
    }

    private static LlmProvider ollama(String url) {
        return new OllamaProvider(new OllamaOptions(url, "qwen2.5:7b"));
    }

    private static LlmProvider anthropic(String url) {
        return new AnthropicProvider("claude-opus-4-8", false, "test-key", url);
    }

    private static Map<String, Function<String, LlmProvider>> providers() {
        Map<String, Function<String, LlmProvider>> all = new LinkedHashMap<>();
        all.put("openai-compat", ConnectTimeoutTest::openAi);
        all.put("ollama", ConnectTimeoutTest::ollama);
        all.put("anthropic", ConnectTimeoutTest::anthropic);
        return all;
    }

    private static ProviderRequest hello(CancelSignal signal) {
        return new ProviderRequest("test",
                List.of(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("hello")))),
                List.of(), 100, signal);
    }

    /** What one dial came to: how long it took, and what it threw. */
    private record Dial(long millis, Throwable error, List<ProviderEvent> events) {}

    private static Dial dial(LlmProvider provider, CancelSignal signal, long giveUpMs) throws Exception {
        List<ProviderEvent> events = new CopyOnWriteArrayList<>();
        CompletableFuture<Throwable> failed = new CompletableFuture<>();
        long started = System.nanoTime();
        Thread.ofVirtual().start(() -> {
            try {
                provider.stream(hello(signal)).forEach(events::add);
                failed.complete(null);
            } catch (Throwable error) {
                failed.complete(error);
            }
        });
        Throwable error;
        try {
            error = failed.get(giveUpMs, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException stillWaiting) {
            return new Dial(-1, null, events);
        }
        return new Dial(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), error, events);
    }

    /** Checks one dial against the timeout: about ten seconds, an error naming the host, retried as before. */
    private static void assertGaveUpAfterTheTimeout(String name, String url, Dial dial) {
        String host = url.substring(url.indexOf("://") + 3);
        System.out.println("card 557 measured: " + name + " gave up on a dial that is never set up after "
                + dial.millis() + " ms: " + dial.error());
        assertTrue(dial.millis() >= LOWEST_MS && dial.millis() <= HIGHEST_MS, name
                + " gave up on a dial that is never set up after "
                + (dial.millis() < 0 ? "more than " + (HIGHEST_MS + 5_000) : dial.millis())
                + " ms; the connect timeout is " + TIMEOUT_MS + " ms");
        assertNotNull(dial.error(), name + " ended without an error: " + dial.events());
        assertTrue(String.valueOf(dial.error().getMessage()).contains(host),
                name + ": the error does not name the unreachable host " + host + ": " + dial.error());
        assertTrue(RetryPolicy.from(2).isTransient(dial.error()),
                name + ": a connect timeout must be retried like any failed dial, or the retry count changes: "
                        + dial.error());
    }

    /**
     * One dial each for the OpenAI-compatible and the Ollama provider, at
     * once, each to a host whose handshake never answers. The retry wrapper
     * is left out: this is one attempt.
     */
    @Test
    void theJdkProvidersGiveUpOnADialThatIsNeverSetUpAfterTheConnectTimeout() throws Exception {
        String openAiUrl = handshakeNeverAnswered();
        String ollamaUrl = handshakeNeverAnswered();
        CompletableFuture<Dial> openAiDial = CompletableFuture.supplyAsync(
                () -> dialQuietly(openAi(openAiUrl)), dialers);
        CompletableFuture<Dial> ollamaDial = CompletableFuture.supplyAsync(
                () -> dialQuietly(ollama(ollamaUrl)), dialers);
        assertGaveUpAfterTheTimeout("openai-compat", openAiUrl, openAiDial.get());
        assertGaveUpAfterTheTimeout("ollama", ollamaUrl, ollamaDial.get());
    }

    /** The Anthropic SDK's dial, to a host whose kernel drops the SYN. */
    @Test
    void anthropicGivesUpOnADialThatIsNeverAnsweredAfterTheConnectTimeout() throws Exception {
        String url = synDropped();
        Dial dial = dialQuietly(anthropic(url));
        assumeTrue(dial.millis() < 0 || dial.millis() >= LOWEST_MS,
                "this kernel gave up on the loopback dial itself after " + dial.millis()
                        + " ms, before the connect timeout could: " + dial.error());
        assertGaveUpAfterTheTimeout("anthropic", url, dial);
    }

    /**
     * Where the kernel gives up on a loopback dial before the timeout can,
     * the timeout is read off the SDK client the provider built: the connect
     * part is the safety net, the read and request parts stay the SDK's own.
     */
    @Test
    void anthropicsClientDialsWithTheConnectTimeoutAndNothingElse() throws Exception {
        AnthropicProvider provider = (AnthropicProvider) anthropic("http://127.0.0.1:9");
        Object client = field(provider, "client");
        com.anthropic.core.ClientOptions options = (com.anthropic.core.ClientOptions) field(client, "clientOptions");
        com.anthropic.core.Timeout sdkDefault = com.anthropic.core.Timeout.builder().build();
        assertEquals(Duration.ofMillis(TIMEOUT_MS), options.timeout().connect(), "the connect timeout");
        assertEquals(sdkDefault.read(), options.timeout().read(), "a connected stream reads as long as before");
        assertEquals(sdkDefault.request(), options.timeout().request(), "a request may take as long as before");
    }

    /**
     * Whatever ends a dial, the run's error says which host was not reached.
     * A refused connection shows it in milliseconds, for all three providers.
     * The Anthropic SDK reports only "Request failed" on its own.
     */
    @Test
    void theErrorOfAFailedDialNamesTheHost() throws Exception {
        int closed;
        try (java.net.ServerSocket probe = new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
            closed = probe.getLocalPort();
        }
        String url = "http://127.0.0.1:" + closed;
        for (Map.Entry<String, Function<String, LlmProvider>> entry : providers().entrySet()) {
            Dial dial = dialQuietly(entry.getValue().apply(url));
            assertNotNull(dial.error(), entry.getKey() + " reached a closed port: " + dial.events());
            assertTrue(String.valueOf(dial.error().getMessage()).contains("127.0.0.1:" + closed),
                    entry.getKey() + ": the error does not name the host it could not reach: " + dial.error());
            assertTrue(RetryPolicy.from(2).isTransient(dial.error()),
                    entry.getKey() + ": a failed dial is retried as before: " + dial.error());
        }
    }

    private static Object field(Object owner, String name) throws ReflectiveOperationException {
        java.lang.reflect.Field field = owner.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(owner);
    }

    private Dial dialQuietly(LlmProvider provider) {
        try {
            return dial(provider, new CancelSignal(), HIGHEST_MS + 5_000);
        } catch (Exception failure) {
            throw new IllegalStateException(failure);
        }
    }

    /**
     * The run as a session runs it: the provider wrapped for two retries.
     * Without a stop it ends with an error naming the host after three
     * attempts of about ten seconds each.
     */
    @Test
    void anUnreachableHostEndsTheRunWithAnErrorAfterThreeAttempts() throws Exception {
        String url = handshakeNeverAnswered();
        String host = url.substring("https://".length());
        Path file = temp.resolve("unreachable.llm.jsonl");
        Agent agent = new Agent(AgentOptions.builder()
                .provider(RetryingProvider.wrap(openAi(url), RetryPolicy.from(2)))
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(temp)
                .onPermission(request -> true)
                .compactionThreshold(100_000)
                .llmWire(new LlmWireRecorder(file, 1_000_000))
                .build());
        List<RunEvent> events = new CopyOnWriteArrayList<>();
        long started = System.nanoTime();
        CompletableFuture<Long> ended = new CompletableFuture<>();
        EventStream stream = agent.run("hello", new RunOptions(new CancelSignal(), null));
        cleanup.add(stream::close);
        Thread.ofVirtual().start(() -> {
            for (RunEvent event : stream) {
                events.add(event);
                if (event instanceof RunEvent.RunEnd) {
                    ended.complete(System.nanoTime());
                }
            }
        });
        long budget = 3 * HIGHEST_MS + 2_000;
        Long endedAt;
        try {
            endedAt = ended.get(budget, TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException stillWaiting) {
            endedAt = null;
        }
        long millis = endedAt == null ? -1 : TimeUnit.NANOSECONDS.toMillis(endedAt - started);
        System.out.println("card 557 measured: the run against an unreachable host ended after " + millis + " ms");
        assertTrue(millis > 0, "the run against an unreachable host had no run_end after " + budget + " ms");

        RunEvent.RunEnd end = (RunEvent.RunEnd) events.getLast();
        assertEquals("error", end.stopReason(), "an unreachable host ends the run as an error");
        RunEvent.ErrorEvent error = events.stream().filter(RunEvent.ErrorEvent.class::isInstance)
                .map(RunEvent.ErrorEvent.class::cast).findFirst().orElseThrow();
        assertTrue(error.message().contains(host), "the error does not name the host " + host + ": "
                + error.message());

        List<JsonNode> lines = new ArrayList<>();
        for (String line : Files.readAllLines(file)) {
            lines.add(JSON.readTree(line));
        }
        List<JsonNode> responses = lines.stream().filter(l -> "llm_response".equals(l.path("type").asText()))
                .toList();
        assertEquals(3, lines.stream().filter(l -> "llm_request".equals(l.path("type").asText())).count(),
                "one attempt and two retries, as before the timeout existed");
        for (JsonNode response : responses) {
            long attempt = response.path("durationMs").asLong();
            System.out.println("card 557 measured: one attempt against the unreachable host: " + attempt + " ms");
            assertTrue(attempt >= LOWEST_MS && attempt <= HIGHEST_MS,
                    "an attempt took " + attempt + " ms; the connect timeout is " + TIMEOUT_MS + " ms");
        }
        assertEquals(3, responses.size(), "every attempt is closed on the wire record");
    }

    /**
     * The timeout bounds the connection setup only. A stream that is
     * connected and stays silent for longer than the timeout is still
     * waiting, and the stop is what ends it.
     */
    @Test
    void aConnectedStreamThatStaysSilentIsNotCutByTheConnectTimeout() throws Exception {
        Map<String, CancelSignal> signals = new LinkedHashMap<>();
        Map<String, CompletableFuture<Dial>> dials = new LinkedHashMap<>();
        for (Map.Entry<String, Function<String, LlmProvider>> entry : providers().entrySet()) {
            SilentBackend backend = new SilentBackend(SilentBackend.Mode.ACCEPTING);
            cleanup.add(backend);
            LlmProvider provider = entry.getValue().apply(backend.url("http"));
            CancelSignal signal = new CancelSignal();
            signals.put(entry.getKey(), signal);
            dials.put(entry.getKey(), CompletableFuture.supplyAsync(() -> {
                try {
                    return dial(provider, signal, 60_000);
                } catch (Exception failure) {
                    throw new IllegalStateException(failure);
                }
            }, dialers));
            assertNotNull(backend.awaitConnection(Duration.ofSeconds(10)), entry.getKey() + " never connected");
        }
        Thread.sleep(TIMEOUT_MS + 1_500);
        for (Map.Entry<String, CompletableFuture<Dial>> entry : dials.entrySet()) {
            assertTrue(!entry.getValue().isDone(), entry.getKey() + " cut a connected, silent stream after "
                    + (TIMEOUT_MS + 1_500) + " ms: " + (entry.getValue().isDone() ? entry.getValue().get() : ""));
        }
        signals.values().forEach(CancelSignal::cancel);
        for (Map.Entry<String, CompletableFuture<Dial>> entry : dials.entrySet()) {
            Dial dial = entry.getValue().get(5, TimeUnit.SECONDS);
            assertEquals(List.of(new PStop(PStop.StopReason.ABORTED)), dial.events(),
                    entry.getKey() + ": the stop ends the silent stream");
        }
    }
}
