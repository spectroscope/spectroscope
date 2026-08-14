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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
 *
 * <p><b>It leaves litter, on purpose.</b> Every run seeds a new session id and
 * posts a whole trace, and nothing deletes it afterwards — that is the price of
 * the virgin-seed guard below, which is what makes a green mean anything. The
 * instance this was measured against held 141 traces before one review pass and
 * 155 after, 40 of the first 100 already carrying the {@code -live-<epoch>}
 * suffix this file mints. Whoever runs it against an instance that matters
 * should know they are writing to it.</p>
 *
 * <p><b>It is a MEASUREMENT, not a standing guard.</b> The annotation above
 * means CI and every ordinary gate skip it, so nothing here defends main. What
 * defends the exported shape on main is {@link OtlpSinkTest} at the payload
 * layer; this file settles the half of the card's criterion that a payload
 * cannot answer, and it answers it on the day someone runs it.</p>
 */
@EnabledIfEnvironmentVariable(named = "SPECTRO_LIVE_LANGFUSE", matches = ".+")
class OtlpSinkLangfuseLiveTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A tool call the exporter gives a span to, plus the two things about it
     *  only the WIRE knows: which agent made it, and whether that agent had a
     *  turn open when the result landed. Neither can be read back out of the
     *  consumer, which is the whole reason a misparented call can look
     *  plausible there. */
    private record Call(String callId, String tool, String agent, boolean turnOpen) {}

    /** A span the exporter can only place after the fact, because it names a
     *  tool CALL whose own span is measured later than it: a gate, an image.
     *  {@code seed} is the exporter's own seed for its id. */
    private record Placed(String seed, String name, String callId, String agent) {}

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
        //
        // 404 and not "nothing came back": the instance answers 404 for a
        // trace that does not exist and 401 when the key pair is wrong, and a
        // check that only asked whether the read was empty would call the
        // second one virgin. It could not produce a green — the POST is
        // rejected too — but it would report "the seed is virgin" when the
        // truth is "I was not allowed to look", and this file exists because
        // the difference between those two sentences cost a day once already.
        String sessionId = file.getFileName().toString().replace(".jsonl", "")
                + "-live-" + System.currentTimeMillis();
        int seed = status(base + "/api/public/traces/" + OtlpSink.traceIdFor(sessionId), auth);
        assertEquals(404, seed,
                "the trace seed is not known to be virgin: the instance answered " + seed
                        + " where 404 is the only answer that means 'no such trace' — "
                        + (seed == 401 || seed == 403 ? "this is a key that may not read, "
                        + "not an empty seed" : "this run cannot tell its own spans from an "
                        + "earlier producer's"));

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

        // Criterion 1: the tree is deeper than one. ON ITS OWN THIS PINS
        // NOTHING, and it is left standing only because the criterion is worded
        // that way. Measured on 2026-08-14 against the two defects this card
        // was opened for: with every agent parented to the root span the run
        // still prints "deepest chain: 5", and with tools parented to the agent
        // span it still prints "deepest chain: 6" — both sail past `> 1`. What
        // catches them is the parenting checks below. Nobody should trim this
        // file back to its stated criterion.
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
        // it — for EVERY spawn the wire names, and under the NEAREST agent
        // above it.
        //
        // Both halves of that sentence were learned the hard way on
        // 2026-08-14. This check used to take findFirst() over the spawn events
        // and ask whether the spawner stood anywhere on the child's chain. An
        // ancestor test is satisfied TRANSITIVELY, so with spawnedBy mutated to
        // hang every spawn after the first under the previously spawned agent,
        // agent · main was still on worker-3's chain and this test stayed
        // GREEN — as did all 30 of OtlpSinkTest — while Langfuse drew
        // main → build_plan → worker-1 → worker-2 → worker-3, a delegation
        // chain that never happened, at depth 10 instead of 8. The lie renders
        // as a BETTER tree than the truth, which is exactly the kind of defect
        // a count or a depth cannot see.
        //
        // Both carriers are read, the same two the exporter reads: the spawn
        // event the orchestrator emits, and RunStart.parentId for a record that
        // reaches us without its spawn. First mention wins; an agent is spawned
        // once.
        Map<String, String> spawnerOf = new LinkedHashMap<>();
        for (RunEvent e : events) {
            if (e instanceof RunEvent.AgentSpawn sp && sp.parentId() != null) {
                spawnerOf.putIfAbsent(sp.agentId(), sp.parentId());
            }
            if (e instanceof RunEvent.RunStart s && s.parentId() != null) {
                spawnerOf.putIfAbsent(s.agentId(), s.parentId());
            }
        }
        assertTrue(!spawnerOf.isEmpty(), "the wire named no spawn parent in " + sessionId);
        System.out.println("spawns the wire names: " + spawnerOf);
        for (Map.Entry<String, String> e : spawnerOf.entrySet()) {
            String child = idOfName(name, "agent · " + e.getKey());
            assertNotNull(child, "no observation named agent · " + e.getKey()
                    + " in " + name.values());
            String spawner = idOfName(name, "agent · " + e.getValue());
            assertNotNull(spawner, "no observation named agent · " + e.getValue()
                    + " in " + name.values());
            String nearest = nearestAgent(child, parent, name);
            assertTrue(spawner.equals(nearest),
                    "agent · " + e.getKey() + " is not under agent · " + e.getValue()
                            + " but under " + (nearest == null ? "no agent at all"
                            : name.get(nearest))
                            + "; its chain is " + chainNames(child, parent, name));
        }
        // And an agent the wire never named as spawned is genuinely a root: no
        // agent stands above it. Not "its parent is null" — Langfuse keeps the
        // posted root span as an observation of its own and hangs the trace row
        // above that, so a root agent legitimately has a parent here. The claim
        // that matters is that the parent is not another agent. Stated over
        // every root rather than over the first spawn's parent, so a fabricated
        // chain among the roots has nowhere to hide either.
        for (Map.Entry<String, String> o : name.entrySet()) {
            if (!o.getValue().startsWith("agent · ")
                    || spawnerOf.containsKey(o.getValue().substring("agent · ".length()))) {
                continue;
            }
            assertNull(nearestAgent(o.getKey(), parent, name),
                    o.getValue() + " is not a root after all, and the wire named no "
                            + "spawner for it: " + chainNames(o.getKey(), parent, name));
        }

        // Scope item 2: a tool sits INSIDE the turn that triggered it — the
        // NEAREST container above it, and a turn of the agent that made the
        // call.
        //
        // Both halves are here because of what this check used to be. It asked
        // `chainNames(tool).anyMatch(n -> n.startsWith("turn "))`: the same
        // transitive ancestor test that was removed from the spawn check one
        // block above, left standing one block below it. A subagent's entire
        // subtree hangs under a turn of its spawner, so ANY tool anywhere
        // beneath a subagent satisfied it. Two probes, both measured GREEN
        // against that wording on 2026-08-14 and both RED against this one:
        //
        //   - openTurnSpan returning the agent span for every agent that is
        //     not main or conductor — every subagent's tools drawn BESIDE the
        //     turns that issued them, the exact defect this card was opened
        //     for, restricted to subagents. It printed "deepest chain: 7" and
        //     exit 0.
        //   - the same tools re-parented onto MAIN's open turn — a worker's
        //     call drawn inside a turn of an agent that never made it. It
        //     printed "deepest chain: 6" and exit 0.
        //
        // The first is caught by asking for the NEAREST container; the second
        // only by asking WHOSE turn it is, which needs the call → agent map
        // the wire carries. Both are read below.
        //
        // Which observation belongs to which call is asked of the exporter
        // itself (its span ids are deterministic), never guessed from names: a
        // session calls `grep` eleven times and every one of those spans is
        // named `grep`. Identity is ours, PARENTHOOD is the consumer's, and
        // only the second is what this test is about.
        Map<String, String> runOwner = new HashMap<>();
        Set<String> turnOpen = new HashSet<>();
        Map<String, Call> openCall = new LinkedHashMap<>();
        List<Call> calls = new ArrayList<>();
        for (RunEvent e : events) {
            if (e instanceof RunEvent.RunStart s) {
                runOwner.put(s.runId(), s.agentId());
            } else if (e instanceof RunEvent.TurnStart t) {
                turnOpen.add(t.agentId());
            } else if (e instanceof RunEvent.RunEnd r) {
                turnOpen.remove(runOwner.get(r.runId()));
            } else if (e instanceof RunEvent.ToolCall c) {
                openCall.put(c.callId(), new Call(c.callId(), c.name(), c.agentId(), false));
            } else if (e instanceof RunEvent.ToolResult r) {
                Call open = openCall.remove(r.callId());
                if (open != null) {
                    calls.add(new Call(open.callId(), open.tool(), open.agent(),
                            turnOpen.contains(open.agent())));
                }
            }
        }
        assertTrue(!calls.isEmpty(), "the session spanned no tool call at all; langfuse holds "
                + name.values());
        for (Call c : calls) {
            String span = spanIdFor("tool:" + sessionId + ":" + c.callId());
            assertTrue(c.tool().equals(name.get(span)),
                    "no observation for call " + c.callId() + " (" + c.tool() + "), which the "
                            + "exporter spans as " + span + "; langfuse holds " + name.get(span));
            String owner = nearestOwner(span, parent, name);
            String owns = owner == null ? "nothing at all" : name.get(owner);
            // A call made while its agent has no turn open is rare but real,
            // and the exporter then hangs it on the agent itself. Whether a
            // turn was open is read off the WIRE — a turn runs from an agent's
            // turn_start to the end of its run — so this escape cannot be
            // widened by the exporter's own opinion of where the call belongs.
            // Measured 2026-08-14 over the 8 stored sessions that carry a
            // spawn: 103 spanned calls, 0 of them outside a turn, so today this
            // branch is never taken.
            if (!c.turnOpen()) {
                assertTrue(("agent · " + c.agent()).equals(owns),
                        c.tool() + " (call " + c.callId() + ", made by " + c.agent()
                                + " with no turn open) hangs under " + owns + "; its chain is "
                                + chainNames(span, parent, name));
                continue;
            }
            assertTrue(owns.startsWith("turn ") && c.agent().equals(agentOfTurn(owns)),
                    c.tool() + " (call " + c.callId() + ", made by " + c.agent() + ") does not "
                            + "sit in a turn of its own agent but under " + owns + "; its chain "
                            + "is " + chainNames(span, parent, name));
        }

        // ONE LEVEL UP from the tools: a turn hangs under ITS OWN agent.
        // Nothing asserted this before, and the tool check above cannot see
        // it — that one reads the agent out of the turn's NAME, so a turn
        // drawn under the wrong agent satisfies it while the picture is
        // wrong in exactly the way this card is about.
        for (Map.Entry<String, String> o : name.entrySet()) {
            if (!o.getValue().startsWith("turn ")) {
                continue;
            }
            String host = nearestAgent(o.getKey(), parent, name);
            assertTrue(host != null && ("agent · " + agentOfTurn(o.getValue())).equals(name.get(host)),
                    o.getValue() + " hangs under " + (host == null ? "no agent at all"
                            : name.get(host)) + "; its chain is "
                            + chainNames(o.getKey(), parent, name));
        }

        // ONE LEVEL DOWN from the tools: the gate and the image. Scope item 2
        // names gate spans as well and only the payload layer ever checked
        // them, and the image rides the very same code path in the exporter —
        // both are placed after the fact, once the call they name has been
        // measured. Leaving them out would repeat this card's own pattern:
        // close the hole for one kind of span and leave it open for its
        // neighbour.
        //
        // Either may sit inside the call's own span, or — when that span no
        // longer contains it, which is what card 111's execution-only tool
        // span does to a gate that waited BEFORE the execution — beside it in
        // the same turn. Under any OTHER call's span, or in another agent's
        // turn, it is the wrong shape.
        Map<String, String> toolSpanOfCall = new LinkedHashMap<>();
        for (Call c : calls) {
            toolSpanOfCall.put(c.callId(), spanIdFor("tool:" + sessionId + ":" + c.callId()));
        }
        Map<String, Placed> asked = new LinkedHashMap<>();
        Set<String> decided = new HashSet<>();
        List<Placed> placed = new ArrayList<>();
        for (RunEvent e : events) {
            if (e instanceof RunEvent.PermissionRequest p) {
                asked.putIfAbsent(p.callId(),
                        new Placed("gate:" + sessionId + ":" + p.callId(),
                                "gate · " + p.name(), p.callId(), p.agentId()));
            } else if (e instanceof RunEvent.PermissionDecision d) {
                decided.add(d.callId());
            } else if (e instanceof RunEvent.ImageGenerated img) {
                placed.add(new Placed("img:" + sessionId + ":" + img.callId(),
                        "image · " + img.provider(), img.callId(), img.agentId()));
            }
        }
        // Only a gate that was DECIDED gets a span — an open request is still
        // being waited on and has no end to draw.
        asked.forEach((callId, gate) -> {
            if (decided.contains(callId)) {
                placed.add(gate);
            }
        });
        for (Placed p : placed) {
            String span = spanIdFor(p.seed());
            assertTrue(p.name().equals(name.get(span)),
                    "no observation for " + p.name() + " on call " + p.callId()
                            + ", which the exporter spans as " + span + "; langfuse holds "
                            + name.get(span));
            String owner = nearestPlacement(span, parent, name, toolSpanOfCall.values());
            String owns = owner == null ? "nothing at all" : name.get(owner);
            boolean ownCall = owner != null && owner.equals(toolSpanOfCall.get(p.callId()));
            boolean ownTurn = owns.startsWith("turn ") && p.agent().equals(agentOfTurn(owns));
            assertTrue(ownCall || ownTurn,
                    p.name() + " (call " + p.callId() + ", from " + p.agent() + ") sits under "
                            + owns + ", which is neither its own call nor a turn of its own "
                            + "agent; its chain is " + chainNames(span, parent, name));
        }
        System.out.println("checked: " + calls.size() + " tool calls · " + placed.size()
                + " gates and images");
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
        HttpResponse<String> res = send(url, auth);
        return res.statusCode() / 100 == 2 ? JSON.readTree(res.body()) : null;
    }

    /** The status alone, for the one question where "not 2xx" is too coarse an
     *  answer to act on. */
    private static int status(String url, String auth) throws Exception {
        return send(url, auth).statusCode();
    }

    private static HttpResponse<String> send(String url, String auth) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(15)).GET();
        if (auth != null && !auth.isBlank()) {
            req.header("Authorization", "Basic " + Base64.getEncoder()
                    .encodeToString(auth.getBytes(StandardCharsets.UTF_8)));
        }
        return HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .connectTimeout(Duration.ofSeconds(5)).build()
                .send(req.build(), HttpResponse.BodyHandlers.ofString());
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

    /** The FIRST agent span above {@code id}, or null when none stands above
     *  it. Nearest and not "somewhere on the chain": an ancestor test passes
     *  transitively, so it cannot tell a subagent under its real spawner from
     *  one re-parented onto a sibling subagent that the spawner also made. */
    private static String nearestAgent(String id, Map<String, String> parent,
                                       Map<String, String> name) {
        for (String at : ancestors(id, parent)) {
            String n = name.get(at);
            if (n != null && n.startsWith("agent · ")) {
                return at;
            }
        }
        return null;
    }

    /** The FIRST thing above {@code id} that can CONTAIN a call — a turn or an
     *  agent — or null when neither stands above it. Same reason as
     *  {@link #nearestAgent}, one level down: a subagent's whole subtree hangs
     *  under a turn of its spawner, so "a turn is somewhere on the chain" is
     *  true of every tool anywhere beneath a subagent, whatever was done to
     *  its parent. */
    private static String nearestOwner(String id, Map<String, String> parent,
                                       Map<String, String> name) {
        for (String at : ancestors(id, parent)) {
            String n = name.get(at);
            if (n != null && (n.startsWith("turn ") || n.startsWith("agent · "))) {
                return at;
            }
        }
        return null;
    }

    /** As {@link #nearestOwner}, but tool spans count too — a gate legitimately
     *  sits inside the call it guarded. Tool spans are named after the tool, so
     *  they are recognised by id rather than by name. */
    private static String nearestPlacement(String id, Map<String, String> parent,
                                           Map<String, String> name,
                                           java.util.Collection<String> toolSpans) {
        for (String at : ancestors(id, parent)) {
            String n = name.get(at);
            if (toolSpans.contains(at)
                    || (n != null && (n.startsWith("turn ") || n.startsWith("agent · ")))) {
                return at;
            }
        }
        return null;
    }

    /** The agent a turn span belongs to, read out of its name — a turn is
     *  named {@code turn N · aid}. */
    private static String agentOfTurn(String turnName) {
        int at = turnName.indexOf(" · ");
        return at < 0 ? turnName : turnName.substring(at + " · ".length());
    }

    /** The span id the exporter itself would mint for a seed, asked of
     *  {@link OtlpSink} rather than recomputed here.
     *
     * <p>The ids are deterministic by design, and that is the only reason an
     * observation can be tied back to the call it belongs to at all: eleven
     * calls of {@code grep} produce eleven spans all named {@code grep}, so a
     * check that matched on names would be free to pick the convenient one.
     * Carrying a second copy of the id scheme in this file would let the two
     * drift apart in silence; asking the class means a rename fails loudly
     * here instead.</p> */
    private static String spanIdFor(String seed) throws Exception {
        java.lang.reflect.Method id = OtlpSink.class.getDeclaredMethod("id", String.class, int.class);
        id.setAccessible(true);
        return (String) id.invoke(null, seed, 8);
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
