package dev.spectroscope.core.trace;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 142's live half: the shape a REAL OTLP consumer renders is the shape the
 * run had.
 *
 * <p>{@link OtlpSinkTest} pins the payload — what leaves the process. It cannot
 * settle the criterion the card actually asks, because a payload is a claim
 * about a protocol and a trace view is what someone looks at. Between the two
 * sits a consumer's own ingestion, which may keep, reparent or drop what it was
 * sent. This test closes that gap by posting through the production HTTP leg
 * into a running Langfuse and reading the tree back out of its public API,
 * where {@code parentObservationId} is the consumer's own answer rather than
 * ours.</p>
 *
 * <p>OFF unless the stack is up. It runs only when
 * {@code SPECTRO_LIVE_LANGFUSE} is set, so CI and every ordinary
 * {@code ./gradlew test} skip it rather than fail on a missing service. To run
 * it:</p>
 *
 * <pre>
 * SPECTRO_LIVE_LANGFUSE=http://localhost:3000 \
 * SPECTRO_LIVE_LANGFUSE_AUTH=pk-lf-…:sk-lf-… \
 * SPECTRO_LIVE_SESSION="$HOME/.spectro/sessions/&lt;id&gt;.jsonl" \
 *   ./gradlew :spectro-core:test --tests '*OtlpSinkLangfuseLiveTest*' \
 *             --rerun-tasks --no-build-cache
 * </pre>
 *
 * <p>Neither the address nor the key pair is written down here: both arrive
 * from the environment, because this repo is public.</p>
 */
