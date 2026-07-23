package dev.spectroscope.core.trace;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The OTLP exporter port: a registered (never load-bearing) TracingPort that
 *  folds each finished run into OTel GenAI spans and posts them asynchronously.
 *  The HTTP leg sits behind a poster seam, so tests see the exact payload. */
class OtlpSinkTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static RunEvent ev(String json) {
        try {
            return new ObjectMapper().readValue(json, RunEvent.class);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static SpectroConfig config(String otlpEndpoint, String otlpAuth) {
        return new SpectroConfig("anthropic", "m", null, 100000, "ask", List.of(), "gemini",
                false, List.of(), 2, false, List.of(), null, "info", null, null, null,
                otlpEndpoint, otlpAuth);
    }

    @Test
    void offWithoutAnEndpoint() {
        assertTrue(OtlpSink.fromConfig(config(null, null), "s1").isEmpty(), "no endpoint -> no sink");
    }

    @Test
    void onWithAnEndpointAndAuth() {
        Optional<OtlpSink> sink =
                OtlpSink.fromConfig(config("http://localhost:3000/api/public/otel", "pk:sk"), "s1");
        assertTrue(sink.isPresent());
    }

    @Test
    void foldsARunIntoAgentTurnAndToolSpansAndPostsOnRunEnd() throws Exception {
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-1", body -> {
            posted.add(body);
            done.countDown();
        });

        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"do it\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"main\",\"text\":\"hi\",\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"write_file\",\"input\":{\"path\":\"a.txt\"},\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":5,\"ts\":1400}"));
        sink.onEvent(ev("{\"type\":\"usage\",\"agentId\":\"main\",\"inputTokens\":10,\"outputTokens\":4,\"ts\":1450}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS), "the post fires after run_end");
        JsonNode root = mapper.readTree(posted.get(0));
        JsonNode spans = root.path("resourceSpans").get(0).path("scopeSpans").get(0).path("spans");
        assertTrue(spans.isArray() && spans.size() >= 4, "root+agent+turn+tool at least");

        List<String> names = new ArrayList<>();
        spans.forEach(s -> names.add(s.path("name").asText()));
        assertTrue(names.stream().anyMatch(n -> n.contains("write_file")), "tool span: " + names);
        assertTrue(names.stream().anyMatch(n -> n.startsWith("turn 1")), "turn span: " + names);
        assertTrue(names.stream().anyMatch(n -> n.contains("agent")), "agent span: " + names);

        // every span carries the trace + the session attribute
        String traceId = spans.get(0).path("traceId").asText();
        assertEquals(32, traceId.length());
        boolean sessionAttr = false;
        for (JsonNode attrNode : spans.get(0).path("attributes")) {
            if ("langfuse.session.id".equals(attrNode.path("key").asText())) {
                sessionAttr = true;
            }
        }
        assertTrue(sessionAttr, "session id attribute rides along");
    }

    @Test
    void aFailingPosterNeverThrowsIntoTheRun() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        CountDownLatch tried = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://down/api", null, "sess-2", body -> {
            attempts.incrementAndGet();
            tried.countDown();
            throw new RuntimeException("connection refused");
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"x\",\"provider\":\"p\",\"ts\":1}"));
        // must not throw — the port is additive, the run owns the thread
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":2}"));
        assertTrue(tried.await(5, TimeUnit.SECONDS));
        assertEquals(1, attempts.get());
    }

    @Test
    void buildsBasicAuthFromThePair() {
        assertNotNull(OtlpSink.basicAuthHeader("pk:sk"));
        assertEquals("Basic cGs6c2s=", OtlpSink.basicAuthHeader("pk:sk"));
    }
}
