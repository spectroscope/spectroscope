package dev.spectroscope.core.trace;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
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
                otlpEndpoint, otlpAuth, null, null, null, false, false);
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

    /** Every span in the payload, by name -> its parentSpanId. */
    private java.util.Map<String, String> parentsOf(String body) throws Exception {
        JsonNode spans = mapper.readTree(body).path("resourceSpans").get(0)
                .path("scopeSpans").get(0).path("spans");
        java.util.Map<String, String> byName = new java.util.LinkedHashMap<>();
        spans.forEach(sp -> byName.put(sp.path("name").asText(), sp.path("parentSpanId").asText("")));
        return byName;
    }

    /** Every span in the payload, by name -> its own spanId. */
    private java.util.Map<String, String> idsOf(String body) throws Exception {
        JsonNode spans = mapper.readTree(body).path("resourceSpans").get(0)
                .path("scopeSpans").get(0).path("spans");
        java.util.Map<String, String> byName = new java.util.LinkedHashMap<>();
        spans.forEach(sp -> byName.put(sp.path("name").asText(), sp.path("spanId").asText("")));
        return byName;
    }

    @Test
    void aSpawnedSubagentHangsUnderTheAgentThatSpawnedIt() throws Exception {
        // Card 142: `parentId` is on the wire and the fleet view already draws
        // the real shape from it. The export ignored it and hung EVERY agent off
        // the root, so a subagent came out as its spawner's sibling — the wrong
        // shape, not a small inaccuracy, in any viewer that draws a tree.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-tree", body -> {
            posted.add(body);
            done.countDown();
        });

        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"agent_spawn\",\"agentId\":\"kid\",\"parentId\":\"main\",\"task\":\"look\",\"ts\":1150}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"kid\",\"turn\":1,\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"kid\",\"text\":\"found\",\"ts\":1250}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS));
        List<Span> spans = spansOf(posted.get(0));
        Span kid = spans.stream().filter(s -> s.name().equals("agent · kid")).findFirst().orElseThrow();
        Span main = spans.stream().filter(s -> s.name().equals("agent · main")).findFirst().orElseThrow();
        Span turn = spans.stream().filter(s -> s.name().startsWith("turn 1 · main")).findFirst().orElseThrow();

        // The spawner's span is an ANCESTOR, not necessarily the parent: this
        // spawn happened inside main's open turn, and hanging the subagent one
        // level higher would make it a sibling of the turn that contains it —
        // the overlap the no-overlap criterion forbids. So: inside the turn,
        // and inside main's subtree through it.
        assertEquals(turn.id(), kid.parent(), "the subagent sits in the turn it was spawned from");
        assertEquals(main.id(), turn.parent(), "and that turn belongs to the spawner");
        assertEquals(List.of(), overlappingSiblings(spans), "with no overlapping siblings left");
    }

    @Test
    void aRootAgentStillHangsUnderTheSession() throws Exception {
        // The other half of the same rule: consulting parentId must not orphan
        // the agent that genuinely has no parent.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-root", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS));
        java.util.Map<String, String> parent = parentsOf(posted.get(0));
        java.util.Map<String, String> id = idsOf(posted.get(0));
        String sessionSpan = id.values().iterator().next(); // the root is written first
        assertEquals(sessionSpan, parent.get("agent · main"),
                "a root agent hangs under the session span: " + parent);
    }

    @Test
    void aToolSpanSitsInsideTheTurnThatTriggeredIt() throws Exception {
        // Measured across the stored corpus before this: 176 overlapping sibling
        // pairs, 173 of them full containment. A turn temporally CONTAINS the
        // tools it triggered, so drawing them as siblings puts a child next to
        // its parent with the parent's time range.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-nest", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"write_file\",\"input\":{\"path\":\"a.txt\"},\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":5,\"ts\":1400}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS));
        java.util.Map<String, String> parent = parentsOf(posted.get(0));
        java.util.Map<String, String> id = idsOf(posted.get(0));

        String turnSpan = id.entrySet().stream().filter(e -> e.getKey().startsWith("turn 1"))
                .map(java.util.Map.Entry::getValue).findFirst().orElse("");
        String toolParent = parent.entrySet().stream().filter(e -> e.getKey().contains("write_file"))
                .map(java.util.Map.Entry::getValue).findFirst().orElse("");
        assertNotEquals("", turnSpan, "there is a turn span: " + id.keySet());
        assertEquals(turnSpan, toolParent, "the tool sits inside its turn: " + parent);
    }

    /** One exported span, reduced to what a tree drawing needs. */
    private record Span(String id, String parent, String name, long start, long end) {}

    /** Every span in the payload, in wire order. */
    private List<Span> spansOf(String body) throws Exception {
        JsonNode spans = mapper.readTree(body).path("resourceSpans").get(0)
                .path("scopeSpans").get(0).path("spans");
        List<Span> out = new ArrayList<>();
        spans.forEach(sp -> out.add(new Span(
                sp.path("spanId").asText(),
                sp.path("parentSpanId").asText(""),
                sp.path("name").asText(),
                Long.parseLong(sp.path("startTimeUnixNano").asText()),
                Long.parseLong(sp.path("endTimeUnixNano").asText()))));
        return out;
    }

    /** The same reduction as {@link #spansOf}, callable from a poster lambda
     *  running on an export thread rather than on the test's own. */
    private static List<Span> spansOfStatic(String body) {
        try {
            JsonNode spans = new ObjectMapper().readTree(body).path("resourceSpans").get(0)
                    .path("scopeSpans").get(0).path("spans");
            List<Span> out = new ArrayList<>();
            spans.forEach(sp -> out.add(new Span(
                    sp.path("spanId").asText(),
                    sp.path("parentSpanId").asText(""),
                    sp.path("name").asText(),
                    Long.parseLong(sp.path("startTimeUnixNano").asText()),
                    Long.parseLong(sp.path("endTimeUnixNano").asText()))));
            return out;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** How deep the deepest branch runs; the session span alone counts as 1. */
    private static int depthOf(List<Span> spans) {
        java.util.Map<String, String> parent = new java.util.HashMap<>();
        spans.forEach(s -> parent.put(s.id(), s.parent()));
        int deepest = 0;
        for (Span s : spans) {
            int d = 1;
            String up = s.parent();
            while (up != null && !up.isEmpty() && parent.containsKey(up)) {
                d++;
                up = parent.get(up);
            }
            deepest = Math.max(deepest, d);
        }
        return deepest;
    }

    /** Sibling pairs whose time ranges genuinely intersect, as "a | b" labels.
     *  Touching at an endpoint is not an overlap — a turn ending exactly where
     *  the next begins is the normal shape, not a defect. */
    private static List<String> overlappingSiblings(List<Span> spans) {
        List<String> bad = new ArrayList<>();
        for (int i = 0; i < spans.size(); i++) {
            for (int j = i + 1; j < spans.size(); j++) {
                Span a = spans.get(i);
                Span b = spans.get(j);
                if (!a.parent().equals(b.parent()) || a.parent().isEmpty()) {
                    continue;
                }
                if (a.start() < b.end() && b.start() < a.end()) {
                    bad.add(a.name() + " | " + b.name());
                }
            }
        }
        return bad;
    }

    /** The run every shape test folds: main spawns a subagent from inside a
     *  tool call and waits for it — the shape the stored corpus actually has
     *  (measured: every one of the 17 spawns in the store sits inside an open
     *  tool call of its spawner). */
    private String spawningSession(String sessionId) throws Exception {
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", sessionId, body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"build_plan\",\"input\":{\"task\":\"plan\"},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"agent_spawn\",\"agentId\":\"kid\",\"parentId\":\"main\",\"task\":\"plan it\",\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r2\",\"agentId\":\"kid\",\"parentId\":\"main\",\"prompt\":\"plan it\",\"provider\":\"anthropic\",\"ts\":1201}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"kid\",\"turn\":1,\"ts\":1210}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"kid\",\"callId\":\"c2\",\"name\":\"read_file\",\"input\":{},\"ts\":1220}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"kid\",\"callId\":\"c2\",\"output\":\"ok\",\"isError\":false,\"durationMs\":10,\"ts\":1240}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"kid\",\"text\":\"done\",\"ts\":1250}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r2\",\"stopReason\":\"end_turn\",\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"plan\",\"isError\":false,\"durationMs\":150,\"ts\":1350}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS), "the post fires after the outer run_end");
        return posted.get(0);
    }

    @Test
    void noSiblingPairOverlapsInASessionThatSpawnedASubagent() throws Exception {
        // Card 142, acceptance criterion 2. Two spans that share a parent are
        // drawn side by side, so a pair that overlaps in TIME is a pair the
        // exporter put in the wrong place: one of them belongs inside the other.
        List<Span> spans = spansOf(spawningSession("sess-siblings"));
        assertEquals(List.of(), overlappingSiblings(spans),
                "siblings must not overlap — an overlap names a child drawn beside its parent");
    }

    @Test
    void aSubagentHangsUnderTheToolCallThatSpawnedIt() throws Exception {
        // The spawn happens INSIDE the spawner's open tool call (build_plan
        // here) and the tool does not return until the subagent is finished.
        // Hanging the subagent off the spawner's agent span instead makes it a
        // sibling of the very tool call that is waiting for it.
        List<Span> spans = spansOf(spawningSession("sess-under-tool"));
        Span kid = spans.stream().filter(s -> s.name().equals("agent · kid")).findFirst().orElseThrow();
        Span tool = spans.stream().filter(s -> s.name().equals("build_plan")).findFirst().orElseThrow();
        assertEquals(tool.id(), kid.parent(),
                "the subagent hangs off the tool call that spawned it");
        assertTrue(kid.start() >= tool.start() && kid.end() <= tool.end(),
                "and it lives entirely inside that tool call");
    }

    @Test
    void aSpawnedSubagentMakesTheTreeDeeperThanOne() throws Exception {
        // Card 142, acceptance criterion 1: session > agent > turn > tool >
        // subagent > turn > tool. A flat list would measure 2.
        List<Span> spans = spansOf(spawningSession("sess-depth"));
        assertTrue(depthOf(spans) >= 6, "the exported tree is deep, not flat: depth " + depthOf(spans)
                + " over " + spans.stream().map(Span::name).toList());
    }

    @Test
    void anAgentWhoseOnlyParentEvidenceIsRunStartStillHangsUnderItsParent() throws Exception {
        // Card 142, acceptance criterion 3: the parent must be READ off the
        // wire, from every field that carries it. `parentId` rides on RunStart
        // as well as on AgentSpawn, so a record that lost its spawn event (a
        // truncated or replayed session) must still produce the real shape
        // instead of quietly falling back to the root.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-runstart", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r2\",\"agentId\":\"kid\",\"parentId\":\"main\",\"prompt\":\"sub\",\"provider\":\"anthropic\",\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"kid\",\"text\":\"x\",\"ts\":1250}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r2\",\"stopReason\":\"end_turn\",\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        Span kid = spans.stream().filter(s -> s.name().equals("agent · kid")).findFirst().orElseThrow();
        Span session = spans.get(0);   // the session span is written first
        assertNotEquals(session.id(), kid.parent(),
                "a run that names its parent must not be exported as a root");
    }

    @Test
    void anAgentSpanCoversTheTurnsThatRanInsideIt() throws Exception {
        // 73 turn spans in the store end AFTER the agent span they hang under.
        // The cause: an agent's extent is read off the events carrying its id,
        // and a run_end carries only a RUN id — so the turn a subagent's run_end
        // closes runs past the subagent itself. (A main-agent run_end is spared
        // by accident: an event without an agentId is attributed to "main".)
        // A child drawn outside its parent is the same lie as one drawn beside it.
        List<Span> spans = spansOf(spawningSession("sess-bounds"));
        Span agent = spans.stream().filter(s -> s.name().equals("agent · kid")).findFirst().orElseThrow();
        Span turn = spans.stream().filter(s -> s.name().startsWith("turn 1 · kid")).findFirst().orElseThrow();
        assertTrue(turn.end() <= agent.end(),
                "the turn ends inside its agent: turn " + turn.start() + ".." + turn.end()
                        + " agent " + agent.start() + ".." + agent.end());
    }

    @Test
    void aSessionWithoutAMainAgentDoesNotGetOneInvented() throws Exception {
        // Fallout of the same attribution bug, found by measuring rather than
        // by reading: 230 of the 286 stored sessions contain no event at all
        // for an agent called "main", and every one of them still exported an
        // "agent · main" span — a zero-length node conjured out of the one
        // event that names no agent, the run_end. 225 of 1564 spans were this
        // phantom.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-noMain", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"worker-alpha\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"worker-alpha\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"worker-alpha\",\"text\":\"hi\",\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        assertTrue(spans.stream().noneMatch(s -> s.name().equals("agent · main")),
                "no agent called main ran, so none is exported: "
                        + spans.stream().map(Span::name).toList());
        assertTrue(spans.stream().anyMatch(s -> s.name().equals("agent · worker-alpha")),
                "the agent that did run is there");
    }

    @Test
    void aGateDecisionDoesNotInventTheAgentItNamesNoId() throws Exception {
        // The run_end leak was closed by attributing a run_end through its runId.
        // Two carriers were left open, and measuring the corpus rather than
        // reading the code found them: permission_decision names only a callId,
        // agent_message names from/to. Both fall through agentOf()'s "main"
        // default and open an agent nobody ran. Measured over the 287 stored
        // sessions on 2026-08-11: 5 phantom "agent · main" spans in 5 sessions,
        // each of them also an overlapping sibling of the agent that did run.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-phantom", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"security-1\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"security-1\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"security-1\",\"callId\":\"c1\",\"name\":\"write_file\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"permission_request\",\"agentId\":\"security-1\",\"callId\":\"c1\",\"name\":\"write_file\",\"input\":{},\"ts\":1210}"));
        sink.onEvent(ev("{\"type\":\"permission_decision\",\"callId\":\"c1\",\"allowed\":true,\"ts\":1260}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"security-1\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":40,\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        assertTrue(spans.stream().noneMatch(s -> s.name().equals("agent · main")),
                "a gate decision carries no agentId and must not conjure an agent: "
                        + spans.stream().map(Span::name).toList());
    }

    @Test
    void anAgentMessageDoesNotInventAnAgentEither() throws Exception {
        // The A2A-lite record names from/to rather than agentId, so it takes the
        // same fall. In the stored corpus this is what produced the phantom in
        // 20260723-151500-auth-refactor-three-lenses: ten agent_message events
        // and an "agent · main" span 22 seconds long, in a session whose agents
        // are conductor and three workers.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-a2a", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"conductor\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"conductor\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"agent_message\",\"from\":\"conductor\",\"to\":\"worker-1\",\"role\":\"task\",\"state\":\"submitted\",\"text\":\"look\",\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"agent_message\",\"from\":\"worker-1\",\"to\":\"conductor\",\"role\":\"result\",\"state\":\"completed\",\"text\":\"done\",\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        assertTrue(spans.stream().noneMatch(s -> s.name().equals("agent · main")),
                "an A2A message names from/to, not agentId, and must not conjure an agent: "
                        + spans.stream().map(Span::name).toList());
    }

    @Test
    void toolCallsThatRanAtTheSameTimeStayPeersAndAreAllowedToOverlap() throws Exception {
        // Card 142, AC2 corrected on 2026-08-11. "Zero overlapping sibling pairs
        // across the whole corpus" cannot hold for an orchestrator: the wire
        // records genuinely parallel work. Measured over the 287 stored sessions:
        // 139 tool-call intervals of ONE agent overlap another of the same agent
        // across 16 sessions, peaking at 12 calls open at once — 8 tool_call
        // events on one millisecond, results interleaved. Nesting those to
        // reach a zero would invent a causal order the run never had.
        //
        // So the rule this pins is the narrower true one: peers stay peers, and
        // the export reports the simultaneity instead of hiding it.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-parallel", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"grep\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c2\",\"name\":\"read_file\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":300,\"ts\":1500}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c2\",\"output\":\"ok\",\"isError\":false,\"durationMs\":400,\"ts\":1600}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1700}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        Span grep = spans.stream().filter(s -> s.name().equals("grep")).findFirst().orElseThrow();
        Span read = spans.stream().filter(s -> s.name().equals("read_file")).findFirst().orElseThrow();
        Span turn = spans.stream().filter(s -> s.name().startsWith("turn 1")).findFirst().orElseThrow();

        assertEquals(turn.id(), grep.parent(), "both calls belong to the turn that issued them");
        assertEquals(turn.id(), read.parent(), "and neither is nested under the other");
        assertTrue(grep.start() < read.end() && read.start() < grep.end(),
                "the export keeps the simultaneity the run had: grep " + grep.start() + ".."
                        + grep.end() + " read_file " + read.start() + ".." + read.end());
    }

    @Test
    void anOldRecordsGateSitsInsideTheToolCallItGuarded() throws Exception {
        // Measured over the stored corpus after the parenting fix: 109 of the
        // 260 remaining overlapping sibling pairs are a gate span against the
        // tool span of THE SAME call. In records written before card 111 the
        // tool span covers call..result, so it CONTAINS its own gate — and the
        // two were still exported side by side.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-oldgate", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"write_file\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"permission_request\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"write_file\",\"input\":{},\"ts\":1210}"));
        sink.onEvent(ev("{\"type\":\"permission_decision\",\"callId\":\"c1\",\"allowed\":true,\"ts\":1260}"));
        // no gateWaitMs: the historic shape, tool span = call .. result
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":40,\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        Span gate = spans.stream().filter(s -> s.name().startsWith("gate ·")).findFirst().orElseThrow();
        Span tool = spans.stream().filter(s -> s.name().equals("write_file")).findFirst().orElseThrow();
        assertEquals(tool.id(), gate.parent(), "the gate belongs to the call it guarded");
        assertEquals(List.of(), overlappingSiblings(spans));
    }

    @Test
    void aCard111GateStaysBesideTheExecutionItPrecedes() throws Exception {
        // The other half: once the wire carries gateWaitMs the tool span is the
        // EXECUTION only, so the gate runs before it rather than inside it.
        // Nesting it there would draw a child entirely outside its parent, so
        // the two stay siblings — and, being disjoint, do not overlap.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-newgate", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"run_command\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"permission_request\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"run_command\",\"input\":{},\"ts\":1210}"));
        sink.onEvent(ev("{\"type\":\"permission_decision\",\"callId\":\"c1\",\"allowed\":true,\"ts\":3210}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":100,\"gateWaitMs\":2000,\"ts\":3310}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":3400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        Span gate = spans.stream().filter(s -> s.name().startsWith("gate ·")).findFirst().orElseThrow();
        Span tool = spans.stream().filter(s -> s.name().equals("run_command")).findFirst().orElseThrow();
        assertEquals(tool.parent(), gate.parent(), "wait and execution are two phases of one turn");
        assertEquals(List.of(), overlappingSiblings(spans));
    }

    @Test
    void anImageHangsUnderTheToolCallThatProducedIt() throws Exception {
        // An ImageGenerated names the call it came out of. Exported beside that
        // call it overlaps it (4 pairs in the store); exported inside it, the
        // reader sees which invocation produced the picture.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-img", body -> {
            posted.add(body);
            done.countDown();
        });
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"draw\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"generate_image\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"image_generated\",\"agentId\":\"main\",\"callId\":\"c1\",\"prompt\":\"a cat\",\"provider\":\"openai\",\"model\":\"m\",\"path\":\"a.png\",\"ts\":1250}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"ok\",\"isError\":false,\"durationMs\":100,\"ts\":1300}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1400}"));
        assertTrue(done.await(5, TimeUnit.SECONDS));

        List<Span> spans = spansOf(posted.get(0));
        Span img = spans.stream().filter(s -> s.name().startsWith("image ·")).findFirst().orElseThrow();
        Span tool = spans.stream().filter(s -> s.name().equals("generate_image")).findFirst().orElseThrow();
        assertEquals(tool.id(), img.parent(), "the image hangs under the call that produced it");
    }

    @Test
    void aZeroLengthSpanIsWidenedJustEnoughToBeSeen() throws Exception {
        // Card 142 scope item 4, decided out loud: 33 spans in the stored corpus
        // came out zero-length and drew as invisible bars. A span nobody can see
        // does not report a fast operation — it reports no operation — which is
        // the more misleading of the two available errors. One millisecond is
        // too small to read as a measurement and big enough to have a hit area.
        List<String> posted = new ArrayList<>();
        CountDownLatch done = new CountDownLatch(1);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-zero", body -> {
            posted.add(body);
            done.countDown();
        });
        // call and result on the SAME millisecond: a real shape for a cached read
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"r1\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":1000}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":1100}"));
        sink.onEvent(ev("{\"type\":\"tool_call\",\"agentId\":\"main\",\"callId\":\"c1\",\"name\":\"read_file\",\"input\":{},\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"tool_result\",\"agentId\":\"main\",\"callId\":\"c1\",\"output\":\"x\",\"isError\":false,\"durationMs\":0,\"ts\":1200}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"r1\",\"stopReason\":\"end_turn\",\"ts\":1500}"));

        assertTrue(done.await(5, TimeUnit.SECONDS));
        JsonNode spans = mapper.readTree(posted.get(0)).path("resourceSpans").get(0)
                .path("scopeSpans").get(0).path("spans");
        boolean checked = false;
        for (JsonNode sp : spans) {
            if (!sp.path("name").asText().contains("read_file")) {
                continue;
            }
            long start = Long.parseLong(sp.path("startTimeUnixNano").asText());
            long end = Long.parseLong(sp.path("endTimeUnixNano").asText());
            assertTrue(end > start, "a zero-length span is widened, not left invisible");
            assertEquals(1_000_000L, end - start, "widened by exactly one millisecond, no more");
            checked = true;
        }
        assertTrue(checked, "the tool span is in the payload at all");
    }

    // ---- card 75: the exports are serialized ------------------------------

    /** One finished prompt on a reused sink: run start, one turn, run end.
     *  Each call leaves no run open, so it is exactly one idle point — one
     *  cumulative snapshot handed to the poster. */
    private static void prompt(OtlpSink sink, String runId, long start, long end) {
        sink.onEvent(ev("{\"type\":\"run_start\",\"runId\":\"" + runId
                + "\",\"agentId\":\"main\",\"prompt\":\"go\",\"provider\":\"anthropic\",\"ts\":" + start + "}"));
        sink.onEvent(ev("{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":" + (start + 100) + "}"));
        sink.onEvent(ev("{\"type\":\"text_delta\",\"agentId\":\"main\",\"text\":\"x\",\"ts\":" + (start + 200) + "}"));
        sink.onEvent(ev("{\"type\":\"run_end\",\"runId\":\"" + runId
                + "\",\"stopReason\":\"end_turn\",\"ts\":" + end + "}"));
    }

    /** Child spans that outlive the parent they hang under, as readable labels.
     *  This is what a viewer draws as a parent ending before its own children. */
    private static List<String> childrenOutlivingTheirParent(Map<String, Span> committed) {
        List<String> bad = new ArrayList<>();
        for (Span child : committed.values()) {
            Span parent = committed.get(child.parent());
            if (parent != null && child.end() > parent.end()) {
                bad.add(child.name() + " ends " + child.end() + " > " + parent.name()
                        + " ends " + parent.end());
            }
        }
        return bad;
    }

    @Test
    void aReorderedExportCannotRegressTheParentSpan() throws Exception {
        // Card 75, the whole point. Span ids are deterministic, so every backend
        // (Langfuse, Jaeger, Phoenix) UPSERTS a re-exported span: last write
        // wins. Two cumulative snapshots in flight at once are two independent
        // HTTP/1.1 requests with no ordering guarantee, so the older one can
        // land last and drag the root and agent spans' end times back below the
        // turn spans the newer snapshot already committed.
        //
        // The poster below makes that race deterministic instead of hoping for
        // it: it delays the FIRST post, so unless the sink serializes, the two
        // export threads finish in reverse order.
        Map<String, Span> committed = Collections.synchronizedMap(new LinkedHashMap<>());
        List<String> commitOrder = Collections.synchronizedList(new ArrayList<>());
        AtomicInteger posts = new AtomicInteger();
        CountDownLatch bothCommitted = new CountDownLatch(2);
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-reorder", body -> {
            if (posts.incrementAndGet() == 1) {
                Thread.sleep(400);   // the slow leg — the older snapshot lands late
            }
            List<Span> batch = spansOfStatic(body);
            batch.forEach(s -> committed.put(s.id(), s));
            commitOrder.add("root ends " + batch.get(0).end());
            bothCommitted.countDown();
        });

        prompt(sink, "r1", 1000, 2000);   // prompt K
        prompt(sink, "r2", 3000, 4000);   // prompt K+1

        assertTrue(bothCommitted.await(10, TimeUnit.SECONDS), "both snapshots reach the backend");
        assertEquals(List.of(), childrenOutlivingTheirParent(committed),
                "the newest snapshot is the last one committed; commit order was " + commitOrder);
    }

    @Test
    void atMostOnePostIsEverInFlight() throws Exception {
        // The ordering property above is bought by a bound: one POST at a time.
        // This drives twelve idle points back to back against a poster that
        // holds the wire for 20 ms and counts how many callers are inside it at
        // once — a genuine race between the export threads, not a choreography.
        AtomicInteger live = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        List<String> bodies = Collections.synchronizedList(new ArrayList<>());
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-inflight", body -> {
            peak.accumulateAndGet(live.incrementAndGet(), Math::max);
            try {
                Thread.sleep(20);
                bodies.add(body);
            } finally {
                live.decrementAndGet();
            }
        });

        for (int i = 1; i <= 12; i++) {
            prompt(sink, "r" + i, i * 1000L, i * 1000L + 900);
        }

        // The newest snapshot must reach the wire whatever gets coalesced on the
        // way, so waiting for it is also the final-flush check.
        long deadline = System.currentTimeMillis() + 15_000;
        while (System.currentTimeMillis() < deadline && turnsInLastBody(bodies) < 12) {
            Thread.sleep(20);
        }
        assertEquals(12, turnsInLastBody(bodies),
                "the newest snapshot went out: " + bodies.size() + " posts");
        assertEquals(1, peak.get(), "at most one POST is ever in flight");
    }

    /** How many turn spans the last posted body carries. Twelve prompts on one
     *  reused sink accumulate twelve turns, so this counts up to the newest
     *  cumulative snapshot and no further. */
    private static int turnsInLastBody(List<String> bodies) {
        if (bodies.isEmpty()) {
            return 0;
        }
        return (int) spansOfStatic(bodies.get(bodies.size() - 1)).stream()
                .filter(s -> s.name().startsWith("turn ")).count();
    }

    @Test
    void aSnapshotHeldWhileAPostWasInFlightStillGoesOut() throws Exception {
        // The final-flush half of single-flight: snapshots that arrive while the
        // wire is busy are held, and the newest of them must still be posted
        // once the in-flight one completes. Losing it would trade a reordering
        // bug for a missing-export bug.
        CountDownLatch firstEntered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        List<String> bodies = Collections.synchronizedList(new ArrayList<>());
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-flush", body -> {
            bodies.add(body);
            if (bodies.size() == 1) {
                firstEntered.countDown();
                release.await(10, TimeUnit.SECONDS);
            }
        });

        prompt(sink, "r1", 1000, 2000);
        assertTrue(firstEntered.await(5, TimeUnit.SECONDS), "the first post is in flight");

        prompt(sink, "r2", 3000, 4000);
        prompt(sink, "r3", 5000, 6000);
        Thread.sleep(500);   // long enough for an unserialized sink to have posted both
        assertEquals(1, bodies.size(),
                "nothing else goes out while a POST is in flight: " + bodies.size() + " posts");

        release.countDown();
        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && bodies.size() < 2) {
            Thread.sleep(20);
        }
        assertEquals(2, bodies.size(), "the two held snapshots coalesce into one further post");
        List<String> names = spansOfStatic(bodies.get(1)).stream().map(Span::name).toList();
        assertTrue(names.contains("turn 1 · main") && names.stream()
                        .filter(n -> n.startsWith("turn ")).count() == 3,
                "and the one that goes out is the NEWEST snapshot: " + names);
    }

    @Test
    void anErrorOnTheWireStrandsNeitherTheHeldSnapshotNorLaterExports() throws Exception {
        // Single-flight buys the ordering with one flag deciding whether
        // anything may go out at all, and that is a new place to get wedged: an
        // export thread killed by an ERROR rather than an Exception (OOM,
        // StackOverflow — the class of failure that froze openRuns in card 73)
        // leaves the flag set and silently ends exporting on a sink that lives
        // as long as the connection. Before serialization each export was its
        // own detached thread and one dying cost exactly that one snapshot, so
        // this regression would be introduced BY the fix.
        //
        // Two things have to survive it, and only the stronger one distinguishes
        // a real fix from merely unlocking the wire again: the snapshot already
        // held behind the dying post must still be exported, not dropped.
        AtomicInteger entered = new AtomicInteger();
        CountDownLatch firstEntered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        List<String> posted = Collections.synchronizedList(new ArrayList<>());
        OtlpSink sink = new OtlpSink("http://x/api/public/otel", "pk:sk", "sess-error", body -> {
            if (entered.incrementAndGet() == 1) {
                firstEntered.countDown();
                release.await(10, TimeUnit.SECONDS);
                throw new StackOverflowError("the wire blew up");
            }
            posted.add(body);
        });

        prompt(sink, "r1", 1000, 2000);
        assertTrue(firstEntered.await(5, TimeUnit.SECONDS), "the doomed post is in flight");
        prompt(sink, "r2", 3000, 4000);   // held behind it
        release.countDown();

        long deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && posted.isEmpty()) {
            Thread.sleep(20);
        }
        assertEquals(1, posted.size(), "the held snapshot survives the Error that killed the post");
        assertEquals(2, spansOfStatic(posted.get(0)).stream()
                        .filter(s -> s.name().startsWith("turn ")).count(),
                "and it is the newest snapshot, both prompts folded in");

        prompt(sink, "r3", 5000, 6000);
        deadline = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < deadline && posted.size() < 2) {
            Thread.sleep(20);
        }
        assertEquals(2, posted.size(), "and the wire is not wedged shut for later prompts");
    }
}