@EnabledIfEnvironmentVariable(named = "SPECTRO_LIVE_LANGFUSE", matches = ".+")
class OtlpSinkLangfuseLiveTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** How long the consumer is given to ingest. Langfuse's OTLP endpoint
     *  accepts on the request thread and materialises through a worker and
     *  ClickHouse afterwards, so an immediate read legitimately returns
     *  nothing. The wait is reported per run rather than remembered here — a
     *  number in a comment drifts, the run prints the one it measured. */
    private static final Duration INGEST_BUDGET = Duration.ofSeconds(90);

    @Test
    void theTreeLangfuseRendersIsTheTreeTheRunHad() throws Exception {
        String base = System.getenv("SPECTRO_LIVE_LANGFUSE").replaceAll("/+$", "");
        String auth = System.getenv("SPECTRO_LIVE_LANGFUSE_AUTH");
        Path file = Path.of(System.getenv("SPECTRO_LIVE_SESSION"));

        // A VIRGIN trace, and the first run of this test is the reason why.
        // Span and trace ids are deterministic so that a re-export upserts,
        // and this instance already held the same session from an export in
        // July. Reading it back proved nothing: the rows carried
        // createdAt 2026-07-23, so the tree on screen could have been the
        // older producer's and not the payload just posted. Seeding the trace
        // with a per-run id removes the question instead of arguing about it —
        // and the assertion below refuses to continue if the id is not new.
        String sessionId = file.getFileName().toString().replace(".jsonl", "")
                + "-live-" + System.currentTimeMillis();
        assertNull(get(base + "/api/public/traces/" + OtlpSink.traceIdFor(sessionId), auth),
                "the trace seed was not virgin — this run cannot tell its own "
                        + "spans from an earlier producer's");

        List<RunEvent> events = new ArrayList<>();
        for (String line : Files.readAllLines(file)) {
            if (!line.isBlank()) {
                events.add(JSON.readValue(line, RunEvent.class));
            }
        }
        long spawns = events.stream().filter(e -> e instanceof RunEvent.AgentSpawn).count();
        assertTrue(spawns > 0,
                "this test needs a session that spawned a subagent; " + sessionId
                        + " carries " + spawns);

        // The production HTTP leg, not the poster seam: the point is to be a
        // client of the real endpoint.
        //
        // Every report is kept and the LAST one is the subject, rather than
        // latching on the first. A session reaches an idle point at every
        // run_end that leaves no run open, so it can export more than once, and
        // reading Langfuse after the first of several posts would compare the
        // finished tree against a partial span count. That also keeps card 75
        // out of this test's way: single-flight decides which snapshots reach
        // the wire and in what order, and by only reading once the reports have
        // stopped, this test asserts on the settled result either way rather
        // than on the race being absent.
        List<OtlpSink.ExportReport> reports = Collections.synchronizedList(new ArrayList<>());
        OtlpSink sink = new OtlpSink(base + "/api/public/otel", auth, sessionId, null)
                .withListener(reports::add);
        events.forEach(sink::onEvent);

        long quiet = System.nanoTime() + Duration.ofSeconds(60).toNanos();
        int last = -1;
        while (System.nanoTime() < quiet && (reports.isEmpty() || reports.size() != last)) {
            last = reports.size();
            Thread.sleep(2000);
        }
        assertTrue(!reports.isEmpty(), "the export never reported");
        System.out.println("exports reported: " + reports.size());
        OtlpSink.ExportReport sent = reports.get(reports.size() - 1);
        assertTrue(sent.ok(), "the export was rejected: " + sent.message());

        String traceId = OtlpSink.traceIdFor(sessionId);
        List<JsonNode> observations = awaitObservations(base, auth, traceId, sent.spans());

        // What the CONSUMER says the parent is — never what we posted.
        Map<String, String> parent = new HashMap<>();
        Map<String, String> name = new LinkedHashMap<>();
        for (JsonNode o : observations) {
            String id = o.path("id").asText();
            JsonNode p = o.path("parentObservationId");
            parent.put(id, p.isNull() || p.isMissingNode() ? null : p.asText());
            name.put(id, o.path("name").asText());
        }
        printTree(observations, parent, name);

        // Criterion 1: the tree is deeper than one.
        int deepest = 0;
        String deepestName = null;
        for (String id : parent.keySet()) {
            int d = depth(id, parent);
            if (d > deepest) {
                deepest = d;
                deepestName = name.get(id);
            }
        }
        System.out.println("deepest chain: " + deepest + " at " + deepestName);
        assertTrue(deepest > 1,
                "Langfuse rendered a flat pile: deepest chain " + deepest
                        + " (" + deepestName + ") over " + observations.size()
                        + " observations " + name.values());

        // Scope item 1: a spawned subagent hangs under its spawner, not beside
        // it. Read off the consumer's parent links by walking up from the
        // subagent; the spawner has to stand somewhere on that chain, and the
        // spawner itself has to be a genuine root.
        RunEvent.AgentSpawn spawn = (RunEvent.AgentSpawn) events.stream()
                .filter(e -> e instanceof RunEvent.AgentSpawn).findFirst().orElseThrow();
        String child = idOfName(name, "agent · " + spawn.agentId());
        assertNotNull(child, "no observation named agent · " + spawn.agentId()
                + " in " + name.values());
        String spawner = idOfName(name, "agent · " + spawn.parentId());
        assertNotNull(spawner, "no observation named agent · " + spawn.parentId()
                + " in " + name.values());
        assertTrue(ancestors(child, parent).contains(spawner),
                "agent · " + spawn.agentId() + " is not under agent · " + spawn.parentId()
                        + "; its chain is " + chainNames(child, parent, name));
        // And the spawner is genuinely a root: no agent stands above it. Not
        // "its parent is null" — Langfuse keeps the posted root span as an
        // observation of its own and hangs the trace row above that, so a root
        // agent legitimately has a parent here. The claim that matters is that
        // the parent is not another agent.
        assertTrue(chainNames(spawner, parent, name).stream().skip(1)
                        .noneMatch(n -> n.startsWith("agent · ")),
                "agent · " + spawn.parentId() + " is not a root after all: "
                        + chainNames(spawner, parent, name));

        // Scope item 2: a tool sits INSIDE the turn that triggered it. Any tool
        // observation whose chain skips every turn is the old flat shape.
        // The tool names come from the RUN, not from a guess about the naming
        // scheme: a tool span is named after the tool itself, so a filter on a
        // "tool · " prefix silently matches nothing and the loop below would
        // pass while checking zero spans.
        List<String> toolNames = events.stream()
                .filter(e -> e instanceof RunEvent.ToolCall)
                .map(e -> ((RunEvent.ToolCall) e).name()).distinct().toList();
        List<String> tools = name.entrySet().stream()
                .filter(e -> toolNames.contains(e.getValue())).map(Map.Entry::getKey).toList();
        assertTrue(!tools.isEmpty(), "the session exported no tool span; the run called "
                + toolNames + " and langfuse holds " + name.values());
        for (String tool : tools) {
            assertTrue(chainNames(tool, parent, name).stream().anyMatch(n -> n.startsWith("turn ")),
                    name.get(tool) + " hangs outside every turn: "
                            + chainNames(tool, parent, name));
        }
    }

    /** Poll until the consumer has materialised the batch it accepted, and
     *  then until it STOPS growing. Waiting for a count alone reads a
     *  half-ingested tree as a finished one — a partially arrived tree has
     *  missing parents and looks exactly like the flat shape this test exists
     *  to catch, so the settle is what keeps a green from being luck. */
    private static List<JsonNode> awaitObservations(String base, String auth,
                                                    String traceId, int expected)
            throws Exception {
        long began = System.nanoTime();
        long deadline = began + INGEST_BUDGET.toNanos();
        List<JsonNode> seen = List.of();
        int stable = 0;
        while (System.nanoTime() < deadline) {
            JsonNode trace = get(base + "/api/public/traces/" + traceId, auth);
            if (trace != null && trace.path("observations").isArray()) {
                List<JsonNode> now = new ArrayList<>();
                trace.path("observations").forEach(now::add);
                stable = !now.isEmpty() && now.size() == seen.size() ? stable + 1 : 0;
                if (seen.isEmpty() && !now.isEmpty()) {
                    System.out.println("langfuse first showed the trace after "
                            + (Duration.ofNanos(System.nanoTime() - began).toMillis()) + " ms");
                }
                seen = now;
                // Langfuse keeps the posted root span as an observation of its
                // own and puts the trace row above it, so the counts match
                // rather than differing by one. Demanding all of them is the
                // point: a half-ingested tree has missing parents and reads
                // exactly like the flat shape this test exists to catch.
                if (seen.size() >= expected && stable >= 3) {
                    System.out.println("langfuse settled: " + seen.size()
                            + " observations for the " + expected + " spans posted");
                    return seen;
                }
            }
            Thread.sleep(1000);
        }
        throw new AssertionError("Langfuse showed " + seen.size() + " of the " + expected
                + " posted spans for trace " + traceId + " within " + INGEST_BUDGET);
    }

    private static JsonNode get(String url, String auth) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(15)).GET();
        if (auth != null && !auth.isBlank()) {
            req.header("Authorization", "Basic " + Base64.getEncoder()
                    .encodeToString(auth.getBytes(StandardCharsets.UTF_8)));
        }
        HttpResponse<String> res = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5)).build()
                .send(req.build(), HttpResponse.BodyHandlers.ofString());
        return res.statusCode() / 100 == 2 ? JSON.readTree(res.body()) : null;
    }

    private static String idOfName(Map<String, String> name, String wanted) {
        return name.entrySet().stream().filter(e -> e.getValue().equals(wanted))
                .map(Map.Entry::getKey).findFirst().orElse(null);
    }

    private static int depth(String id, Map<String, String> parent) {
        int d = 1;
        for (String at = parent.get(id); at != null; at = parent.get(at)) {
            d++;
            if (d > 64) {
                throw new AssertionError("cycle in the parent links at " + id);
            }
        }
        return d;
    }

    private static List<String> ancestors(String id, Map<String, String> parent) {
        List<String> up = new ArrayList<>();
        for (String at = parent.get(id); at != null; at = parent.get(at)) {
            up.add(at);
        }
        return up;
    }

    private static List<String> chainNames(String id, Map<String, String> parent,
                                           Map<String, String> name) {
        List<String> up = new ArrayList<>();
        up.add(name.get(id));
        ancestors(id, parent).forEach(a -> up.add(name.get(a)));
        return up;
    }

    /** Prints the tree the consumer holds, as a tree — the eyes on the thing
     *  the assertions speak about, because the card's finding was a SHAPE and a
     *  shape is worth seeing rather than counting. Children follow their own
     *  parent, so a span drawn beside its owner is visible here as a wrong
     *  indent and not only as a failed assertion. */
    private static void printTree(List<JsonNode> observations,
                                  Map<String, String> parent, Map<String, String> name) {
        Map<String, Long> ms = new HashMap<>();
        observations.forEach(o -> ms.put(o.path("id").asText(), o.path("latency").asLong()));
        Map<String, List<String>> kids = new LinkedHashMap<>();
        name.keySet().forEach(id ->
                kids.computeIfAbsent(String.valueOf(parent.get(id)), k -> new ArrayList<>()).add(id));
        System.out.println("the tree langfuse holds — " + name.size() + " observations");
        walk(kids.getOrDefault("null", List.of()), kids, name, ms, 1);
    }

    private static void walk(List<String> ids, Map<String, List<String>> kids,
                             Map<String, String> name, Map<String, Long> ms, int level) {
        for (String id : ids) {
            System.out.println("  " + "    ".repeat(level - 1) + name.get(id)
                    + "  [depth " + level + ", " + ms.get(id) + " ms]");
            walk(kids.getOrDefault(id, List.of()), kids, name, ms, level + 1);
        }
    }
}
