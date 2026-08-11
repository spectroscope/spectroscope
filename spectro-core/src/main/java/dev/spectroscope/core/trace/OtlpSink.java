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

    /** One export outcome for UI mirrors (card 86) — never carries auth.
     *  message is null on success, the failure text otherwise; body is the
     *  exported OTLP JSON itself (the mirror bounds what rides the wire). */
    public record ExportReport(String endpoint, int spans, int bytes,
                               boolean ok, String message, String body, long ts) {}

    /** Registered by the server face to mirror each export as a socket frame. */
    public interface ExportListener {
        void onExport(ExportReport report);
    }

    private volatile ExportListener listener;

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

    /** Registers the one export mirror (card 86) — fluent, returns this.
     *  @param next the listener the exports report to
     *  @return this sink */
    public OtlpSink withListener(ExportListener next) {
        this.listener = next;
        return this;
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
        Payload payload = buildPayload(new ArrayList<>(buffer));
        Thread.startVirtualThread(() -> {
            try {
                poster.post(payload.body());
                notifyExport(payload, true, null);
            } catch (Exception failed) {
                if (warned.compareAndSet(false, true)) {
                    log.warn("otlp: export to {} failed ({}) — runs continue, further "
                            + "failures stay quiet", endpoint, failed.getMessage());
                }
                notifyExport(payload, false, failed.getMessage());
            }
        });
    }

    /** Tells the registered mirror (if any) — a mirror must never break the export. */
    private void notifyExport(Payload payload, boolean ok, String message) {
        ExportListener current = this.listener;
        if (current == null) {
            return;
        }
        try {
            current.onExport(new ExportReport(endpoint, payload.spans(),
                    payload.body().getBytes(StandardCharsets.UTF_8).length,
                    ok, message, payload.body(), System.currentTimeMillis()));
        } catch (RuntimeException never) {
            log.debug("otlp export listener failed (ignored)", never);
        }
    }

    /** A built batch + its span count — the mirror wants the number. */
    private record Payload(String body, int spans) {}

    /** A span that names a tool call and therefore cannot be placed until that
     *  call has been measured: the gate that guarded it, the image it produced.
     *  {@code fallbackParent} is where it lands when the call's own span turns
     *  out not to contain it (or never arrives at all). */
    private record Pending(String spanId, String callId, String fallbackParent, String name,
                           long start, long end, Map<String, String> attrs) {}

    // ---- the fold: the whole session so far -> spans (deterministic ids) ----

    private Payload buildPayload(List<RunEvent> events) {
        ObjectNode root = JSON.createObjectNode();
        ArrayNode resourceSpans = root.putArray("resourceSpans");
        ObjectNode rs = resourceSpans.addObject();
        ArrayNode resAttrs = rs.putObject("resource").putArray("attributes");
        addAttr(resAttrs, "service.name", "spectroscope");
        addAttr(resAttrs, "deployment.environment.name", "spectro-local");
        ObjectNode scopeSpans = rs.putArray("scopeSpans").addObject();
        scopeSpans.putObject("scope").put("name", "spectroscope-otlp").put("version", "0.1");
        ArrayNode spans = scopeSpans.putArray("spans");

        String traceId = traceIdFor(sessionId);

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
        /** Who spawned whom, straight off the wire. Absent for a genuine root. */
        Map<String, String> spawnedBy = new HashMap<>();
        /** Which agent opened which run — the only way to attribute a run_end. */
        Map<String, String> boundsOwner = new HashMap<>();
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
            // Card 142: `parentId` is on the wire and the fleet view already draws
            // the real shape from it. The export used to ignore it and hang every
            // agent off the root, so a subagent came out as its spawner's
            // SIBLING — which in a viewer that draws a tree is not a small
            // inaccuracy, it is the wrong shape.
            //
            // BOTH carriers are read. AgentSpawn is the one the orchestrator
            // emits today (measured over the stored corpus: 17 spawns, 17 of
            // them also named on a RunStart, so today the two agree), but
            // RunStart.parentId is equally part of the wire and a record that
            // reaches us without its spawn event — truncated, replayed, or
            // written by another producer — must still export the real shape
            // instead of quietly flattening onto the root. First mention wins;
            // an agent is spawned once.
            if (e instanceof RunEvent.AgentSpawn sp && sp.parentId() != null) {
                spawnedBy.putIfAbsent(sp.agentId(), sp.parentId());
            }
            if (e instanceof RunEvent.RunStart sub && sub.parentId() != null) {
                spawnedBy.putIfAbsent(sub.agentId(), sub.parentId());
            }
            if (e instanceof RunEvent.RunStart s) {
                boundsOwner.put(s.runId(), aid);
            }
            // A run_end names only the RUN. Attributed by the "main" default it
            // stretches the main agent instead of the one whose run it closed,
            // and the closing turn then ends after its own agent span: 73 turn
            // spans in the store were drawn outside their parent that way.
            //
            // Card 142: only an event that NAMES an agent may open one. Two
            // records name none — permission_decision carries a callId,
            // agent_message carries from/to — and both fell through agentOf()'s
            // "main" default, conjuring an agent span for an agent nobody ran.
            // Measured over the 287 stored sessions on 2026-08-11: 5 such
            // phantoms, each of them an overlapping sibling of the agent that
            // did run. Their own spans are placed elsewhere from the call they
            // name, so dropping them here loses no information.
            String owner = e instanceof RunEvent.RunEnd end
                    ? boundsOwner.get(end.runId()) : namedAgentOf(e);
            if (owner != null && ts > 0) {
                long[] b = agentBounds.computeIfAbsent(owner, k -> new long[]{ts, ts});
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
            agentSpan.put(aid, id("agent:" + sessionId + ":" + aid, 8));
        }
        // Where each spawned agent hangs, filled in by the event walk below at
        // the moment of the spawn — the agent spans themselves are written
        // afterwards, because until the walk reaches the spawn nobody knows
        // which of the spawner's spans was open around it.
        Map<String, String> agentParent = new HashMap<>();

        // turns, tools, gates, images
        Map<String, Integer> turnSeq = new HashMap<>();
        Map<String, Long> turnStart = new HashMap<>();
        Map<String, StringBuilder> turnText = new HashMap<>();
        Map<String, int[]> turnUsage = new HashMap<>();
        // Insertion-ordered: when an agent has more than one call in flight the
        // INNERMOST one is the most recently opened, and a spawn belongs to it.
        Map<String, Object[]> openTools = new LinkedHashMap<>();  // callId -> [aid, name, start, input]
        Map<String, Object[]> openGates = new HashMap<>();
        Map<String, String> runOwner = new HashMap<>();
        // Card 142: a gate and an image name the tool CALL they belong to, but
        // that call's own span is only measured when its result arrives — later
        // than both. So they are collected here and placed once the call's span
        // exists; until then nobody can tell whether the call contains them.
        Map<String, long[]> toolRange = new HashMap<>();   // callId -> {start, end}
        List<Pending> pending = new ArrayList<>();

        for (RunEvent e : events) {
            String aid = agentOf(e);
            long ts = tsOf(e);
            if (e instanceof RunEvent.AgentSpawn sp) {
                agentParent.computeIfAbsent(sp.agentId(), k -> spawnContainer(
                        agentSpan, turnSeq, turnStart, openTools, spawnedBy.get(k)));
            }
            if (e instanceof RunEvent.RunStart s) {
                runOwner.put(s.runId(), aid);
                if (s.parentId() != null) {
                    agentParent.computeIfAbsent(aid, k -> spawnContainer(
                            agentSpan, turnSeq, turnStart, openTools, spawnedBy.get(k)));
                }
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
                    // Card 111: with an execution-only durationMs on the wire the
                    // tool span covers the EXECUTION (result ts − durationMs), and
                    // the wait stays with the gate span — a parked operator no
                    // longer inflates the tool's span in Langfuse. Old archives
                    // carry no gateWaitMs and keep their historic call..result shape.
                    long start = (long) open[2];
                    if (r.gateWaitMs() != null) {
                        start = Math.max(start, ts - r.durationMs());
                        attrs.put("spectroscope.gate.wait_ms", String.valueOf(r.gateWaitMs()));
                    }
                    toolRange.put(r.callId(), new long[]{start, ts});
                    span(spans, traceId, id("tool:" + sessionId + ":" + r.callId(), 8),
                            openTurnSpan(agentSpan, turnSeq, turnStart, (String) open[0]), (String) open[1],
                            start, ts, attrs, r.isError(),
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
                    pending.add(new Pending(id("gate:" + sessionId + ":" + d.callId(), 8),
                            d.callId(),
                            openTurnSpan(agentSpan, turnSeq, turnStart, (String) open[0]),
                            "gate · " + open[1], (long) open[2], ts, attrs));
                }
            } else if (e instanceof RunEvent.ImageGenerated img) {
                Map<String, String> attrs = new LinkedHashMap<>();
                attrs.put("langfuse.observation.type", "span");
                attrs.put("langfuse.session.id", sessionId);
                attrs.put("gen_ai.request.model", img.model() == null ? "" : img.model());
                attrs.put("langfuse.observation.input", cut(img.prompt(), CUT));
                pending.add(new Pending(id("img:" + sessionId + ":" + img.callId(), 8),
                        img.callId(), openTurnSpan(agentSpan, turnSeq, turnStart, aid),
                        "image · " + img.provider(), ts, ts, attrs));
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

        for (Pending p : pending) {
            // Inside the call it names when that call's span still covers it —
            // an old record's tool span runs call..result and holds its own
            // gate. Once the wire carries gateWaitMs the tool span is the
            // EXECUTION alone and the wait sits BEFORE it, so nesting would
            // draw a child entirely outside its parent; those stay in the turn,
            // where they are the call's other phase and overlap nothing.
            long[] call = toolRange.get(p.callId());
            boolean insideTheCall = call != null && p.start() >= call[0] && p.end() <= call[1];
            span(spans, traceId, p.spanId(),
                    insideTheCall ? id("tool:" + sessionId + ":" + p.callId(), 8) : p.fallbackParent(),
                    p.name(), p.start(), p.end(), p.attrs(), false, null);
        }

        for (String aid : agentBounds.keySet()) {
            Map<String, String> attrs = new LinkedHashMap<>();
            attrs.put("langfuse.observation.type", "agent");
            attrs.put("gen_ai.operation.name", "invoke_agent");
            attrs.put("langfuse.session.id", sessionId);
            if (provider.containsKey(aid)) {
                attrs.put("gen_ai.system", provider.get(aid));
            }
            long[] b = agentBounds.get(aid);
            // Under whatever of its spawner was open around the spawn, under the
            // session only when the wire never named a parent. The fallback is
            // the root rather than nothing: a dangling parentSpanId draws as an
            // empty tree, so a spawn whose parent left no span still lands
            // somewhere a reader can find it.
            span(spans, traceId, agentSpan.get(aid), agentParent.getOrDefault(aid, rootSpan),
                    "agent · " + aid, b[0], b[1], attrs, false, null);
        }

        return new Payload(root.toString(), spans.size());
    }

    /**
     * The span a tool, gate or image belongs INSIDE — the agent's open turn.
     *
     * <p>Card 142: these used to attach to the agent span, beside the turn that
     * triggered them, while temporally sitting inside it. Measured across the
     * stored corpus at the time: 176 overlapping sibling pairs, 173 of them full
     * containment, across 30 sessions. A child drawn next to its parent, holding
     * the parent's time range, is the wrong shape rather than a rounding error.</p>
     *
     * <p>The number is computed the same way {@link #closeTurn} computes it —
     * one past what has closed — so an open turn and its own closing span agree
     * without either having to remember an id.</p>
     *
     * @param agentSpan the agent spans by id, for the fallback
     * @param turnSeq how many turns have CLOSED per agent
     * @param turnStart which agents currently have a turn open
     * @param aid the agent
     * @return the open turn's span id, or the agent's own when no turn is open
     *         (a tool outside any turn is rare but real, and it must still land
     *         somewhere that exists)
     */
    private String openTurnSpan(Map<String, String> agentSpan, Map<String, Integer> turnSeq,
                                Map<String, Long> turnStart, String aid) {
        if (aid == null || !turnStart.containsKey(aid)) {
            return agentSpan.getOrDefault(aid, id("root:" + sessionId, 8));
        }
        int n = turnSeq.getOrDefault(aid, 0) + 1;
        return id("turn:" + sessionId + ":" + aid + ":" + n, 8);
    }

    /**
     * The span a newly spawned agent belongs INSIDE: the innermost thing its
     * spawner had open at that instant.
     *
     * <p>Card 142 asked for the subagent to hang off its spawning agent, and
     * that alone still draws the wrong picture. Measured over the stored
     * corpus, every one of the 17 spawns arrives while the spawner has a tool
     * call open — the tool that requested the work and does not return until
     * the subagent is done. Hung off the agent, the subagent comes out as a
     * SIBLING of that waiting tool call and of the turn around it, both of
     * which contain it in time. So: the open tool call first, the open turn
     * next, the spawner's own span last.</p>
     *
     * @param agentSpan the agent spans by id, for the fallback
     * @param turnSeq how many turns have CLOSED per agent
     * @param turnStart which agents currently have a turn open
     * @param openTools the calls in flight, oldest first
     * @param parentAid the spawning agent, or null when the wire named none
     * @return the span id the spawned agent parents to
     */
    private String spawnContainer(Map<String, String> agentSpan, Map<String, Integer> turnSeq,
                                  Map<String, Long> turnStart, Map<String, Object[]> openTools,
                                  String parentAid) {
        String innermost = null;
        for (Map.Entry<String, Object[]> open : openTools.entrySet()) {
            if (parentAid != null && parentAid.equals(open.getValue()[0])) {
                innermost = open.getKey();
            }
        }
        if (innermost != null) {
            return id("tool:" + sessionId + ":" + innermost, 8);
        }
        return openTurnSpan(agentSpan, turnSeq, turnStart, parentAid);
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

    /** What a zero-length span is widened to, so it can be seen at all. One
     *  millisecond: too small to read as a measurement, big enough to click. */
    private static final long ZERO_SPAN_FLOOR_MS = 1;

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
        // ZERO-LENGTH SPANS, decided out loud (card 142, scope item 4).
        //
        // 33 spans in the stored corpus came out zero or negative — 12 tool,
        // 10 gate, 6 turn, 5 image — and drew as invisible bars. Two honest
        // answers were available: leave them at zero, which tells the truth
        // about duration and shows the reader nothing, or give them a floor,
        // which is readable and is a small lie about how long something took.
        //
        // The floor wins, and only just. This exporter's job is to make a run
        // legible in somebody else's viewer, and a span nobody can see does not
        // report a fast operation — it reports no operation at all, which is
        // the more misleading of the two errors. The floor is ONE MILLISECOND:
        // small enough that no reader mistakes it for a real measurement, large
        // enough to have a hit area. `durationMs` on the event carries the
        // truth for anyone who needs it.
        //
        // The negative case is separate and is NOT floored into looking fine:
        // an end before its start is a clock going backwards, and it collapses
        // to the start rather than being given a width it never had.
        long end = Math.max(endMs, startMs);
        if (end == startMs) {
            end = startMs + ZERO_SPAN_FLOOR_MS;
        }
        s.put("startTimeUnixNano", String.valueOf(startMs * 1_000_000L));
        s.put("endTimeUnixNano", String.valueOf(end * 1_000_000L));
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
        String named = namedAgentOf(event);
        return named != null ? named : "main";
    }

    /** The agent an event NAMES on the wire, or null when it names none —
     *  the difference {@link #agentOf}'s "main" default papers over, and the
     *  only safe basis for deciding that an agent existed at all. */
    private static String namedAgentOf(RunEvent event) {
        try {
            JsonNode node = JSON.valueToTree(event);
            JsonNode aid = node.get("agentId");
            return aid != null && aid.isTextual() && !aid.asText().isEmpty() ? aid.asText() : null;
        } catch (RuntimeException e) {
            return null;
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

    /**
     * The trace id a session's exported spans share: the first 16 bytes of
     * {@code sha256("trace:" + sessionId)}, as 32 lowercase hex characters.
     *
     * <p>Public because the browser recomputes it to build a deep link into
     * the configured backend (card 137) instead of asking the server for a
     * value it can derive. Deterministic by design: a re-export upserts the
     * same trace rather than creating a second one.</p>
     */
    public static String traceIdFor(String sessionId) {
        return id("trace:" + sessionId, 16);
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
