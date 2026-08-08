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
                false, List.of(), 2, false, List.of(), null, "info", null, null, "auto", "auto", null,
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
    void aGatedToolSpanStartsAtExecutionNotAtTheRequest() throws Exception {
        // Card 111: the operator parked the call from ts 1310 to 3310; the tool
        // ran 100 ms. The tool span must cover the EXECUTION (3310..3410) — the
        // gate span keeps the wait — or every Langfuse trace bills the human
        // to the tool.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-gate", body -> {
            posted.add(body);
            done.countDown();
        });

        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"do it\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"run_command\",\"input\":{\"command\":\"ls\"},\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"permission_request\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"run_command\",\"input\":{\"command\":\"ls\"},\"ts\":1310}"));
        sink.onEvent(ev("{\"type\":\"permission_decision\",\"callId\":\"c1\",\"allowed\":true,\"ts\":3310}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":100,\"gateWaitMs\":2000,\"ts\":3410}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":3500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS), "the post fires after run_end");
        JsonNode spans = mapper.readTree(posted.get(0))
                .path("resourceSpans").get(0).path("scopeSpans").get(0).path("spans");

        JsonNode toolSpan = null;
        JsonNode gateSpan = null;
        for (JsonNode s : spans) {
            if ("run_command".equals(s.path("name").asText())) {
                toolSpan = s;
            }
            if (s.path("name").asText().startsWith("gate ·")) {
                gateSpan = s;
            }
        }
        assertNotNull(toolSpan, "tool span exists");
        assertNotNull(gateSpan, "gate span exists");

        // Tool span: execution only — start = result ts − durationMs.
        assertEquals(3310L * 1_000_000L, toolSpan.path("startTimeUnixNano").asLong(),
                "the tool span starts when the tool ran, not when it was requested");
        assertEquals(3410L * 1_000_000L, toolSpan.path("endTimeUnixNano").asLong());
        boolean waitAttr = false;
        for (JsonNode attrNode : toolSpan.path("attributes")) {
            if ("spectroscope.gate.wait_ms".equals(attrNode.path("key").asText())
                    && "2000".equals(attrNode.path("value").path("stringValue").asText())) {
                waitAttr = true;
            }
        }
        assertTrue(waitAttr, "the tool span names its gate wait as an attribute");

        // The gate span keeps the wait: request..decision, untouched.
        assertEquals(1310L * 1_000_000L, gateSpan.path("startTimeUnixNano").asLong());
        assertEquals(3310L * 1_000_000L, gateSpan.path("endTimeUnixNano").asLong());
    }

    @Test
    void anUngatedToolSpanKeepsItsCallToResultShape() throws Exception {
        // Old archives carry no gateWaitMs — their tool spans must render
        // exactly as before the fix (call ts .. result ts), no reinterpretation.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-old", body -> {
            posted.add(body);
            done.countDown();
        });

        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"do it\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"list_dir\",\"input\":{\"path\":\".\"},\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":5,\"ts\":1400}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS), "the post fires after run_end");
        JsonNode spans = mapper.readTree(posted.get(0))
                .path("resourceSpans").get(0).path("scopeSpans").get(0).path("spans");
        JsonNode toolSpan = null;
        for (JsonNode s : spans) {
            if ("list_dir".equals(s.path("name").asText())) {
                toolSpan = s;
            }
        }
        assertNotNull(toolSpan, "tool span exists");
        assertEquals(1300L * 1_000_000L, toolSpan.path("startTimeUnixNano").asLong(),
                "without a recorded gate wait the span keeps its historic shape");
        assertEquals(1400L * 1_000_000L, toolSpan.path("endTimeUnixNano").asLong());
    }

    @Test
    void anExportListenerSeesTheOutcomeAndNeverBreaksTheExport() throws Exception {
        // Card 86: the trace tab mirrors each export as a socket frame. The
        // sink reports endpoint, span count, byte size and ok to a registered
        // listener — and a THROWING listener must never break the exports.
        List<OtlpSink.ExportReport> reports = new ArrayList<>();
        CountDownLatch reported = new CountDownLatch(2);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-l", body -> {
        }).withListener(report -> {
            reports.add(report);
            reported.countDown();
            throw new RuntimeException("mirror broke");
        });

        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"x\",\"provider\":\"p\",\"ts\":1}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":2}"));
        // The throwing listener must not have poisoned the machinery: a second
        // run exports (and reports) again.
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r2\",\"agentId\":\"main\",\"prompt\":\"y\",\"provider\":\"p\",\"ts\":3}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r2\",\"stopReason\":\"end_turn\",\"ts\":4}"));

        assertTrue(reported.await(5, TimeUnit.SECONDS), "both exports report");
        OtlpSink.ExportReport first = reports.get(0);
        assertTrue(first.ok());
        assertEquals("http://x/api/public/otel", first.endpoint());
        assertTrue(first.spans() >= 1, "span count rides along: " + first.spans());
        assertTrue(first.bytes() > 0, "payload size rides along");
        assertTrue(first.message() == null, "no message on success");
        assertTrue(first.toString().indexOf("pk:sk") < 0, "auth never in the report");
        // The owner wants the CONTENT visible in the trace: the report carries
        // the exported body itself (the mirror decides how much rides the wire).
        assertTrue(String.valueOf(first.body()).contains("resourceSpans"),
                "the exported payload rides the report");
    }

    @Test
    void aFailedExportReportsNotOkWithTheMessage() throws Exception {
        List<OtlpSink.ExportReport> reports = new ArrayList<>();
        CountDownLatch reported = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://down/api", null, "sess-f", body -> {
            throw new RuntimeException("HTTP 401 unauthorized");
        }).withListener(report -> {
            reports.add(report);
            reported.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"x\",\"provider\":\"p\",\"ts\":1}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":2}"));
        assertTrue(reported.await(5, TimeUnit.SECONDS));
        assertTrue(!reports.get(0).ok());
        assertTrue(String.valueOf(reports.get(0).message()).contains("401"));
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
    void aWedgedEpochDoesNotFreezeExportForever() throws Exception {
        // Finding 6 (0.3.0 adversarial pass): an uncaught Error can leave a
        // RunStart without its RunEnd, so openRuns never empties again and a
        // REUSED sink silently stops exporting every later prompt. A fresh
        // top-level run must un-wedge it.
        List<String> posted = new ArrayList<>();
        CountDownLatch second = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api", null, "sess-wedge", body -> {
            posted.add(body);
            second.countDown();
        });

        // Epoch 1: a top-level run that NEVER ends (the wedge).
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"first\",\"provider\":\"p\",\"ts\":100}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"main\",\"text\":\"hi\",\"ts\":110}"));

        // Epoch 2: a fresh top-level run (no parentId) that completes cleanly.
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r2\",\"agentId\":\"main\",\"prompt\":\"second\",\"provider\":\"p\",\"ts\":200}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":210}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r2\",\"stopReason\":\"end_turn\",\"ts\":300}"));

        assertTrue(second.await(5, TimeUnit.SECONDS),
                "the second epoch's run_end still exports — the wedge did not freeze the sink");
    }

    @Test
    void buildsBasicAuthFromThePair() {
        assertNotNull(OtlpSink.basicAuthHeader("pk:sk"));
        assertEquals("Basic cGs6c2s=", OtlpSink.basicAuthHeader("pk:sk"));
    }
}
