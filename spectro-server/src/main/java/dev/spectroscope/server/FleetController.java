package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.orchestrator.BusEnvelope;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The fleet's REST face (block C): the roster fold and per-node ring replay.
 * Honest by construction — {@code enabled:false} with an empty roster is a
 * valid answer (the hub is opt-in), and the replay names its bound: the hub
 * ring is the whole story, there is no fleet store behind it.
 */
@RestController
public class FleetController {

    private final FleetAggregator fleet;
    private final NodeSpawner spawner;
    /** One shared configured mapper for the whole module (module convention). */
    private final ObjectMapper mapper = new ObjectMapper();

    FleetController(FleetAggregator fleet, NodeSpawner spawner) {
        this.fleet = fleet;
        this.spawner = spawner;
    }

    /**
     * The fleet roster. LOCAL-ORIGIN gated like the write endpoints: a fleet's
     * prompts, reasoning and tool I/O are as sensitive as the ability to spawn,
     * so a DNS-rebinding page (attacker Host) must not read them either.
     *
     * @param request the servlet request — must be a local origin
     * @return whether the hub is on plus every node seen · 404 for a non-local caller
     */
    @GetMapping("/api/fleet")
    public ResponseEntity<Map<String, Object>> fleet(HttpServletRequest request) {
        if (!isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("enabled", fleet.enabled());
        body.put("nodes", fleet.snapshot().stream().map(FleetAggregator::nodeJson).toList());
        return ResponseEntity.ok(body);
    }

    /**
     * Per-node replay from the hub ring — bounded by the ring, and saying so.
     *
     * @param node the node id from the roster
     * @return its ring-held frames in canonical envelope form, or 404 for a
     *         node the fold has never seen
     */
    @GetMapping("/api/fleet/{node}/events")
    public ResponseEntity<Map<String, Object>> events(@PathVariable("node") String node,
                                                      HttpServletRequest request) {
        if (!isLocalOrigin(request)) {
            return ResponseEntity.notFound().build(); // a node's full replay is sensitive
        }
        return fleet.replayFor(node)
                .map(replay -> {
                    Map<String, Object> body = new LinkedHashMap<>();
                    body.put("node", node);
                    body.put("ringBounded", true); // the ring IS the replay story
                    body.put("truncated", replay.truncated()); // did the ring evict earlier frames?
                    body.put("events", replay.frames().stream().map(this::canonical).toList());
                    return ResponseEntity.ok(body);
                })
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Stop a running fleet node (block 3): dispatch a {@code ctl{stop}} to it
     * over the hub. Best-effort and honest about it — a 202 means the verb was
     * SENT to the node's live connection, not that the node has confirmed it
     * stopped (the control plane has no ack). The client re-issues the stop —
     * it is idempotent — until the node leaves the roster.
     *
     * <p>Same LOCAL-ORIGIN gate as spawn: a loopback remote address AND a
     * localhost {@code Host} header, so a browser CSRF / DNS-rebinding page (its
     * Host is the attacker's domain) is a 404 — and {@code consumes=json} turns a
     * form POST into a 415. A remote or rebound caller can never stop a node.</p>
     *
     * @param node    the node id from the roster
     * @param request the servlet request — must be a local origin
     * @return 202 sent · 404 not local / no fleet / unknown · 409 the node already left
     */
    @PostMapping(path = "/api/fleet/{node}/stop", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> stop(@PathVariable("node") String node,
                                                    HttpServletRequest request) {
        if (!isLocalOrigin(request)) {
            return ResponseEntity.notFound().build(); // remote / rebinding — hide it
        }
        return switch (fleet.control(node, "stop")) {
            case DISABLED, UNKNOWN -> ResponseEntity.notFound().build();
            case DISCONNECTED -> ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(body(node, "the node already left the roster"));
            case DISPATCHED -> ResponseEntity.accepted()
                    .body(body(node, "stop sent — best-effort; re-issue until the node leaves the roster"));
        };
    }

    /**
     * Answer a parked permission gate on a fleet node (block 4): dispatch a
     * {@code ctl{gate}} carrying the operator's verdict to the node over the hub.
     * Best-effort and honest like {@link #stop}: a 202 means the answer was SENT
     * to the node's live connection, not that the node acted on it (the control
     * plane has no ack). If the node left before the answer lands, its own close
     * denies the orphaned gate — the operator sees the gate clear either way.
     *
     * <p>Same LOCAL-ORIGIN gate and {@code consumes=json} guard as stop/spawn: a
     * remote or DNS-rebinding caller is a 404, a form POST a 415. The body must
     * carry both {@code callId} and {@code allow}; a missing verdict is a 400, so
     * a malformed answer never silently denies (or allows) a parked tool.</p>
     *
     * @param node    the node id from the roster
     * @param answer  the operator's verdict {callId, allow}
     * @param request the servlet request — must be a local origin
     * @return 202 sent · 404 not local / no fleet / unknown · 409 the node left ·
     *         400 a missing callId or verdict
     */
    @PostMapping(path = "/api/fleet/{node}/gate", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> gate(@PathVariable("node") String node,
                                                    @RequestBody GateAnswer answer,
                                                    HttpServletRequest request) {
        if (!isLocalOrigin(request)) {
            return ResponseEntity.notFound().build(); // remote / rebinding — hide it
        }
        if (answer == null || answer.callId() == null || answer.callId().isBlank()
                || answer.allow() == null) {
            return ResponseEntity.badRequest()
                    .body(Map.of("error", "callId and allow are both required"));
        }
        return switch (fleet.controlGate(node, answer.callId(), answer.allow())) {
            case DISABLED, UNKNOWN -> ResponseEntity.notFound().build();
            case DISCONNECTED -> ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(gateBody(node, answer.callId(), "the node already left the roster"));
            case DISPATCHED -> ResponseEntity.accepted()
                    .body(gateBody(node, answer.callId(),
                            "gate answer sent — best-effort; if the node left, its close denies the gate"));
        };
    }

    /**
     * Spawn a readonly fleet node (block 3b) — the RCE-sensitive surface, gated
     * to the teeth: LOCAL-ORIGIN (loopback remote address AND a localhost Host —
     * the Host check is what stops DNS rebinding, which a loopback check alone
     * does not), JSON-only ({@code consumes} makes a browser form POST a 415),
     * OPT-IN ({@code SPECTRO_ALLOW_SPAWN}, default off), a spawn cap, and the
     * node is FORCED readonly (see {@link NodeSpawner}). Every rejection is a 404
     * so a remote caller learns nothing (no enablement oracle). Residual limits
     * are documented in {@link NodeSpawner}: not same-user on a shared host, and
     * a reverse proxy in front would rewrite the origin — do neither.
     *
     * @param body    the spawn request (prompt + context required)
     * @param request the servlet request — must be a local origin
     * @return 202 spawning · 404 not local / off / no hub · 400 bad input ·
     *         429 too many nodes spawning · 500 the process could not start
     */
    @PostMapping(path = "/api/fleet/nodes", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> spawn(@RequestBody SpawnRequest body,
                                                     HttpServletRequest request) {
        // Local origin FIRST, and 404 for everything — a non-local caller cannot
        // tell an enabled spawn (would 200/400) from a disabled one.
        if (!isLocalOrigin(request) || !spawner.allowed()) {
            return ResponseEntity.notFound().build();
        }
        try {
            String id = spawner.spawn(body);
            Map<String, Object> json = new LinkedHashMap<>();
            json.put("id", id);
            json.put("note", "readonly node spawning — it appears in the roster when it connects");
            return ResponseEntity.accepted().body(json);
        } catch (IllegalArgumentException bad) {
            return ResponseEntity.badRequest().body(Map.of("error", bad.getMessage()));
        } catch (IllegalStateException tooMany) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("error", tooMany.getMessage()));
        } catch (IOException failed) {
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                    .body(Map.of("error", "the node process could not be started"));
        }
    }

    /**
     * A local-origin request: a loopback remote address AND a localhost Host
     * header. The Host check is the DNS-rebinding defense — a rebinding page
     * reaches loopback but carries the attacker's Host (which JS cannot forge),
     * so it fails here; loopback alone would let it through.
     *
     * @param request the servlet request
     * @return true only for a loopback peer with a localhost Host
     */
    static boolean isLocalOrigin(HttpServletRequest request) {
        return isLoopback(request.getRemoteAddr()) && isLocalHostName(request.getServerName());
    }

    /** Whether a Host header names loopback (localhost or a loopback literal). */
    static boolean isLocalHostName(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.trim().toLowerCase(java.util.Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1); // an IPv6 literal's brackets
        }
        return h.equals("localhost") || h.equals("127.0.0.1")
                || h.equals("::1") || h.equals("0:0:0:0:0:0:0:1");
    }

    /**
     * Whether a servlet remote address is the loopback interface — half of the
     * local-origin gate. An unparseable address is refused (not trusted).
     *
     * @param remoteAddr the request's remote address
     * @return true only for a loopback address
     */
    static boolean isLoopback(String remoteAddr) {
        if (remoteAddr == null || remoteAddr.isBlank()) {
            return false;
        }
        try {
            return InetAddress.getByName(remoteAddr).isLoopbackAddress();
        } catch (UnknownHostException unparseable) {
            return false;
        }
    }

    /** The stop response shape — the verb, the node, and an honest note. */
    private static Map<String, Object> body(String node, String note) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("node", node);
        json.put("action", "stop");
        json.put("note", note);
        return json;
    }

    /** The gate response shape — the verb, node, addressed callId, and a note. */
    private static Map<String, Object> gateBody(String node, String callId, String note) {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("node", node);
        json.put("action", "gate");
        json.put("callId", callId);
        json.put("note", note);
        return json;
    }

    /** The envelope's canonical line IS the frame format — reuse it verbatim. */
    private JsonNode canonical(BusEnvelope envelope) {
        try {
            return mapper.readTree(envelope.toLine(mapper));
        } catch (IOException impossible) {
            throw new UncheckedIOException(
                    "own envelope line unreadable: " + envelope.id(), impossible);
        }
    }
}
