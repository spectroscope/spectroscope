package dev.spectroscope.core.trace;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The OTel exporter port (KONZEPT §4.3's "later an OTel exporter", now real):
 * a REGISTERED — never load-bearing — {@link TracingPort} that folds the
 * session's events into OTel GenAI spans and posts them to an OTLP/HTTP
 * traces endpoint (Langfuse's {@code /api/public/otel}, Jaeger, Phoenix …).
 *
 * <p>Contract kept deliberately additive, like the fleet mirror: the JSONL
 * file is the durability anchor; this port buffers events and exports at the
 * session's idle points (every run_end that leaves no run open), on a virtual
 * thread, warn-once on failure — a dead backend never slows or fails a run.
 * Span/trace ids are deterministic (sha256 of session/run/call seeds), so a
 * re-export upserts instead of duplicating.</p>
 *
 * <p>Semconv: both {@code langfuse.observation.type} (Langfuse's priority
 * registry) and {@code gen_ai.operation.name} (OpenLLMetry-style consumers)
 * ride on every span — agents as {@code invoke_agent}, turns as {@code chat}
 * GENERATIONs with {@code gen_ai.usage.*}, tools as {@code execute_tool},
 * gates as spans (WARNING when denied).</p>
 */
public final class OtlpSink implements TracingPort {

    private static final Logger log = LoggerFactory.getLogger(OtlpSink.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int MAX_BUFFER = 20_000;   // events; beyond = warn once, stop buffering
    private static final int CUT = 4000;            // attribute payload bound

    /** The HTTP leg as a seam — tests inject a capture, production posts. */
    interface Poster {
        void post(String body) throws Exception;
    }

    /** One reachability probe against (endpoint, pk:sk) — the doctor's seam. */
    public interface Prober {
        /**
         * @param endpoint  the OTLP base or full traces URL
         * @param basicAuth the {@code pk:sk} pair, or null
         * @throws Exception when unreachable or rejected
         */
        void probe(String endpoint, String basicAuth) throws Exception;
    }

    /** Probe an endpoint by posting an EMPTY resourceSpans batch — valid OTLP,
     *  ingests nothing; success means auth + reachability are real.
     *  @param endpoint  the OTLP base or full traces URL
     *  @param basicAuth the {@code pk:sk} pair, or null
     *  @throws Exception when unreachable or rejected */
    public static void probe(String endpoint, String basicAuth) throws Exception {
        new OtlpSink(endpoint.trim(), basicAuth, "probe", null)
                .httpPost("{\"resourceSpans\":[]}");
    }

    private final String endpoint;
    private final String authHeader;   // full header value or null
    private final String sessionId;
    private final Poster poster;
    private final List<RunEvent> buffer = new ArrayList<>();
    private final Set<String> openRuns = new HashSet<>();
    private final AtomicBoolean warned = new AtomicBoolean(false);
    private final AtomicBoolean overflowWarned = new AtomicBoolean(false);
    private final AtomicBoolean wedgeWarned = new AtomicBoolean(false);

    /**
     * Build the sink when (and only when) the config carries an endpoint.
     *
     * @param config    the resolved config ({@code otlpEndpoint} decides)
     * @param sessionId the session the spans belong to (the trace seed)
     * @return the sink, or empty when the exporter is off
     */
    public static Optional<OtlpSink> fromConfig(SpectroConfig config, String sessionId) {
        String endpoint = config.otlpEndpoint();
        if (endpoint == null || endpoint.isBlank()) {
            return Optional.empty();
        }
        return Optional.of(new OtlpSink(endpoint.trim(), config.otlpBasicAuth(), sessionId, null));
    }

    /**
     * Seam constructor (tests pass a poster; production passes null for HTTP).
     *
     * @param endpoint  the OTLP base ({@code …/api/public/otel}) or full traces URL
     * @param basicAuth optional {@code pk:sk} pair for Basic auth, or null
     * @param sessionId the session id — trace seed + Langfuse session attribute
     * @param poster    the HTTP seam; null wires the real client
     */
    OtlpSink(String endpoint, String basicAuth, String sessionId, Poster poster) {
        this.endpoint = Objects.requireNonNull(endpoint, "endpoint");
        this.authHeader = basicAuthHeader(basicAuth);
        this.sessionId = Objects.requireNonNull(sessionId, "sessionId");
        this.poster = poster != null ? poster : this::httpPost;
    }

    /** The Basic header for a {@code pk:sk} pair; null in, null out.
     *  @param pair the {@code public:secret} pair, or null
     *  @return the full header value, or null */
    static String basicAuthHeader(String pair) {
        if (pair == null || pair.isBlank()) {
            return null;
        }
        return "Basic " + Base64.getEncoder().encodeToString(pair.getBytes(StandardCharsets.UTF_8));
    }

    @Override
    public void onEvent(RunEvent event) {
        try {
            // A fresh top-level run (no parent) arriving while runs are still open
            // means a previous epoch never closed: an uncaught Error (OOM,
            // StackOverflow) can leave a RunStart without its RunEnd, and because
            // one sink is reused across a whole connection, openRuns would stay
            // non-empty forever and silently freeze every later prompt's export.
            // Flush the wedged epoch's best effort and reset so exports resume.
            if (event instanceof RunEvent.RunStart fresh
                    && fresh.parentId() == null && !openRuns.isEmpty()) {
                if (wedgeWarned.compareAndSet(false, true)) {
                    log.warn("otlp: session {} began a new run with {} still open — a prior run "
                            + "ended without a run_end; exporting best-effort and resetting",
                            sessionId, openRuns.size());
                }
                exportSnapshot();
                openRuns.clear();
            }
            if (buffer.size() >= MAX_BUFFER) {
                if (overflowWarned.compareAndSet(false, true)) {
                    log.warn("otlp: session {} exceeded {} buffered events — export stops growing",
                            sessionId, MAX_BUFFER);
                }
                return;
            }
            buffer.add(event);
            if (event instanceof RunEvent.RunStart start) {
                openRuns.add(start.runId());
            } else if (event instanceof RunEvent.RunEnd end) {
                openRuns.remove(end.runId());
                if (openRuns.isEmpty()) {
                    exportSnapshot();
                }
            }
        } catch (RuntimeException never) {
            // A port must not throw into the drain loop — belt and braces.
            if (warned.compareAndSet(false, true)) {
                log.warn("otlp: fold failed ({}) — export disabled for this session",
                        never.getMessage());
            }
        }
    }

    /** Fold the buffer-so-far and post it on a virtual thread — the one export
     *  path, shared by the clean idle point and the wedge recovery. The snapshot
     *  is copied on THIS thread before the VT starts, so the VT owns immutable
     *  state; a failed post warns once and never touches the run. */
    private void exportSnapshot() {
        String body = buildPayload(new ArrayList<>(buffer));
        Thread.startVirtualThread(() -> {
            try {
                poster.post(body);
            } catch (Exception failed) {
                if (warned.compareAndSet(false, true)) {
                    log.warn("otlp: export to {} failed ({}) — runs continue, further "
                            + "failures stay quiet", endpoint, failed.getMessage());
                }
            }
        });
    }

    // ---- the fold: the whole session so far -> spans (deterministic ids) ----

    private String buildPayload(List<RunEvent> events) {
        ObjectNode root = JSON.createObjectNode();
        ArrayNode resourceSpans = root.putArray("resourceSpans");
        ObjectNode rs = resourceSpans.addObject();
        ArrayNode resAttrs = rs.putObject("resource").putArray("attributes");
        addAttr(resAttrs, "service.name", "spectroscope");
        addAttr(resAttrs, "deployment.environment.name", "spectro-local");
        ObjectNode scopeSpans = rs.putArray("scopeSpans").addObject();
        scopeSpans.putObject("scope").put("name", "spectroscope-otlp").put("version", "0.1");
        ArrayNode spans = scopeSpans.putArray("spans");

        String traceId = id("trace:" + sessionId, 16);

        long t0 = Long.MAX_VALUE;
        long t1 = Long.MIN_VALUE;
        for (RunEvent e : events) {
            long ts = tsOf(e);
            if (ts > 0) {
                t0 = Math.min(t0, ts);
                t1 = Math.max(t1, ts);
            }
        }
        if (t0 == Long.MAX_VALUE) {
            t0 = 0;
            t1 = 0;
        }

        String firstPrompt = "";
        Map<String, String> provider = new HashMap<>();
        Map<String, long[]> agentBounds = new LinkedHashMap<>();
        for (RunEvent e : events) {
            String aid = agentOf(e);
            long ts = tsOf(e);
            if (e instanceof RunEvent.RunStart s) {
                if (firstPrompt.isEmpty()) {
                    firstPrompt = s.prompt() == null ? "" : s.prompt();
                }
                if (s.provider() != null) {
                    provider.put(aid, s.provider());
                }
            }
            if (aid != null && ts > 0) {
                agentBounds.computeIfAbsent(aid, k -> new long[]{ts, ts});
                long[] b = agentBounds.get(aid);
                b[0] = Math.min(b[0], ts);
                b[1] = Math.max(b[1], ts);
            }
        }

        String rootSpan = id("root:" + sessionId, 8);
        span(spans, traceId, rootSpan, null,
                firstPrompt.isEmpty() ? "session " + sessionId : cut(firstPrompt, 80), t0, t1,
                Map.of("langfuse.observation.type", "agent",
                        "gen_ai.operation.name", "invoke_agent",
                        "langfuse.session.id", sessionId,
                        "langfuse.observation.input", cut(firstPrompt, CUT)), false, null);

        Map<String, String> agentSpan = new HashMap<>();
        for (String aid : agentBounds.keySet()) {
            String sid = id("agent:" + sessionId + ":" + aid, 8);
            agentSpan.put(aid, sid);
            Map<String, String> attrs = new LinkedHashMap<>();
            attrs.put("langfuse.observation.type", "agent");
            attrs.put("gen_ai.operation.name", "invoke_agent");
            attrs.put("langfuse.session.id", sessionId);
            if (provider.containsKey(aid)) {
                attrs.put("gen_ai.system", provider.get(aid));
            }
            long[] b = agentBounds.get(aid);
            span(spans, traceId, sid, rootSpan, "agent · " + aid, b[0], b[1], attrs, false, null);
        }

        // turns, tools, gates, images
        Map<String, Integer> turnSeq = new HashMap<>();
        Map<String, Long> turnStart = new HashMap<>();
        Map<String, StringBuilder> turnText = new HashMap<>();
        Map<String, int[]> turnUsage = new HashMap<>();
        Map<String, Object[]> openTools = new HashMap<>();  // callId -> [aid, name, start, input]
        Map<String, Object[]> openGates = new HashMap<>();
        Map<String, String> runOwner = new HashMap<>();

        for (RunEvent e : events) {
            String aid = agentOf(e);
            long ts = tsOf(e);
            if (e instanceof RunEvent.RunStart s) {
                runOwner.put(s.runId(), aid);
            } else if (e instanceof RunEvent.TurnStart) {
                closeTurn(spans, traceId, agentSpan, turnSeq, turnStart, turnText, turnUsage,
                        provider, aid, ts);
                turnStart.put(aid, ts);
            } else if (e instanceof RunEvent.TextDelta d) {
                turnText.computeIfAbsent(aid, k -> new StringBuilder()).append(d.text());
            } else if (e instanceof RunEvent.Usage u) {
                turnUsage.put(aid, new int[]{u.inputTokens(), u.outputTokens()});
            } else if (e instanceof RunEvent.ToolCall c) {
                openTools.put(c.callId(), new Object[]{aid, c.name(), ts, compact(c.input())});
            } else if (e instanceof RunEvent.ToolResult r) {
                Object[] open = openTools.remove(r.callId());
                if (open != null) {
                    Map<String, String> attrs = new LinkedHashMap<>();
                    attrs.put("langfuse.observation.type", "tool");
                    attrs.put("gen_ai.operation.name", "execute_tool");
                    attrs.put("gen_ai.tool.name", (String) open[1]);
                    attrs.put("langfuse.session.id", sessionId);
                    attrs.put("langfuse.observation.input", cut((String) open[3], CUT));
                    attrs.put("langfuse.observation.output", cut(r.output(), CUT));
                    if (r.isError()) {
                        attrs.put("langfuse.observation.level", "ERROR");
                    }
                    span(spans, traceId, id("tool:" + sessionId + ":" + r.callId(), 8),
                            agentSpan.getOrDefault(open[0], rootSpan), (String) open[1],
                            (long) open[2], ts, attrs, r.isError(),
                            r.isError() ? cut(r.output(), 300) : null);
                }
            } else if (e instanceof RunEvent.PermissionRequest p) {
                openGates.put(p.callId(), new Object[]{aid, p.name(), ts});
            } else if (e instanceof RunEvent.PermissionDecision d) {
                Object[] open = openGates.remove(d.callId());
                if (open != null) {
                    Map<String, String> attrs = new LinkedHashMap<>();
                    attrs.put("langfuse.observation.type", "span");
                    attrs.put("langfuse.session.id", sessionId);
                    attrs.put("spectroscope.gate.allowed", String.valueOf(d.allowed()));
                    if (!d.allowed()) {
                        attrs.put("langfuse.observation.level", "WARNING");
                    }
                    span(spans, traceId, id("gate:" + sessionId + ":" + d.callId(), 8),
                            agentSpan.getOrDefault(open[0], rootSpan), "gate · " + open[1],
                            (long) open[2], ts, attrs, false, null);
                }
            } else if (e instanceof RunEvent.ImageGenerated img) {
                Map<String, String> attrs = new LinkedHashMap<>();
                attrs.put("langfuse.observation.type", "span");
                attrs.put("langfuse.session.id", sessionId);
                attrs.put("gen_ai.request.model", img.model() == null ? "" : img.model());
                attrs.put("langfuse.observation.input", cut(img.prompt(), CUT));
                span(spans, traceId, id("img:" + sessionId + ":" + img.callId(), 8),
                        agentSpan.getOrDefault(aid, rootSpan), "image · " + img.provider(),
                        ts, ts, attrs, false, null);
            } else if (e instanceof RunEvent.RunEnd end) {
                String owner = runOwner.getOrDefault(end.runId(), "main");
                closeTurn(spans, traceId, agentSpan, turnSeq, turnStart, turnText, turnUsage,
                        provider, owner, ts);
            }
        }
        for (String aid : new ArrayList<>(turnStart.keySet())) {
            closeTurn(spans, traceId, agentSpan, turnSeq, turnStart, turnText, turnUsage,
                    provider, aid, t1);
        }

        return root.toString();
    }

    private void closeTurn(ArrayNode spans, String traceId, Map<String, String> agentSpan,
                           Map<String, Integer> turnSeq, Map<String, Long> turnStart,
                           Map<String, StringBuilder> turnText, Map<String, int[]> turnUsage,
                           Map<String, String> provider, String aid, long endTs) {
        Long start = turnStart.remove(aid);
        if (start == null) {
            return;
        }
        int n = turnSeq.merge(aid, 1, Integer::sum);
        Map<String, String> attrs = new LinkedHashMap<>();
        attrs.put("langfuse.observation.type", "generation");
        attrs.put("gen_ai.operation.name", "chat");
        attrs.put("langfuse.session.id", sessionId);
        if (provider.containsKey(aid)) {
            attrs.put("gen_ai.system", provider.get(aid));
        }
        int[] usage = turnUsage.remove(aid);
        if (usage != null) {
            attrs.put("gen_ai.usage.input_tokens", String.valueOf(usage[0]));
            attrs.put("gen_ai.usage.output_tokens", String.valueOf(usage[1]));
        }
        StringBuilder text = turnText.remove(aid);
        if (text != null && text.length() > 0) {
            attrs.put("langfuse.observation.output", cut(text.toString(), CUT));
        }
        span(spans, traceId, id("turn:" + sessionId + ":" + aid + ":" + n, 8),
                agentSpan.getOrDefault(aid, id("root:" + sessionId, 8)),
                "turn " + n + " · " + aid, start, endTs, attrs, false, null);
    }

    // ---- OTLP plumbing -----------------------------------------------------

    private void span(ArrayNode spans, String traceId, String spanId, String parent, String name,
                      long startMs, long endMs, Map<String, String> attrs, boolean error,
                      String errorMessage) {
        ObjectNode s = spans.addObject();
        s.put("traceId", traceId);
        s.put("spanId", spanId);
        if (parent != null) {
            s.put("parentSpanId", parent);
        }
        s.put("name", name);
        s.put("kind", 1);
        s.put("startTimeUnixNano", String.valueOf(startMs * 1_000_000L));
        s.put("endTimeUnixNano", String.valueOf(Math.max(endMs, startMs) * 1_000_000L));
        ArrayNode attrArray = s.putArray("attributes");
        attrs.forEach((k, v) -> addAttr(attrArray, k, v));
        if (error) {
            ObjectNode status = s.putObject("status");
            status.put("code", 2);
            if (errorMessage != null) {
                status.put("message", errorMessage);
            }
        }
    }

    private static void addAttr(ArrayNode attrs, String key, String value) {
        ObjectNode a = attrs.addObject();
        a.put("key", key);
        a.putObject("value").put("stringValue", value == null ? "" : value);
    }

    private void httpPost(String body) throws Exception {
        // HTTP/1.1 pinned: the default client attempts an h2c upgrade on plain
        // http, which Node-based servers (Langfuse) answer by closing the
        // connection — "header parser received no bytes".
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5))
                .build();
        String url = endpoint.endsWith("/v1/traces") ? endpoint
                : endpoint.replaceAll("/+$", "") + "/v1/traces";
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (authHeader != null) {
            req.header("Authorization", authHeader);
        }
        HttpResponse<String> res = client.send(req.build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() / 100 != 2) {
            throw new IllegalStateException("HTTP " + res.statusCode());
        }
    }

    private static String agentOf(RunEvent event) {
        try {
            JsonNode node = JSON.valueToTree(event);
            JsonNode aid = node.get("agentId");
            return aid != null && aid.isTextual() && !aid.asText().isEmpty() ? aid.asText() : "main";
        } catch (RuntimeException e) {
            return "main";
        }
    }

    private static long tsOf(RunEvent event) {
        JsonNode node = JSON.valueToTree(event);
        JsonNode ts = node.get("ts");
        return ts != null && ts.isNumber() ? ts.asLong() : 0L;
    }

    private static String compact(Object input) {
        try {
            return JSON.writeValueAsString(input);
        } catch (Exception e) {
            return String.valueOf(input);
        }
    }

    private static String cut(String text, int max) {
        if (text == null) {
            return "";
        }
        return text.length() <= max ? text : text.substring(0, max) + " …[cut]";
    }

    private static String id(String seed, int bytes) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(seed.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < bytes; i++) {
                hex.append(String.format("%02x", digest[i]));
            }
            return hex.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
