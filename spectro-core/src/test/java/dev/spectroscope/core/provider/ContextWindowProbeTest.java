package dev.spectroscope.core.provider;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 263 on the WIRE: what {@code contextWindow()} actually does against a
 * server, per provider — the {@code ReasoningWireTest} pattern.
 *
 * <p>Why this file exists at all. The first pass pinned the pure parsers
 * ({@code loadedWindow}) and the pure derivation, and nothing else: replacing
 * the body of {@code contextWindow()} in BOTH real providers with
 * {@code return 0;} left the whole core suite green — 1,565 tests, 0 failures,
 * with the feature disconnected for both backends the card is about. Everything
 * between the parser and the run — which URL is dialled, that a positive answer
 * is memoized, that a negative one is not, that the key rides along — was
 * measured by no test. This one counts the server's hits, so "asked once" and
 * "asked again" are observations rather than claims about a double.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class ContextWindowProbeTest {

    /** The listing shape read off the owner's LM Studio on 2026-08-18, trimmed
     *  to the fields the parser reads. Note the two numbers: the instance was
     *  LOADED with 204,288 while the model COULD hold 1,048,576. */
    private static final String LM_STUDIO_LOADED = """
            {"models":[
              {"key":"deepseek-v4-flash","max_context_length":1048576,
               "loaded_instances":[{"id":"deepseek-v4-flash","config":{"context_length":204288}}]}
            ]}""";

    /** The same endpoint with the model installed and nothing loaded — the state
     *  every fresh session starts in on a just-in-time backend. */
    private static final String LM_STUDIO_IDLE = """
            {"models":[
              {"key":"deepseek-v4-flash","max_context_length":1048576,"loaded_instances":[]}
            ]}""";

    /** What an endpoint without that route answers — LM Studio's own words for
     *  a path it does not serve, and the shape api.openai.com answers too. */
    private static final String LM_STUDIO_NO_SUCH_ROUTE =
            "{\"error\":\"Unexpected endpoint or method.\"}";

    /** ollama 0.24.0 with qwen2.5:3b loaded, measured on this machine. */
    private static final String OLLAMA_RUNNING = """
            {"models":[{"name":"qwen2.5:3b","model":"qwen2.5:3b","context_length":32768}]}""";

    /** ollama with nothing loaded — what /api/ps answers before the first chat. */
    private static final String OLLAMA_IDLE = """
            {"models":[]}""";

    /**
     * One scripted endpoint: it counts every hit, records the paths and the
     * Authorization headers it saw, and answers whatever the test set last.
     */
    private static final class ScriptedServer {
        private final HttpServer server;
        private final AtomicInteger hits = new AtomicInteger();
        private final List<String> paths = new CopyOnWriteArrayList<>();
        private final List<String> authorizations = new CopyOnWriteArrayList<>();
        private final AtomicReference<String> body = new AtomicReference<>("{}");
        private final AtomicInteger status = new AtomicInteger(200);

        ScriptedServer() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", this::answer);
            server.start();
        }

        private void answer(HttpExchange exchange) throws IOException {
            hits.incrementAndGet();
            paths.add(exchange.getRequestURI().getPath());
            String auth = exchange.getRequestHeaders().getFirst("Authorization");
            authorizations.add(auth == null ? "<none>" : auth);
            byte[] payload = body.get().getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status.get(), payload.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(payload);
            }
        }

        void answers(int code, String payload) {
            status.set(code);
            body.set(payload);
        }

        String baseUrl() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        void stop() {
            server.stop(0);
        }
    }

    // ---- LM Studio's own REST listing, under /api/v1/models ----------------

    @Nested
    class LmStudio {

        private ScriptedServer server;

        @BeforeEach
        void start() throws IOException {
            server = new ScriptedServer();
        }

        @AfterEach
        void stop() {
            server.stop();
        }

        private OpenAiCompatProvider provider(String apiKey) {
            return new OpenAiCompatProvider(new OpenAiCompatProvider.Options(
                    server.baseUrl() + "/v1", "deepseek-v4-flash", apiKey));
        }

        @Test
        void theLoadedWindowIsReadOffLmStudiosOwnListing() {
            server.answers(200, LM_STUDIO_LOADED);

            assertEquals(204_288, provider(null).contextWindow(),
                    "the LOADED instance's window, not the model's 1,048,576 ceiling");
            assertEquals(List.of("/api/v1/models"), server.paths,
                    "the compatible /v1/models listing carries ids and nothing else");
        }

        @Test
        void aPositiveAnswerIsRememberedAndTheServerIsNotAskedTwice() {
            server.answers(200, LM_STUDIO_LOADED);
            OpenAiCompatProvider provider = provider(null);

            assertEquals(204_288, provider.contextWindow());
            assertEquals(204_288, provider.contextWindow());
            assertEquals(204_288, provider.contextWindow());

            assertEquals(1, server.hits.get(),
                    "the non-functional criterion: one lookup, memoized");
        }

        @Test
        void anIdleBackendTeachesNothingYetAndIsAskedAgainNextRun() {
            // The card's decision 4, and the reason it is a decision: LM Studio
            // loads on demand, so a first probe before the first turn can
            // legitimately find nothing. Freezing that into "unknowable" would
            // deny the truth to every later run of the session.
            server.answers(200, LM_STUDIO_IDLE);
            OpenAiCompatProvider provider = provider(null);

            assertEquals(0, provider.contextWindow());
            server.answers(200, LM_STUDIO_LOADED);
            assertEquals(204_288, provider.contextWindow(), "the second run gets the truth");
            assertEquals(2, server.hits.get());
        }

        @Test
        void anEndpointThatDeniesTheRouteIsNeverAskedAgain() {
            // Review finding: only positive answers were remembered, so every
            // endpoint that structurally CANNOT answer — api.openai.com,
            // openrouter, llama.cpp's server, vLLM, the gemini gateway — was
            // re-probed on every run for the life of the session, and on every
            // child run too. A 404 is not a just-in-time state: it is the server
            // saying it has no such route, and that answer does not expire.
            server.answers(404, LM_STUDIO_NO_SUCH_ROUTE);
            OpenAiCompatProvider provider = provider(null);

            assertEquals(0, provider.contextWindow());
            assertEquals(0, provider.contextWindow());
            assertEquals(0, provider.contextWindow());

            assertEquals(1, server.hits.get(),
                    "a definitive no is remembered exactly like a yes");
        }

        @Test
        void aServerHavingABadDayIsAskedAgain() {
            // The other half of the same rule: a 500 says nothing about whether
            // the route exists, so it must NOT be frozen into a verdict.
            server.answers(500, "{}");
            OpenAiCompatProvider provider = provider(null);

            assertEquals(0, provider.contextWindow());
            server.answers(200, LM_STUDIO_LOADED);
            assertEquals(204_288, provider.contextWindow());
            assertEquals(2, server.hits.get());
        }

        @Test
        void theProbeCarriesTheSameKeyTheChatWireCarries() {
            // Review finding: the capability client was built from a bare
            // RestClient.builder() while the chat client got the Bearer header,
            // so LM Studio with its API-key setting on, a vLLM started with
            // --api-key or a LiteLLM proxy answered 401 — swallowed by the
            // blanket catch, landing the run on the fallback with nothing said.
            server.answers(200, LM_STUDIO_LOADED);

            assertEquals(204_288, provider("sk-local-123").contextWindow());
            assertEquals(List.of("Bearer sk-local-123"), server.authorizations);
        }

        @Test
        void withoutAKeyNoAuthorizationHeaderIsInvented() {
            server.answers(200, LM_STUDIO_LOADED);

            provider(null).contextWindow();

            assertEquals(List.of("<none>"), server.authorizations);
        }
    }

    // ---- ollama's /api/ps -------------------------------------------------

    @Nested
    class Ollama {

        private ScriptedServer server;

        @BeforeEach
        void start() throws IOException {
            server = new ScriptedServer();
        }

        @AfterEach
        void stop() {
            server.stop();
        }

        private OllamaProvider provider() {
            return new OllamaProvider(new OllamaOptions(server.baseUrl(), "qwen2.5:3b"));
        }

        @Test
        void theRunningWindowIsReadOffApiPs() {
            server.answers(200, OLLAMA_RUNNING);

            assertEquals(32_768, provider().contextWindow());
            assertEquals(List.of("/api/ps"), server.paths,
                    "/api/show would answer the TRAINED window, not the loaded one");
        }

        @Test
        void aPositiveAnswerIsRememberedAndTheServerIsNotAskedTwice() {
            server.answers(200, OLLAMA_RUNNING);
            OllamaProvider provider = provider();

            assertEquals(32_768, provider.contextWindow());
            assertEquals(32_768, provider.contextWindow());

            assertEquals(1, server.hits.get());
        }

        @Test
        void nothingRunningYetIsAskedAgainAfterTheFirstChatLoadsTheModel() {
            server.answers(200, OLLAMA_IDLE);
            OllamaProvider provider = provider();

            assertEquals(0, provider.contextWindow());
            server.answers(200, OLLAMA_RUNNING);
            assertEquals(32_768, provider.contextWindow());
            assertEquals(2, server.hits.get());
        }

        @Test
        void anEndpointThatDeniesTheRouteIsNeverAskedAgain() {
            // An ollama old enough to have no /api/ps, or anything else wearing
            // the ollama options. Same rule as the compatible provider.
            server.answers(404, "404 page not found");
            OllamaProvider provider = provider();

            assertEquals(0, provider.contextWindow());
            assertEquals(0, provider.contextWindow());

            assertEquals(1, server.hits.get());
        }

        @Test
        void aServerHavingABadDayIsAskedAgain() {
            server.answers(503, "{}");
            OllamaProvider provider = provider();

            assertEquals(0, provider.contextWindow());
            server.answers(200, OLLAMA_RUNNING);
            assertEquals(32_768, provider.contextWindow());
            assertEquals(2, server.hits.get());
        }

        @Test
        void aBodyThatIsNotJsonAtAllIsSurvived() {
            // The probe path rests on a blanket catch; this is the case that
            // proves the catch is really there rather than assumed. A proxy's
            // HTML error page is the realistic shape of it.
            server.answers(200, "<html><body>gateway</body></html>");

            assertEquals(0, provider().contextWindow());
        }
    }
}
